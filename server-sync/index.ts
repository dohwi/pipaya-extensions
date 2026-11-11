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
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

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
 */
const GROUPS = [
	{ field: "syncModels", keys: ["default_model", "system_model", "image_model"] },
	{ field: "syncWorkdir", keys: ["default_workdir"] },
	{ field: "syncMcp", keys: ["mcp_servers"] },
	{ field: "syncSkills", keys: ["skills"] },
	{ field: "syncTools", keys: ["disabled_tools", "disabled_subagents", "delegate_policy"] },
	{ field: "syncHistory", keys: ["compaction", "retention"] },
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
}

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
function allExtensionSettings(): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	const root = join(dataDir(), "extensions");
	if (!existsSync(root)) return out;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === SELF_ID || !EXTENSION_ID.test(entry.name)) continue;
		const value = readExtensionSettings(entry.name);
		if (value) out[entry.name] = Object.fromEntries(Object.entries(value).filter(([k]) => !CREDENTIAL_KEY.test(k)));
	}
	return out;
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
	let busy = false;
	let failures = 0;
	let lastSyncAt: number | null = null;
	let lastApplied: string[] = [];
	let lastError: string | null = null;

	const settings = (): Record<string, unknown> => (pi.settings.get() ?? {}) as Record<string, unknown>;
	const role = (): "primary" | "follower" => (settings().role === "follower" ? "follower" : "primary");

	const cfg = (): { url: string; token: string; interval: number } => {
		const s = settings();
		const interval = Number(s.intervalSeconds ?? 60);
		return {
			url: String(s.remoteUrl ?? "").trim().replace(/\/+$/, ""),
			token: String(s.remoteToken ?? "").trim(),
			interval: Math.max(15, Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 60),
		};
	};

	const keys = (): string[] => effectiveKeys(String(settings().keys ?? ""));
	/** A group is pulled unless the follower unchecked it (an older saved setting has no box at all: pull). */
	const picked = (field: string) => settings()[field] !== false;
	/** Of the keys the primary mirrors, the ones this follower picked. A key in no group (a listed extra) always comes along. */
	const pickedKeys = (list: readonly string[]): string[] =>
		list.filter((k) => !GROUPED.has(k) || GROUPS.some((g) => (g.keys as readonly string[]).includes(k) && picked(g.field)));
	/** Extension settings are opt-in: they carry choices a follower may well want to keep its own. */
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
	 * Keep the status field on the page in step. Written only when the text changes, so a timer tick that changed nothing
	 * does not rewrite the settings file.
	 * Korean for now: the app that shows a `{ ko, en }` value in the reader's language is not released yet, and 0.8.5 shows
	 * an object as "아직 없음". Switch to `statusText()` once that app is out; the `status` method already returns both.
	 */
	let writing = false;
	const showStatus = () => {
		if (writing) return;
		const text = statusText().ko;
		if (JSON.stringify(settings().statusText ?? "") === JSON.stringify(text)) return;
		writing = true;
		try { pi.settings.set({ ...settings(), statusText: text }); } finally { writing = false; }
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
		if (plain(params) && params.extensions === true) snap.extensions = allExtensionSettings();
		return snap;
	});

	pi.registerMethod("status", () => status());

	/** This server's address as a peer should reach it: the Tailscale/LAN address of this box. */
	const publicUrl = (): string => {
		const port = process.env.PIPAYA_PORT ?? "8787";
		const host = firstAddress();
		return host ? `http://${host}:${port}` : "";
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
			body: JSON.stringify({ code: value, name: "server-sync follower" }),
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
		pi.settings.set({ ...settings(), role: "follower", remoteUrl: url, remoteToken: token });
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
		const res = await fetch(`${url}/server-extensions/server-sync/methods/snapshot`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: withExtensions ? JSON.stringify({ extensions: true }) : "null",
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 401 || res.status === 403) throw new Error(`the peer refused the token (${res.status})`);
		if (!res.ok) throw new Error(`the peer answered ${res.status}`);
		const body = (await res.json()) as { result?: { keys?: unknown; settings?: unknown; extensions?: unknown } };
		const peer = body.result?.settings;
		if (!peer || typeof peer !== "object" || Array.isArray(peer)) throw new Error("the peer returned no settings");
		const list = pickedKeys(mirrorKeys(body.result?.keys, keys()));
		const mine = readSettings(dbo(), list);
		const theirs = Object.fromEntries(list.filter((k) => k in peer).map((k) => [k, (peer as Record<string, unknown>)[k]]));
		const changed = hashOf(theirs) === hashOf(mine) ? [] : applySnapshot(dbo(), list, peer as Record<string, unknown>);
		// A primary older than 0.8.0 sends no extensions: nothing to do, not an error.
		if (withExtensions && plain(body.result?.extensions)) changed.push(...(await applyExtensions(body.result.extensions)));
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
			const own = Object.fromEntries(Object.entries(current ?? {}).filter(([k]) => CREDENTIAL_KEY.test(k)));
			const theirs = Object.fromEntries(Object.entries(value).filter(([k]) => !CREDENTIAL_KEY.test(k)));
			const next = { ...theirs, ...own };
			if (sameObject(current, next)) continue;
			const port = process.env.PIPAYA_PORT ?? "8787";
			const res = await fetch(`http://127.0.0.1:${port}/extensions/${id}/settings`, {
				method: "PUT",
				headers: { authorization: `Bearer ${adminToken()}`, "content-type": "application/json" },
				body: JSON.stringify({ settings: next }),
				signal: AbortSignal.timeout(5_000),
			});
			if (!res.ok) throw new Error(`could not save the settings of ${id} here (${res.status})`);
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
	const arm = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		failures = 0;
		const { url, token, interval } = cfg();
		if (role() !== "follower" || !url || !token) return;
		const tick = () => {
			timer = undefined;
			if (busy) return schedule();
			busy = true;
			pull()
				.catch(() => { /* already logged and recorded in the status */ })
				.finally(() => { busy = false; schedule(); });
		};
		const schedule = () => {
			if (timer) return;
			const wait = Math.min(interval * 2 ** Math.min(failures, 4), interval * MAX_BACKOFF);
			timer = setTimeout(tick, wait * 1000);
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
		if (!url || !pasted || String(s.remoteToken ?? "").trim()) return;
		const key = `${url} ${pasted}`;
		if (rejected?.key === key && Date.now() < rejected.until) return;
		fetching = true;
		try {
			const token = await redeemPeerCode(url, pasted);
			rejected = null;
			lastError = null;
			pi.settings.set({ ...settings(), remoteUrl: url, remoteToken: token, shareCode: "" });
			log(`redeemed the peer's code at ${url}`);
			// Pull now: the page should say "connected" right after the save, not one interval later.
			if (!busy) {
				busy = true;
				void pull().catch(() => { /* recorded in the status */ }).finally(() => { busy = false; });
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
		// The form sends the status field back with every save (an empty one for a fresh page), which would leave the
		// line blank until the next pull. Writing it again here makes the blank last for one event, not for minutes.
		showStatus();
		arm();
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

	dropStaleCode();
	void fillPeerToken();
	showStatus();
	arm();
	// "3분 전" goes stale between pulls, and a settings store that was not ready at load would leave the field empty.
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
