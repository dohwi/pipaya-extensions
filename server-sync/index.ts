// server-sync: mirrors the pipaya `settings` table of a primary server onto this one.
//
// Roles (chosen in the settings form):
//   - "primary": serves its settings to the peer (the `snapshot` method below) and changes nothing itself.
//   - "follower": polls the primary and applies what it sees. Its own conflicting edits are overwritten.
//
// One file on purpose. A server from before 0.8.4 busts the module cache for the entry file alone, so a folder
// extension (`index.ts` + `store.ts`) kept running its old helper after a reload and failed with "Export named X not
// found". Everything lives here so an update is a single file that always reloads.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** How often a failing pull is retried at most (the base interval is multiplied by 2 per miss, up to this). */
const MAX_BACKOFF = 8;
/** How long a connection code stays valid (same as the app's pairing code). */
const CODE_TTL_MS = 120_000;

/** Rows mirrored by default. */
const SYNCED_KEYS = [
	"default_model", "default_workdir", "system_model", "image_model",
	"mcp_servers", "compaction", "retention", "skills",
	"disabled_tools", "disabled_subagents", "delegate_policy",
] as const;

/**
 * What a follower can pick on its form. A checked group is pulled from the primary; an unchecked one keeps this server's
 * own value and is never touched. A setting saved before 0.8.0 has none of these: everything counts as checked.
 * The six groups of 0.8–0.12 are one box ("앱 설정", `syncApp`) now; they were nearly always checked together.
 */
const GROUPS = [
	{ field: "syncApp", keys: ["default_model", "system_model", "image_model", "default_workdir", "mcp_servers", "skills", "disabled_tools", "disabled_subagents", "delegate_policy", "compaction", "retention"] },
] as const;
const GROUPED = new Set<string>(GROUPS.flatMap((g) => g.keys));

/** Extension settings keys that look like a credential (the app's own list): never sent, and the follower keeps its own. */
const CREDENTIAL_KEY = /token|secret|password|credential|authorization|api.?key|cookie|private/i;
/** A folder under `<dataDir>/extensions` that holds an extension's settings (the server's own id rule). */
const EXTENSION_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** This extension's own settings hold the peer address and token: never mirrored. */
const SELF_ID = "server-sync";

/** Never mirrored: per-device identity, token-adjacent or local-only rows. */
const NEVER_SYNCED = new Set(["device_id", "default_approval", "retention_state", "session_retention_state"]);

/** The same text in Korean and English: the settings page shows the reader's (`readonly` field, app 0.8.6+). */
type Text = { ko: string; en: string };

/** A settings key as the server writes it (`<feature>` or `<feature>.<field>`), and the most keys one snapshot may carry. */
const KEY = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
const MAX_KEYS = 200;

interface DatabaseLike {
	query(sql: string): { get(...p: unknown[]): any; all(...p: unknown[]): any; run(...p: unknown[]): unknown };
}

/** What a primary serves: the rows it mirrors and the keys they cover. */
interface Snapshot {
	keys: string[];
	settings: Record<string, unknown>;
	/** Extension id -> its settings without credentials; only when the follower asked for them. */
	extensions?: Record<string, Record<string, unknown>>;
	/** The rest of the environment, each part only when the follower asked for it (0.10.0+). */
	environment?: Environment;
}

/** One installed extension that runs inside the server: enough for the follower to install the same version from the marketplace. */
interface InstalledExtension { id: string; version: string; /** The code itself, only when the follower asked for unlisted ones */ files?: FileSet }
/** Files of a folder, by path inside it. */
type FileSet = Record<string, string>;
/** What a primary sends besides settings rows. Never a secret: see each reader. */
interface Environment {
	serverExtensions?: InstalledExtension[];
	clientExtensions?: { list: unknown; states: unknown };
	skills?: Record<string, FileSet>;
	subagents?: FileSet;
	agentsMd?: string | null;
	providers?: Record<string, Record<string, unknown>>;
	/** Model API keys by provider id (api_key only): only when the follower turned on 비밀값 and the primary allows it. */
	apiKeys?: Record<string, string>;
	/** `~/.agents/extensions`: the owner's own extensions, single files and folders. */
	agentExtensions?: { files: FileSet; folders: Record<string, FileSet> };
}
/**
 * The environment parts a follower can ask for, by the settings box that turns each on. "Installed extensions" is one
 * box for the person; what runs inside the server and what runs in the apps are two reads here, never two boxes.
 */
const PARTS = {
	serverExtensions: "syncExtensions",
	clientExtensions: "syncExtensions",
	skills: "syncAgent",
	subagents: "syncAgent",
	agentsMd: "syncAgent",
	providers: "syncProviders",
	apiKeys: "syncSecrets",
	agentExtensions: "syncLocalExtensions",
} as const;
type Part = keyof typeof PARTS;
/** Where the marketplace lists each extension's pinned git source. */
const CATALOG_URL = "https://raw.githubusercontent.com/dohwi/pipaya-marketplace/main/index.json";
/** Bounds on what a folder copy may carry: a skill is a few text files, not a repository. */
const FOLDER_LIMITS = { files: 200, bytes: 2 * 1024 * 1024, file: 512 * 1024 };
/** An extension's own runtime files: never part of its code (settings travel with 확장 설정, the rest is per server). */
const EXTENSION_RUNTIME = new Set(["settings.json", "settings.at"]);

interface Status {
	role: "primary" | "follower";
	/** The peer address in effect (follower only). */
	url: string;
	/** Seconds between pulls, as configured (minimum 15). */
	intervalSeconds: number;
	/** The keys this server mirrors (on a follower: the ones it picked). */
	keys: string[];
	/** Whether this follower also pulls extension settings. */
	syncExtensions: boolean;
	/** Unix ms of the last successful pull (follower only). */
	lastSyncAt: number | null;
	/** Keys the last successful pull changed. */
	lastApplied: string[];
	/** Why the last pull failed, if it did. */
	lastError: string | null;
	/** The status line of the page, in Korean and English. */
	status: Text;
}

/** The effective key list: the built-ins plus the user's extras, minus the never-synced. */
function effectiveKeys(extra: string | undefined): string[] {
	const list = String(extra ?? "").split(",").map((k) => k.trim()).filter(Boolean);
	return [...new Set([...SYNCED_KEYS, ...list])].filter((k) => !NEVER_SYNCED.has(k));
}

/**
 * The keys a follower mirrors: what the primary says it mirrors, so the two never disagree about what a missing row
 * means. A primary too old to send its list (or a damaged one) falls back to the follower's own list.
 */
function mirrorKeys(peerKeys: unknown, fallback: readonly string[]): string[] {
	const raw = Array.isArray(peerKeys) ? peerKeys.filter((k): k is string => typeof k === "string" && KEY.test(k)) : [];
	const keys = [...new Set(raw)].filter((k) => !NEVER_SYNCED.has(k)).slice(0, MAX_KEYS);
	return keys.length ? keys : [...fallback];
}

/** The rows we mirror from the settings table: key -> parsed value, only the keys present. */
function readSettings(db: DatabaseLike, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!keys.length) return out;
	const rows = db.query(`SELECT key, data FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as { key: string; data: string }[];
	for (const r of rows) {
		try { out[r.key] = JSON.parse(r.data); } catch { /* a damaged row is not ours to fix */ }
	}
	return out;
}

/** Writes the peer's rows over ours; a key the peer lacks is deleted. Returns the keys that changed. */
function applySnapshot(db: DatabaseLike, keys: readonly string[], peer: Record<string, unknown>): string[] {
	const changed: string[] = [];
	for (const key of keys) {
		const value = key in peer ? JSON.stringify(peer[key]) : null;
		const row = db.query("SELECT data FROM settings WHERE key = ?").get(key) as { data: string } | undefined;
		const current = row?.data ?? null;
		if (current === value) continue;
		if (value === null) db.query("DELETE FROM settings WHERE key = ?").run(key);
		else db.query("INSERT INTO settings (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, value);
		changed.push(key);
	}
	return changed;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const dataDir = () => process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya");

/** One extension's stored settings, or undefined when there are none (or they are damaged). */
function readExtensionSettings(id: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(dataDir(), "extensions", id, "settings.json"), "utf8"));
		return plain(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Every extension's settings on this server, credentials left out, this extension's own skipped. */
function allExtensionSettings(withSecrets = false): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	const root = join(dataDir(), "extensions");
	if (!existsSync(root)) return out;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === SELF_ID || !EXTENSION_ID.test(entry.name)) continue;
		const value = readExtensionSettings(entry.name);
		if (value) out[entry.name] = Object.fromEntries(Object.entries(value).filter(([k]) => withSecrets || !CREDENTIAL_KEY.test(k)));
	}
	return out;
}

/** A file or folder name that may be copied: no hidden files, no path tricks. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

/** A text file, or null when there is none. */
function readText(file: string): string | null {
	try { return readFileSync(file, "utf8"); } catch { return null; }
}

/** The text files directly in a folder whose names match, by name. */
function readFiles(dir: string, match: RegExp): FileSet {
	const out: FileSet = {};
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (!e.isFile() || !SAFE_NAME.test(e.name) || !match.test(e.name)) continue;
		const text = readText(join(dir, e.name));
		if (text !== null && text.length <= FOLDER_LIMITS.file) out[e.name] = text;
	}
	return out;
}

/**
 * Every sub-folder of `root` as path -> text, within FOLDER_LIMITS. Symlinks are not followed and binary files are left
 * out: a skill is instructions and small scripts.
 */
function readFolders(root: string, only?: string): Record<string, FileSet> {
	const out: Record<string, FileSet> = {};
	if (!existsSync(root)) return out;
	for (const e of readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !SAFE_NAME.test(e.name) || (only !== undefined && e.name !== only)) continue;
		const files: FileSet = {};
		let count = 0;
		let bytes = 0;
		const walk = (dir: string) => {
			for (const f of readdirSync(dir, { withFileTypes: true })) {
				if (!SAFE_NAME.test(f.name) || f.name === "node_modules" || count >= FOLDER_LIMITS.files) continue;
				const path = join(dir, f.name);
				if (f.isDirectory()) { walk(path); continue; }
				if (!f.isFile()) continue;
				const text = readText(path);
				if (text === null || text.length > FOLDER_LIMITS.file || text.includes("\u0000") || bytes + text.length > FOLDER_LIMITS.bytes) continue;
				files[relative(join(root, e.name), path).split(sep).join("/")] = text;
				count++;
				bytes += text.length;
			}
		};
		walk(join(root, e.name));
		if (Object.keys(files).length) out[e.name] = files;
	}
	return out;
}

/** A relative path from a peer, checked part by part: it must stay inside the folder it is written to. */
const safePath = (path: string) => typeof path === "string" && path.length <= 300 && path.split("/").every((p) => SAFE_NAME.test(p));

/** Write a file only when its text differs. Returns whether it did. */
function writeIfChanged(file: string, text: string): boolean {
	if (readText(file) === text) return false;
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
	return true;
}

/**
 * Make each folder the primary has the same as there (files it lacks are removed from that folder). A folder only here
 * stays: a follower keeps what it added itself. A symlinked folder here is someone's own link and is left alone.
 */
function applyFolders(root: string, theirs: Record<string, FileSet>, label: string): string[] {
	const changed: string[] = [];
	for (const [name, files] of Object.entries(theirs)) {
		if (!SAFE_NAME.test(name) || !plain(files)) continue;
		const dir = join(root, name);
		try { if (lstatSync(dir).isSymbolicLink()) continue; } catch { /* not there yet */ }
		let touched = false;
		for (const [path, text] of Object.entries(files)) {
			if (!safePath(path) || typeof text !== "string" || text.length > FOLDER_LIMITS.file) continue;
			if (writeIfChanged(join(dir, ...path.split("/")), text)) touched = true;
		}
		const keep = new Set(Object.keys(files).filter(safePath));
		const prune = (sub: string) => {
			if (!existsSync(sub)) return;
			for (const f of readdirSync(sub, { withFileTypes: true })) {
				const path = join(sub, f.name);
				if (f.isDirectory()) { prune(path); if (!readdirSync(path).length) rmSync(path, { recursive: true, force: true }); continue; }
				if (f.isFile() && SAFE_NAME.test(f.name) && !keep.has(relative(dir, path).split(sep).join("/"))) { rmSync(path, { force: true }); touched = true; }
			}
		};
		prune(dir);
		if (touched) changed.push(`${label}:${name}`);
	}
	return changed;
}

/** The files directly in `dir` matching `match`, made the same as the primary's; a file only here stays. */
function applyFiles(dir: string, theirs: FileSet, match: RegExp, label: string): string[] {
	const changed: string[] = [];
	for (const [name, text] of Object.entries(theirs)) {
		if (!SAFE_NAME.test(name) || !match.test(name) || typeof text !== "string" || text.length > FOLDER_LIMITS.file) continue;
		if (writeIfChanged(join(dir, name), text)) changed.push(`${label}:${name.replace(match, "")}`);
	}
	return changed;
}

/** One file made the same as the primary's. A primary without it leaves this server's own in place. */
function applyText(file: string, text: string | null, label: string): string[] {
	if (typeof text !== "string" || text.length > FOLDER_LIMITS.file) return [];
	return writeIfChanged(file, text) ? [label] : [];
}

/** Same value whatever the key order. */
const sameObject = (a: Record<string, unknown> | undefined, b: Record<string, unknown>) =>
	!!a && JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

/** Order-independent hash so a no-op sync is cheap to detect. */
const hashOf = (settings: Record<string, unknown>) =>
	createHash("sha256").update(JSON.stringify(Object.keys(settings).sort().map((k) => [k, settings[k]]))).digest("hex");

export default (pi: any) => {
	let db: Database | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Extensions the primary has that could not be installed here (not in the marketplace, copying not allowed). */
	let unlisted: string[] = [];
	/** Pulled extensions that cannot run here until a secret is typed in on this server: name -> the settings they lack. */
	let needsInput: { id: string; title: string; fields: string[] }[] = [];
	/** When the pull timer fires next, for the page. */
	let nextPullAt = 0;
	let busy = false;
	let failures = 0;
	let lastSyncAt: number | null = null;
	let lastApplied: string[] = [];
	let lastError: string | null = null;

	const settings = (): Record<string, unknown> => (pi.settings.get() ?? {}) as Record<string, unknown>;
	const role = (): "primary" | "follower" => (settings().role === "follower" ? "follower" : "primary");

	/**
	 * The peer's address and the device token redeemed there, kept in this extension's own data folder and not in its
	 * settings: the app's form saves only the fields it shows, so a token kept in the settings was wiped by the next save
	 * (the status line or any checkbox) and the follower went back to redeeming a code already used.
	 */
	const peerFile = () => join(typeof pi.dataDir === "string" && pi.dataDir ? pi.dataDir : join(dataDir(), "extension-data", SELF_ID), "peer.json");
	type Peer = { url: string; token: string; code: string };
	const readPeer = (): Peer | null => {
		try {
			const v: unknown = JSON.parse(readFileSync(peerFile(), "utf8"));
			if (!plain(v) || typeof v.url !== "string" || typeof v.token !== "string" || !v.token) return null;
			return { url: v.url, token: v.token, code: typeof v.code === "string" ? v.code : "" };
		} catch {
			return null;
		}
	};
	const writePeer = (peer: Peer | null) => {
		const file = peerFile();
		if (!peer) return rmSync(file, { force: true });
		mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(tmp, JSON.stringify(peer), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	};
	/** Only a digest of the redeemed code is kept: enough to tell "the same link pasted again" from a new one. */
	const codeDigest = (code: string) => createHash("sha256").update(code).digest("hex");

	/** The address typed in the form wins; empty, the one the pasted link carried. */
	const peerUrl = (): string => String(settings().remoteUrl ?? "").trim().replace(/\/+$/, "") || readPeer()?.url || "";

	const cfg = (): { url: string; token: string; interval: number } => {
		const s = settings();
		const interval = Number(s.intervalSeconds ?? 60);
		const url = peerUrl();
		const peer = readPeer();
		// A token belongs to the server that issued it: after the address changes it is not sent anywhere else.
		const token = peer && peer.url === url ? peer.token : String(s.remoteToken ?? "").trim();
		return { url, token, interval: Math.max(15, Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 60) };
	};

	const keys = (): string[] => effectiveKeys(String(settings().keys ?? ""));
	/** A group is pulled unless the follower unchecked it (an older saved setting has no box at all: pull). */
	const picked = (field: string) => settings()[field] !== false;
	/** Of the keys the primary mirrors, the ones this follower picked. A key in no group (a listed extra) always comes along. */
	const pickedKeys = (list: readonly string[]): string[] =>
		list.filter((k) => !GROUPED.has(k) || GROUPS.some((g) => (g.keys as readonly string[]).includes(k) && picked(g.field)));
	/** Pull secrets too (a model API key, an extension's own token): its own box, off, and the primary must allow it. */
	const wantSecrets = () => settings().syncSecrets === true;
	/** Extension settings values travel with the extensions: one box, "확장". */
	const syncExtensions = () => settings().syncExtensions === true;

	/**
	 * The server's own db, opened lazily at the same path the server process uses. The path is re-read each time and the
	 * handle reopened when it changes, so two instances in one process (tests, or a server switching data dir) never
	 * share a connection to the wrong file.
	 */
	let dbPath = "";
	const dbo = (): Database => {
		const path = process.env.PIPAYA_DB ?? join(process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya"), "pipaya.db");
		if (db && dbPath === path) return db;
		try { db?.close(); } catch { /* already closed */ }
		db = new Database(path);
		db.exec("PRAGMA busy_timeout = 5000");
		dbPath = path;
		return db;
	};

	// `pi.log` already prefixes the extension name.
	const log = (msg: string) => pi.log(msg);

	/** "3분 전" / "3 min ago": the page shows this instead of a timestamp the reader has to decode. */
	const ago = (at: number): Text => {
		const s = Math.max(0, Math.round((Date.now() - at) / 1000));
		if (s < 10) return { ko: "방금", en: "just now" };
		if (s < 60) return { ko: `${s}초 전`, en: `${s} s ago` };
		const m = Math.round(s / 60);
		if (m < 60) return { ko: `${m}분 전`, en: `${m} min ago` };
		const h = Math.round(m / 60);
		if (h < 24) return { ko: `${h}시간 전`, en: `${h} h ago` };
		const d = Math.round(h / 24);
		return { ko: `${d}일 전`, en: `${d} day${d === 1 ? "" : "s"} ago` };
	};

	/** The one line the page shows, in Korean and English (the app shows the reader's): a dot for the state, then what happened last. */
	const statusText = (): Text => {
		if (role() === "primary") {
			const url = publicUrl();
			return url
				? {
					ko: `● 기준 서버 — 팔로워가 이 서버의 설정을 가져갑니다\n주소: ${url}\n연결 링크: 이 서버의 기기 탭 → 연결 링크 복사`,
					en: `● Primary — followers pull this server's settings\nAddress: ${url}\nConnection link: this server's Devices tab → Copy connection link`,
				}
				: { ko: "● 기준 서버 — 다른 서버가 이 서버의 설정을 가져갑니다", en: "● Primary — other servers pull this server's settings" };
		}
		const pasted = String(settings().shareCode ?? "").trim();
		if (!cfg().url && !pairingLink(pasted)) return { ko: "○ 기준 서버 주소를 입력하세요", en: "○ Enter the primary's address" };
		if (!cfg().token && !pasted) return { ko: "○ 기준 서버의 연결 코드를 붙여넣으세요", en: "○ Paste the primary's connection code" };
		// the reason is the peer's or the network's own words: shown as is in both
		if (lastError) return { ko: `✕ 연결 실패 — ${lastError}`, en: `✕ Cannot connect — ${lastError}` };
		if (lastSyncAt === null) return { ko: "○ 아직 연결하지 못했습니다", en: "○ Not connected yet" };
		const n = lastApplied.length;
		const when = ago(lastSyncAt);
		return n
			? { ko: `● 연결됨 — ${when.ko} 확인, ${n}개 항목 가져옴`, en: `● Connected — checked ${when.en}, pulled ${n} item${n === 1 ? "" : "s"}` }
			: { ko: `● 연결됨 — ${when.ko} 확인, 바뀐 것 없음`, en: `● Connected — checked ${when.en}, nothing changed` };
	};

	/**
	 * Keep the page in step (`pi.ui`, app 0.8.8+). An older app has no page: the state is still in the `status` method.
	 * A `statusText` field an older version kept in the settings is dropped once; status never lives in the settings.
	 */
	let writing = false;
	const hasPanel = typeof pi.ui?.setPanel === "function";
	const showStatus = () => {
		if (writing) return;
		if ("statusText" in settings()) {
			writing = true;
			try { const { statusText: _, ...rest } = settings(); pi.settings.set(rest); } finally { writing = false; }
		}
		if (!hasPanel) return;
		try { pi.ui.setPanel(panel()); } catch (e) { log(`panel: ${e instanceof Error ? e.message : String(e)}`); }
	};

	/** What each mirrored key is, for the "recently pulled" list. */
	const KEY_LABEL: Record<string, Text> = {
		default_model: { ko: "기본 모델", en: "Default model" }, system_model: { ko: "시스템 모델", en: "System model" },
		image_model: { ko: "이미지 모델", en: "Image model" }, default_workdir: { ko: "기본 작업 디렉터리", en: "Default working directory" },
		mcp_servers: { ko: "MCP 서버", en: "MCP servers" }, skills: { ko: "스킬", en: "Skills" },
		disabled_tools: { ko: "꺼 둔 도구", en: "Disabled tools" }, disabled_subagents: { ko: "꺼 둔 도우미", en: "Disabled helpers" },
		delegate_policy: { ko: "위임 정책", en: "Delegation policy" }, compaction: { ko: "대화 압축", en: "Compaction" },
		retention: { ko: "보관 기간", en: "Retention" },
	};
	const keyLabel = (k: string): Text => {
		const [kind, rest = ""] = k.includes(":") ? [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)] : ["", k];
		if (kind === "ext") return { ko: `확장 설정: ${rest}`, en: `Extension settings: ${rest}` };
		if (kind === "srv") return { ko: `확장 설치: ${rest}`, en: `Extension installed: ${rest}` };
		if (kind === "client") return { ko: "앱 확장 목록·켜기 상태", en: "App extension list and on/off" };
		if (kind === "skill") return { ko: `스킬 파일: ${rest}`, en: `Skill files: ${rest}` };
		if (kind === "helper") return { ko: `도우미 역할: ${rest}`, en: `Helper role: ${rest}` };

		if (kind === "key") return { ko: `모델 API 키: ${rest}`, en: `Model API key: ${rest}` };
		if (kind === "provider") return { ko: `모델 연결: ${rest}`, en: `Model provider: ${rest}` };
		if (kind === "agent-ext") return { ko: `내 확장(~/.agents/extensions): ${rest}`, en: `Own extension (~/.agents/extensions): ${rest}` };
		if (k === "agents-md") return { ko: "전역 AGENTS.md", en: "Global AGENTS.md" };
		return KEY_LABEL[k] ?? { ko: k, en: k };
	};
	/** "42초 후" / "in 42 s", rounded like `ago`. */
	const until = (at: number): Text => {
		const s = Math.max(0, Math.round((at - Date.now()) / 1000));
		if (s < 60) return { ko: `${s}초 후`, en: `in ${s} s` };
		const m = Math.round(s / 60);
		return { ko: `${m}분 후`, en: `in ${m} min` };
	};
	const hostOf = (url: string) => url.replace(/^https?:\/\//, "");
	/** What went wrong, in words, from the raw message (which is shown under it as is). */
	const errorTitle = (msg: string): Text =>
		/could not save the settings of/.test(msg) ? { ko: "기준 서버에서 받았지만 이 서버에 저장하지 못했습니다", en: "Pulled from the primary, but could not save it here" }
		: /refused the token|\b40[13]\b/.test(msg) ? { ko: "기준 서버가 접속을 거부했습니다. 새 연결 링크로 다시 연결하세요", en: "The primary refused this server. Connect again with a new link" }
		: /wrong, expired or already used|too many wrong codes/.test(msg) ? { ko: "연결 링크를 쓸 수 없습니다", en: "The connection link cannot be used" }
		: /unable to connect|econnrefused|fetch failed|timed? ?out|timeout|enotfound|network/i.test(msg) ? { ko: "기준 서버에 연결할 수 없습니다. 기준 서버가 켜져 있는지, 주소가 맞는지 확인하세요", en: "Cannot reach the primary. Check that it is running and the address is right" }
		: { ko: "마지막 시도가 실패했습니다", en: "The last attempt failed" };

	/** A manual pull from the page is running: its button shows that. */
	let pulling = false;

	/** The extension's page (`pi.ui`): the state, the numbers that matter and what can be done now. */
	const panel = () => {
		if (role() === "primary") {
			const url = publicUrl();
			return {
				type: "stack", id: "status", gap: "medium", children: [
					{ type: "badge", id: "state", tone: "info", text: { ko: "기준 서버", en: "Primary" } },
					{ type: "text", id: "what", text: { ko: "팔로워 서버가 이 서버의 설정을 가져갑니다.", en: "Follower servers pull this server's settings." } },
					...(url ? [{ type: "stat", id: "address", label: { ko: "이 서버 주소", en: "This server's address" }, value: hostOf(url) }] : []),
					{ type: "text", id: "how", size: "small", text: { ko: "팔로워를 연결하려면: 이 서버의 기기 탭 → [연결 링크 복사] → 팔로워의 연결 링크 칸에 붙여넣기", en: "To connect a follower: this server's Devices tab → [Copy connection link] → paste it into the follower's link field" } },
					{ type: "text", id: "pick", size: "small", text: { ko: "무엇을 가져갈지(앱 설정·확장·스킬 등)는 팔로워 서버의 이 화면에서 고릅니다.", en: "What to pull (app settings, extensions, skills, …) is picked on the follower's own page." } },
					settings().shareSecrets === true
						? { type: "alert", id: "secrets-on", tone: "warning", text: { ko: "비밀값 내보내기가 켜져 있습니다. 팔로워가 요청하면 이 서버의 모델 API 키와 확장 토큰을 건네줍니다. 내 서버가 아니면 끄세요.", en: "Sharing secrets is on. A follower that asks gets this server's model API keys and extension tokens. Turn it off unless the follower is yours." } }
						: { type: "text", id: "secrets-off", size: "small", text: { ko: "API 키·토큰은 나가지 않습니다(비밀값 내보내기 꺼짐).", en: "API keys and tokens do not leave (sharing secrets is off)." } },
				],
			};
		}
		const { url, token } = cfg();
		const pasted = String(settings().shareCode ?? "").trim();
		const waiting = !token && !!pasted && !lastError;
		const state: { tone: string; text: Text } = !url && !pairingLink(pasted) && !token
			? { tone: "neutral", text: { ko: "연결 안 됨", en: "Not connected" } }
			: lastError ? { tone: "danger", text: { ko: "연결 실패", en: "Failed" } }
			: waiting || (token && lastSyncAt === null) ? { tone: "neutral", text: { ko: "연결 중", en: "Connecting" } }
			: token ? { tone: "success", text: { ko: "연결됨", en: "Connected" } }
			: { tone: "neutral", text: { ko: "연결 안 됨", en: "Not connected" } };
		const next = timer && nextPullAt > Date.now() ? until(nextPullAt) : null;
		const children: unknown[] = [
			{ type: "stack", id: "head", direction: "horizontal", gap: "small", children: [
				{ type: "badge", id: "state", tone: state.tone, text: state.text },
				...(lastSyncAt !== null ? [{ type: "text", id: "checked", size: "small", tone: "neutral", text: lastError
					? { ko: `마지막 성공 ${ago(lastSyncAt).ko}`, en: `last succeeded ${ago(lastSyncAt).en}` }
					: { ko: `${ago(lastSyncAt).ko} 확인`, en: `checked ${ago(lastSyncAt).en}` } }] : []),
			] },
		];
		if (!token) {
			children.push({ type: "text", id: "how", text: { ko: "기준 서버의 기기 탭 → [연결 링크 복사]로 받은 링크를 아래 ‘연결 링크’에 붙여넣고 저장하세요.", en: "Paste the link from the primary's Devices tab → [Copy connection link] into ‘Connection link’ below, then save." } });
		} else {
			children.push({ type: "grid", id: "numbers", columns: 3, children: [
				{ type: "stat", id: "peer", label: { ko: "기준 서버", en: "Primary" }, value: hostOf(url) },
				{ type: "stat", id: "pulled", label: { ko: "지난번 가져온 항목", en: "Pulled last time" }, value: lastSyncAt === null ? "—" : lastApplied.length ? { ko: `${lastApplied.length}개`, en: String(lastApplied.length) } : { ko: "변경 없음", en: "No changes" } },
				{ type: "stat", id: "next", label: { ko: "다음 동기화", en: "Next sync" }, value: pulling || busy ? { ko: "지금", en: "now" } : next ?? { ko: "곧", en: "soon" } },
			] });
		}
		if (lastError) children.push({ type: "alert", id: "error", tone: "danger", title: errorTitle(lastError), text: lastError });
		if (token && needsInput.length && settings().syncExtensions === true) {
			// The alert carries the sentence; the list under it names each extension and what it lacks (an alert's text
			// is one paragraph, so a list inside it would run together).
			// What is true depends on the box: with 비밀값 on, the server-side secrets already came; what is left is a value an
			// app keeps only on the device (a `secret` field of an extension's settings), which never reaches any server.
			const asked = settings().syncSecrets === true;
			children.push({ type: "alert", id: "needs-input", tone: "warning",
				title: { ko: "이 서버(기기)에서 직접 입력해야 하는 값이 있습니다", en: "Some values must be entered here" },
				text: asked
					? { ko: "아래 값은 앱이 기기에만 저장해서 어느 서버에도 없습니다. 그래서 ‘API 키·토큰도 가져오기’로도 옮길 수 없습니다. 설정 → 확장에서 해당 확장을 열면, 이 기기의 다른 서버에 입력해 둔 값이 있을 때 [그 값 쓰기]로 한 번에 채울 수 있습니다(앱 0.9.2+). 주소 같은 나머지 값은 이미 맞춰져 있습니다.", en: "The values below are kept by the app on the device only, so no server has them and ‘Also pull API keys and tokens’ cannot move them. Open the extension under Settings → Extensions: when this device has a value for another server, [Use that value] fills it in (app 0.9.2+). Addresses and the other values are already matched." }
					: { ko: "비밀값(토큰·키)은 기본으로 기준 서버에서 가져오지 않습니다. 설정 → 확장에서 해당 확장을 열어 한 번만 입력하면 켜집니다. 주소 같은 나머지 값은 이미 맞춰져 있습니다. (서버에 저장된 키는 ‘API 키·토큰도 가져오기’로 가져올 수 있지만, 앱이 기기에만 저장하는 값은 가져올 수 없습니다.)", en: "Secrets (tokens, keys) are not pulled by default. Open the extension under Settings → Extensions and enter them once; then it turns on. Addresses and the other values are already matched. (‘Also pull API keys and tokens’ brings keys stored on a server, but not values an app keeps on the device only.)" } });
			children.push({ type: "list", id: "needs-input-list", items: needsInput.slice(0, 20).map((n, i) => ({
				id: `n${i}`, title: n.title,
				description: { ko: `입력할 값: ${n.fields.join(" · ")}`, en: `To enter: ${n.fields.join(" · ")}` },
			})) });
		}
		if (token && unlisted.length && settings().syncExtensions === true) children.push({ type: "alert", id: "unlisted", tone: "warning",
			title: { ko: "마켓플레이스에 없는 확장은 설치하지 않았습니다", en: "Extensions not in the marketplace were not installed" },
			text: { ko: `${unlisted.join(", ")} — 기준 서버에서 복사하려면 아래 ‘직접 만든 확장도 복사’를 켜세요.`, en: `${unlisted.join(", ")} — to copy them from the primary, turn on ‘Also copy extensions you made yourself’ below.` } });
		if (token && lastApplied.length) {
			children.push({ type: "text", id: "changed-title", size: "small", text: { ko: "지난번에 바뀐 항목", en: "Changed last time" } });
			children.push({ type: "list", id: "changed", items: lastApplied.slice(0, 20).map((k, i) => ({ id: `k${i}`, title: keyLabel(k) })) });
		}
		if (token) {
			children.push({ type: "stack", id: "actions", direction: "horizontal", gap: "small", children: [
				{ type: "button", id: "sync", variant: "primary", disabled: pulling || busy, label: pulling ? { ko: "동기화 중…", en: "Syncing…" } : { ko: "지금 동기화", en: "Sync now" } },
				{ type: "button", id: "disconnect", variant: "secondary", disabled: pulling, label: { ko: "연결 해제", en: "Disconnect" } },
			] });
		}
		return { type: "stack", id: "status", gap: "medium", children };
	};

	const status = (): Status => ({
		role: role(),
		url: cfg().url,
		intervalSeconds: cfg().interval,
		keys: role() === "follower" ? pickedKeys(keys()) : keys(),
		syncExtensions: role() === "follower" && syncExtensions(),
		lastSyncAt,
		lastApplied,
		lastError,
		status: statusText(),
	});

	// ---- what a peer reads: the rows this server mirrors and the keys they cover ----

	pi.registerMethod("snapshot", (params: unknown): Snapshot => {
		const list = keys();
		const snap: Snapshot = { keys: list, settings: readSettings(dbo(), list) };
		// Only when the follower asks: most never want them, and they are the bulkiest part.
		// Secrets of extensions (their own settings file) go only when this server's owner allows it AND the follower asked.
		if (plain(params) && params.extensions === true) snap.extensions = allExtensionSettings(settings().shareSecrets === true && params.secrets === true);
		const asked = plain(params) && Array.isArray(params.parts) ? params.parts.filter((p): p is Part => typeof p === "string" && p in PARTS) : [];
		// The code of extensions, for those the follower cannot get from the marketplace: only the ids it names.
		const codeOf = plain(params) && Array.isArray(params.codeOf) ? params.codeOf.filter((x): x is string => typeof x === "string" && EXTENSION_ID.test(x) && x !== SELF_ID).slice(0, 50) : [];
		if (asked.length) snap.environment = readEnvironment(asked);
		if (codeOf.length) {
			const env = (snap.environment ??= {});
			const list = env.serverExtensions ?? installedServerExtensions();
			env.serverExtensions = list.map((e) => (codeOf.includes(e.id) ? { ...e, files: extensionFiles(e.id) } : e));
		}
		return snap;
	});

	/** This server's environment parts, as a follower asked for them. */
	const readEnvironment = (parts: readonly Part[]): Environment => {
		const env: Environment = {};
		const home = typeof pi.home === "string" && pi.home ? pi.home : homedir();
		for (const part of parts) {
			try {
				if (part === "serverExtensions") env.serverExtensions = installedServerExtensions();
				else if (part === "clientExtensions") env.clientExtensions = clientExtensionRows();
				else if (part === "skills") env.skills = readFolders(join(home, ".agents", "skills"));
				else if (part === "subagents") env.subagents = readFiles(join(home, ".agents", "subagents"), /\.md$/);
				else if (part === "agentsMd") env.agentsMd = readText(join(home, ".agents", "AGENTS.md"));
				else if (part === "providers") env.providers = providerRows();
				else if (part === "apiKeys") env.apiKeys = apiKeyRows();
				else if (part === "agentExtensions") {
					const dir = join(home, ".agents", "extensions");
					env.agentExtensions = { files: readFiles(dir, /\.(ts|js|mjs)$/), folders: readFolders(dir) };
				}
			} catch (e) {
				log(`snapshot ${part}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return env;
	};

	/** Server extensions installed in the data folder (not `~/.agents/extensions`, which are the owner's own files), with their versions. */
	const installedServerExtensions = (): InstalledExtension[] => {
		const root = join(dataDir(), "extensions");
		if (!existsSync(root)) return [];
		const out: InstalledExtension[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === SELF_ID || !EXTENSION_ID.test(entry.name)) continue;
			try {
				const pkg = JSON.parse(readFileSync(join(root, entry.name, "package.json"), "utf8")) as { version?: unknown };
				if (typeof pkg.version === "string") out.push({ id: entry.name, version: pkg.version });
			} catch { /* a folder that only holds settings: not an installed extension */ }
		}
		return out;
	};

	/** An installed extension's code as text files, without its settings and without anything hidden or binary. */
	const extensionFiles = (id: string): FileSet => {
		const all = readFolders(join(dataDir(), "extensions"), id)[id] ?? {};
		return Object.fromEntries(Object.entries(all).filter(([path]) => !EXTENSION_RUNTIME.has(path)));
	};

	/** The extensions this server keeps for its apps (`client_settings`): the list and which are on. */
	const clientExtensionRows = () => {
		const row = (key: string) => {
			const r = dbo().query("SELECT data FROM client_settings WHERE key = ?").get(key) as { data: string } | undefined;
			try { return r ? JSON.parse(r.data) : null; } catch { return null; }
		};
		return { list: row("extensions"), states: row("extensionStates") };
	};

	/**
	 * Model API keys of this server (credentials of type api_key; a login (oauth) is tied to this server and never copied).
	 * Served only when the owner of THIS server allows it (`shareSecrets`): the follower asking is not enough, because
	 * a key leaves the machine. The link is the Tailscale address and a revocable device token, but it is still a key.
	 */
	const apiKeyRows = (): Record<string, string> => {
		if (settings().shareSecrets !== true) return {};
		const out: Record<string, string> = {};
		const rows = dbo().query("SELECT provider_id, data FROM credentials").all() as { provider_id: string; data: string }[];
		for (const r of rows) {
			try {
				const v: unknown = JSON.parse(r.data);
				// the voice-input key is this server's own microphone service: not a model provider, never copied
				if (plain(v) && v.type === "api_key" && typeof v.key === "string" && v.key && r.provider_id !== "voice_input") out[r.provider_id] = v.key;
			} catch { /* a damaged row is not ours to fix */ }
		}
		return out;
	};

	/** Custom model providers without anything secret: the key is in the credentials table, which is never read. */
	const providerRows = (): Record<string, Record<string, unknown>> => {
		const out: Record<string, Record<string, unknown>> = {};
		const rows = dbo().query("SELECT id, data FROM custom_providers").all() as { id: string; data: string }[];
		for (const r of rows) {
			try {
				const v: unknown = JSON.parse(r.data);
				if (plain(v)) out[r.id] = Object.fromEntries(Object.entries(v).filter(([k]) => !CREDENTIAL_KEY.test(k)));
			} catch { /* a damaged row is not ours to fix */ }
		}
		return out;
	};

	pi.registerMethod("status", () => status());

	/** This server's address as a peer should reach it: the Tailscale/LAN address of this box. */
	const publicUrl = (): string => {
		const port = process.env.PIPAYA_PORT ?? "8787";
		const host = firstAddress();
		return host ? `http://${host}:${port}` : "";
	};

	/**
	 * Where this server itself listens, for the calls it makes to its own routes. Not always loopback: the desktop app
	 * can bind its bundled server to one address only (e.g. the Tailscale one), and then 127.0.0.1 refuses the call.
	 */
	const ownUrl = (): string => {
		const port = process.env.PIPAYA_PORT ?? "8787";
		const bind = String(process.env.PIPAYA_HOST ?? "").trim();
		const host = !bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]" ? "127.0.0.1" : bind;
		return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
	};

	/** How the primary's Devices tab names this follower: the name it gave itself, else this machine and its address. */
	const followerLabel = (): string => {
		const given = String(settings().followerName ?? "").trim();
		if (given) return given.slice(0, 60);
		const ip = firstAddress();
		return `Server Sync · ${hostname()}${ip ? ` (${ip})` : ""}`.slice(0, 60);
	};

	/** The admin token of this server (`PIPAYA_TOKEN`, else the `token` file in the data dir). */
	const adminToken = (): string => {
		const fromEnv = process.env.PIPAYA_TOKEN;
		if (fromEnv) return fromEnv.trim();
		try {
			return readFileSync(join(dataDir(), "token"), "utf8").trim();
		} catch {
			return "";
		}
	};

	/**
	 * The address a follower should dial, and a one-time pairing code for it. The code is the app's own mechanism
	 * (`POST /pairing` -> `POST /pairing/redeem`): it is worth nothing after it expires, and redeeming it mints a
	 * revocable device token instead of handing out the admin token.
	 */
	pi.registerMethod("code", async () => {
		const url = publicUrl();
		if (!url) throw new Error("this server has no address to share");
		const res = await fetch(`${url}/pairing`, {
			method: "POST",
			headers: { authorization: `Bearer ${adminToken()}`, "content-type": "application/json" },
			body: "null",
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) throw new Error(`could not make a code (${res.status})`);
		const body = (await res.json()) as { code?: unknown };
		const code = typeof body.code === "string" ? body.code : "";
		if (!code) throw new Error("the server returned no code");
		return { url, code };
	});

	/**
	 * Redeem a peer's pairing code for a device token. That token is revocable on the primary (`DELETE /devices/tokens/:id`),
	 * unlike its admin token, so a follower never holds the keys to the primary.
	 */
	const redeemPeerCode = async (url: string, value: string): Promise<string> => {
		const res = await fetch(`${url}/pairing/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: value, name: followerLabel() }),
			signal: AbortSignal.timeout(5_000),
		});
		if (res.status === 403) throw new CodeRejected("the code is wrong, expired or already used; copy a new link on the primary");
		if (res.status === 429) throw new CodeRejected("too many wrong codes; wait a minute, then copy a new link on the primary", Date.now() + 60_000);
		if (!res.ok) throw new Error(`the peer refused the code (${res.status})`);
		const body = (await res.json()) as { token?: unknown };
		const token = typeof body.token === "string" ? body.token : "";
		if (!token) throw new Error("the peer returned no token");
		return token;
	};

	/**
	 * Connect to a peer with the address and the one-time code it shows: redeem the code for its token, then pull.
	 * A token typed in by hand is used as-is, so a peer too old for codes still works.
	 */
	pi.registerMethod("connect", async (params: unknown) => {
		const input = (params ?? {}) as { url?: unknown; token?: unknown; code?: unknown };
		const url = String(input.url ?? "").trim().replace(/\/+$/, "");
		if (!url) throw new Error("a peer address is required");
		if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error(`not an http(s) address: ${url}`);
		const typed = String(input.token ?? "").trim();
		const given = String(input.code ?? "").trim();
		const token = typed || (given ? await redeemPeerCode(url, given) : "");
		if (!token) throw new Error("a peer address and its code are required");
		writePeer({ url, token, code: given && !typed ? codeDigest(given) : "" });
		pi.settings.set({ ...withoutToken(settings()), role: "follower", remoteUrl: url });
		const applied = await pull();
		return { applied, ...status() };
	});

	/**
	 * Pull the primary's snapshot and mirror it. Returns the keys changed (empty when already equal).
	 * The primary decides which keys are mirrored: its list is what both sides use, so a row missing on the peer
	 * really means "deleted there" and not "this side happens to mirror one more key".
	 */
	const syncNow = async (): Promise<string[]> => {
		const { url, token } = cfg();
		if (!url || !token) throw new Error("set the peer server URL and its admin token first");
		const withExtensions = syncExtensions();
		// Copying unlisted code is a sub-option of installing server extensions: it means nothing without it.
		const parts = (Object.keys(PARTS) as Part[]).filter((p) => settings()[PARTS[p]] === true && (p !== "agentExtensions" || settings().syncExtensions === true) && (p !== "apiKeys" || settings().syncSecrets === true));
		const res = await fetch(`${url}/server-extensions/server-sync/methods/snapshot`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: withExtensions || parts.length ? JSON.stringify({ ...(withExtensions ? { extensions: true, ...(wantSecrets() ? { secrets: true } : {}) } : {}), ...(parts.length ? { parts } : {}) }) : "null",
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 401 || res.status === 403) throw new Error(`the peer refused the token (${res.status})`);
		if (!res.ok) throw new Error(`the peer answered ${res.status}`);
		const body = (await res.json()) as { result?: { keys?: unknown; settings?: unknown; extensions?: unknown; environment?: unknown } };
		const peer = body.result?.settings;
		if (!peer || typeof peer !== "object" || Array.isArray(peer)) throw new Error("the peer returned no settings");
		const list = pickedKeys(mirrorKeys(body.result?.keys, keys()));
		const mine = readSettings(dbo(), list);
		const theirs = Object.fromEntries(list.filter((k) => k in peer).map((k) => [k, (peer as Record<string, unknown>)[k]]));
		const changed = hashOf(theirs) === hashOf(mine) ? [] : applySnapshot(dbo(), list, peer as Record<string, unknown>);
		// Server extensions first: a pulled extension's settings need the extension installed to mean anything.
		// A primary older than 0.10.0 sends no environment: nothing to do, not an error.
		const env = plain(body.result?.environment) ? (body.result.environment as Environment) : {};
		if (parts.includes("serverExtensions") && Array.isArray(env.serverExtensions)) {
			const fetchCode = async (ids: string[]): Promise<InstalledExtension[]> => {
				const r = await fetch(`${url}/server-extensions/server-sync/methods/snapshot`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({ codeOf: ids }),
					signal: AbortSignal.timeout(30_000),
				});
				if (!r.ok) throw new Error(`the peer answered ${r.status} when asked for extension code`);
				const b = (await r.json()) as { result?: { environment?: { serverExtensions?: unknown } } };
				return Array.isArray(b.result?.environment?.serverExtensions) ? (b.result.environment.serverExtensions as InstalledExtension[]) : [];
			};
			changed.push(...(await applyServerExtensions(env.serverExtensions, fetchCode)));
		}
		// A primary older than 0.8.0 sends no extensions: nothing to do, not an error.
		if (withExtensions && plain(body.result?.extensions)) changed.push(...(await applyExtensions(body.result.extensions)));
		const home = typeof pi.home === "string" && pi.home ? pi.home : homedir();
		if (parts.includes("clientExtensions") && plain(env.clientExtensions)) changed.push(...(await applyClientExtensions(env.clientExtensions)));
		if (parts.includes("skills") && plain(env.skills)) changed.push(...applyFolders(join(home, ".agents", "skills"), env.skills as Record<string, FileSet>, "skill"));
		if (parts.includes("subagents") && plain(env.subagents)) changed.push(...applyFiles(join(home, ".agents", "subagents"), env.subagents as FileSet, /\.md$/, "helper"));
		if (parts.includes("agentsMd") && "agentsMd" in env) changed.push(...applyText(join(home, ".agents", "AGENTS.md"), env.agentsMd ?? null, "agents-md"));
		if (parts.includes("providers") && plain(env.providers)) changed.push(...(await applyProviders(env.providers as Record<string, Record<string, unknown>>)));
		if (parts.includes("apiKeys") && plain(env.apiKeys)) changed.push(...(await applyApiKeys(env.apiKeys as Record<string, string>)));
		if (parts.includes("agentExtensions") && plain(env.agentExtensions)) {
			const dir = join(home, ".agents", "extensions");
			const a = env.agentExtensions as { files?: unknown; folders?: unknown };
			const copied = [
				...(plain(a.files) ? applyFiles(dir, a.files as FileSet, /\.(ts|js|mjs)$/, "agent-ext") : []),
				...(plain(a.folders) ? applyFolders(dir, a.folders as Record<string, FileSet>, "agent-ext") : []),
			];
			if (copied.length) {
				const res = await own("POST", "/server-extensions/reload", {});
				if (!res.ok) throw new Error(`copied ~/.agents/extensions from the primary, but this server could not reload them (${res.status})`);
			}
			changed.push(...copied);
		}
		return changed;
	};

	/** This server's own route, as the admin: what every apply below goes through so the app hears about it. */
	const own = async (method: string, path: string, body?: unknown): Promise<Response> => {
		try {
			return await fetch(`${ownUrl()}${path}`, {
				method,
				headers: { authorization: `Bearer ${adminToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(60_000),
			});
		} catch (e) {
			throw new Error(`pulled from the primary, but could not reach this server (${ownUrl()}): ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	/**
	 * Install what the primary has and this server lacks (or has at another version), from the marketplace's pinned git
	 * source, through this server's own install route. Never removes one: an extension only here stays.
	 */
	const applyServerExtensions = async (theirs: InstalledExtension[], fetchCode: (ids: string[]) => Promise<InstalledExtension[]>): Promise<string[]> => {
		const mineList = installedServerExtensions();
		const mine = new Map(mineList.map((e) => [e.id, e.version]));
		const wanted = theirs.filter((e) => plain(e) && typeof e.id === "string" && EXTENSION_ID.test(e.id) && e.id !== SELF_ID && typeof e.version === "string" && mine.get(e.id) !== e.version);
		if (!wanted.length) { unlisted = []; return []; }
		let catalog: Record<string, any>[] = [];
		try { catalog = await fetchCatalog(); } catch (e) { log(`marketplace: ${e instanceof Error ? e.message : String(e)}`); }
		const changed: string[] = [];
		const missing: InstalledExtension[] = [];
		for (const e of wanted) {
			const entry = catalog.find((c) => c.id === e.id && c.kind === "server" && c.version === e.version && plain(c.source) && c.source.type === "git");
			if (!entry) { missing.push(e); continue; }
			const { repo, dir, ref, commit, host } = entry.source as Record<string, string>;
			const res = await own("POST", "/server-extensions/install", { id: e.id, repo, ref, commit, ...(dir ? { dir } : {}), ...(host ? { host } : {}) });
			if (!res.ok) throw new Error(`pulled from the primary, but could not install ${e.id} ${e.version} on this server (${res.status}: ${(await res.text()).slice(0, 200)})`);
			changed.push(`srv:${e.id}`);
		}
		// Not in the marketplace at that version (a hand-made or newer local build): its code comes from the primary, but
		// only with its own box checked, since it is code nobody reviewed that runs inside this server.
		if (missing.length && settings().syncLocalExtensions === true) {
			const withCode = await fetchCode(missing.map((e) => e.id));
			let copied = false;
			for (const e of withCode) {
				if (!plain(e) || !missing.some((m) => m.id === e.id) || !plain(e.files) || !Object.keys(e.files).length) continue;
				if (copyExtension(e.id, e.files as FileSet)) { changed.push(`srv:${e.id}`); copied = true; }
			}
			// The server loads extensions from disk on reload: the copied code starts now.
			if (copied) {
				const res = await own("POST", "/server-extensions/reload", {});
				if (!res.ok) throw new Error(`copied extensions from the primary, but this server could not reload them (${res.status})`);
			}
			unlisted = [];
		} else {
			unlisted = missing.map((e) => `${e.id} ${e.version}`);
			if (unlisted.length) log(`not in the marketplace: ${unlisted.join(", ")} (turn on 직접 만든 확장도 복사 to copy them)`);
		}
		return changed;
	};

	/**
	 * Replace this server's copy of one extension with the primary's files, keeping its settings. Written next to it and
	 * swapped in, so a half-written copy is never loaded. Returns whether anything changed.
	 */
	const copyExtension = (id: string, files: FileSet): boolean => {
		const root = join(dataDir(), "extensions");
		const to = join(root, id);
		const current = existsSync(to) ? extensionFiles(id) : {};
		const incoming = Object.fromEntries(Object.entries(files).filter(([path, text]) => safePath(path) && !EXTENSION_RUNTIME.has(path) && typeof text === "string" && text.length <= FOLDER_LIMITS.file));
		if (!Object.keys(incoming).some((p) => p === "package.json")) return false;
		if (JSON.stringify(Object.keys(current).sort().map((k) => [k, current[k]])) === JSON.stringify(Object.keys(incoming).sort().map((k) => [k, incoming[k]]))) return false;
		try { if (lstatSync(to).isSymbolicLink()) return false; } catch { /* not there yet */ }
		const staging = `${to}.syncing`;
		rmSync(staging, { recursive: true, force: true });
		for (const [path, text] of Object.entries(incoming)) writeIfChanged(join(staging, ...path.split("/")), text);
		for (const keep of EXTENSION_RUNTIME) if (existsSync(join(to, keep))) writeFileSync(join(staging, keep), readFileSync(join(to, keep)));
		rmSync(to, { recursive: true, force: true });
		renameSync(staging, to);
		return true;
	};
	let catalogCache: { at: number; list: Record<string, any>[] } | null = null;
	const fetchCatalog = async (): Promise<Record<string, any>[]> => {
		if (catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.list;
		const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`could not read the marketplace (${res.status})`);
		const body = (await res.json()) as { extensions?: unknown };
		const list = Array.isArray(body.extensions) ? body.extensions.filter(plain) : [];
		catalogCache = { at: Date.now(), list };
		return list;
	};

	/**
	 * Which of the apps' extensions are on in the pulled states but lack a required secret here. A secret (a token, a
	 * key) never leaves the primary, so after a pull the follower has the extension and its address but not the key:
	 * the apps then keep it off with "required". Saying so here tells the person what to type and where.
	 */
	const findNeedsInput = (list: unknown, states: unknown): { id: string; title: string; fields: string[] }[] => {
		if (!Array.isArray(list)) return [];
		const on = plain(states) ? states : {};
		const out: { id: string; title: string; fields: string[] }[] = [];
		for (const item of list) {
			const m = plain(item) && plain(item.manifest) ? item.manifest : null;
			if (!m || typeof m.id !== "string" || !Array.isArray(m.settings) || on[m.id] !== true) continue;
			const have = readExtensionSettings(m.id) ?? {};
			const lacking = (m.settings as unknown[]).filter(plain)
				.filter((f) => f.required === true && f.readonly !== true && typeof f.key === "string" && (f.secret === true || CREDENTIAL_KEY.test(f.key)))
				.filter((f) => { const v = have[f.key as string]; return v === undefined || v === null || v === ""; })
				.map((f) => (typeof f.label === "string" && f.label ? f.label : String(f.key)));
			if (lacking.length) out.push({ id: m.id, title: typeof m.name === "string" && m.name ? m.name : m.id, fields: lacking });
		}
		return out;
	};

	/** The apps' extension list and on/off states, through `/client-settings` so open apps reload them. */
	const applyClientExtensions = async (theirs: { list?: unknown; states?: unknown }): Promise<string[]> => {
		const current = clientExtensionRows();
		const changed: string[] = [];
		needsInput = findNeedsInput(theirs.list ?? current.list, theirs.states ?? current.states);
		for (const [key, value] of [["extensions", theirs.list], ["extensionStates", theirs.states]] as const) {
			if (value === null || value === undefined) continue;
			if (JSON.stringify(current[key === "extensions" ? "list" : "states"]) === JSON.stringify(value)) continue;
			const res = await own("PUT", `/client-settings/${key}`, { value });
			if (!res.ok) throw new Error(`pulled from the primary, but could not save ${key} on this server (${res.status})`);
			changed.push(`client:${key}`);
		}
		return changed;
	};

	/**
	 * Custom providers, through the configuration route (which checks them and loads them at once). The key stays this
	 * server's own: set it once in Settings → Models on each server. A provider only here stays.
	 */
	/** A key is set only where this server has none: a key typed here is never replaced by the primary's. */
	const applyApiKeys = async (theirs: Record<string, string>): Promise<string[]> => {
		const have = new Set((dbo().query("SELECT provider_id FROM credentials").all() as { provider_id: string }[]).map((r) => r.provider_id));
		const changed: string[] = [];
		for (const [id, key] of Object.entries(theirs)) {
			if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || typeof key !== "string" || !key || have.has(id) || id === "voice_input") continue;
			const res = await own("PUT", `/providers/${id}/credential`, { key });
			// 404: the provider is not on this server (its connection was not pulled): nothing to attach the key to
			if (res.status === 404) continue;
			if (!res.ok) throw new Error(`pulled from the primary, but could not save the key of ${id} on this server (${res.status})`);
			changed.push(`key:${id}`);
		}
		return changed;
	};

	const applyProviders = async (theirs: Record<string, Record<string, unknown>>): Promise<string[]> => {
		const mine = providerRows();
		const changed: string[] = [];
		for (const [id, value] of Object.entries(theirs)) {
			if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !plain(value)) continue;
			const { id: _, ...body } = value;
			const { id: __, ...current } = mine[id] ?? {};
			if (mine[id] && JSON.stringify(Object.keys(current).sort().map((k) => [k, current[k]])) === JSON.stringify(Object.keys(body).sort().map((k) => [k, body[k]]))) continue;
			const res = await own("PUT", `/configuration/providers/${id}`, body);
			if (!res.ok) throw new Error(`pulled from the primary, but could not save the provider ${id} on this server (${res.status}: ${(await res.text()).slice(0, 200)})`);
			changed.push(`provider:${id}`);
		}
		return changed;
	};

	/**
	 * Write the primary's extension settings here, through this server's own route so running extensions and open apps
	 * hear about it. Credentials stay this server's own; an extension the primary lacks is left alone, never deleted.
	 */
	const applyExtensions = async (peer: Record<string, unknown>): Promise<string[]> => {
		const changed: string[] = [];
		for (const [id, value] of Object.entries(peer)) {
			if (id === SELF_ID || !EXTENSION_ID.test(id) || !plain(value)) continue;
			const current = readExtensionSettings(id);
			// This server's own secrets win: a value typed here is never replaced. A key it lacks comes from the primary
			// only when 비밀값 is on (the primary then sent them).
			const own = Object.fromEntries(Object.entries(current ?? {}).filter(([k, v]) => CREDENTIAL_KEY.test(k) && v !== "" && v !== null && v !== undefined));
			const theirs = Object.fromEntries(Object.entries(value).filter(([k]) => wantSecrets() || !CREDENTIAL_KEY.test(k)));
			const next = { ...theirs, ...own };
			if (sameObject(current, next)) continue;
			let res: Response;
			try {
				res = await fetch(`${ownUrl()}/extensions/${id}/settings`, {
				method: "PUT",
				headers: { authorization: `Bearer ${adminToken()}`, "content-type": "application/json" },
				body: JSON.stringify({ settings: next }),
				signal: AbortSignal.timeout(5_000),
				});
			} catch (e) {
				// Not the primary's fault: say it is this server, so the page does not read "cannot connect" to the peer.
				throw new Error(`pulled from the primary, but could not save the settings of ${id} on this server (${ownUrl()}): ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!res.ok) throw new Error(`pulled from the primary, but could not save the settings of ${id} on this server (${res.status})`);
			changed.push(`ext:${id}`);
		}
		return changed;
	};

	/** One pull, with the status and the client event updated either way. Shared by the timer and the method. */
	const pull = async (): Promise<string[]> => {
		try {
			const changed = await syncNow();
			failures = 0;
			lastError = null;
			lastSyncAt = Date.now();
			lastApplied = changed;
			if (changed.length) {
				log(`applied: ${changed.join(", ")}`);
				pi.emit(null, "synced", { keys: changed, at: lastSyncAt }, { ephemeral: true });
			}
			return changed;
		} catch (e) {
			failures++;
			lastError = e instanceof Error ? e.message : String(e);
			log(`sync failed: ${lastError}`);
			throw e;
		} finally {
			showStatus();
		}
	};

	pi.registerMethod("sync", async () => {
		if (role() !== "follower") throw new Error("this server is the primary; set the role to follower to pull");
		const applied = await pull();
		return { applied, ...status() };
	});

	// Poll the primary. A miss is logged and retried later (backing off up to MAX_BACKOFF intervals); the loop never throws.
	/**
	 * What the timer was set up for. Every settings write calls back here (the status line rewrites itself every 30 s),
	 * and restarting the timer on each one pushed the next pull back for good: a follower pulled once and then never.
	 * Only a change that matters (role, address, token, interval) restarts it.
	 */
	let armedFor = "";
	const arm = (force = false) => {
		const { url, token, interval } = cfg();
		const key = JSON.stringify([role(), url, token, interval]);
		if (!force && key === armedFor && (timer || busy)) return;
		armedFor = key;
		if (timer) clearTimeout(timer);
		timer = undefined;
		failures = 0;
		if (role() !== "follower" || !url || !token) return;
		const tick = () => {
			timer = undefined;
			if (busy) return schedule();
			busy = true;
			pull()
				.catch(() => { /* already logged and recorded in the status */ })
				.finally(() => { busy = false; schedule(); showStatus(); });
		};
		const schedule = () => {
			if (timer) return;
			// Right after a (re)start nothing has been checked yet: do it within seconds, not one interval later.
			const wait = lastSyncAt === null && failures === 0 ? 3 : Math.min(interval * 2 ** Math.min(failures, 4), interval * MAX_BACKOFF);
			timer = setTimeout(tick, wait * 1000);
			nextPullAt = Date.now() + wait * 1000;
			// A pending pull must not keep the process alive on shutdown.
			(timer as unknown as { unref?: () => void }).unref?.();
		};
		schedule();
	};

	/**
	 * A follower with an address and the primary's code needs nothing else: redeem the code for a device token and save
	 * it. The code is cleared once used, so it never lingers in the settings file.
	 */
	let fetching = false;
	/**
	 * The code the peer last turned down, and when it may be tried again. Every settings write (the status line included)
	 * calls back here, so without this one dead code was sent again and again until the peer throttled this server.
	 */
	let rejected: { key: string; until: number } | null = null;
	const fillPeerToken = async () => {
		if (fetching || role() !== "follower") return;
		const s = settings();
		const raw = String(s.shareCode ?? "").trim();
		// The app's "연결 링크 복사" / "링크 복사" link carries the address and the code together: either is enough to paste.
		const link = pairingLink(raw);
		const url = String(s.remoteUrl ?? "").trim().replace(/\/+$/, "") || link?.url || "";
		const pasted = link?.code ?? raw;
		if (!url || !pasted) return;
		// The link already redeemed, sent back by a form that still shows it: connected already, nothing to redeem.
		const peer = readPeer();
		if (peer && peer.url === url && peer.code === codeDigest(pasted)) {
			if (raw) pi.settings.set({ ...settings(), shareCode: "" });
			return;
		}
		const key = `${url} ${pasted}`;
		if (rejected?.key === key && Date.now() < rejected.until) return;
		fetching = true;
		try {
			const token = await redeemPeerCode(url, pasted);
			rejected = null;
			lastError = null;
			writePeer({ url, token, code: codeDigest(pasted) });
			pi.settings.set({ ...withoutToken(settings()), remoteUrl: url, shareCode: "" });
			arm();
			log(`redeemed the peer's code at ${url}`);
			// Pull now: the page should say "connected" right after the save, not one interval later.
			if (!busy) {
				busy = true;
				void pull().catch(() => { /* recorded in the status */ }).finally(() => { busy = false; showStatus(); });
			}
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			if (e instanceof CodeRejected) rejected = { key, until: e.retryAt };
			log(lastError);
		} finally {
			fetching = false;
			// Say so on the page now, not at the next 30 s tick.
			showStatus();
		}
	};

	const refresh = () => {
		void fillPeerToken();
		showStatus();
		arm();
	};

	/**
	 * Boxes of older versions become the four of today: 0.8–0.12 had up to fifteen. A box that was on stays on; a
	 * group that was off (and not covered by another) is off. Old keys are removed so nothing flips back later.
	 */
	const OLD_BOXES = ["syncModels", "syncWorkdir", "syncMcp", "syncSkills", "syncTools", "syncHistory", "syncInstalled", "syncServerExtensions", "syncClientExtensions", "syncSkillFiles", "syncSubagentFiles", "syncAgentsMd"] as const;
	const mergeOldBoxes = () => {
		const s = settings();
		if (!OLD_BOXES.some((k) => k in s)) return;
		const on = (k: string) => s[k] === true;
		const next: Record<string, unknown> = Object.fromEntries(Object.entries(s).filter(([k]) => !(OLD_BOXES as readonly string[]).includes(k)));
		// 앱 설정: the six groups. Off only when every one that was ever saved is off (a fresh setting has none: on).
		const app = ["syncModels", "syncWorkdir", "syncMcp", "syncSkills", "syncTools", "syncHistory"].filter((k) => k in s);
		if (!("syncApp" in s)) next.syncApp = app.length ? app.some((k) => s[k] !== false) : true;
		// 확장: installed extensions, their settings values (the old 확장 설정 값 was the box named syncExtensions) or the old two boxes.
		if (!("syncExtensions" in s) || OLD_BOXES.some((k) => ["syncInstalled", "syncServerExtensions", "syncClientExtensions"].includes(k) && k in s)) {
			next.syncExtensions = on("syncExtensions") || on("syncInstalled") || on("syncServerExtensions") || on("syncClientExtensions");
		}
		if (!("syncAgent" in s)) next.syncAgent = on("syncSkillFiles") || on("syncSubagentFiles") || on("syncAgentsMd");
		pi.settings.set(next);
	};

	/** 0.8.4 and older kept the token in the settings: move it to the peer file once, then drop it from there. */
	const moveOldToken = () => {
		const s = settings();
		const token = String(s.remoteToken ?? "").trim();
		const url = String(s.remoteUrl ?? "").trim().replace(/\/+$/, "");
		// A peer file left from another address must not swallow it: the address in the settings is the one in use.
		if (token && url && readPeer()?.url !== url) writePeer({ url, token, code: "" });
		if ("remoteToken" in s) pi.settings.set(withoutToken(s));
	};

	// 0.3.0 stored a packed {u,t} blob here; it is not a pairing code, so drop it instead of failing on it.
	const dropStaleCode = () => {
		const s = settings();
		const pasted = String(s.shareCode ?? "").trim();
		if (!pasted) return;
		try {
			const parsed = JSON.parse(Buffer.from(pasted, "base64url").toString("utf8"));
			if (parsed && typeof parsed === "object" && "u" in parsed) pi.settings.set({ ...s, shareCode: "" });
		} catch { /* a pairing code is not base64 JSON: keep it */ }
	};

	/** What the page's buttons do. */
	if (hasPanel && typeof pi.ui.onEvent === "function") {
		pi.ui.onEvent(async (e: { type: string; id: string }) => {
			if (e.type !== "action") return;
			if (e.id === "sync") {
				if (pulling || busy || role() !== "follower") return;
				pulling = busy = true;
				showStatus();
				// The timer keeps running (and keeps its back-off): a manual pull does not reset it.
				try { await pull(); } catch { /* shown on the page */ } finally { pulling = busy = false; arm(); showStatus(); }
			} else if (e.id === "disconnect") {
				// Forget the token and the address; the primary can revoke the token in its Devices tab.
				writePeer(null);
				lastSyncAt = null;
				lastApplied = [];
				lastError = null;
				pi.settings.set({ ...withoutToken(settings()), remoteUrl: "", shareCode: "" });
				arm(true);
				showStatus();
			}
		});
	}

	mergeOldBoxes();
	moveOldToken();
	dropStaleCode();
	void fillPeerToken();
	showStatus();
	arm();
	// "3분 전" and "42초 후" go stale between pulls.
	const tick = setInterval(showStatus, 30_000);
	(tick as unknown as { unref?: () => void }).unref?.();
	setTimeout(showStatus, 1500);
	pi.on("extension_unload", () => clearInterval(tick));
	pi.settings.onChange(refresh);
	pi.on("extension_unload", () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		try { db?.close(); } catch { /* already closed */ }
		db = undefined;
	});
};

const withoutToken = (s: Record<string, unknown>): Record<string, unknown> => {
	const { remoteToken: _, ...rest } = s;
	return rest;
};

/** The peer turned the code down: trying the same code again cannot work (until `retryAt`, when it was only throttled). */
class CodeRejected extends Error {
	constructor(message: string, readonly retryAt = Number.POSITIVE_INFINITY) {
		super(message);
	}
}

/** `pipaya://connect?u=<address>&c=<code>` (the app's "링크 복사"), split into the address and the code; null for anything else. */
export function pairingLink(input: string): { url: string; code: string } | null {
	if (!input.startsWith("pipaya://")) return null;
	try {
		const link = new URL(input);
		if (link.hostname !== "connect") return null;
		const u = (link.searchParams.get("u") ?? "").trim().replace(/\/+$/, "");
		const code = (link.searchParams.get("c") ?? "").trim();
		const url = /^https?:\/\//i.test(u) ? u : u ? `http://${u}` : "";
		return url && code ? { url, code } : null;
	} catch {
		return null;
	}
}

/**
 * The first non-loopback IPv4 address of this machine: what a peer on the same tailnet or LAN should dial. Read from
 * the network interfaces rather than a hard-coded guess, so the address the form offers is the one that works.
 */
function firstAddress(): string {
	try {
		const all = networkInterfaces();
		const candidates: string[] = [];
		for (const list of Object.values(all)) {
			for (const net of list ?? []) {
				if (net.internal || net.family !== "IPv4") continue;
				candidates.push(net.address);
			}
		}
		// Tailscale (100.64.0.0/10) first: it is reachable from the user's other devices wherever they are.
		const tailscale = candidates.find((ip) => ip.startsWith("100."));
		return tailscale ?? candidates[0] ?? "";
	} catch {
		return "";
	}
}
