// server-sync: mirrors the pipaya `settings` table of a primary server onto this one.
//
// Roles (chosen in the settings form):
//   - "primary": serves its settings to the peer (`snapshot`) and takes the follower's own edits (`push`).
//   - "follower": polls the primary. What changed on one side goes to the other; when both changed the same item
//     since the last sync, the primary wins. Installs, the apps' extension list and API keys only come down.
//
// One file on purpose. A server from before 0.8.4 busts the module cache for the entry file alone, so a folder
// extension (`index.ts` + `store.ts`) kept running its old helper after a reload and failed with "Export named X not
// found". Everything lives here so an update is a single file that always reloads.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** How often a failing pull is retried at most (the base interval is multiplied by 2 per miss, up to this). */
const MAX_BACKOFF = 8;
/** How long a connection code stays valid (same as the app's pairing code). */
const CODE_TTL_MS = 120_000;
/** How many automatic pre-change backups to keep per server. */
const MAX_BACKUPS = 20;
const SAFE_BACKUP_ID = /^[0-9]+-[a-f0-9]+$/;

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
	{ field: "syncApp", keys: ["default_model", "system_model", "image_model", "default_workdir", "skills", "disabled_tools", "disabled_subagents", "delegate_policy", "compaction", "retention"] },
	// MCP servers often run a program installed on one PC only: a sub-box of 앱 설정 (on by default, off on its own).
	{ field: "syncMcpServers", keys: ["mcp_servers"], within: "syncApp" },
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
	/** MCP server names hidden by the primary's own syncignore (so a follower never mistakes them for deleted). */
	ignoredMcp?: string[];
	/** Extension id -> its settings without credentials; only when the follower asked for them. */
	extensions?: Record<string, Record<string, unknown>>;
	/** The rest of the environment, each part only when the follower asked for it (0.10.0+). */
	environment?: Environment;
	/** 1 when this primary takes a follower's own changes (`push`, 0.14.0+); 2 adds per-server `mcp` push (0.19.0+). */
	push?: number;
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
	/** Path to this server's `.gitignore`-style `syncignore` file. */
	rulesFile?: string;
	/** Unix ms of the last successful pull (follower only). */
	lastSyncAt: number | null;
	/** Keys the last successful pull changed. */
	lastApplied: string[];
	/** Why the last pull failed, if it did. */
	lastError: string | null;
	/** The status line of the page, in Korean and English. */
	status: Text;
	/** Followers that pulled from this server, newest first (primary only). */
	followers?: { name: string; url: string; lastSyncAt: number }[];
}

/** What a follower says about itself when it pulls, so the primary's page can list it. */
export type FollowerInfo = { id: string; name: string; url: string; interval: number };
/** A follower as the primary keeps it: what it said on its last pull, and when. */
export type FollowerRecord = FollowerInfo & { firstAt: number; lastAt: number };
const FOLLOWER_ID = /^[a-f0-9]{16,64}$/;
/** At most this many followers are kept; the one silent longest goes first. */
const MAX_FOLLOWERS = 20;
/** A follower silent this long is forgotten (disconnected, revoked or gone for good). */
const FORGET_FOLLOWER_MS = 30 * 86_400_000;

/**
 * A follower's `from` field, cleaned: null when there is none (a follower older than 0.17.0) or it is not usable. Any
 * paired device may call `snapshot`, so the name and address are only text to show: short, single-line, http(s) only.
 */
export function followerFrom(v: unknown): FollowerInfo | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.id !== "string" || !FOLLOWER_ID.test(o.id)) return null;
	const url = typeof o.url === "string" && /^https?:\/\/[^\s/?#]{1,120}$/.test(o.url) ? o.url : "";
	const name = (typeof o.name === "string" ? o.name : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)
		|| url.replace(/^https?:\/\//, "") || "Server Sync";
	const n = Number(o.interval);
	const interval = Number.isFinite(n) && n >= 15 && n <= 86_400 ? Math.floor(n) : 60;
	return { id: o.id, name, url, interval };
}

/** Whether a follower has missed its pulls: three intervals (at least three minutes) without one. */
export const followerSilent = (f: Pick<FollowerRecord, "interval" | "lastAt">, now = Date.now()): boolean =>
	now - f.lastAt > Math.max(f.interval * 3, 180) * 1000;

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

/** One row as the server stored it (the raw JSON text), or null when there is none. */
const rawRow = (db: DatabaseLike, key: string): string | null => (db.query("SELECT data FROM settings WHERE key = ?").get(key) as { data: string } | undefined)?.data ?? null;

/**
 * Writes the peer's rows over ours straight into the table; a key the peer lacks is deleted. Returns the keys that
 * changed. Only for a row the app has no route for (`skills`, a key added in `keys`), or a server without `pi.api`.
 */
function writeRows(db: DatabaseLike, keys: readonly string[], peer: Record<string, unknown>): string[] {
	const changed: string[] = [];
	for (const key of keys) {
		const value = key in peer ? JSON.stringify(peer[key]) : null;
		if (rawRow(db, key) === value) continue;
		if (value === null) db.query("DELETE FROM settings WHERE key = ?").run(key);
		else db.query("INSERT INTO settings (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, value);
		changed.push(key);
	}
	return changed;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const dataDir = () => process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya");

/** Every extension's stored settings, read from its folder: how a server without `pi.api` (0.9.3 and older) is read. */
function extensionSettingsFiles(): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	const root = join(dataDir(), "extensions");
	if (!existsSync(root)) return out;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			const value: unknown = JSON.parse(readFileSync(join(root, entry.name, "settings.json"), "utf8"));
			if (plain(value)) out[entry.name] = value;
		} catch { /* none, or damaged: not ours to fix */ }
	}
	return out;
}

/** The extension settings that travel: credentials left out (unless asked for), this extension's own skipped. */
function shareable(all: Record<string, Record<string, unknown>>, withSecrets = false): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const [id, value] of Object.entries(all)) {
		if (id === SELF_ID || !EXTENSION_ID.test(id) || !plain(value)) continue;
		out[id] = Object.fromEntries(Object.entries(value).filter(([k]) => withSecrets || !CREDENTIAL_KEY.test(k)));
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
 * Make each folder the primary has the same as there (files it lacks are removed from that folder, unless `preserve`
 * says a file is excluded by local sync rules and must stay). A folder only here stays: a follower keeps what it added
 * itself. A symlinked folder here is someone's own link and is left alone.
 */
function applyFolders(root: string, theirs: Record<string, FileSet>, label: string, preserve?: (name: string, rel: string) => boolean): string[] {
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
				const rel = relative(dir, path).split(sep).join("/");
				if (f.isFile() && SAFE_NAME.test(f.name) && !keep.has(rel) && !preserve?.(name, rel)) { rmSync(path, { force: true }); touched = true; }
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

/**
 * A row that names a place on this PC (the default working directory) is taken only when that folder exists here:
 * two PCs often keep their work in different places, and a missing folder would start new chats in the wrong one.
 * Not taken = this server keeps its own value, and the item counts as "only here" until the paths agree again.
 */
const PATH_ROWS = new Set(["default_workdir"]);
const fitsHere = (key: string, value: unknown): boolean => {
	if (!PATH_ROWS.has(key) || value === null || value === undefined) return true;
	if (typeof value !== "string" || !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return false;
	try { return statSync(value).isDirectory(); } catch { return false; }
};

/** Any JSON value as text with object keys sorted, so the same value always reads the same. */
const stable = (v: unknown): string =>
	JSON.stringify(v, (_k, x) => (plain(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
/** Hash of one synced item; "" for an item that is not there. */
const itemHash = (v: unknown): string => (v === undefined || v === null ? "" : createHash("sha256").update(stable(v)).digest("hex").slice(0, 32));
/** An extension's settings without anything that looks like a credential: what travels both ways. */
const publicOf = (o: Record<string, unknown> | undefined): Record<string, unknown> =>
	Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !CREDENTIAL_KEY.test(k)));

/** What both sides had at the last sync: each side's own hash (the two may store one value a little differently). */
export type SyncBase = { p: string; f: string } | "local";

/**
 * One item of a two-way sync. `p` and `f` are its hash on the primary and here ("" = not there), `b` what both had at
 * the last sync ("local" = it was only here then and stays here, undefined = never seen). What changed on one side goes
 * to the other; when both changed, the primary wins. `first`: the first sync of this kind of item only pulls, as before
 * (an item only here stays). `deletes`: a removal travels too (settings rows); a removed file never does, it comes back.
 */
export function decide(p: string, f: string, b: SyncBase | undefined, o: { first: boolean; deletes: boolean }): "same" | "pull" | "push" | "keep" {
	if (p === f) return "same";
	const pullOrKeep = p || o.deletes ? "pull" : "keep";
	if (o.first) return pullOrKeep;
	if (b === "local") return p ? "pull" : "keep";
	if (b === undefined) return p ? "pull" : "push"; // never seen: made here goes up, otherwise the primary's wins
	const primaryChanged = p !== b.p;
	const hereChanged = f !== b.f;
	if (!primaryChanged && !hereChanged) return "same"; // the two only store it differently: nothing to do
	if (hereChanged && !primaryChanged) return f || o.deletes ? "push" : "pull";
	return pullOrKeep; // changed on the primary, or on both: the primary wins
}

/** The kinds of item that sync both ways, and how each is hashed the same way on both servers. */
type Kind = "rows" | "mcp" | "ext" | "skill" | "helper" | "agentsMd" | "provider";
const providerHash = (row: Record<string, unknown> | undefined) => itemHash(row ? Object.fromEntries(Object.entries(publicOf(row)).filter(([k]) => k !== "id")) : undefined);

/** Known top-level namespaces in `syncignore` (used only for typo warnings; unknown ones still compile). */
export const SYNC_NAMESPACES = new Set([
	"settings", "mcp", "extensions", "skills", "subagents", "agents-md", "providers", "agent-extensions", "secrets",
]);
const MAX_RULES_BYTES = 64 * 1024;
const MAX_RULES_COUNT = 500;
const MAX_RULE_LINE = 200;

export interface SyncRule {
	line: number;
	raw: string;
	negate: boolean;
	pattern: string;
	anchored: boolean;
	matchAll: boolean;
}

export interface SyncRuleWarning {
	line: number;
	raw: string;
	message: Text;
}

export interface ParsedSyncRules {
	rules: SyncRule[];
	warnings: SyncRuleWarning[];
}

// ReDoS-proof O(P*S) glob matcher supporting `**/` (zero or more directory segments), `**` (any chars),
// `*` (any non-`/` chars), `?` (one non-`/` char), and literal characters without regex compilation.
function globMatch(pat: string, str: string): boolean {
	type Tok = { kind: "lit"; ch: string } | { kind: "q" } | { kind: "star" } | { kind: "dstar" } | { kind: "dstarSlash" };
	const toks: Tok[] = [];
	for (let i = 0; i < pat.length; i++) {
		const ch = pat[i]!;
		if (ch === "*") {
			if (pat[i + 1] === "*") {
				while (pat[i + 1] === "*") i++;
				if (pat[i + 1] === "/") {
					i++;
					if (toks[toks.length - 1]?.kind !== "dstarSlash") toks.push({ kind: "dstarSlash" });
				} else if (toks[toks.length - 1]?.kind !== "dstar") {
					toks.push({ kind: "dstar" });
				}
			} else if (toks[toks.length - 1]?.kind !== "star") {
				toks.push({ kind: "star" });
			}
		} else if (ch === "?") {
			toks.push({ kind: "q" });
		} else {
			toks.push({ kind: "lit", ch });
		}
	}
	const n = str.length;
	let dp = new Uint8Array(n + 1);
	dp[0] = 1;
	for (const tok of toks) {
		const next = new Uint8Array(n + 1);
		if (tok.kind === "lit") {
			for (let j = 0; j < n; j++) if (dp[j] && str[j] === tok.ch) next[j + 1] = 1;
		} else if (tok.kind === "q") {
			for (let j = 0; j < n; j++) if (dp[j] && str[j] !== "/") next[j + 1] = 1;
		} else if (tok.kind === "star") {
			for (let j = 0; j <= n; j++) {
				if (dp[j]) next[j] = 1;
				if (j < n && next[j] && str[j] !== "/") next[j + 1] = 1;
			}
		} else if (tok.kind === "dstar") {
			let seen = 0;
			for (let j = 0; j <= n; j++) {
				if (dp[j]) seen = 1;
				if (seen) next[j] = 1;
			}
		} else {
			// `**/`: matches empty string OR any prefix ending with `/`
			let seen = 0;
			for (let j = 0; j <= n; j++) {
				if (dp[j]) { next[j] = 1; seen = 1; }
				if (j < n && seen && str[j] === "/") next[j + 1] = 1;
			}
		}
		dp = next;
	}
	return dp[n] === 1;
}

const normalizeSyncPathAlias = (pat: string): string => {
	if (/^agents\.md$/i.test(pat)) return "agents-md";
	if (/^subagents\/.+\.md$/i.test(pat)) return pat.replace(/\.md$/i, "");
	if (pat === "settings/mcp_servers") return "mcp/*";
	return pat;
};

/**
 * Parse `.gitignore`-style sync rules. Blank lines and `#` comments are ignored; `!` re-includes; `*`, `**`, `?` are
 * globs; last matching rule wins. Ergonomic aliases (`AGENTS.md` -> `agents-md`, `subagents/<x>.md` -> `subagents/<x>`,
 * `settings/mcp_servers` -> `mcp/*`) are normalized so natural spellings work without surprises.
 */
export function parseSyncRules(text: string): ParsedSyncRules {
	const rules: SyncRule[] = [];
	const warnings: SyncRuleWarning[] = [];
	if (typeof text !== "string" || !text) return { rules, warnings };
	const clipped = text.length > MAX_RULES_BYTES ? text.slice(0, MAX_RULES_BYTES) : text;
	if (text.length > MAX_RULES_BYTES) {
		warnings.push({
			line: 0,
			raw: "",
			message: { ko: "규칙 파일이 너무 커서 앞 64KB만 적용합니다.", en: "Rules file exceeds 64 KB; only the first 64 KB was parsed." },
		});
	}
	const lines = clipped.split(/\r?\n/);
	for (let idx = 0; idx < lines.length; idx++) {
		const lineNo = idx + 1;
		const rawLine = lines[idx]!;
		// Trim leading whitespace and unescaped trailing whitespace.
		let s = rawLine.replace(/^\s+/, "").replace(/(?<!\\)\s+$/, "").replace(/\\ /g, " ");
		if (!s || s.startsWith("#")) continue;
		if (rules.length >= MAX_RULES_COUNT) {
			warnings.push({
				line: lineNo,
				raw: rawLine.trim(),
				message: { ko: `규칙이 최대 개수(${MAX_RULES_COUNT})를 넘어 나머지를 건너뛰었습니다.`, en: `Exceeded maximum rule count (${MAX_RULES_COUNT}); remaining lines skipped.` },
			});
			break;
		}
		let negate = false;
		if (s.startsWith("!")) {
			negate = true;
			s = s.slice(1).trim();
		} else if (s.startsWith("\\#") || s.startsWith("\\!")) {
			s = s.slice(1);
		}
		if (!s) {
			warnings.push({
				line: lineNo,
				raw: rawLine.trim(),
				message: { ko: `${lineNo}행: '!' 뒤에 패턴이 비어 있습니다.`, en: `Line ${lineNo}: empty pattern after '!'.` },
			});
			continue;
		}
		if (s.length > MAX_RULE_LINE) {
			warnings.push({
				line: lineNo,
				raw: s.slice(0, 40),
				message: { ko: `${lineNo}행: 패턴이 너무 길어 건너뛰었습니다.`, en: `Line ${lineNo}: pattern too long; skipped.` },
			});
			continue;
		}
		const leadingSlash = s.startsWith("/");
		let pat = s.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/").replace(/\*{3,}/g, "**");
		if (!pat) continue;
		pat = normalizeSyncPathAlias(pat);
		const matchAll = pat === "*" || pat === "**";
		const anchored = !matchAll && (leadingSlash || pat.includes("/"));
		if (anchored) {
			const head = pat.split("/")[0]!;
			if (head && !head.includes("*") && !head.includes("?") && !SYNC_NAMESPACES.has(head)) {
				warnings.push({
					line: lineNo,
					raw: rawLine.trim(),
					message: { ko: `${lineNo}행: 알 수 없는 네임스페이스 '${head}'.`, en: `Line ${lineNo}: unknown namespace '${head}'.` },
				});
			}
		}
		rules.push({ line: lineNo, raw: rawLine.trim(), negate, pattern: pat, anchored, matchAll });
	}
	return { rules, warnings };
}

const ruleMatches = (rule: SyncRule, path: string): boolean => {
	if (rule.matchAll) return true;
	const segs = path.split("/");
	if (!rule.anchored) return segs.some((seg) => globMatch(rule.pattern, seg));
	let prefix = "";
	for (let i = 0; i < segs.length; i++) {
		prefix = i === 0 ? segs[0]! : `${prefix}/${segs[i]!}`;
		if (globMatch(rule.pattern, prefix)) return true;
	}
	return false;
};

/** Evaluate `.gitignore`-style rules against a canonical sync path (last match wins). */
export function matchSyncPath(rules: readonly SyncRule[], path: string): { ignored: boolean; matchedBy: SyncRule | null } {
	let ignored = false;
	let matchedBy: SyncRule | null = null;
	for (const rule of rules) {
		if (ruleMatches(rule, path)) {
			ignored = !rule.negate;
			matchedBy = rule;
		}
	}
	return { ignored, matchedBy };
}

/**
 * Whether any item under `ns` (which may be multi-segment like `"secrets/providers"`, plus optional trailing sub-aspect
 * `sub` such as `"settings"` / `"install"` / `"client"` / `"code"` for `"extensions"`) might be included by `rules`.
 */
export function mayIncludeNamespace(rules: readonly SyncRule[], ns: string, sub?: string): boolean {
	if (ns === "agents-md") return !matchSyncPath(rules, "agents-md").ignored;
	const probe = sub ? `${ns}/__probe__/${sub}` : `${ns}/__probe__`;
	if (!matchSyncPath(rules, probe).ignored) return true;
	const nsParts = ns.split("/");
	for (const rule of rules) {
		if (!rule.negate) continue;
		if (rule.matchAll || !rule.anchored) return true;
		const parts = rule.pattern.split("/");
		let prefixOk = true;
		let wildcardPrefix = false;
		for (let i = 0; i < Math.min(nsParts.length, parts.length); i++) {
			if (parts[i] === "**") { wildcardPrefix = true; break; }
			if (!globMatch(parts[i]!, nsParts[i]!)) { prefixOk = false; break; }
		}
		if (!prefixOk) continue;
		if (wildcardPrefix || !sub) return true;
		const subIdx = nsParts.length + 1;
		if (parts.length <= subIdx) return true;
		const seg = parts[subIdx]!;
		if (seg === "**" || globMatch(seg, sub)) return true;
	}
	return false;
}

const RULES_HEADER = [
	"# server-sync rules (.gitignore style: last matching rule wins; ! re-includes)",
	"# Matching paths are excluded from both pull and push on this server.",
	"#",
	"# Namespaces:",
	"#   settings/<key>             default_model, default_workdir, system_model, image_model,",
	"#                              compaction, retention, skills, disabled_tools,",
	"#                              disabled_subagents, delegate_policy",
	"#   mcp/<name>                 individual MCP server by name",
	"#   extensions/<id>            extension install, settings, client state, code",
	"#                              (or extensions/<id>/{install,settings,client,code})",
	"#   skills/<name>[/<file>]     ~/.agents/skills/<name>",
	"#   subagents/<name>           ~/.agents/subagents/<name>.md",
	"#   agents-md                  ~/.agents/AGENTS.md",
	"#   providers/<id>             custom model providers",
	"#   agent-extensions/<name>    ~/.agents/extensions (requires local extensions switch)",
	"#   secrets/providers/<id>     model API keys (requires secrets switch on both sides)",
	"#   secrets/extensions/<id>    extension tokens (requires secrets switch on both sides)",
].join("\n");

const LEGACY_SCOPE_KEYS = ["syncApp", "syncMcpServers", "syncExtensions", "syncAgent", "syncProviders"] as const;

/** Default `syncignore` text for a server role, or derived from pre-0.19 legacy box settings when no file exists yet. */
export function defaultRulesText(role: "primary" | "follower", legacySettings?: Record<string, unknown>): string {
	if (role === "primary") {
		return `${RULES_HEADER}\n#\n# Primary serves everything by default. Add patterns below to hide items from followers:\n`;
	}
	const s = legacySettings ?? {};
	const hasLegacy = LEGACY_SCOPE_KEYS.some((k) => k in s);
	const lines: string[] = [];
	if (!hasLegacy) {
		lines.push(
			"# By default, app settings and MCP servers sync.",
			"# Remove a line (or add !pattern below it) to include more items:",
			"extensions/*",
			"skills/*",
			"subagents/*",
			"agents-md",
			"providers/*",
			"agent-extensions/*",
		);
	} else {
		if (s.syncApp === false) {
			for (const k of GROUPS[0].keys) lines.push(`settings/${k}`);
			lines.push("mcp/*");
		} else if (s.syncMcpServers === false) {
			lines.push("mcp/*");
		}
		if (s.syncExtensions !== true) {
			lines.push("extensions/*", "agent-extensions/*");
		}
		if (s.syncAgent !== true) {
			lines.push("skills/*", "subagents/*", "agents-md");
		}
		if (s.syncProviders !== true) {
			lines.push("providers/*");
		}
	}
	return `${RULES_HEADER}\n#\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

/** Index an `mcp_servers` row array by trimmed server name. */
function mcpMap(value: unknown): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	if (!Array.isArray(value)) return out;
	for (const entry of value) {
		if (!plain(entry) || typeof entry.name !== "string") continue;
		const name = entry.name.trim();
		if (name) out[name] = entry;
	}
	return out;
}

/** Rebuild an `mcp_servers` array preserving existing order for retained entries and appending new ones. */
function mcpArray(current: unknown, next: Record<string, Record<string, unknown>>): Record<string, unknown>[] {
	const seen = new Set<string>();
	const out: Record<string, unknown>[] = [];
	if (Array.isArray(current)) {
		for (const entry of current) {
			if (!plain(entry) || typeof entry.name !== "string") continue;
			const name = entry.name.trim();
			if (name && name in next && !seen.has(name)) {
				out.push(next[name]!);
				seen.add(name);
			}
		}
	}
	for (const [name, entry] of Object.entries(next)) {
		if (!seen.has(name)) out.push(entry);
	}
	return out;
}

export default (pi: any) => {
	let db: Database | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Extensions the primary has that could not be installed here (not in the marketplace, copying not allowed). */
	let unlisted: string[] = [];
	/** Pulled extensions that cannot run here until a secret is typed in on this server: name -> the settings they lack. */
	let needsInput: { id: string; title: string; fields: string[] }[] = [];
	/** Paths the primary uses that this PC does not have (the working directory): kept as this server's own. */
	let skippedPaths: string[] = [];
	/** Rows the primary has that this server's own routes refused (a model it lacks): kept as this server's own for now. */
	let refusedRows: { key: string; reason: string }[] = [];
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
	/**
	 * What both servers had at the last sync, per two-way item (hashes only, never values), next to the peer file. It
	 * belongs to one primary: another address starts over, and so does a kind whose box was turned off.
	 */
	type BaseFile = { url: string; seen: Kind[]; items: Partial<Record<Kind, Record<string, SyncBase>>> };
	const baseFile = () => join(dirname(peerFile()), "sync-base.json");
	const readBase = (url: string): BaseFile => {
		try {
			const v: unknown = JSON.parse(readFileSync(baseFile(), "utf8"));
			if (plain(v) && v.url === url && Array.isArray(v.seen) && plain(v.items)) return v as unknown as BaseFile;
		} catch { /* none yet */ }
		return { url, seen: [], items: {} };
	};
	const writeBase = (b: BaseFile | null) => {
		const file = baseFile();
		if (!b) return rmSync(file, { force: true });
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(tmp, JSON.stringify(b), { mode: 0o600 });
		renameSync(tmp, file);
	};
	type BackupReason = "pull" | "push" | "restore";
	interface BackupSummary { id: string; at: number; reason: BackupReason; summary: string[] }
	interface BackupRecord extends BackupSummary {
		rows?: Record<string, unknown>;
		extensions?: Record<string, Record<string, unknown>>;
		clientExtensions?: { list?: unknown; states?: unknown };
		skills?: Record<string, FileSet | null>;
		subagents?: Record<string, string | null>;
		agentsMd?: string | null;
		providers?: Record<string, Record<string, unknown> | null>;
	}
	const backupsDir = () => join(dirname(peerFile()), "backups");
	const listBackups = (): BackupSummary[] => {
		const dir = backupsDir();
		if (!existsSync(dir)) return [];
		const out: BackupSummary[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -5);
			if (!SAFE_BACKUP_ID.test(id)) continue;
			try {
				const v: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
				if (plain(v) && typeof v.id === "string" && typeof v.at === "number" && (v.reason === "pull" || v.reason === "push" || v.reason === "restore") && Array.isArray(v.summary)) {
					out.push({ id: v.id, at: v.at, reason: v.reason, summary: v.summary.filter((x): x is string => typeof x === "string") });
				}
			} catch { /* damaged backup file */ }
		}
		return out.sort((a, b) => b.at - a.at);
	};
	const readBackup = (id: string): BackupRecord | null => {
		if (!SAFE_BACKUP_ID.test(id)) return null;
		try {
			const v: unknown = JSON.parse(readFileSync(join(backupsDir(), `${id}.json`), "utf8"));
			if (plain(v) && v.id === id && typeof v.at === "number" && (v.reason === "pull" || v.reason === "push" || v.reason === "restore") && Array.isArray(v.summary)) {
				return v as unknown as BackupRecord;
			}
		} catch { /* missing or damaged */ }
		return null;
	};
	const saveBackup = (record: Omit<BackupRecord, "id" | "at">): BackupSummary | null => {
		if (!record.summary.length) return null;
		const dir = backupsDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const at = Date.now();
		const id = `${at}-${randomBytes(3).toString("hex")}`;
		const full: BackupRecord = { id, at, ...record };
		const file = join(dir, `${id}.json`);
		const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(tmp, JSON.stringify(full), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
		// Keep at most MAX_BACKUPS newest files.
		const files = readdirSync(dir)
			.filter((n) => n.endsWith(".json") && SAFE_BACKUP_ID.test(n.slice(0, -5)))
			.sort((a, b) => {
				const ta = Number(a.split("-")[0]) || 0;
				const tb = Number(b.split("-")[0]) || 0;
				return tb - ta || b.localeCompare(a);
			});
		for (const old of files.slice(MAX_BACKUPS)) rmSync(join(dir, old), { force: true });
		return { id, at, reason: full.reason, summary: full.summary };
	};
	/**
	 * This follower's own id, made once and kept next to the peer file: how the primary tells two followers apart and
	 * one follower's pulls from another's. A random value, not derived from the token, so it says nothing about it.
	 */
	const selfId = (): string => {
		const file = join(dirname(peerFile()), "follower-id");
		try { const v = readFileSync(file, "utf8").trim(); if (FOLLOWER_ID.test(v)) return v; } catch { /* none yet */ }
		const id = randomBytes(16).toString("hex");
		try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, id, { mode: 0o600 }); } catch { /* used for this run only */ }
		return id;
	};

	/**
	 * On the primary: the followers that pulled from it, by their id, for the page. Kept in a file next to the peer file
	 * so a restart keeps the list; written when one is new or changed, else at most every five minutes per follower.
	 */
	const followersFile = () => join(dirname(peerFile()), "followers.json");
	let followers: Map<string, FollowerRecord> | null = null;
	const savedAt = new Map<string, number>();
	const loadFollowers = (): Map<string, FollowerRecord> => {
		if (followers) return followers;
		followers = new Map();
		try {
			const v: unknown = JSON.parse(readFileSync(followersFile(), "utf8"));
			for (const raw of Array.isArray(v) ? v : []) {
				const f = followerFrom(raw);
				const r = raw as Record<string, unknown>;
				if (f && typeof r.lastAt === "number" && typeof r.firstAt === "number") {
					followers.set(f.id, { ...f, firstAt: r.firstAt, lastAt: r.lastAt });
					savedAt.set(f.id, r.lastAt);
				}
			}
		} catch { /* none yet */ }
		return followers;
	};
	const saveFollowers = () => {
		const file = followersFile();
		try {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
			writeFileSync(tmp, JSON.stringify([...loadFollowers().values()]), { mode: 0o600 });
			renameSync(tmp, file);
		} catch (e) {
			log(`followers: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	/** The followers to show, newest pull first; the ones silent for a month are dropped. */
	const followerList = (now = Date.now()): FollowerRecord[] => {
		const all = loadFollowers();
		let dropped = false;
		for (const [id, f] of all) if (now - f.lastAt > FORGET_FOLLOWER_MS) { all.delete(id); dropped = true; }
		if (dropped) saveFollowers();
		return [...all.values()].sort((a, b) => b.lastAt - a.lastAt);
	};
	/** A follower pulled: remember it, and redraw the page when the list changes (a new one, or one back from silence). */
	const sawFollower = (info: FollowerInfo, now = Date.now()) => {
		const all = loadFollowers();
		const old = all.get(info.id);
		all.set(info.id, { ...info, firstAt: old?.firstAt ?? now, lastAt: now });
		while (all.size > MAX_FOLLOWERS) {
			const oldest = [...all.values()].sort((a, b) => a.lastAt - b.lastAt)[0]!;
			all.delete(oldest.id);
		}
		const changed = !old || old.name !== info.name || old.url !== info.url || old.interval !== info.interval;
		if (changed || now - (savedAt.get(info.id) ?? 0) >= 5 * 60_000) {
			savedAt.set(info.id, now);
			saveFollowers();
		}
		if (changed || followerSilent(old!, now)) showStatus();
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

	/**
	 * This server's `.gitignore`-style sync rules file (`extension-data/server-sync/syncignore`).
	 * Plain UTF-8 text (never synced to peers), editable from the UI, terminal, or AI agent.
	 * When the file does not exist yet, rules fall back to defaults (or pre-0.19 legacy box settings).
	 */
	const rulesFile = () => join(dirname(peerFile()), "syncignore");
	const hasRulesFile = () => existsSync(rulesFile());
	const readRulesText = (): string => {
		const file = rulesFile();
		if (existsSync(file)) {
			try { return readFileSync(file, "utf8"); } catch { /* unreadable: fall back to defaults */ }
		}
		return defaultRulesText(role(), settings());
	};
	const writeRulesText = (text: string) => {
		const file = rulesFile();
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const normalized = text.endsWith("\n") || !text ? text : `${text}\n`;
		const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(tmp, normalized, { mode: 0o644 });
		chmodSync(tmp, 0o644);
		renameSync(tmp, file);
		// Once the file exists it is the sole source of truth: drop any obsolete pre-0.19 scope checkboxes.
		const s = settings();
		if (LEGACY_SCOPE_KEYS.some((k) => k in s)) {
			const cleaned = Object.fromEntries(Object.entries(withoutToken(s)).filter(([k]) => !(LEGACY_SCOPE_KEYS as readonly string[]).includes(k)));
			pi.settings.set(cleaned);
		}
	};
	const activeParsedRules = (overrideText?: string): ParsedSyncRules => parseSyncRules(overrideText ?? readRulesText());
	const activeRules = (): SyncRule[] => activeParsedRules().rules;
	const isIgnoredPath = (rules: readonly SyncRule[], path: string): boolean => matchSyncPath(rules, path).ignored;

	/** Filter a folder map (`skills` or `agent-extensions`) file-by-file against `rules`. */
	const filterFoldersByRules = (rules: readonly SyncRule[], ns: string, folders: Record<string, FileSet>): Record<string, FileSet> => {
		const out: Record<string, FileSet> = {};
		for (const [name, files] of Object.entries(folders)) {
			if (!plain(files)) continue;
			const kept: FileSet = {};
			for (const [rel, text] of Object.entries(files)) {
				if (!isIgnoredPath(rules, `${ns}/${name}/${rel}`)) kept[rel] = text;
			}
			if (Object.keys(kept).length) out[name] = kept;
		}
		return out;
	};
	/** Filter client extensions list + states against `extensions/<id>/client` rules. */
	const filterClientExtensionsByRules = (rules: readonly SyncRule[], data: { list: unknown; states: unknown }): { list: unknown; states: unknown } => {
		const list = Array.isArray(data.list)
			? data.list.filter((item) => {
				const id = plain(item) && plain(item.manifest) && typeof item.manifest.id === "string" ? item.manifest.id : "";
				return id ? !isIgnoredPath(rules, `extensions/${id}/client`) : !isIgnoredPath(rules, "extensions/__unknown__/client");
			})
			: data.list;
		const states = plain(data.states)
			? Object.fromEntries(Object.entries(data.states).filter(([id]) => !isIgnoredPath(rules, `extensions/${id}/client`)))
			: data.states;
		return { list, states };
	};

	const keys = (): string[] => effectiveKeys(String(settings().keys ?? ""));
	/** Of the keys in `list`, the ones allowed by `rules` (`mcp_servers` is kept whenever any `mcp/*` may be included). */
	const allowedKeys = (list: readonly string[], rules: readonly SyncRule[] = activeRules()): string[] =>
		list.filter((k) => (k === "mcp_servers" ? mayIncludeNamespace(rules, "mcp") : !isIgnoredPath(rules, `settings/${k}`)));
	/** Pull secrets too (a model API key, an extension's own token): security gate, off by default, primary must allow it. */
	const wantSecrets = () => settings().syncSecrets === true;
	/** Copy unreviewed extension code & `~/.agents/extensions`: security gate, off by default. */
	const wantLocalExtensions = () => settings().syncLocalExtensions === true;
	/** Whether extension settings may sync on this follower. */
	const syncExtensions = (rules: readonly SyncRule[] = activeRules()) => mayIncludeNamespace(rules, "extensions", "settings");
	/** Pause automatic sync (follower) and sync responses (primary). */
	const isPaused = () => settings().paused === true;

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

	// ---- this server itself: its own API (`pi.api`, `pi.server`, app 0.9.4+), else the old way (`legacy`) ----

	/** What a call to this server's own route answered: the status and the parsed body (text when it is not JSON). */
	type Answer = { ok: boolean; status: number; body: any; text: string };
	const answer = (status: number, body: unknown): Answer =>
		({ ok: status >= 200 && status < 300, status, body, text: typeof body === "string" ? body : body === null || body === undefined ? "" : JSON.stringify(body) });
	const hasApi = typeof pi.api?.request === "function";
	/**
	 * Set once this instance is unloaded. Installing or copying an extension reloads every extension, this one too: the
	 * new instance pulls again at once, and this one must not touch anything (its `pi.api` is closed, its page is not
	 * its own any more).
	 */
	let gone = false;

	/**
	 * How a server without `pi.api` (0.9.3 and older) is reached, and everything here that leans on the app's insides
	 * for it: the admin token from `PIPAYA_TOKEN` or the data folder's `token` file, this server's address guessed from
	 * `PIPAYA_HOST`/`PIPAYA_PORT`, other extensions' settings and the apps' rows read from the data folder and the
	 * database. Kept in one place so it can go once those servers are gone; nothing else in this file guesses.
	 */
	const legacy = {
		/** Where this server listens. Not always loopback: the desktop app can bind it to one address only. */
		url(): string {
			const port = process.env.PIPAYA_PORT ?? "8787";
			const bind = String(process.env.PIPAYA_HOST ?? "").trim();
			const host = !bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]" ? "127.0.0.1" : bind;
			return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
		},
		token(): string {
			const fromEnv = process.env.PIPAYA_TOKEN;
			if (fromEnv) return fromEnv.trim();
			try { return readFileSync(join(dataDir(), "token"), "utf8").trim(); } catch { return ""; }
		},
		/** This server's address as a peer should reach it: the first Tailscale/LAN address of this box. */
		publicUrl(): string {
			const host = firstAddress();
			return host ? `http://${host}:${process.env.PIPAYA_PORT ?? "8787"}` : "";
		},
		async request(method: string, path: string, body?: unknown, base = legacy.url(), timeoutMs = 60_000): Promise<Answer> {
			let res: Response;
			try {
				res = await fetch(`${base}${path}`, {
					method,
					headers: { authorization: `Bearer ${legacy.token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (e) {
				throw new Error(`could not reach this server itself (${base}): ${e instanceof Error ? e.message : String(e)}`);
			}
			const text = await res.text();
			let parsed: unknown = text;
			try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON: the text */ }
			return { ...answer(res.status, parsed), text };
		},
		clientSetting(key: string): unknown {
			const r = dbo().query("SELECT data FROM client_settings WHERE key = ?").get(key) as { data: string } | undefined;
			try { return r ? JSON.parse(r.data) : null; } catch { return null; }
		},
		providers(): Record<string, Record<string, unknown>> {
			const out: Record<string, Record<string, unknown>> = {};
			for (const r of dbo().query("SELECT id, data FROM custom_providers").all() as { id: string; data: string }[]) {
				try { const v: unknown = JSON.parse(r.data); if (plain(v)) out[r.id] = v; } catch { /* a damaged row is not ours to fix */ }
			}
			return out;
		},
		storedKeys(): Set<string> {
			return new Set((dbo().query("SELECT provider_id FROM credentials").all() as { provider_id: string }[]).map((r) => r.provider_id));
		},
	};

	/** One call to this server's own route, as the admin: what every apply goes through so the app hears about it. */
	const own = async (method: string, path: string, body?: unknown): Promise<Answer> => {
		if (gone) throw new Error("this server reloaded its extensions; the new instance syncs again now");
		if (!hasApi) return legacy.request(method, path, body);
		let r: { status: number; body: unknown };
		try {
			r = await pi.api.request(method, path, body);
		} catch (e) {
			if (gone) throw new Error("this server reloaded its extensions; the new instance syncs again now");
			throw new Error(`could not reach this server itself (${method} ${path}): ${e instanceof Error ? e.message : String(e)}`);
		}
		return answer(r.status, r.body);
	};
	/** A read that must work: its body, or an error naming the route. */
	const ownRead = async (path: string): Promise<any> => {
		const res = await own("GET", path);
		if (!res.ok) throw new Error(`this server answered ${res.status} to GET ${path}`);
		return res.body;
	};

	/** This server's address as a peer should reach it (`pi.server.info`), a Tailscale address first. */
	const publicUrl = (): string => {
		if (typeof pi.server?.info !== "function") return legacy.publicUrl();
		try {
			const urls = (pi.server.info() as { urls?: unknown }).urls;
			const list = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string") : [];
			return list.find((u) => /^http:\/\/100\./.test(u)) ?? list[0] ?? "";
		} catch {
			return legacy.publicUrl();
		}
	};

	/** Every extension's settings on this server, by id (`GET /extensions/settings`). */
	const extensionSettings = async (): Promise<Record<string, Record<string, unknown>>> => {
		if (!hasApi) return extensionSettingsFiles();
		const body = await ownRead("/extensions/settings");
		const out: Record<string, Record<string, unknown>> = {};
		for (const [id, stored] of Object.entries(plain(body?.settings) ? body.settings : {})) if (plain(stored) && plain(stored.value)) out[id] = stored.value;
		return out;
	};
	/** One row of the apps' settings (`GET /client-settings/:key`), null when there is none. */
	const clientSetting = async (key: string): Promise<unknown> => {
		if (!hasApi) return legacy.clientSetting(key);
		const res = await own("GET", `/client-settings/${key}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`this server answered ${res.status} to GET /client-settings/${key}`);
		return plain(res.body) ? (res.body.value ?? null) : null;
	};
	/**
	 * Custom model providers as the server stores them (`GET /configuration`), without what the route adds to describe
	 * them, so a server read through its API and one read from its database hash the same connection the same.
	 */
	const storedProviders = async (): Promise<Record<string, Record<string, unknown>>> => {
		if (!hasApi) return legacy.providers();
		const body = await ownRead("/configuration");
		const out: Record<string, Record<string, unknown>> = {};
		for (const p of Array.isArray(body?.providers) ? body.providers : []) {
			if (!plain(p) || typeof p.id !== "string") continue;
			const { configured: _c, hasStoredKey: _k, ...rest } = p;
			const models = Array.isArray(rest.models) ? rest.models.map((m: unknown) => {
				if (!plain(m)) return m;
				const { thinkingSource: _t, unavailable: _u, ...model } = m;
				return model;
			}) : rest.models;
			out[p.id] = { ...rest, models };
		}
		return out;
	};
	/** Providers this server holds a credential for (`GET /providers`): never the credential itself. */
	const storedKeys = async (): Promise<Set<string>> => {
		if (!hasApi) return legacy.storedKeys();
		const body = await ownRead("/providers");
		return new Set((Array.isArray(body?.providers) ? body.providers : []).filter((p: any) => plain(p) && typeof p.id === "string" && p.storedCredential).map((p: any) => p.id as string));
	};

	/**
	 * Settings rows the app has a route for: the request that saves a value, and the one that clears it (a route that
	 * cannot delete its row gets the route's own default, which is what a missing row means). null: no route (`skills`,
	 * a key added in `keys`), or nothing that clears it (`delegate_policy`): the row is written directly.
	 */
	const DEFAULTS_OF: Record<string, string> = { system_model: "/system-model", image_model: "/image-model", compaction: "/compaction", retention: "/retention" };
	const rowRequest = async (key: string, value: unknown): Promise<[string, unknown] | null> => {
		const gone = value === undefined;
		if (key === "default_model") return ["/configuration/defaults", gone ? null : value];
		if (key === "default_workdir") return ["/configuration/workdir", { path: gone ? null : value }];
		if (key === "mcp_servers") return ["/mcp", { servers: gone ? [] : value }];
		if (key === "disabled_tools") return ["/configuration/tools", { disabled: gone ? [] : value }];
		if (key === "delegate_policy") return gone ? null : ["/configuration/delegate", value];
		const path = DEFAULTS_OF[key];
		if (!path) return null;
		if (!gone) return [path, value];
		const defaults = (await ownRead(path))?.defaults;
		return plain(defaults) ? [path, defaults] : null;
	};
	/** What the server said when it refused a value (its own words), short. */
	const reason = (res: Answer): string => String((plain(res.body) && plain(res.body.error) && typeof res.body.error.message === "string" ? res.body.error.message : res.text) || res.status).slice(0, 200);
	/**
	 * Helper roles switched off: one switch per role (`PUT /configuration/subagents/:name/enabled`). A role this server
	 * does not have (yet: its file comes with 스킬·도우미, after the rows) has no switch to flip; then the list is written
	 * as a whole, directly, so the role starts off once its file arrives.
	 */
	const writeDisabledSubagents = async (value: unknown): Promise<"done" | "direct" | { refused: string }> => {
		const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
		let current: string[] = [];
		try { const raw = rawRow(dbo(), "disabled_subagents"); current = raw === null ? [] : list(JSON.parse(raw)); } catch { /* damaged: start from none */ }
		const target = list(value);
		let missing = false;
		for (const k of [...new Set([...current, ...target])]) {
			if (current.includes(k) === target.includes(k)) continue;
			const slash = k.indexOf("/");
			const scope = k.slice(0, slash);
			if (slash < 1 || (scope !== "global" && scope !== "project")) { missing = true; continue; }
			const res = await own("PUT", `/configuration/subagents/${encodeURIComponent(k.slice(slash + 1))}/enabled`, { scope, enabled: !target.includes(k) });
			if (res.status === 404) missing = true;
			else if (!res.ok) return { refused: reason(res) };
		}
		return missing ? "direct" : "done";
	};
	/**
	 * Make this server's rows the given ones (a key missing from `values` is removed), through the app's routes where it
	 * has them. A value a route refuses (a model this server does not have, a folder outside its workspace) is not
	 * written: this server keeps its own and the key is listed in `refused`, tried again on the next sync.
	 */
	const applyRows = async (keys: readonly string[], values: Record<string, unknown>): Promise<{ changed: string[]; refused: { key: string; reason: string }[] }> => {
		const changed: string[] = [];
		const refused: { key: string; reason: string }[] = [];
		const direct: string[] = [];
		for (const key of keys) {
			const value = key in values ? values[key] : undefined;
			if (rawRow(dbo(), key) === (value === undefined ? null : JSON.stringify(value))) continue;
			if (!hasApi) { direct.push(key); continue; }
			if (key === "disabled_subagents") {
				const r = await writeDisabledSubagents(value);
				if (r === "direct") direct.push(key);
				else if (r === "done") changed.push(key);
				else refused.push({ key, reason: r.refused });
				continue;
			}
			const req = await rowRequest(key, value);
			if (!req) { direct.push(key); continue; }
			const res = await own("PUT", req[0], req[1]);
			if (res.ok) changed.push(key);
			else if (res.status === 400 || res.status === 404 || res.status === 409) refused.push({ key, reason: reason(res) });
			else throw new Error(`could not save ${key} on this server (${res.status}: ${reason(res)})`);
		}
		if (direct.length) changed.push(...writeRows(dbo(), direct, values));
		if (refused.length) log(`this server refused: ${refused.map((r) => `${r.key} (${r.reason})`).join(", ")}`);
		return { changed, refused };
	};

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
			? { ko: `● 연결됨 — ${when.ko} 확인, ${n}개 항목 맞춤`, en: `● Connected — checked ${when.en}, ${n} item${n === 1 ? "" : "s"} matched` }
			: { ko: `● 연결됨 — ${when.ko} 확인, 바뀐 것 없음`, en: `● Connected — checked ${when.en}, nothing changed` };
	};

	/**
	 * Keep the page in step (`pi.ui`, app 0.8.8+). An older app has no page: the state is still in the `status` method.
	 * A `statusText` field an older version kept in the settings is dropped once; status never lives in the settings.
	 */
	let writing = false;
	const hasPanel = typeof pi.ui?.setPanel === "function";
	const showStatus = () => {
		if (writing || gone) return;
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
		if (k.startsWith("up:")) { const t = keyLabel(k.slice(3)); return { ko: `↑ 기준 서버에 반영: ${t.ko}`, en: `↑ Sent to the primary: ${t.en}` }; }
		if (k.startsWith("restore:")) { const t = keyLabel(k.slice(8)); return { ko: `↩ 백업에서 복원: ${t.ko}`, en: `↩ Restored from backup: ${t.en}` }; }
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

	let selectedBackupId = "";
	let confirmRestoreId: string | null = null;
	let pauseAfterRestore = true;
	let previewRowsCache: { id: string; rows: { id: string; cells: (Text | string)[] }[] } | null = null;

	const backupButton = (list: BackupSummary[], confirming: boolean): unknown[] =>
		!list.length || confirming ? [] : [{
			type: "button", id: "restore-preview", variant: "secondary", disabled: pulling || busy,
			label: { ko: `백업 복원 (${list.length})`, en: `Restore backup (${list.length})` },
		}];

	const restoreCardNodes = (list: BackupSummary[]): unknown[] => {
		if (!list.length || !confirmRestoreId) return [];
		const active = list.find((b) => b.id === selectedBackupId) ?? list[0]!;
		if (confirmRestoreId !== active.id || previewRowsCache?.id !== confirmRestoreId) return [];
		const reasonLabel = (r: BackupReason): Text => r === "pull"
			? { ko: "수신 전", en: "Before pull" }
			: r === "push" ? { ko: "반영 전", en: "Before push" }
			: { ko: "복원 직전", en: "Before restore" };
		const summaryText = (keys: readonly string[], lang: "ko" | "en"): string => {
			if (!keys.length) return "";
			const head = keys.slice(0, 2).map((k) => keyLabel(k)[lang]).join(", ");
			return keys.length > 2 ? (lang === "ko" ? `${head} 외 ${keys.length - 2}` : `${head} +${keys.length - 2}`) : head;
		};
		const rows = previewRowsCache.rows;
		return [{
			type: "card", id: "restore-confirm",
			title: { ko: "백업 복원", en: "Restore backup" },
			description: { ko: `총 ${list.length}개 보관 · 복원 전 현재 상태도 자동 백업됩니다.`, en: `${list.length} kept · current state is backed up beforehand.` },
			children: [
				{
					type: "select", id: "backup-select",
					label: { ko: "복원할 시점", en: "Backup point" },
					value: active.id,
					options: list.map((b) => ({
						value: b.id,
						label: {
							ko: `${formatDate(b.at)} · ${reasonLabel(b.reason).ko} · ${summaryText(b.summary, "ko")}`,
							en: `${formatDate(b.at)} · ${reasonLabel(b.reason).en} · ${summaryText(b.summary, "en")}`,
						},
					})),
				},
				...(rows.length ? [{
					type: "table", id: "restore-diff",
					columns: [
						{ id: "item", label: { ko: "항목", en: "Item" } },
						{ id: "before", label: { ko: "현재", en: "Current" } },
						{ id: "after", label: { ko: "복원", en: "Restored" } },
					],
					rows,
				}] : [{ type: "text", id: "restore-same", size: "small", text: { ko: "현재 상태와 차이가 없습니다.", en: "No differences from the current state." } }]),
				{
					type: "select", id: "restore-after",
					label: { ko: "복원 후 동작", en: "After restore" },
					value: pauseAfterRestore ? "pause" : "keep",
					options: [
						{ value: "pause", label: { ko: "자동 동기화 멈춤 (권장)", en: "Pause auto sync (recommended)" } },
						{ value: "keep", label: { ko: "자동 동기화 유지", en: "Keep auto sync" } },
					],
				},
				{
					type: "stack", id: "restore-actions", direction: "horizontal", gap: "small",
					children: [
						{ type: "button", id: "restore-cancel", variant: "secondary", disabled: pulling || busy, label: { ko: "취소", en: "Cancel" } },
						{ type: "button", id: "restore-approve", variant: "danger", disabled: pulling || busy || !rows.length, label: { ko: "승인하고 복원", en: "Approve and restore" } },
					],
				},
			],
		}];
	};

	let editingRules = false;
	let rulesDraft = "";
	let rulesDraftRevision = 0;
	interface DiscoveredSyncItem {
		path: string;
		synced: boolean;
		matchedBy: string | null;
	}
	interface RulesInspection {
		file: string;
		exists: boolean;
		role: "primary" | "follower";
		content: string;
		warnings: SyncRuleWarning[];
		gates: { syncLocalExtensions: boolean; syncSecrets: boolean; shareSecrets: boolean };
		items: DiscoveredSyncItem[];
		syncedCount: number;
		ignoredCount: number;
	}
	let rulesPreviewCache: RulesInspection | null = null;
	let liveInspection: RulesInspection | null = null;
	let refreshingInspection = false;

	const rulesButton = (open: boolean): unknown[] =>
		open ? [] : [{
			type: "button", id: "rules-open", variant: "secondary", disabled: pulling || busy,
			label: { ko: "규칙 수정", en: "Edit rules" },
		}];

	const UI_TEXTAREA_MAX = 16_000;

	const categoryBreakdown = (items: readonly DiscoveredSyncItem[], synced: boolean): Text => {
		const counts = new Map<string, number>();
		for (const item of items) {
			if (item.synced !== synced) continue;
			const ns = item.path.includes("/") ? item.path.slice(0, item.path.indexOf("/")) : item.path;
			counts.set(ns, (counts.get(ns) ?? 0) + 1);
		}
		const labels: [string, string, string][] = [
			["settings", "설정", "settings"],
			["mcp", "MCP", "MCP"],
			["skills", "스킬", "skills"],
			["subagents", "도우미", "helpers"],
			["agents-md", "AGENTS.md", "AGENTS.md"],
			["extensions", "확장", "extensions"],
			["providers", "모델 연결", "providers"],
			["agent-extensions", "내 확장", "local ext"],
		];
		const ko: string[] = [];
		const en: string[] = [];
		for (const [key, lKo, lEn] of labels) {
			const n = counts.get(key) ?? 0;
			if (!n) continue;
			if (key === "agents-md") { ko.push(lKo); en.push(lEn); }
			else { ko.push(`${lKo} ${n}`); en.push(`${lEn} ${n}`); }
		}
		return ko.length
			? { ko: ko.join(" · "), en: en.join(" · ") }
			: synced
				? { ko: "동기화할 항목 없음", en: "No items to sync" }
				: { ko: "제외된 항목 없음", en: "Nothing excluded" };
	};

	const rulesListNodes = (rules: readonly SyncRule[], hidden: boolean): unknown[] => {
		if (hidden) return [];
		const custom = hasRulesFile();
		const shownRules = rules.slice(0, 20);
		const rawBody = shownRules.length
			? [
				...shownRules.map((r) => r.raw),
				...(rules.length > shownRules.length ? [`# … +${rules.length - shownRules.length} more`] : []),
			].join("\n")
			: "";
		const rawNode = rawBody
			? { type: "code", id: "rules-list", language: "gitignore", text: rawBody }
			: {
				type: "text", id: "rules-list", size: "small", tone: "neutral",
				text: {
					ko: "제외 규칙 없음 (보안 스위치가 허용한 모든 항목 동기화)",
					en: "No exclude rules (everything allowed by security switches syncs)",
				},
			};
		const live = liveInspection;
		if (!live) {
			const title: Text = custom
				? { ko: `동기화 규칙 (syncignore · ${rules.length}개)`, en: `Sync rules (syncignore · ${rules.length})` }
				: { ko: `동기화 규칙 (기본값 · ${rules.length}개)`, en: `Sync rules (defaults · ${rules.length})` };
			return [
				{ type: "divider", id: "rules-sep" },
				{ type: "text", id: "rules-list-title", size: "small", tone: "neutral", text: title },
				rawNode,
			];
		}
		const excluded = live.items.filter((i) => !i.synced);
		const synced = live.items.filter((i) => i.synced);
		const allOrdered = [...excluded, ...synced].slice(0, 25);
		const toRows = (list: readonly DiscoveredSyncItem[], prefix: string, withState: boolean) =>
			list.map((item, idx) => ({
				id: `${prefix}${idx}`,
				cells: withState
					? [
						item.path,
						item.synced ? { ko: "동기화", en: "Sync" } : { ko: "제외", en: "Excluded" },
						item.matchedBy ?? { ko: "(기본)", en: "(default)" },
					]
					: [item.path, item.matchedBy ?? { ko: "(기본)", en: "(default)" }],
			}));
		const excludedHint: Text = excluded.length
			? categoryBreakdown(live.items, false)
			: {
				ko: custom ? `syncignore ${rules.length}개 규칙 적용` : `기본 규칙 ${rules.length}개 적용`,
				en: custom ? `${rules.length} syncignore rules` : `${rules.length} default rules`,
			};
		return [
			{ type: "divider", id: "rules-sep" },
			{
				type: "grid", id: "sync-stats", columns: 2,
				children: [
					{
						type: "stat", id: "stat-synced",
						label: { ko: "현재 서버 동기화 대상", en: "Synced on this server" },
						value: { ko: `${live.syncedCount}개`, en: String(live.syncedCount) },
						hint: categoryBreakdown(live.items, true),
					},
					{
						type: "stat", id: "stat-excluded",
						label: { ko: "규칙으로 제외됨", en: "Excluded by rules" },
						value: { ko: `${live.ignoredCount}개`, en: String(live.ignoredCount) },
						hint: excludedHint,
					},
				],
			},
			{
				type: "tabs", id: "rules-tabs",
				items: [
					{
						id: "tab-items",
						label: { ko: `현재 서버 항목 (${live.items.length})`, en: `Server items (${live.items.length})` },
						children: [
							...(allOrdered.length ? [{
								type: "table", id: "rules-items-table",
								columns: [
									{ id: "path", label: { ko: "경로", en: "Path" } },
									{ id: "state", label: { ko: "동작", en: "Action" } },
									{ id: "rule", label: { ko: "적용 규칙", en: "Matched rule" } },
								],
								rows: toRows(allOrdered, "ri", true),
							}] : [{
								type: "text", id: "rules-items-empty", size: "small", tone: "neutral",
								text: { ko: "이 서버에서 발견된 동기화 항목이 없습니다.", en: "No syncable items found on this server." },
							}]),
						],
					},
					{
						id: "tab-excluded",
						label: { ko: `제외됨 (${excluded.length})`, en: `Excluded (${excluded.length})` },
						children: [
							...(excluded.length ? [{
								type: "table", id: "rules-excluded-table",
								columns: [
									{ id: "path", label: { ko: "제외된 경로", en: "Excluded path" } },
									{ id: "rule", label: { ko: "적용 규칙", en: "Matched rule" } },
								],
								rows: toRows(excluded.slice(0, 30), "re", false),
							}] : [{
								type: "text", id: "rules-excluded-empty", size: "small", tone: "neutral",
								text: { ko: "제외된 항목이 없습니다.", en: "No excluded items." },
							}]),
						],
					},
					{
						id: "tab-raw",
						label: { ko: `syncignore (${rules.length})`, en: `syncignore (${rules.length})` },
						children: [rawNode],
					},
				],
			},
		];
	};

	const rulesCardNodes = (): unknown[] => {
		if (!editingRules) return [];
		const preview = rulesPreviewCache;
		const parsed = parseSyncRules(rulesDraft);
		const warnings = preview?.warnings ?? parsed.warnings;
		const items = preview?.items ?? [];
		const tooLongForUi = rulesDraft.length > UI_TEXTAREA_MAX;
		// Show excluded items first so the user immediately verifies what will be skipped, then synced items (max 20 rows).
		const ordered = [...items.filter((i) => !i.synced), ...items.filter((i) => i.synced)].slice(0, 20);
		const rows = ordered.map((item, idx) => ({
			id: `rp${idx}`,
			cells: [
				item.path,
				item.synced ? { ko: "동기화", en: "Sync" } : { ko: "제외", en: "Excluded" },
				item.matchedBy ?? { ko: "(기본)", en: "(default)" },
			],
		}));
		const summaryText: Text = preview
			? {
				ko: `현재 서버 항목 기준: 동기화 ${preview.syncedCount}개 · 제외 ${preview.ignoredCount}개${items.length > 20 ? " (20개만 표시)" : ""}`,
				en: `On this server: ${preview.syncedCount} synced · ${preview.ignoredCount} excluded${items.length > 20 ? " (showing 20)" : ""}`,
			}
			: { ko: "항목 미리보기를 불러오는 중…", en: "Loading preview…" };
		const fileHint = rulesFile().slice(-240);
		return [{
			type: "card", id: "rules-editor",
			title: { ko: "동기화 규칙 (syncignore)", en: "Sync rules (syncignore)" },
			description: {
				ko: `파일: ${fileHint} · .gitignore 문법(# 주석, * / ** 와일드카드, ! 다시 포함, 아래 규칙 우선)`,
				en: `File: ${fileHint} · .gitignore syntax (# comment, * / ** globs, ! re-include, last rule wins)`,
			},
			children: [
				...(tooLongForUi ? [{
					type: "alert", id: "rules-too-long", tone: "warning",
					text: { ko: "syncignore 파일이 16,000자를 넘어 화면 편집을 비활성화했습니다. 파일을 직접 편집하세요.", en: "syncignore exceeds 16,000 characters; edit the file directly." },
				}] : [{
					type: "form", id: "rules-form",
					submitLabel: { ko: "규칙 저장", en: "Save rules" },
					disabled: pulling || busy,
					children: [
						{
							type: "textarea", id: `rules-text-${rulesDraftRevision}`,
							label: { ko: "제외/포함 규칙", en: "Exclude / include rules" },
							value: rulesDraft,
							rows: 7,
							maxLength: UI_TEXTAREA_MAX,
							placeholder: {
								ko: "예: skills/browser-bridge, mcp/local-*, !skills/orchestrate",
								en: "e.g. skills/browser-bridge, mcp/local-*, !skills/orchestrate",
							},
						},
					],
				}]),
				...(warnings.length ? [{
					type: "alert", id: "rules-warn", tone: "warning",
					title: { ko: "규칙 확인 필요", en: "Check rules" },
					text: {
						ko: warnings.slice(0, 5).map((w) => w.message.ko).join("\n"),
						en: warnings.slice(0, 5).map((w) => w.message.en).join("\n"),
					},
				}] : []),
				{ type: "text", id: "rules-summary", size: "small", tone: "neutral", text: summaryText },
				...(rows.length ? [{
					type: "table", id: "rules-preview",
					columns: [
						{ id: "path", label: { ko: "경로", en: "Path" } },
						{ id: "state", label: { ko: "동작", en: "Action" } },
						{ id: "rule", label: { ko: "적용 규칙", en: "Matched rule" } },
					],
					rows,
				}] : []),
				{
					type: "stack", id: "rules-actions", direction: "horizontal", gap: "small",
					children: [
						{ type: "button", id: "rules-reset", variant: "secondary", disabled: pulling || busy, label: { ko: "기본값 불러오기", en: "Load defaults" } },
						{ type: "button", id: "rules-cancel", variant: "secondary", disabled: pulling || busy, label: { ko: "닫기", en: "Close" } },
					],
				},
			],
		}];
	};

	/** The extension's page (`pi.ui`): the state, the numbers that matter and what can be done now. */
	const panel = () => {
		const backups = listBackups();
		const restoreCard = restoreCardNodes(backups);
		const rulesCard = rulesCardNodes();
		const confirming = restoreCard.length > 0;
		const rules = activeRules();
		const extEnabled = mayIncludeNamespace(rules, "extensions");
		if (role() === "primary") {
			const url = publicUrl();
			const flist = followerList();
			const secretsOn = settings().shareSecrets === true;
			const primaryActions: unknown[] = [
				...(isPaused() ? [{ type: "button", id: "resume-sync", variant: "primary", disabled: pulling || busy, label: { ko: "동기화 다시 시작", en: "Resume sync" } }] : []),
				...rulesButton(editingRules),
				...backupButton(backups, confirming),
			];
			const addrKo = url ? hostOf(url) : "로컬 전용";
			const addrEn = url ? hostOf(url) : "loopback only";
			const secKo = secretsOn ? "비밀값 허용됨" : "비밀값 꺼짐";
			const secEn = secretsOn ? "secrets allowed" : "secrets off";
			return {
				type: "stack", id: "status", gap: "small", children: [
					{
						type: "text", id: isPaused() ? "paused-badge" : secretsOn ? "state" : "secrets-off", size: "small",
						tone: isPaused() ? "warning" : "neutral",
						text: isPaused()
							? { ko: `● 기준 서버 · 일시 중지됨 · ${addrKo} · ${secKo}`, en: `● Primary · paused · ${addrEn} · ${secEn}` }
							: { ko: `● 기준 서버 · ${addrKo} · 팔로워 ${flist.length}대 · ${secKo}`, en: `● Primary · ${addrEn} · ${flist.length} follower${flist.length === 1 ? "" : "s"} · ${secEn}` },
					},
					...(secretsOn ? [{ type: "alert", id: "secrets-on", tone: "warning", text: { ko: "비밀값 내보내기가 켜져 있습니다. 팔로워가 요청하면 모델 API 키와 확장 토큰을 건네줍니다.", en: "Sharing secrets is on. Followers that ask receive model API keys and extension tokens." } }] : []),
					{ type: "list", id: "followers", items: flist.map((f, i) => {
						const when = ago(f.lastAt);
						const where = f.url ? `${hostOf(f.url)} · ` : "";
						return {
							id: `f${i}`, title: f.name,
							description: { ko: `${where}마지막 동기화 ${when.ko}`, en: `${where}last synced ${when.en}` },
							...(followerSilent(f) ? { badge: { ko: "동기화 멈춤", en: "Not syncing" } } : {}),
						};
					}),
					emptyText: { ko: "연결된 팔로워가 없습니다. 기기 탭 → [연결 링크 복사]로 연결하세요.", en: "No followers yet. Connect via Devices → [Copy connection link]." } },
					...(primaryActions.length ? [{ type: "stack", id: "actions", direction: "horizontal", gap: "small", children: primaryActions }] : []),
					...rulesListNodes(rules, editingRules || confirming),
					...rulesCard,
					...restoreCard,
				],
			};
		}
		const { url, token } = cfg();
		const pasted = String(settings().shareCode ?? "").trim();
		const waiting = !token && !!pasted && !lastError;
		const stateTone = !url && !pairingLink(pasted) && !token ? "neutral"
			: lastError ? "danger"
			: isPaused() ? "warning"
			: waiting || (token && lastSyncAt === null) ? "neutral"
			: token ? "success" : "neutral";
		const stateDot = stateTone === "danger" ? "✕" : stateTone === "neutral" ? "○" : "●";
		const stateLabel: Text = !url && !pairingLink(pasted) && !token
			? { ko: "연결 안 됨", en: "Not connected" }
			: lastError ? { ko: "연결 실패", en: "Failed" }
			: isPaused() ? { ko: "일시 중지됨", en: "Paused" }
			: waiting || (token && lastSyncAt === null) ? { ko: "연결 중", en: "Connecting" }
			: token ? { ko: "연결됨", en: "Connected" }
			: { ko: "연결 안 됨", en: "Not connected" };
		const next = timer && nextPullAt > Date.now() ? until(nextPullAt) : null;
		const headPartsKo = [`${stateDot} ${stateLabel.ko}`];
		const headPartsEn = [`${stateDot} ${stateLabel.en}`];
		if (token && url) {
			headPartsKo.push(hostOf(url));
			headPartsEn.push(hostOf(url));
		}
		if (token && !isPaused() && !lastError) {
			if (pulling || busy) { headPartsKo.push("동기화 중…"); headPartsEn.push("syncing…"); }
			else if (next) { headPartsKo.push(`다음 ${next.ko}`); headPartsEn.push(`next ${next.en}`); }
		}
		if (lastSyncAt !== null) {
			if (lastError) { headPartsKo.push(`마지막 성공 ${ago(lastSyncAt).ko}`); headPartsEn.push(`last ok ${ago(lastSyncAt).en}`); }
			else { headPartsKo.push(`${ago(lastSyncAt).ko} 확인`); headPartsEn.push(`checked ${ago(lastSyncAt).en}`); }
		}
		const children: unknown[] = [
			{
				type: "text", id: isPaused() ? "paused-badge" : "state", size: "small", tone: stateTone,
				text: { ko: headPartsKo.join(" · "), en: headPartsEn.join(" · ") },
			},
		];
		if (!token) {
			children.push({ type: "text", id: "how", size: "small", tone: "neutral", text: { ko: "기준 서버의 기기 탭 → [연결 링크 복사]로 받은 링크를 아래 ‘연결 링크’에 붙여넣고 저장하세요.", en: "Paste the link from the primary's Devices tab → [Copy connection link] into ‘Connection link’ below, then save." } });
			const offActions = [...rulesButton(editingRules), ...backupButton(backups, confirming)];
			if (offActions.length) children.push({ type: "stack", id: "actions", direction: "horizontal", gap: "small", children: offActions });
		} else {
			if (lastApplied.length) {
				children.push({
					type: "text", id: "recent", size: "small", tone: "neutral",
					text: {
						ko: `최근 반영: ${lastApplied.slice(0, 3).map((k) => keyLabel(k).ko).join(", ")}${lastApplied.length > 3 ? ` 외 ${lastApplied.length - 3}개` : ""}`,
						en: `Last matched: ${lastApplied.slice(0, 3).map((k) => keyLabel(k).en).join(", ")}${lastApplied.length > 3 ? ` +${lastApplied.length - 3}` : ""}`,
					},
				});
			}
			children.push({ type: "stack", id: "actions", direction: "horizontal", gap: "small", children: [
				isPaused()
					? { type: "button", id: "resume-sync", variant: "primary", disabled: pulling || busy, label: { ko: "동기화 다시 시작", en: "Resume sync" } }
					: { type: "button", id: "sync", variant: "primary", disabled: pulling || busy, label: pulling ? { ko: "동기화 중…", en: "Syncing…" } : { ko: "지금 동기화", en: "Sync now" } },
				...rulesButton(editingRules),
				...backupButton(backups, confirming),
				{ type: "button", id: "disconnect", variant: "secondary", disabled: pulling, label: { ko: "연결 해제", en: "Disconnect" } },
			] });
		}
		children.push(...rulesListNodes(rules, editingRules || confirming));
		children.push(...rulesCard);
		children.push(...restoreCard);
		if (lastError) children.push({ type: "alert", id: "error", tone: "danger", title: errorTitle(lastError), text: lastError });
		if (token && needsInput.length && extEnabled) {
			// The alert carries the sentence; the list under it names each extension and what it lacks (an alert's text
			// is one paragraph, so a list inside it would run together).
			// What is true depends on the box: with 비밀값 on, whatever the primary holds already came, so the primary has no
			// value either (an app from before 0.9.5 kept a `secret` field on the device, and uploads it once when updated).
			const asked = settings().syncSecrets === true;
			children.push({ type: "alert", id: "needs-input", tone: "warning",
				title: { ko: "이 서버(기기)에서 직접 입력해야 하는 값이 있습니다", en: "Some values must be entered here" },
				text: asked
					? { ko: "아래 값은 기준 서버에도 아직 없습니다. 이 값을 입력해 둔 기기에서 앱(0.9.5 이상)을 한 번 열면 기준 서버에 올라가고, 다음 동기화 때 이 서버로 옵니다. 바로 쓰려면 설정 → 확장에서 해당 확장을 열어 입력하세요. 주소 같은 나머지 값은 이미 맞춰져 있습니다.", en: "The primary does not have the values below yet. Open the app (0.9.5 or later) once on a device where they were entered: they go up to the primary and come here with the next sync. To use the extension now, open it under Settings → Extensions and enter them. Addresses and the other values are already matched." }
					: { ko: "비밀값(토큰·키)은 기본으로 기준 서버에서 가져오지 않습니다. ‘API 키·토큰도 가져오기’를 켜거나(기준 서버도 허용해야 합니다), 설정 → 확장에서 해당 확장을 열어 한 번만 입력하세요. 주소 같은 나머지 값은 이미 맞춰져 있습니다.", en: "Secrets (tokens, keys) are not pulled by default. Turn on ‘Also pull API keys and tokens’ (the primary has to allow it too), or open the extension under Settings → Extensions and enter them once. Addresses and the other values are already matched." } });
			children.push({ type: "list", id: "needs-input-list", items: needsInput.slice(0, 20).map((n, i) => ({
				id: `n${i}`, title: n.title,
				description: { ko: `입력할 값: ${n.fields.join(" · ")}`, en: `To enter: ${n.fields.join(" · ")}` },
			})) });
		}
		if (token && skippedPaths.length) children.push({ type: "text", id: "paths", size: "small", tone: "neutral",
			text: { ko: `기준 서버의 작업 디렉터리(${skippedPaths.join(", ")})가 이 PC에 없어서, 이 서버의 작업 디렉터리를 그대로 씁니다.`, en: `The primary's working directory (${skippedPaths.join(", ")}) does not exist on this PC, so this server keeps its own.` } });
		if (token && refusedRows.length) children.push({ type: "text", id: "refused", size: "small", tone: "neutral",
			text: {
				ko: `이 서버가 받아들이지 않은 항목이 있어 이 서버 값을 그대로 둡니다: ${refusedRows.map((r) => `${keyLabel(r.key).ko} (${r.reason})`).join(", ")}. 기준 서버의 모델 연결 등을 이 서버에도 맞추면 다음 동기화 때 다시 가져옵니다.`,
				en: `This server did not accept some items and keeps its own: ${refusedRows.map((r) => `${keyLabel(r.key).en} (${r.reason})`).join(", ")}. Once it has what they need (a model connection, say), the next sync takes them.`,
			} });
		if (token && unlisted.length && extEnabled) children.push({ type: "alert", id: "unlisted", tone: "warning",
			title: { ko: "마켓플레이스에 없는 확장은 설치하지 않았습니다", en: "Extensions not in the marketplace were not installed" },
			text: { ko: `${unlisted.join(", ")} — 기준 서버에서 복사하려면 아래 ‘직접 만든 확장도 복사’를 켜세요.`, en: `${unlisted.join(", ")} — to copy them from the primary, turn on ‘Also copy extensions you made yourself’ below.` } });
		return { type: "stack", id: "status", gap: "small", children };
	};

	const status = (): Status => {
		const rules = activeRules();
		return {
			role: role(),
			url: cfg().url,
			intervalSeconds: cfg().interval,
			keys: allowedKeys(keys(), rules),
			syncExtensions: role() === "follower" && syncExtensions(rules),
			rulesFile: rulesFile(),
			lastSyncAt,
			lastApplied,
			lastError,
			status: statusText(),
			...(role() === "primary" ? { followers: followerList().map((f) => ({ name: f.name, url: f.url, lastSyncAt: f.lastAt })) } : {}),
		};
	};

	// ---- what a peer reads: the rows this server mirrors and the keys they cover ----

	pi.registerMethod("snapshot", async (params: unknown): Promise<Snapshot> => {
		if (isPaused()) throw new Error("sync is paused on the primary");
		const rules = activeRules();
		const list = allowedKeys(keys(), rules);
		const rawSettings = readSettings(dbo(), list);
		let ignoredMcp: string[] | undefined;
		if ("mcp_servers" in rawSettings) {
			const allMcp = mcpMap(rawSettings.mcp_servers);
			const kept: Record<string, Record<string, unknown>> = {};
			const hidden: string[] = [];
			for (const [name, entry] of Object.entries(allMcp)) {
				if (isIgnoredPath(rules, `mcp/${name}`)) hidden.push(name);
				else kept[name] = entry;
			}
			if (hidden.length) {
				rawSettings.mcp_servers = mcpArray(rawSettings.mcp_servers, kept);
				ignoredMcp = hidden;
			}
		}
		const snap: Snapshot = {
			keys: list,
			settings: rawSettings,
			...(ignoredMcp?.length ? { ignoredMcp } : {}),
			push: 2,
		};
		// A follower (0.17.0+) says who it is: the page lists it. Only on a primary; a code fetch (`codeOf`) sends nothing.
		const from = role() === "primary" && plain(params) ? followerFrom(params.from) : null;
		if (from) sawFollower(from);
		// Only when the follower asks: most never want them, and they are the bulkiest part.
		// Secrets of extensions (their own settings file) go only when this server's owner allows it AND the follower asked.
		if (plain(params) && params.extensions === true) {
			const withSec = settings().shareSecrets === true && params.secrets === true;
			const all = shareable(await extensionSettings(), withSec);
			const filtered: Record<string, Record<string, unknown>> = {};
			for (const [id, val] of Object.entries(all)) {
				if (isIgnoredPath(rules, `extensions/${id}/settings`)) continue;
				filtered[id] = withSec
					? Object.fromEntries(Object.entries(val).filter(([k]) => !CREDENTIAL_KEY.test(k) || (!isIgnoredPath(rules, `secrets/extensions/${id}`) && !isIgnoredPath(rules, `secrets/extensions/${id}/${k}`))))
					: val;
			}
			snap.extensions = filtered;
		}
		const asked = plain(params) && Array.isArray(params.parts) ? params.parts.filter((p): p is Part => typeof p === "string" && p in PARTS) : [];
		// The code of extensions, for those the follower cannot get from the marketplace: only the ids it names.
		const codeOf = plain(params) && Array.isArray(params.codeOf)
			? params.codeOf.filter((x): x is string => typeof x === "string" && EXTENSION_ID.test(x) && x !== SELF_ID && !isIgnoredPath(rules, `extensions/${x}/code`) && !isIgnoredPath(rules, `extensions/${x}/install`)).slice(0, 50)
			: [];
		if (asked.length) snap.environment = await readEnvironment(asked, rules);
		if (codeOf.length) {
			const env = (snap.environment ??= {});
			const srvList = env.serverExtensions ?? (await installedServerExtensions()).filter((e) => !isIgnoredPath(rules, `extensions/${e.id}/install`));
			env.serverExtensions = srvList.map((e) => (codeOf.includes(e.id) ? { ...e, files: extensionFiles(e.id) } : e));
		}
		return snap;
	});

	/** This server's environment parts, as a follower asked for them (filtered by this server's sync rules). */
	const readEnvironment = async (parts: readonly Part[], rules: readonly SyncRule[] = activeRules()): Promise<Environment> => {
		const env: Environment = {};
		const home = typeof pi.home === "string" && pi.home ? pi.home : homedir();
		for (const part of parts) {
			try {
				if (part === "serverExtensions") {
					env.serverExtensions = (await installedServerExtensions()).filter((e) => !isIgnoredPath(rules, `extensions/${e.id}/install`));
				} else if (part === "clientExtensions") {
					env.clientExtensions = filterClientExtensionsByRules(rules, await clientExtensionRows());
				} else if (part === "skills") {
					env.skills = filterFoldersByRules(rules, "skills", readFolders(join(home, ".agents", "skills")));
				} else if (part === "subagents") {
					const all = readFiles(join(home, ".agents", "subagents"), /\.md$/);
					env.subagents = Object.fromEntries(Object.entries(all).filter(([name]) => !isIgnoredPath(rules, `subagents/${name.replace(/\.md$/i, "")}`)));
				} else if (part === "agentsMd") {
					if (!isIgnoredPath(rules, "agents-md")) env.agentsMd = readText(join(home, ".agents", "AGENTS.md"));
				} else if (part === "providers") {
					const all = await providerRows();
					env.providers = Object.fromEntries(Object.entries(all).filter(([id]) => !isIgnoredPath(rules, `providers/${id}`)));
				} else if (part === "apiKeys") {
					const all = apiKeyRows();
					env.apiKeys = Object.fromEntries(Object.entries(all).filter(([id]) => !isIgnoredPath(rules, `secrets/providers/${id}`)));
				} else if (part === "agentExtensions") {
					const dir = join(home, ".agents", "extensions");
					const files = Object.fromEntries(Object.entries(readFiles(dir, /\.(ts|js|mjs)$/)).filter(([name]) => !isIgnoredPath(rules, `agent-extensions/${name}`)));
					const folders = filterFoldersByRules(rules, "agent-extensions", readFolders(dir));
					env.agentExtensions = { files, folders };
				}
			} catch (e) {
				log(`snapshot ${part}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return env;
	};

	/**
	 * Server extensions installed in the server's extensions folder (not `~/.agents/extensions`, which are the owner's own
	 * files), with their versions: `GET /server-extensions`, else read from the data folder.
	 */
	const installedServerExtensions = async (): Promise<InstalledExtension[]> => {
		if (hasApi) {
			const body = await ownRead("/server-extensions");
			const mineDir = join(agentsHome(), ".agents", "extensions") + sep;
			const out = new Map<string, InstalledExtension>();
			for (const e of Array.isArray(body?.extensions) ? body.extensions : []) {
				if (!plain(e) || typeof e.name !== "string" || typeof e.version !== "string") continue;
				const id = e.name.split("/")[0]!;
				if (id === SELF_ID || !EXTENSION_ID.test(id) || (typeof e.path === "string" && e.path.startsWith(mineDir))) continue;
				if (!out.has(id)) out.set(id, { id, version: e.version });
			}
			return [...out.values()];
		}
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

	/** The extensions this server keeps for its apps (`/client-settings`): the list and which are on. */
	const clientExtensionRows = async () => ({ list: await clientSetting("extensions"), states: await clientSetting("extensionStates") });

	/**
	 * Model API keys of this server (credentials of type api_key; a login (oauth) is tied to this server and never copied).
	 * Served only when the owner of THIS server allows it (`shareSecrets`): the follower asking is not enough, because
	 * a key leaves the machine. The link is the Tailscale address and a revocable device token, but it is still a key.
	 * Read from the database on every server: the app has no route that hands a stored key back, by design.
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

	/** Custom model providers without anything secret (the key is a credential, kept apart). */
	const providerRows = async (): Promise<Record<string, Record<string, unknown>>> =>
		Object.fromEntries(Object.entries(await storedProviders()).map(([id, v]) => [id, publicOf(v)]));

	pi.registerMethod("status", () => status());

	const agentsHome = () => (typeof pi.home === "string" && pi.home ? pi.home : homedir());
	/** This server's items of one two-way kind, by id (filtered by `rules` when provided). */
	const localItems = async (kind: Kind, list: readonly string[], rules?: readonly SyncRule[], skipMcp?: ReadonlySet<string>): Promise<Record<string, unknown>> => {
		const home = agentsHome();
		if (kind === "rows") return readSettings(dbo(), list);
		if (kind === "mcp") {
			const all = mcpMap(readSettings(dbo(), ["mcp_servers"]).mcp_servers);
			if (!rules && !skipMcp) return all;
			return Object.fromEntries(Object.entries(all).filter(([name]) => (!rules || !isIgnoredPath(rules, `mcp/${name}`)) && !skipMcp?.has(name)));
		}
		if (kind === "ext") {
			const all = shareable(await extensionSettings());
			return rules ? Object.fromEntries(Object.entries(all).filter(([id]) => !isIgnoredPath(rules, `extensions/${id}/settings`))) : all;
		}
		if (kind === "skill") {
			const all = readFolders(join(home, ".agents", "skills"));
			return rules ? filterFoldersByRules(rules, "skills", all) : all;
		}
		if (kind === "helper") {
			const all = readFiles(join(home, ".agents", "subagents"), /\.md$/);
			return rules ? Object.fromEntries(Object.entries(all).filter(([name]) => !isIgnoredPath(rules, `subagents/${name.replace(/\.md$/i, "")}`))) : all;
		}
		if (kind === "agentsMd") {
			if (rules && isIgnoredPath(rules, "agents-md")) return {};
			const t = readText(join(home, ".agents", "AGENTS.md"));
			return t === null ? {} : { "AGENTS.md": t };
		}
		const all = await providerRows();
		return rules ? Object.fromEntries(Object.entries(all).filter(([id]) => !isIgnoredPath(rules, `providers/${id}`))) : all;
	};
	const hashOfItem = (kind: Kind, v: unknown): string =>
		kind === "ext" ? itemHash(plain(v) ? publicOf(v) : undefined) : kind === "provider" ? providerHash(plain(v) ? v : undefined) : itemHash(v);
	const hashesOf = (kind: Kind, items: Record<string, unknown>): Record<string, string> =>
		Object.fromEntries(Object.entries(items).map(([id, v]) => [id, hashOfItem(kind, v)]));

	/**
	 * A follower's own changes, made there since the last sync (it decided that; the primary wins a conflict by sending
	 * its value back on the next pull). Taken only on the primary, only for what this server mirrors anyway (and not
	 * excluded by this server's `syncignore`), and never a secret, an install or code: settings rows, individual MCP
	 * servers, the public settings of extensions installed here, skill/helper/AGENTS.md text and model connections.
	 * Each goes through this server's own route or the same writes a pull does, so this server's apps hear about it.
	 * The caller is a paired device (the follower's token), like any client of this server.
	 */
	pi.registerMethod("push", async (params: unknown) => {
		if (role() !== "primary") throw new Error("this server is not a primary");
		if (isPaused()) throw new Error("sync is paused on the primary");
		if (!plain(params)) throw new Error("nothing to push");
		const rules = activeRules();
		const changed: string[] = [];
		const list = allowedKeys(keys(), rules);
		let refused: string[] = [];
		const hasMcpParam = plain(params.mcp);
		const before = await captureBefore({
			rowKeys: (plain(params.settings) || Array.isArray(params.deleted) || hasMcpParam) ? list : undefined,
			extensions: plain(params.extensions),
			skills: plain(params.skills),
			subagents: plain(params.subagents),
			agentsMd: typeof params.agentsMd === "string",
			providers: plain(params.providers),
		});
		if (plain(params.settings) || Array.isArray(params.deleted)) {
			const rows = plain(params.settings) ? params.settings : {};
			const gone = Array.isArray(params.deleted) ? params.deleted.filter((k): k is string => typeof k === "string") : [];
			const touched = [...new Set([...Object.keys(rows), ...gone])].filter((k) => list.includes(k) && !(k === "mcp_servers" && hasMcpParam));
			const curRows = readSettings(dbo(), touched);
			const next: Record<string, unknown> = { ...curRows };
			for (const k of touched) {
				if (k === "mcp_servers") {
					// Legacy follower pushing whole mcp_servers row: preserve MCP servers ignored on primary.
					const curMcp = mcpMap(curRows.mcp_servers);
					const keptIgnored = Object.fromEntries(Object.entries(curMcp).filter(([n]) => isIgnoredPath(rules, `mcp/${n}`)));
					if (k in rows) {
						const incoming = Object.fromEntries(Object.entries(mcpMap(rows[k])).filter(([n]) => !isIgnoredPath(rules, `mcp/${n}`)));
						next[k] = mcpArray(curRows.mcp_servers, { ...keptIgnored, ...incoming });
					} else if (gone.includes(k)) {
						if (Object.keys(keptIgnored).length) next[k] = mcpArray(curRows.mcp_servers, keptIgnored);
						else delete next[k];
					}
					continue;
				}
				if (k in rows && fitsHere(k, rows[k])) next[k] = rows[k];
				else if (gone.includes(k)) delete next[k];
			}
			// A value this server refuses (a model it does not have) stays its own, and the primary wins it back on the
			// next pull: its hash below is one that matches nothing, so the follower sees the primary's value as changed.
			const res = await applyRows(touched, next);
			changed.push(...res.changed);
			refused = res.refused.map((r) => r.key);
		}
		const pushedMcpNames: string[] = [];
		let mcpRefused = false;
		if (hasMcpParam && list.includes("mcp_servers")) {
			const p = params.mcp as Record<string, unknown>;
			const upserted = plain(p.upserted) ? p.upserted : {};
			const deleted = Array.isArray(p.deleted) ? p.deleted.filter((x): x is string => typeof x === "string") : [];
			const curRaw = readSettings(dbo(), ["mcp_servers"]).mcp_servers;
			const nextMap = mcpMap(curRaw);
			let touchedMcp = false;
			for (const [name, val] of Object.entries(upserted)) {
				const trimmed = name.trim();
				if (!trimmed || !plain(val) || isIgnoredPath(rules, `mcp/${trimmed}`)) continue;
				nextMap[trimmed] = { ...val, name: trimmed };
				pushedMcpNames.push(trimmed);
				touchedMcp = true;
			}
			for (const name of deleted) {
				const trimmed = name.trim();
				if (!trimmed || isIgnoredPath(rules, `mcp/${trimmed}`)) continue;
				delete nextMap[trimmed];
				pushedMcpNames.push(trimmed);
				touchedMcp = true;
			}
			if (touchedMcp) {
				const merged = mcpArray(curRaw, nextMap);
				const res = await applyRows(["mcp_servers"], merged.length ? { mcp_servers: merged } : {});
				changed.push(...res.changed);
				if (res.refused.some((r) => r.key === "mcp_servers")) mcpRefused = true;
			}
		}
		if (plain(params.extensions)) {
			const all = await extensionSettings();
			// Only for an extension this server has (installed, or with settings already): never a new one from a follower.
			const installed = new Set((await installedServerExtensions()).map((e) => e.id));
			for (const [id, value] of Object.entries(params.extensions)) {
				if (id === SELF_ID || !EXTENSION_ID.test(id) || !plain(value) || !(id in all || installed.has(id))) continue;
				if (isIgnoredPath(rules, `extensions/${id}/settings`)) continue;
				const current = all[id] ?? {};
				// never a secret from the follower, and this server's own secrets stay
				const next = { ...publicOf(value), ...Object.fromEntries(Object.entries(current).filter(([k]) => CREDENTIAL_KEY.test(k))) };
				if (sameObject(current, next)) continue;
				const res = await own("PUT", `/extensions/${id}/settings`, { settings: next });
				if (!res.ok) throw new Error(`could not save the settings of ${id} (${res.status})`);
				changed.push(`ext:${id}`);
			}
		}
		const home = agentsHome();
		if (plain(params.skills)) {
			const allowedSkills = filterFoldersByRules(rules, "skills", params.skills as Record<string, FileSet>);
			changed.push(...applyFolders(join(home, ".agents", "skills"), allowedSkills, "skill", (name, rel) => isIgnoredPath(rules, `skills/${name}/${rel}`)));
		}
		if (plain(params.subagents)) {
			const allowedSub = Object.fromEntries(Object.entries(params.subagents as FileSet).filter(([name]) => !isIgnoredPath(rules, `subagents/${name.replace(/\.md$/i, "")}`)));
			changed.push(...applyFiles(join(home, ".agents", "subagents"), allowedSub, /\.md$/, "helper"));
		}
		if (typeof params.agentsMd === "string" && !isIgnoredPath(rules, "agents-md")) {
			changed.push(...applyText(join(home, ".agents", "AGENTS.md"), params.agentsMd, "agents-md"));
		}
		if (plain(params.providers)) {
			const clean = Object.fromEntries(
				Object.entries(params.providers)
					.filter(([id, v]) => plain(v) && !isIgnoredPath(rules, `providers/${id}`))
					.map(([id, v]) => [id, publicOf(v as Record<string, unknown>)]),
			);
			changed.push(...(await applyProviders(clean)));
		}
		if (changed.length) {
			commitBackup("push", changed, before);
			log(`took from a follower: ${changed.join(", ")}`);
			pi.emit(null, "synced", { keys: changed, at: Date.now(), from: "follower" }, { ephemeral: true });
			showStatus();
		}
		// What this server holds now for every item it was sent, hashed as a follower hashes it: the follower's next
		// comparison starts from there, so a value this server stores a little differently is not a change.
		const sent: Partial<Record<Kind, string[]>> = {
			rows: [...Object.keys(plain(params.settings) ? params.settings : {}), ...(Array.isArray(params.deleted) ? params.deleted.filter((k): k is string => typeof k === "string") : [])],
			mcp: [...new Set(pushedMcpNames)],
			ext: Object.keys(plain(params.extensions) ? params.extensions : {}),
			skill: Object.keys(plain(params.skills) ? params.skills : {}),
			helper: Object.keys(plain(params.subagents) ? params.subagents : {}),
			agentsMd: typeof params.agentsMd === "string" ? ["AGENTS.md"] : [],
			provider: Object.keys(plain(params.providers) ? params.providers : {}),
		};
		const hashes: Partial<Record<Kind, Record<string, string>>> = {};
		for (const [kind, ids] of Object.entries(sent) as [Kind, string[]][]) {
			if (!ids.length) continue;
			const now = await localItems(kind, kind === "rows" ? ids.filter((k) => list.includes(k)) : [], rules);
			hashes[kind] = Object.fromEntries(ids.map((id) => [
				id,
				(kind === "rows" && refused.includes(id)) || (kind === "mcp" && mcpRefused) ? "refused" : hashOfItem(kind, now[id]),
			]));
		}
		return { applied: changed, hashes };
	});

	/** How the primary's Devices tab names this follower: the name it gave itself, else this machine and its address. */
	const followerLabel = (): string => {
		const given = String(settings().followerName ?? "").trim();
		if (given) return given.slice(0, 60);
		const ip = publicUrl().replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		return `Server Sync · ${hostname()}${ip ? ` (${ip})` : ""}`.slice(0, 60);
	};

	/**
	 * The address a follower should dial, and a one-time pairing code for it. The code is the app's own mechanism
	 * (`POST /pairing` -> `POST /pairing/redeem`): it is worth nothing after it expires, and redeeming it mints a
	 * revocable device token instead of handing out the admin token.
	 */
	pi.registerMethod("code", async () => {
		const url = publicUrl();
		if (!url) throw new Error("this server has no address to share");
		// An older server is asked at the address it hands out: that is the one known to answer.
		const res = hasApi ? await own("POST", "/pairing") : await legacy.request("POST", "/pairing", null, url, 5_000);
		if (!res.ok) throw new Error(`could not make a code (${res.status})`);
		const code = plain(res.body) && typeof res.body.code === "string" ? res.body.code : "";
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
		const rules = activeRules();
		const withExtensions = syncExtensions(rules);
		const parts: Part[] = [];
		if (mayIncludeNamespace(rules, "extensions", "install")) parts.push("serverExtensions");
		if (mayIncludeNamespace(rules, "extensions", "client")) parts.push("clientExtensions");
		if (mayIncludeNamespace(rules, "skills")) parts.push("skills");
		if (mayIncludeNamespace(rules, "subagents")) parts.push("subagents");
		if (mayIncludeNamespace(rules, "agents-md")) parts.push("agentsMd");
		if (mayIncludeNamespace(rules, "providers")) parts.push("providers");
		if (wantSecrets() && mayIncludeNamespace(rules, "secrets/providers")) parts.push("apiKeys");
		if (wantLocalExtensions() && mayIncludeNamespace(rules, "agent-extensions")) parts.push("agentExtensions");
		const res = await fetch(`${url}/server-extensions/server-sync/methods/snapshot`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				...(withExtensions ? { extensions: true, ...(wantSecrets() && mayIncludeNamespace(rules, "secrets/extensions") ? { secrets: true } : {}) } : {}),
				...(parts.length ? { parts } : {}),
				// who is pulling, for the primary's page: never the token or anything secret
				from: { id: selfId(), name: followerLabel(), url: publicUrl(), interval: cfg().interval },
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 401 || res.status === 403) throw new Error(`the peer refused the token (${res.status})`);
		if (!res.ok) throw new Error(`the peer answered ${res.status}`);
		const body = (await res.json()) as { result?: { keys?: unknown; settings?: unknown; ignoredMcp?: unknown; extensions?: unknown; environment?: unknown; push?: unknown } };
		const peer = body.result?.settings;
		if (!peer || typeof peer !== "object" || Array.isArray(peer)) throw new Error("the peer returned no settings");
		const allAllowed = allowedKeys(mirrorKeys(body.result?.keys, keys()), rules);
		const list = allAllowed.filter((k) => k !== "mcp_servers");
		const syncMcp = allAllowed.includes("mcp_servers");
		const primaryIgnoredMcp = new Set(Array.isArray(body.result?.ignoredMcp) ? body.result.ignoredMcp.filter((x): x is string => typeof x === "string") : []);
		const changed: string[] = [];
		// Two ways only with a primary that takes changes (0.14.0+); push >= 2 supports per-server MCP push (0.19.0+).
		const pushVersion = typeof body.result?.push === "number" ? body.result.push : 0;
		const twoWay = pushVersion >= 1;
		const base = readBase(url);
		const planned: Kind[] = [];
		/** Decide every item of one kind: what comes down, what goes up; the items already equal are recorded at once. */
		const plan = async (kind: Kind, theirs: Record<string, unknown>, ids?: readonly string[]) => {
			planned.push(kind);
			const mine = await localItems(kind, list, rules, kind === "mcp" ? primaryIgnoredMcp : undefined);
			const items = (base.items[kind] ??= {});
			const p = hashesOf(kind, theirs);
			const f = hashesOf(kind, mine);
			const first = !twoWay || !base.seen.includes(kind);
			const known = base.items[kind] ?? {};
			const out = { pull: [] as string[], push: [] as string[], mine, p };
			const deletes = kind === "rows" || kind === "mcp";
			for (const id of ids ?? [...new Set([...Object.keys(theirs), ...Object.keys(mine)])]) {
				const hp = p[id] ?? "";
				const hf = f[id] ?? "";
				// a row or MCP server never seen while enabled (just re-included) starts by pulling
				const fresh = deletes && base.seen.includes(kind) && !(id in known) && (hp !== "" || hf === "");
				const d = decide(hp, hf, items[id], { first: first || fresh, deletes });
				if (d === "pull") out.pull.push(id);
				else if (d === "push" && twoWay) out.push.push(id);
				else if (d === "keep") items[id] = "local";
				else if (!hp && !hf) delete items[id];
				else if (d === "same") items[id] = { p: hp, f: hf };
			}
			return out;
		};
		/** After pulling: both sides now hold the primary's value, hashed as each stores it. */
		const settle = async (kind: Kind, ids: readonly string[], p: Record<string, string>) => {
			if (!ids.length) return;
			const now = hashesOf(kind, await localItems(kind, list, rules, kind === "mcp" ? primaryIgnoredMcp : undefined));
			const items = (base.items[kind] ??= {});
			for (const id of ids) {
				const hp = p[id] ?? "";
				const hf = now[id] ?? "";
				if (!hp && !hf) delete items[id];
				else items[id] = { p: hp, f: hf };
			}
		};
		/** What goes up, gathered over every kind and sent once the pulls are done. */
		const up: { kind: Kind; ids: string[]; mine: Record<string, unknown> }[] = [];
		const peerRows = Object.fromEntries(list.filter((k) => k in peer).map((k) => [k, (peer as Record<string, unknown>)[k]]));
		// Excluded items forget their baseline: if re-included later, they start cleanly by pulling.
		for (const k of Object.keys(base.items.rows ?? {})) if (!list.includes(k)) delete base.items.rows![k];
		const rows = await plan("rows", peerRows, list);
		const unfit = rows.pull.filter((k) => !fitsHere(k, peerRows[k]));
		if (unfit.length) {
			rows.pull = rows.pull.filter((k) => !unfit.includes(k));
			for (const k of unfit) (base.items.rows ??= {})[k] = "local";
			skippedPaths = unfit.map((k) => String(peerRows[k]));
		} else skippedPaths = [];

		// Individual MCP server sync (per-server merge, baseline, and push).
		let mcpPlan: { pull: string[]; push: string[]; mine: Record<string, unknown>; p: Record<string, string> } | null = null;
		let peerMcp: Record<string, Record<string, unknown>> = {};
		if (syncMcp) {
			const rawPeerMcp = "mcp_servers" in peer ? mcpMap((peer as Record<string, unknown>).mcp_servers) : {};
			peerMcp = Object.fromEntries(Object.entries(rawPeerMcp).filter(([name]) => !isIgnoredPath(rules, `mcp/${name}`) && !primaryIgnoredMcp.has(name)));
			for (const name of Object.keys(base.items.mcp ?? {})) {
				if (isIgnoredPath(rules, `mcp/${name}`) || primaryIgnoredMcp.has(name)) delete base.items.mcp![name];
			}
			mcpPlan = await plan("mcp", peerMcp);
		}

		// Server extensions first: a pulled extension's settings need the extension installed to mean anything.
		// A primary older than 0.10.0 sends no environment: nothing to do, not an error.
		const env = plain(body.result?.environment) ? (body.result.environment as Environment) : {};
		const beforeRowKeys = [...rows.pull, ...(mcpPlan?.pull.length ? ["mcp_servers"] : [])];
		const before = await captureBefore({
			rowKeys: beforeRowKeys.length ? beforeRowKeys : undefined,
			extensions: withExtensions && plain(body.result?.extensions),
			clientExtensions: parts.includes("clientExtensions") && plain(env.clientExtensions),
			skills: parts.includes("skills") && plain(env.skills),
			subagents: parts.includes("subagents") && plain(env.subagents),
			agentsMd: parts.includes("agentsMd") && "agentsMd" in env,
			providers: parts.includes("providers") && plain(env.providers),
		});
		// A value this server's route refuses (a model it does not have) is not taken and not settled: it is tried again
		// on the next sync, and this server keeps its own until then.
		const applied = rows.pull.length ? await applyRows(rows.pull, peer as Record<string, unknown>) : { changed: [], refused: [] };
		changed.push(...applied.changed);
		refusedRows = applied.refused;
		await settle("rows", rows.pull.filter((k) => !applied.refused.some((r) => r.key === k)), rows.p);
		up.push({ kind: "rows", ids: rows.push, mine: rows.mine });

		if (mcpPlan) {
			if (mcpPlan.pull.length) {
				const curRaw = readSettings(dbo(), ["mcp_servers"]).mcp_servers;
				const nextMap = mcpMap(curRaw);
				for (const name of mcpPlan.pull) {
					if (name in peerMcp) nextMap[name] = peerMcp[name]!;
					else delete nextMap[name];
				}
				const hasKept = Object.keys(nextMap).length > 0;
				const mergedVal = hasKept ? { mcp_servers: mcpArray(curRaw, nextMap) } : ("mcp_servers" in peer ? { mcp_servers: [] } : {});
				const mcpApplied = await applyRows(["mcp_servers"], mergedVal);
				changed.push(...mcpApplied.changed);
				if (mcpApplied.refused.length) refusedRows = [...refusedRows, ...mcpApplied.refused];
				else await settle("mcp", mcpPlan.pull, mcpPlan.p);
			}
			up.push({ kind: "mcp", ids: mcpPlan.push, mine: mcpPlan.mine });
		}

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
			changed.push(...(await applyServerExtensions(env.serverExtensions, fetchCode, rules)));
		}
		const pick = <T,>(from: Record<string, T>, ids: readonly string[]) => Object.fromEntries(ids.filter((id) => id in from).map((id) => [id, from[id]!]));
		// A primary older than 0.8.0 sends no extensions: nothing to do, not an error.
		if (withExtensions && plain(body.result?.extensions)) {
			const rawTheirs = body.result.extensions as Record<string, Record<string, unknown>>;
			const theirs: Record<string, Record<string, unknown>> = {};
			for (const [id, v] of Object.entries(rawTheirs)) {
				if (!plain(v) || isIgnoredPath(rules, `extensions/${id}/settings`)) continue;
				theirs[id] = wantSecrets()
					? Object.fromEntries(Object.entries(v).filter(([k]) => !CREDENTIAL_KEY.test(k) || (!isIgnoredPath(rules, `secrets/extensions/${id}`) && !isIgnoredPath(rules, `secrets/extensions/${id}/${k}`))))
					: v;
			}
			for (const id of Object.keys(base.items.ext ?? {})) if (isIgnoredPath(rules, `extensions/${id}/settings`)) delete base.items.ext![id];
			const ext = await plan("ext", theirs);
			changed.push(...(await applyExtensions(pick(theirs, ext.pull))));
			// A secret the primary sent (비밀값 on both sides) fills a gap here even when nothing else differs.
			if (wantSecrets()) {
				const fill: Record<string, Record<string, unknown>> = {};
				const all = await extensionSettings();
				for (const [id, v] of Object.entries(theirs)) {
					if (ext.pull.includes(id) || !plain(v)) continue;
					const cur = all[id] ?? {};
					const lacking = Object.entries(v).filter(([k, x]) => CREDENTIAL_KEY.test(k) && x !== "" && x !== null && x !== undefined && (cur[k] === undefined || cur[k] === null || cur[k] === ""));
					if (lacking.length) fill[id] = { ...cur, ...Object.fromEntries(lacking) };
				}
				changed.push(...(await applyExtensions(fill)));
			}
			await settle("ext", ext.pull, ext.p);
			up.push({ kind: "ext", ids: ext.push, mine: ext.mine });
		}
		const home = agentsHome();
		if (parts.includes("clientExtensions") && plain(env.clientExtensions)) changed.push(...(await applyClientExtensions(env.clientExtensions, rules)));
		if (parts.includes("skills") && plain(env.skills)) {
			const theirs = filterFoldersByRules(rules, "skills", env.skills as Record<string, FileSet>);
			for (const name of Object.keys(base.items.skill ?? {})) {
				if (isIgnoredPath(rules, `skills/${name}`) && !(name in theirs)) delete base.items.skill![name];
			}
			const r = await plan("skill", theirs);
			changed.push(...applyFolders(join(home, ".agents", "skills"), pick(theirs, r.pull), "skill", (name, rel) => isIgnoredPath(rules, `skills/${name}/${rel}`)));
			await settle("skill", r.pull, r.p);
			up.push({ kind: "skill", ids: r.push, mine: r.mine });
		}
		if (parts.includes("subagents") && plain(env.subagents)) {
			const theirs = Object.fromEntries(Object.entries(env.subagents as FileSet).filter(([name]) => !isIgnoredPath(rules, `subagents/${name.replace(/\.md$/i, "")}`)));
			for (const name of Object.keys(base.items.helper ?? {})) {
				if (isIgnoredPath(rules, `subagents/${name.replace(/\.md$/i, "")}`)) delete base.items.helper![name];
			}
			const r = await plan("helper", theirs);
			changed.push(...applyFiles(join(home, ".agents", "subagents"), pick(theirs, r.pull), /\.md$/, "helper"));
			await settle("helper", r.pull, r.p);
			up.push({ kind: "helper", ids: r.push, mine: r.mine });
		}
		if (parts.includes("agentsMd") && "agentsMd" in env && !isIgnoredPath(rules, "agents-md")) {
			const theirs: Record<string, string> = typeof env.agentsMd === "string" ? { "AGENTS.md": env.agentsMd } : {};
			const r = await plan("agentsMd", theirs, ["AGENTS.md"]);
			if (r.pull.length) changed.push(...applyText(join(home, ".agents", "AGENTS.md"), theirs["AGENTS.md"] ?? null, "agents-md"));
			await settle("agentsMd", r.pull, r.p);
			up.push({ kind: "agentsMd", ids: r.push, mine: r.mine });
		}
		if (parts.includes("providers") && plain(env.providers)) {
			const theirs = Object.fromEntries(Object.entries(env.providers as Record<string, Record<string, unknown>>).filter(([id]) => !isIgnoredPath(rules, `providers/${id}`)));
			for (const id of Object.keys(base.items.provider ?? {})) if (isIgnoredPath(rules, `providers/${id}`)) delete base.items.provider![id];
			const r = await plan("provider", theirs);
			changed.push(...(await applyProviders(pick(theirs, r.pull))));
			await settle("provider", r.pull, r.p);
			up.push({ kind: "provider", ids: r.push, mine: r.mine });
		}
		// A kind no longer synced forgets its history: turned on again later, it starts by pulling, like the first time.
		for (const kind of Object.keys(base.items) as Kind[]) if (!planned.includes(kind)) delete base.items[kind];
		base.seen = twoWay ? [...planned] : base.seen.filter((k) => planned.includes(k));
		writeBase(base);
		if (changed.length) commitBackup("pull", changed, before);
		// Then what changed here goes up. A failure leaves the history as it was, so the next sync tries again.
		const sendUp = async (params: Record<string, unknown>): Promise<{ applied: string[]; hashes: Partial<Record<Kind, Record<string, string>>> }> => {
			const r = await fetch(`${url}/server-extensions/server-sync/methods/push`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(params),
				signal: AbortSignal.timeout(30_000),
			});
			if (!r.ok) throw new Error(`could not send this server's changes to the primary (${r.status}: ${(await r.text()).slice(0, 200)})`);
			const b = (await r.json()) as { result?: { applied?: unknown; hashes?: unknown } };
			return {
				applied: Array.isArray(b.result?.applied) ? b.result.applied.filter((x): x is string => typeof x === "string") : [],
				hashes: plain(b.result?.hashes) ? (b.result.hashes as Partial<Record<Kind, Record<string, string>>>) : {},
			};
		};
		const batches: Record<string, unknown>[] = [];
		const main: Record<string, unknown> = {};
		let legacyMcpFallback = false;
		for (const { kind, ids, mine } of up) {
			if (!ids.length) continue;
			if (kind === "rows") {
				main.settings = pick(mine, ids);
				main.deleted = ids.filter((id) => !(id in mine));
			} else if (kind === "mcp") {
				if (pushVersion >= 2) {
					main.mcp = {
						upserted: pick(mine, ids),
						deleted: ids.filter((id) => !(id in mine)),
					};
				} else {
					// Pre-0.19 primary only accepts whole `mcp_servers` row: only push if no local MCP servers are hidden.
					const fullLocal = mcpMap(readSettings(dbo(), ["mcp_servers"]).mcp_servers);
					const hasHiddenLocal = Object.keys(fullLocal).some((n) => isIgnoredPath(rules, `mcp/${n}`) || primaryIgnoredMcp.has(n));
					if (!hasHiddenLocal) {
						const arr = mcpArray(readSettings(dbo(), ["mcp_servers"]).mcp_servers, mine as Record<string, Record<string, unknown>>);
						if (arr.length) main.settings = { ...(plain(main.settings) ? main.settings : {}), mcp_servers: arr };
						else main.deleted = [...(Array.isArray(main.deleted) ? main.deleted : []), "mcp_servers"];
						legacyMcpFallback = true;
					}
				}
			} else if (kind === "ext") main.extensions = Object.fromEntries(ids.filter((id) => id in mine).map((id) => [id, publicOf(mine[id] as Record<string, unknown>)]));
			else if (kind === "helper") main.subagents = pick(mine, ids);
			else if (kind === "agentsMd") { if (typeof mine["AGENTS.md"] === "string") main.agentsMd = mine["AGENTS.md"]; }
			else if (kind === "provider") main.providers = Object.fromEntries(ids.filter((id) => id in mine).map((id) => [id, publicOf(mine[id] as Record<string, unknown>)]));
			// a skill can be up to 2 MB: one request each, under the server's body limit
			else if (kind === "skill") for (const id of ids) if (id in mine) batches.push({ skills: { [id]: mine[id] } });
		}
		if (Object.keys(main).length) batches.unshift(main);
		for (const params of batches) {
			const res = await sendUp(params);
			changed.push(...res.applied.map((k) => `up:${k}`));
			for (const { kind, ids, mine } of up) {
				const got = res.hashes[kind];
				if (!got) {
					if (kind === "mcp" && legacyMcpFallback && res.hashes.rows && "mcp_servers" in res.hashes.rows && res.hashes.rows.mcp_servers !== "refused") {
						const items = (base.items.mcp ??= {});
						const f = hashesOf("mcp", mine);
						for (const id of ids) {
							if (!f[id]) delete items[id];
							else items[id] = { p: f[id]!, f: f[id]! };
						}
					}
					continue;
				}
				const items = (base.items[kind] ??= {});
				const f = hashesOf(kind, mine);
				for (const id of ids) {
					if (!(id in got)) continue;
					const hp = typeof got[id] === "string" ? got[id]! : "";
					if (!hp && !f[id]) delete items[id];
					else items[id] = { p: hp, f: f[id] ?? "" };
				}
			}
			writeBase(base);
		}
		if (parts.includes("apiKeys") && plain(env.apiKeys)) {
			const allowedKeysMap = Object.fromEntries(Object.entries(env.apiKeys as Record<string, string>).filter(([id]) => !isIgnoredPath(rules, `secrets/providers/${id}`)));
			changed.push(...(await applyApiKeys(allowedKeysMap)));
		}
		if (parts.includes("agentExtensions") && plain(env.agentExtensions)) {
			const dir = join(home, ".agents", "extensions");
			const a = env.agentExtensions as { files?: unknown; folders?: unknown };
			const allowedFiles = plain(a.files)
				? Object.fromEntries(Object.entries(a.files as FileSet).filter(([name]) => !isIgnoredPath(rules, `agent-extensions/${name}`)))
				: {};
			const allowedFolders = plain(a.folders) ? filterFoldersByRules(rules, "agent-extensions", a.folders as Record<string, FileSet>) : {};
			const copied = [
				...applyFiles(dir, allowedFiles, /\.(ts|js|mjs)$/, "agent-ext"),
				...applyFolders(dir, allowedFolders, "agent-ext", (name, rel) => isIgnoredPath(rules, `agent-extensions/${name}/${rel}`)),
			];
			if (copied.length) {
				const res = await own("POST", "/server-extensions/reload", {});
				if (!res.ok) throw new Error(`copied ~/.agents/extensions from the primary, but this server could not reload them (${res.status})`);
			}
			changed.push(...copied);
		}
		return changed;
	};

	/**
	 * Install what the primary has and this server lacks (or has at another version), from the marketplace's pinned git
	 * source, through this server's own install route. Never removes one: an extension only here stays.
	 */
	const applyServerExtensions = async (theirs: InstalledExtension[], fetchCode: (ids: string[]) => Promise<InstalledExtension[]>, rules: readonly SyncRule[] = []): Promise<string[]> => {
		const mineList = await installedServerExtensions();
		const mine = new Map(mineList.map((e) => [e.id, e.version]));
		const wanted = theirs.filter((e) => plain(e) && typeof e.id === "string" && EXTENSION_ID.test(e.id) && e.id !== SELF_ID && !isIgnoredPath(rules, `extensions/${e.id}/install`) && typeof e.version === "string" && mine.get(e.id) !== e.version);
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
			if (!res.ok) throw new Error(`pulled from the primary, but could not install ${e.id} ${e.version} on this server (${res.status}: ${reason(res)})`);
			changed.push(`srv:${e.id}`);
		}
		// Not in the marketplace at that version (a hand-made or newer local build): its code comes from the primary, but
		// only with its own box checked, since it is code nobody reviewed that runs inside this server.
		const copyable = missing.filter((e) => !isIgnoredPath(rules, `extensions/${e.id}/code`));
		if (copyable.length && wantLocalExtensions()) {
			const withCode = await fetchCode(copyable.map((e) => e.id));
			let copied = false;
			for (const e of withCode) {
				if (!plain(e) || !copyable.some((m) => m.id === e.id) || !plain(e.files) || !Object.keys(e.files).length) continue;
				if (copyExtension(e.id, e.files as FileSet)) { changed.push(`srv:${e.id}`); copied = true; }
			}
			// The server loads extensions from disk on reload: the copied code starts now.
			if (copied) {
				const res = await own("POST", "/server-extensions/reload", {});
				if (!res.ok) throw new Error(`copied extensions from the primary, but this server could not reload them (${res.status})`);
			}
			unlisted = [];
		} else {
			unlisted = copyable.map((e) => `${e.id} ${e.version}`);
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
	const findNeedsInput = (list: unknown, states: unknown, all: Record<string, Record<string, unknown>>): { id: string; title: string; fields: string[] }[] => {
		if (!Array.isArray(list)) return [];
		const on = plain(states) ? states : {};
		const out: { id: string; title: string; fields: string[] }[] = [];
		for (const item of list) {
			const m = plain(item) && plain(item.manifest) ? item.manifest : null;
			if (!m || typeof m.id !== "string" || !Array.isArray(m.settings) || on[m.id] !== true) continue;
			const have = all[m.id] ?? {};
			const lacking = (m.settings as unknown[]).filter(plain)
				.filter((f) => f.required === true && f.readonly !== true && typeof f.key === "string" && (f.secret === true || CREDENTIAL_KEY.test(f.key)))
				.filter((f) => { const v = have[f.key as string]; return v === undefined || v === null || v === ""; })
				.map((f) => (typeof f.label === "string" && f.label ? f.label : String(f.key)));
			if (lacking.length) out.push({ id: m.id, title: typeof m.name === "string" && m.name ? m.name : m.id, fields: lacking });
		}
		return out;
	};

	/** The apps' extension list and on/off states, through `/client-settings` so open apps reload them. */
	const applyClientExtensions = async (theirs: { list?: unknown; states?: unknown }, rules?: readonly SyncRule[]): Promise<string[]> => {
		const current = await clientExtensionRows();
		const changed: string[] = [];
		const itemId = (x: unknown): string => (plain(x) && plain(x.manifest) && typeof x.manifest.id === "string" ? x.manifest.id : "");
		let targetList = theirs.list;
		let targetStates = theirs.states;
		if (rules) {
			if (Array.isArray(theirs.list)) {
				const keptLocal = Array.isArray(current.list)
					? current.list.filter((x) => { const id = itemId(x); return id ? isIgnoredPath(rules, `extensions/${id}/client`) : isIgnoredPath(rules, "extensions/__unknown__/client"); })
					: [];
				const keptIds = new Set(keptLocal.map(itemId).filter(Boolean));
				const incoming = theirs.list.filter((x) => {
					const id = itemId(x);
					if (id) return !isIgnoredPath(rules, `extensions/${id}/client`) && !keptIds.has(id);
					return !isIgnoredPath(rules, "extensions/__unknown__/client");
				});
				targetList = [...keptLocal, ...incoming];
			}
			if (plain(theirs.states)) {
				const keptStates = plain(current.states)
					? Object.fromEntries(Object.entries(current.states).filter(([id]) => isIgnoredPath(rules, `extensions/${id}/client`)))
					: {};
				const incomingStates = Object.fromEntries(Object.entries(theirs.states).filter(([id]) => !isIgnoredPath(rules, `extensions/${id}/client`)));
				targetStates = { ...keptStates, ...incomingStates };
			}
		}
		needsInput = findNeedsInput(targetList ?? current.list, targetStates ?? current.states, await extensionSettings());
		for (const [key, value] of [["extensions", targetList], ["extensionStates", targetStates]] as const) {
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
		const have = await storedKeys();
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
		const mine = await providerRows();
		const changed: string[] = [];
		for (const [id, value] of Object.entries(theirs)) {
			if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !plain(value)) continue;
			const { id: _, ...body } = value;
			const { id: __, ...current } = mine[id] ?? {};
			if (mine[id] && JSON.stringify(Object.keys(current).sort().map((k) => [k, current[k]])) === JSON.stringify(Object.keys(body).sort().map((k) => [k, body[k]]))) continue;
			const res = await own("PUT", `/configuration/providers/${id}`, body);
			if (!res.ok) throw new Error(`pulled from the primary, but could not save the provider ${id} on this server (${res.status}: ${reason(res)})`);
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
		const entries = Object.entries(peer).filter(([id, value]) => id !== SELF_ID && EXTENSION_ID.test(id) && plain(value));
		if (!entries.length) return changed;
		const all = await extensionSettings();
		for (const [id, value] of entries as [string, Record<string, unknown>][]) {
			const current = all[id];
			// This server's own secrets win: a value typed here is never replaced. A key it lacks comes from the primary
			// only when 비밀값 is on (the primary then sent them).
			const mine = Object.fromEntries(Object.entries(current ?? {}).filter(([k, v]) => CREDENTIAL_KEY.test(k) && v !== "" && v !== null && v !== undefined));
			const theirs = Object.fromEntries(Object.entries(value).filter(([k]) => wantSecrets() || !CREDENTIAL_KEY.test(k)));
			const next = { ...theirs, ...mine };
			if (sameObject(current, next)) continue;
			let res: Answer;
			try {
				res = await own("PUT", `/extensions/${id}/settings`, { settings: next });
			} catch (e) {
				// Not the primary's fault: say it is this server, so the page does not read "cannot connect" to the peer.
				throw new Error(`pulled from the primary, but could not save the settings of ${id} on this server: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!res.ok) throw new Error(`pulled from the primary, but could not save the settings of ${id} on this server (${res.status})`);
			changed.push(`ext:${id}`);
		}
		return changed;
	};

	type BackupSnapshot = {
		rows: Record<string, unknown>;
		extensions: Record<string, Record<string, unknown>>;
		clientExtensions?: { list: unknown; states: unknown };
		skills: Record<string, FileSet>;
		subagents: FileSet;
		agentsMd: string | null;
		providers: Record<string, Record<string, unknown>>;
	};
	const captureBefore = async (opts: {
		rowKeys?: readonly string[];
		extensions?: boolean;
		clientExtensions?: boolean;
		skills?: boolean;
		subagents?: boolean;
		agentsMd?: boolean;
		providers?: boolean;
	}): Promise<BackupSnapshot> => {
		const home = agentsHome();
		return {
			rows: opts.rowKeys?.length ? readSettings(dbo(), opts.rowKeys) : {},
			extensions: opts.extensions ? await extensionSettings() : {},
			clientExtensions: opts.clientExtensions ? await clientExtensionRows() : undefined,
			skills: opts.skills ? readFolders(join(home, ".agents", "skills")) : {},
			subagents: opts.subagents ? readFiles(join(home, ".agents", "subagents"), /\.md$/) : {},
			agentsMd: opts.agentsMd ? readText(join(home, ".agents", "AGENTS.md")) : null,
			providers: opts.providers ? await providerRows() : {},
		};
	};
	const commitBackup = (reasonKind: BackupReason, changed: readonly string[], before: BackupSnapshot): BackupSummary | null => {
		const rec: Omit<BackupRecord, "id" | "at"> = { reason: reasonKind, summary: [] };
		for (const k of changed) {
			if (k.startsWith("up:") || k.startsWith("srv:") || k.startsWith("key:") || k.startsWith("agent-ext:")) continue;
			if (k.startsWith("ext:")) {
				const id = k.slice(4);
				(rec.extensions ??= {})[id] = publicOf(before.extensions[id]);
				rec.summary.push(k);
			} else if (k === "client:extensions") {
				(rec.clientExtensions ??= {}).list = before.clientExtensions?.list ?? null;
				rec.summary.push(k);
			} else if (k === "client:extensionStates") {
				(rec.clientExtensions ??= {}).states = before.clientExtensions?.states ?? null;
				rec.summary.push(k);
			} else if (k.startsWith("skill:")) {
				const name = k.slice(6);
				(rec.skills ??= {})[name] = name in before.skills ? before.skills[name]! : null;
				rec.summary.push(k);
			} else if (k.startsWith("helper:")) {
				const name = k.slice(7);
				const file = `${name}.md`;
				(rec.subagents ??= {})[file] = file in before.subagents ? before.subagents[file]! : null;
				rec.summary.push(k);
			} else if (k === "agents-md") {
				rec.agentsMd = before.agentsMd;
				rec.summary.push(k);
			} else if (k.startsWith("provider:")) {
				const id = k.slice(9);
				(rec.providers ??= {})[id] = id in before.providers ? publicOf(before.providers[id]) : null;
				rec.summary.push(k);
			} else if (!k.includes(":")) {
				(rec.rows ??= {})[k] = k in before.rows ? before.rows[k] : null;
				rec.summary.push(k);
			}
		}
		return saveBackup(rec);
	};
	const restoreBackup = async (id?: string): Promise<{ id: string; restored: string[] }> => {
		const target = id ? readBackup(id) : (() => { const first = listBackups()[0]; return first ? readBackup(first.id) : null; })();
		if (!target) throw new Error("no backup to restore");
		const before = await captureBefore({
			rowKeys: target.rows ? Object.keys(target.rows) : undefined,
			extensions: !!target.extensions,
			clientExtensions: !!target.clientExtensions,
			skills: !!target.skills,
			subagents: !!target.subagents,
			agentsMd: "agentsMd" in target,
			providers: !!target.providers,
		});
		const restored: string[] = [];
		if (target.rows && Object.keys(target.rows).length) {
			const rowKeys = Object.keys(target.rows);
			const vals = Object.fromEntries(Object.entries(target.rows).filter(([, v]) => v !== null));
			const res = await applyRows(rowKeys, vals);
			restored.push(...res.changed);
		}
		if (target.extensions) {
			const all = await extensionSettings();
			for (const [extId, pub] of Object.entries(target.extensions)) {
				if (extId === SELF_ID || !EXTENSION_ID.test(extId) || !plain(pub)) continue;
				const current = all[extId];
				const secrets = Object.fromEntries(Object.entries(current ?? {}).filter(([k]) => CREDENTIAL_KEY.test(k)));
				const next = { ...publicOf(pub), ...secrets };
				if (sameObject(current, next)) continue;
				const res = await own("PUT", `/extensions/${extId}/settings`, { settings: next });
				if (!res.ok) throw new Error(`could not restore the settings of ${extId} (${res.status})`);
				restored.push(`ext:${extId}`);
			}
		}
		if (target.clientExtensions) restored.push(...(await applyClientExtensions(target.clientExtensions)));
		const home = agentsHome();
		if (target.skills) {
			const toApply: Record<string, FileSet> = {};
			for (const [name, files] of Object.entries(target.skills)) {
				if (!SAFE_NAME.test(name)) continue;
				if (files === null) {
					const dir = join(home, ".agents", "skills", name);
					try {
						if (existsSync(dir) && !lstatSync(dir).isSymbolicLink()) {
							rmSync(dir, { recursive: true, force: true });
							restored.push(`skill:${name}`);
						}
					} catch { /* ignore */ }
				} else if (plain(files)) toApply[name] = files;
			}
			if (Object.keys(toApply).length) restored.push(...applyFolders(join(home, ".agents", "skills"), toApply, "skill"));
		}
		if (target.subagents) {
			const toApply: FileSet = {};
			for (const [file, text] of Object.entries(target.subagents)) {
				if (!SAFE_NAME.test(file) || !/\.md$/.test(file)) continue;
				if (text === null) {
					const path = join(home, ".agents", "subagents", file);
					if (existsSync(path)) { rmSync(path, { force: true }); restored.push(`helper:${file.replace(/\.md$/, "")}`); }
				} else if (typeof text === "string") toApply[file] = text;
			}
			if (Object.keys(toApply).length) restored.push(...applyFiles(join(home, ".agents", "subagents"), toApply, /\.md$/, "helper"));
		}
		if ("agentsMd" in target) {
			const path = join(home, ".agents", "AGENTS.md");
			if (typeof target.agentsMd === "string") restored.push(...applyText(path, target.agentsMd, "agents-md"));
			else if (target.agentsMd === null && existsSync(path)) { rmSync(path, { force: true }); restored.push("agents-md"); }
		}
		if (target.providers) {
			const toApply: Record<string, Record<string, unknown>> = {};
			const current = await providerRows();
			for (const [pid, val] of Object.entries(target.providers)) {
				if (!/^[a-z][a-z0-9_-]{0,63}$/.test(pid)) continue;
				if (val === null) {
					if (pid in current) {
						if (hasApi) {
							const res = await own("DELETE", `/configuration/providers/${pid}`);
							if (res.ok || res.status === 404) restored.push(`provider:${pid}`);
						} else {
							dbo().query("DELETE FROM custom_providers WHERE id = ?").run(pid);
							restored.push(`provider:${pid}`);
						}
					}
				} else if (plain(val)) toApply[pid] = val;
			}
			if (Object.keys(toApply).length) restored.push(...(await applyProviders(toApply)));
		}
		if (restored.length) {
			commitBackup("restore", restored, before);
			log(`restored from backup ${target.id}: ${restored.join(", ")}`);
			lastApplied = restored.map((k) => `restore:${k}`);
			pi.emit(null, "synced", { keys: lastApplied, at: Date.now(), from: "restore" }, { ephemeral: true });
		}
		showStatus();
		return { id: target.id, restored };
	};

	const formatDate = (at: number): string => {
		const d = new Date(at);
		const pad = (n: number) => String(n).padStart(2, "0");
		const now = new Date();
		const hm = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		return d.getFullYear() === now.getFullYear() ? hm : `${d.getFullYear()}-${hm}`;
	};
	const shortVal = (v: unknown, key = ""): Text | string => {
		if (v === null || v === undefined) return { ko: "(없음)", en: "(none)" };
		if (typeof v === "string") {
			const clean = v.replace(/\s+/g, " ").trim();
			return clean.length > 34 ? `${clean.slice(0, 34)}…` : clean || { ko: "(빈 문자열)", en: "(empty)" };
		}
		if (typeof v === "boolean") return v ? { ko: "켜짐", en: "on" } : { ko: "꺼짐", en: "off" };
		if (typeof v === "number") return String(v);
		if (key === "retention" && plain(v)) {
			const days = typeof v.days === "number" ? v.days : "?";
			return v.enabled === false
				? { ko: `${days}일 · 꺼짐`, en: `${days}d · off` }
				: { ko: `${days}일 보관 · 켜짐`, en: `${days}d · on` };
		}
		if (key === "compaction" && plain(v)) {
			const m = plain(v.model) && typeof v.model.model === "string" ? ` (${v.model.model})` : "";
			return v.auto === false ? { ko: `자동 꺼짐${m}`, en: `auto off${m}` } : { ko: `자동 켜짐${m}`, en: `auto on${m}` };
		}
		if (key === "mcp_servers" && Array.isArray(v)) {
			const names = v.map((x) => (plain(x) && typeof x.name === "string" ? x.name : "")).filter(Boolean);
			if (!v.length) return { ko: "0개", en: "0" };
			const head = names.slice(0, 2).join(", ");
			return { ko: `${v.length}개${head ? ` (${head}${names.length > 2 ? "…" : ""})` : ""}`, en: `${v.length}${head ? ` (${head}${names.length > 2 ? "…" : ""})` : ""}` };
		}
		if ((key === "disabled_tools" || key === "disabled_subagents") && Array.isArray(v)) {
			return v.length ? { ko: `${v.length}개 꺼짐`, en: `${v.length} off` } : { ko: "모두 켜짐", en: "all on" };
		}
		if (plain(v) && "provider" in v && "model" in v) return `${v.provider} / ${v.model}`;
		if (plain(v) && "model" in v && plain(v.model) && "provider" in v.model && "model" in v.model) return `${v.model.provider} / ${v.model.model}`;
		if (Array.isArray(v)) return { ko: `${v.length}개 항목`, en: `${v.length} items` };
		if (plain(v)) {
			const parts = Object.entries(v).slice(0, 3).map(([k, x]) => `${k}: ${typeof x === "object" ? "…" : String(x)}`);
			const s = parts.join(", ");
			return s.length > 34 ? `${s.slice(0, 34)}…` : s || "{}";
		}
		const raw = JSON.stringify(v);
		return raw.length > 34 ? `${raw.slice(0, 34)}…` : raw;
	};
	const previewBackup = async (id: string): Promise<{ id: string; rows: { id: string; cells: (Text | string)[] }[] }> => {
		const target = readBackup(id);
		if (!target) throw new Error("no backup to preview");
		const cur = await captureBefore({
			rowKeys: target.rows ? Object.keys(target.rows) : undefined,
			extensions: !!target.extensions,
			clientExtensions: !!target.clientExtensions,
			skills: !!target.skills,
			subagents: !!target.subagents,
			agentsMd: "agentsMd" in target,
			providers: !!target.providers,
		});
		const rows: { id: string; cells: (Text | string)[] }[] = [];
		const add = (key: string, before: unknown, after: unknown) => {
			if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
			rows.push({
				id: `r${rows.length}`,
				cells: [keyLabel(key), shortVal(before, key), shortVal(after, key)],
			});
		};
		for (const [k, v] of Object.entries(target.rows ?? {})) add(k, k in cur.rows ? cur.rows[k] : null, v);
		for (const [extId, v] of Object.entries(target.extensions ?? {})) add(`ext:${extId}`, publicOf(cur.extensions[extId]), publicOf(v));
		if (target.clientExtensions) {
			if ("list" in target.clientExtensions) add("client:extensions", cur.clientExtensions?.list ?? null, target.clientExtensions.list ?? null);
			if ("states" in target.clientExtensions) add("client:extensionStates", cur.clientExtensions?.states ?? null, target.clientExtensions.states ?? null);
		}
		for (const [name, files] of Object.entries(target.skills ?? {})) {
			const c = name in cur.skills ? { ko: `파일 ${Object.keys(cur.skills[name]!).length}개`, en: `${Object.keys(cur.skills[name]!).length} files` } : null;
			const a = files === null ? null : { ko: `파일 ${Object.keys(files).length}개`, en: `${Object.keys(files).length} files` };
			if (JSON.stringify(c) !== JSON.stringify(a)) rows.push({ id: `r${rows.length}`, cells: [keyLabel(`skill:${name}`), c ?? { ko: "(없음)", en: "(none)" }, a ?? { ko: "(없음)", en: "(none)" }] });
		}
		for (const [file, text] of Object.entries(target.subagents ?? {})) add(`helper:${file.replace(/\.md$/, "")}`, cur.subagents[file] ?? null, text);
		if ("agentsMd" in target) add("agents-md", cur.agentsMd, target.agentsMd ?? null);
		for (const [pid, val] of Object.entries(target.providers ?? {})) add(`provider:${pid}`, pid in cur.providers ? publicOf(cur.providers[pid]) : null, val ? publicOf(val) : null);
		return { id: target.id, rows };
	};

	/**
	 * Discover all live syncable items on this server and evaluate each against `overrideText` (or the active rules).
	 * Never reads or returns any secret value — only canonical sync paths, status, and matching rule.
	 */
	const inspectRules = async (overrideText?: string, testPaths?: readonly string[]): Promise<RulesInspection & { tested?: DiscoveredSyncItem[] }> => {
		const content = overrideText ?? readRulesText();
		const { rules, warnings } = parseSyncRules(content);
		const items: DiscoveredSyncItem[] = [];
		const seen = new Set<string>();
		const pushItem = (path: string) => {
			if (seen.has(path)) return;
			seen.add(path);
			const m = matchSyncPath(rules, path);
			items.push({ path, synced: !m.ignored, matchedBy: m.matchedBy?.raw ?? null });
		};
		// 1. Settings rows (except mcp_servers, which is expanded per server below).
		const allKeys = keys();
		let settingsRows: Record<string, unknown> = {};
		try { settingsRows = readSettings(dbo(), allKeys); } catch { /* db may not exist yet */ }
		for (const k of allKeys) {
			if (k === "mcp_servers") continue;
			pushItem(`settings/${k}`);
		}
		// 2. Individual MCP servers.
		for (const name of Object.keys(mcpMap(settingsRows.mcp_servers)).sort()) {
			pushItem(`mcp/${name}`);
		}
		// 3. Installed server extensions, extension settings, and client extensions.
		const extIds = new Set<string>();
		try {
			for (const e of await installedServerExtensions()) extIds.add(e.id);
		} catch { /* ignore */ }
		try {
			for (const id of Object.keys(shareable(await extensionSettings()))) extIds.add(id);
		} catch { /* ignore */ }
		try {
			const c = await clientExtensionRows();
			if (Array.isArray(c.list)) {
				for (const item of c.list) {
					if (plain(item) && plain(item.manifest) && typeof item.manifest.id === "string" && item.manifest.id !== SELF_ID) extIds.add(item.manifest.id);
				}
			}
			if (plain(c.states)) {
				for (const id of Object.keys(c.states)) if (id !== SELF_ID) extIds.add(id);
			}
		} catch { /* ignore */ }
		for (const id of [...extIds].sort()) {
			const subAspects = ["install", "settings", "client"] as const;
			const states = subAspects.map((sub) => matchSyncPath(rules, `extensions/${id}/${sub}`));
			const allSame = states.every((st) => st.ignored === states[0]!.ignored);
			if (allSame) {
				const m = matchSyncPath(rules, `extensions/${id}`);
				const eff = m.ignored === states[0]!.ignored ? m : states[0]!;
				if (!seen.has(`extensions/${id}`)) {
					seen.add(`extensions/${id}`);
					items.push({ path: `extensions/${id}`, synced: !states[0]!.ignored, matchedBy: eff.matchedBy?.raw ?? null });
				}
			} else {
				for (const sub of subAspects) pushItem(`extensions/${id}/${sub}`);
			}
		}
		// 4. Skills (~/.agents/skills) + file-level exceptions inside synced skills.
		const home = agentsHome();
		const skills = readFolders(join(home, ".agents", "skills"));
		for (const name of Object.keys(skills).sort()) {
			const files = Object.keys(skills[name] ?? {}).sort();
			const matches = files.map((rel) => ({ rel, m: matchSyncPath(rules, `skills/${name}/${rel}`) }));
			const syncedFiles = matches.filter((x) => !x.m.ignored);
			const ignoredFiles = matches.filter((x) => x.m.ignored);
			if (!syncedFiles.length) {
				const top = matchSyncPath(rules, `skills/${name}`);
				seen.add(`skills/${name}`);
				items.push({ path: `skills/${name}`, synced: false, matchedBy: (top.ignored ? top.matchedBy : ignoredFiles[0]?.m.matchedBy)?.raw ?? null });
			} else {
				const top = matchSyncPath(rules, `skills/${name}`);
				seen.add(`skills/${name}`);
				items.push({ path: `skills/${name}`, synced: true, matchedBy: (!top.ignored ? top.matchedBy : syncedFiles[0]?.m.matchedBy)?.raw ?? null });
				for (const ig of ignoredFiles) pushItem(`skills/${name}/${ig.rel}`);
			}
		}
		// 5. Subagents (~/.agents/subagents/*.md).
		for (const file of Object.keys(readFiles(join(home, ".agents", "subagents"), /\.md$/)).sort()) {
			pushItem(`subagents/${file.replace(/\.md$/i, "")}`);
		}
		// 6. Global AGENTS.md.
		if (readText(join(home, ".agents", "AGENTS.md")) !== null) pushItem("agents-md");
		// 7. Custom providers.
		try {
			for (const id of Object.keys(await providerRows()).sort()) pushItem(`providers/${id}`);
		} catch { /* ignore */ }
		// 8. ~/.agents/extensions (local agent extensions).
		const agentExtDir = join(home, ".agents", "extensions");
		for (const file of Object.keys(readFiles(agentExtDir, /\.(ts|js|mjs)$/)).sort()) pushItem(`agent-extensions/${file}`);
		for (const folder of Object.keys(readFolders(agentExtDir)).sort()) pushItem(`agent-extensions/${folder}`);

		const syncedCount = items.filter((i) => i.synced).length;
		const ignoredCount = items.length - syncedCount;
		const result: RulesInspection & { tested?: DiscoveredSyncItem[] } = {
			file: rulesFile(),
			exists: hasRulesFile(),
			role: role(),
			content,
			warnings,
			gates: {
				syncLocalExtensions: wantLocalExtensions(),
				syncSecrets: wantSecrets(),
				shareSecrets: settings().shareSecrets === true,
			},
			items,
			syncedCount,
			ignoredCount,
		};
		if (testPaths?.length) {
			result.tested = testPaths.slice(0, MAX_KEYS).map((raw) => {
				const p = normalizeSyncPathAlias(raw.slice(0, 300).replace(/^\/+/, "").replace(/\/+$/, ""));
				const m = matchSyncPath(rules, p);
				return { path: p, synced: !m.ignored, matchedBy: m.matchedBy?.raw ?? null };
			});
		}
		return result;
	};

	const refreshInspection = async () => {
		if (gone || !hasPanel || refreshingInspection) return;
		refreshingInspection = true;
		try {
			const next = await inspectRules();
			const prev = liveInspection;
			const changed = !prev
				|| prev.content !== next.content
				|| prev.syncedCount !== next.syncedCount
				|| prev.ignoredCount !== next.ignoredCount
				|| prev.items.length !== next.items.length
				|| JSON.stringify(prev.items) !== JSON.stringify(next.items);
			liveInspection = next;
			if (changed && !editingRules) showStatus();
		} catch { /* ignore transient read failures */ } finally {
			refreshingInspection = false;
		}
	};

	const saveRulesContent = async (raw: string) => {
		const clean = raw.replace(/\u0000/g, "");
		if (clean.length > MAX_RULES_BYTES) throw new Error(`syncignore exceeds ${MAX_RULES_BYTES} bytes`);
		writeRulesText(clean);
		const inspected = await inspectRules();
		rulesDraft = inspected.content;
		rulesPreviewCache = inspected;
		liveInspection = inspected;
		log(`updated syncignore (${inspected.syncedCount} synced, ${inspected.ignoredCount} excluded)`);
		showStatus();
		return inspected;
	};

	pi.registerMethod("rules", async (params: unknown) => {
		const content = plain(params) && typeof params.content === "string" ? params.content : undefined;
		const paths = plain(params) && Array.isArray(params.paths) ? params.paths.filter((x): x is string => typeof x === "string").slice(0, MAX_KEYS) : undefined;
		return inspectRules(content, paths);
	});
	pi.registerMethod("setRules", async (params: unknown) => {
		if (!plain(params) || typeof params.content !== "string") throw new Error("content (string) is required");
		return saveRulesContent(params.content);
	});

	if (typeof pi.registerTool === "function" && pi.Type) {
		const T = pi.Type;
		pi.registerTool({
			name: "server_sync_rules",
			label: "Server Sync Rules",
			description: [
				"Inspect, test, or edit this server's .gitignore-style server-sync rules file (`syncignore`).",
				"Use action='inspect' to see the rules file path, active patterns, security gates, and every discovered syncable item on this server.",
				"Use action='set' with `content` to replace the file, action='add' or 'remove' with `patterns` to append/delete lines while keeping comments, action='reset' to restore role defaults, or action='test' with optional `content` and `paths` to dry-run without saving.",
				"Namespaces: settings/<key>, mcp/<name>, extensions/<id>[/{install,settings,client,code}], skills/<name>[/<file>], subagents/<name>, agents-md, providers/<id>, agent-extensions/<name>, secrets/providers/<id>, secrets/extensions/<id>.",
				"Security switches (syncLocalExtensions, syncSecrets, shareSecrets) and NEVER_SYNCED keys cannot be bypassed by rules.",
			].join(" "),
			parameters: T.Object({
				action: T.Optional(T.String({ description: "inspect | set | add | remove | reset | test (default: inspect)" })),
				content: T.Optional(T.String({ description: "Full .gitignore-style rules text (for action='set' or dry-run action='test')" })),
				patterns: T.Optional(T.Array(T.String(), { description: "Pattern lines to add or remove (for action='add' or 'remove')" })),
				paths: T.Optional(T.Array(T.String(), { description: "Specific canonical sync paths to evaluate (for action='test')" })),
			}),
			execute: async (_id: string, params: Record<string, unknown>) => {
				const action = typeof params?.action === "string" ? params.action : "inspect";
				let result: RulesInspection & { tested?: DiscoveredSyncItem[] };
				if (action === "inspect") {
					result = await inspectRules();
				} else if (action === "test") {
					const content = typeof params?.content === "string" ? params.content : undefined;
					const paths = Array.isArray(params?.paths) ? params.paths.filter((x): x is string => typeof x === "string").slice(0, MAX_KEYS) : undefined;
					result = await inspectRules(content, paths);
				} else if (action === "set") {
					if (typeof params?.content !== "string") throw new Error("action='set' requires `content`");
					result = await saveRulesContent(params.content);
				} else if (action === "add") {
					const pats = Array.isArray(params?.patterns) ? params.patterns.map((x) => String(x).replace(/[\r\n\u0000]/g, "").trim()).filter(Boolean) : [];
					if (!pats.length) throw new Error("action='add' requires non-empty `patterns`");
					const current = readRulesText();
					const existing = new Set(current.split(/\r?\n/).map((l) => l.trim()));
					const toAdd = pats.filter((p) => !existing.has(p));
					const base = current.replace(/\s*$/, "");
					const next = toAdd.length ? `${base ? `${base}\n` : ""}${toAdd.join("\n")}\n` : current;
					result = await saveRulesContent(next);
				} else if (action === "remove") {
					const pats = new Set(Array.isArray(params?.patterns) ? params.patterns.map((x) => String(x).replace(/[\r\n\u0000]/g, "").trim()).filter(Boolean) : []);
					if (!pats.size) throw new Error("action='remove' requires non-empty `patterns`");
					const current = readRulesText();
					const cleaned = current.split(/\r?\n/).filter((l) => !pats.has(l.trim())).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "");
					const next = cleaned ? `${cleaned}\n` : "";
					result = await saveRulesContent(next);
				} else if (action === "reset") {
					result = await saveRulesContent(defaultRulesText(role()));
				} else {
					throw new Error(`unknown action: ${action}`);
				}
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			},
		});
	}

	pi.registerMethod("backups", () => ({ backups: listBackups() }));
	pi.registerMethod("restorePreview", async (params: unknown) => {
		const id = plain(params) && typeof params.id === "string" ? params.id : listBackups()[0]?.id;
		if (!id) throw new Error("no backup to preview");
		return previewBackup(id);
	});
	pi.registerMethod("restore", async (params: unknown) => {
		const id = plain(params) && typeof params.id === "string" ? params.id : undefined;
		const res = await restoreBackup(id);
		if (plain(params) && params.pause === true) {
			pi.settings.set({ ...withoutToken(settings()), paused: true });
			arm(true);
			showStatus();
		}
		return res;
	});

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
			void refreshInspection();
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
		const key = JSON.stringify([role(), url, token, interval, isPaused()]);
		if (!force && key === armedFor && (timer || busy)) return;
		armedFor = key;
		if (timer) clearTimeout(timer);
		timer = undefined;
		failures = 0;
		if (role() !== "follower" || !url || !token || isPaused()) return;
		const tick = () => {
			timer = undefined;
			if (busy) return schedule();
			busy = true;
			pull()
				.catch(() => { /* already logged and recorded in the status */ })
				.finally(() => { busy = false; schedule(); showStatus(); });
		};
		const schedule = () => {
			if (timer || gone) return;
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
		void refreshInspection();
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

	/** What the page's buttons and fields do. */
	if (hasPanel && typeof pi.ui.onEvent === "function") {
		pi.ui.onEvent(async (e: { type: string; id: string; value?: unknown; values?: Record<string, unknown> }) => {
			if (e.type === "change") {
				if (e.id === "backup-select" && typeof e.value === "string") {
					selectedBackupId = e.value;
					if (confirmRestoreId) {
						try {
							previewRowsCache = await previewBackup(e.value);
							confirmRestoreId = e.value;
						} catch {
							confirmRestoreId = null;
							previewRowsCache = null;
						}
					} else {
						previewRowsCache = null;
					}
					showStatus();
				} else if (e.id === "restore-after" && typeof e.value === "string") {
					pauseAfterRestore = e.value === "pause";
					showStatus();
				} else if (e.id === `rules-text-${rulesDraftRevision}` && typeof e.value === "string") {
					rulesDraft = e.value;
					try { rulesPreviewCache = await inspectRules(rulesDraft); } catch { /* ignore */ }
					showStatus();
				}
				return;
			}
			if (e.type === "submit") {
				if (e.id === "rules-form" && !pulling && !busy) {
					const fieldId = `rules-text-${rulesDraftRevision}`;
					const submitted = plain(e.values) && typeof e.values[fieldId] === "string" ? (e.values[fieldId] as string) : rulesDraft;
					busy = true;
					showStatus();
					try {
						await saveRulesContent(submitted);
						editingRules = false;
						rulesPreviewCache = null;
						lastError = null;
					} catch (err) {
						lastError = err instanceof Error ? err.message : String(err);
						log(`save rules failed: ${lastError}`);
					} finally {
						busy = false;
						showStatus();
					}
				}
				return;
			}
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
				writeBase(null);
				lastSyncAt = null;
				lastApplied = [];
				lastError = null;
				confirmRestoreId = null;
				previewRowsCache = null;
				editingRules = false;
				rulesPreviewCache = null;
				pi.settings.set({ ...withoutToken(settings()), remoteUrl: "", shareCode: "" });
				arm(true);
				showStatus();
			} else if (e.id === "resume-sync") {
				if (pulling || busy) return;
				pi.settings.set({ ...withoutToken(settings()), paused: false });
				arm(true);
				showStatus();
			} else if (e.id === "rules-open") {
				if (pulling || busy) return;
				confirmRestoreId = null;
				previewRowsCache = null;
				rulesDraft = readRulesText();
				rulesDraftRevision++;
				editingRules = true;
				showStatus();
				try {
					rulesPreviewCache = await inspectRules(rulesDraft);
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					log(`rules preview failed: ${lastError}`);
				} finally {
					showStatus();
				}
			} else if (e.id === "rules-reset") {
				if (pulling || busy) return;
				rulesDraft = defaultRulesText(role());
				rulesDraftRevision++;
				try {
					rulesPreviewCache = await inspectRules(rulesDraft);
				} catch { /* ignore */ }
				showStatus();
			} else if (e.id === "rules-cancel") {
				editingRules = false;
				rulesPreviewCache = null;
				showStatus();
				void refreshInspection();
			} else if (e.id === "restore-preview") {
				if (pulling || busy) return;
				editingRules = false;
				rulesPreviewCache = null;
				const list = listBackups();
				const activeId = list.some((b) => b.id === selectedBackupId) ? selectedBackupId : list[0]?.id;
				if (!activeId) return;
				busy = true;
				showStatus();
				try {
					previewRowsCache = await previewBackup(activeId);
					confirmRestoreId = activeId;
					lastError = null;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					log(`preview failed: ${lastError}`);
				} finally {
					busy = false;
					showStatus();
				}
			} else if (e.id === "restore-cancel") {
				confirmRestoreId = null;
				previewRowsCache = null;
				showStatus();
			} else if (e.id === "restore-approve") {
				if (pulling || busy || !confirmRestoreId) return;
				const id = confirmRestoreId;
				busy = true;
				showStatus();
				try {
					await restoreBackup(id);
					if (pauseAfterRestore) pi.settings.set({ ...withoutToken(settings()), paused: true });
					confirmRestoreId = null;
					previewRowsCache = null;
					lastError = null;
					arm(true);
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					log(`restore failed: ${lastError}`);
				} finally {
					busy = false;
					showStatus();
				}
			}
		});
	}

	mergeOldBoxes();
	moveOldToken();
	dropStaleCode();
	void fillPeerToken();
	showStatus();
	void refreshInspection();
	arm();
	// "3분 전" and "42초 후" go stale between pulls.
	const tick = setInterval(() => { showStatus(); void refreshInspection(); }, 30_000);
	(tick as unknown as { unref?: () => void }).unref?.();
	setTimeout(() => { showStatus(); void refreshInspection(); }, 1500);
	pi.on("extension_unload", () => clearInterval(tick));
	pi.settings.onChange(refresh);
	pi.on("extension_unload", () => {
		gone = true;
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
