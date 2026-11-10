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
import { readFileSync } from "node:fs";

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

/** Never mirrored: per-device identity, token-adjacent or local-only rows. */
const NEVER_SYNCED = new Set(["device_id", "default_approval", "voice_input", "retention_state", "session_retention_state"]);

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
}

interface Status {
	role: "primary" | "follower";
	/** The peer address in effect (follower only). */
	url: string;
	/** Seconds between pulls, as configured (minimum 15). */
	intervalSeconds: number;
	/** The keys this server mirrors. */
	keys: string[];
	/** Unix ms of the last successful pull (follower only). */
	lastSyncAt: number | null;
	/** Keys the last successful pull changed. */
	lastApplied: string[];
	/** Why the last pull failed, if it did. */
	lastError: string | null;
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

/** Pack an address and token into the one value a follower pastes: `{ u, t }` as base64url. */
function packCode(url: string, token: string): string {
	return Buffer.from(JSON.stringify({ u: url, t: token }), "utf8").toString("base64url");
}

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

	const status = (): Status => ({
		role: role(),
		url: cfg().url,
		intervalSeconds: cfg().interval,
		keys: keys(),
		lastSyncAt,
		lastApplied,
		lastError,
	});

	// ---- what a peer reads: the rows this server mirrors and the keys they cover ----

	pi.registerMethod("snapshot", (): Snapshot => {
		const list = keys();
		return { keys: list, settings: readSettings(dbo(), list) };
	});

	pi.registerMethod("status", () => status());

	/**
	 * This server's address as a peer should reach it. `shareUrl` is the field the user sees and may edit (it is what
	 * `redeem` hands out); when it is empty the Tailscale/LAN address of this box is offered instead.
	 */
	const publicUrl = (): string => {
		const typed = String(settings().shareUrl ?? "").trim().replace(/\/+$/, "");
		if (typed) return typed;
		const port = process.env.PIPAYA_PORT ?? "8787";
		const host = firstAddress();
		return host ? `http://${host}:${port}` : "";
	};

	/** The admin token of this server (`PIPAYA_TOKEN`, else the `token` file in the data dir). */
	const adminToken = (): string => {
		const fromEnv = process.env.PIPAYA_TOKEN;
		if (fromEnv) return fromEnv.trim();
		try {
			const dir = process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya");
			return readFileSync(join(dir, "token"), "utf8").trim();
		} catch {
			return "";
		}
	};

	/**
	 * A connection string: the address and admin token, packed so the user copies one value instead of two. It is not a
	 * secret of its own — whoever holds it holds the token — so it is shown only on the primary's own page (an admin-only
	 * settings page) and the follower stores it as its `remoteToken`.
	 */
	pi.registerMethod("code", () => {
		const url = publicUrl();
		const token = adminToken();
		if (!url || !token) throw new Error("this server has no address or token to share");
		const value = packCode(url, token);
		pi.settings.set({ ...settings(), shareCode: value });
		return { code: value, url, expiresAt: 0 };
	});

	/**
	 * Unpack a connection string the primary produced: `{ u, t }` in base64url. It needs no call to the peer, so
	 * connecting works even when the peer's method routes are closed to an unauthenticated caller.
	 */
	const unpackCode = (value: string): { url: string; token: string } => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		} catch {
			throw new Error("this is not a connection code; copy the whole value from the primary");
		}
		const o = parsed as { u?: unknown; t?: unknown };
		const url = typeof o.u === "string" ? o.u.trim().replace(/\/+$/, "") : "";
		const token = typeof o.t === "string" ? o.t.trim() : "";
		if (!url || !token) throw new Error("the connection code is incomplete; make a new one on the primary");
		return { url, token };
	};

	/**
	 * Connect to a peer with the address and the one-time code it shows: redeem the code for its token, then pull.
	 * A token typed in by hand is used as-is, so a peer too old for codes still works.
	 */
	pi.registerMethod("connect", async (params: unknown) => {
		const input = (params ?? {}) as { url?: unknown; token?: unknown; code?: unknown };
		const givenCode = String(input.code ?? "").trim();
		const packed = givenCode ? unpackCode(givenCode) : undefined;
		const url = String(input.url ?? "").trim().replace(/\/+$/, "") || packed?.url || "";
		if (!url) throw new Error("a peer address is required");
		if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error(`not an http(s) address: ${url}`);
		const token = String(input.token ?? "").trim() || packed?.token || "";
		if (!token) throw new Error("set the peer's connection code (or its admin token)");
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
		const res = await fetch(`${url}/server-extensions/server-sync/methods/snapshot`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "null",
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 401 || res.status === 403) throw new Error(`the peer refused the token (${res.status})`);
		if (!res.ok) throw new Error(`the peer answered ${res.status}`);
		const body = (await res.json()) as { result?: { keys?: unknown; settings?: unknown } };
		const peer = body.result?.settings;
		if (!peer || typeof peer !== "object" || Array.isArray(peer)) throw new Error("the peer returned no settings");
		const list = mirrorKeys(body.result?.keys, keys());
		const mine = readSettings(dbo(), list);
		if (hashOf(peer as Record<string, unknown>) === hashOf(mine)) return [];
		return applySnapshot(dbo(), list, peer as Record<string, unknown>);
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
	 * Keep the two "share" fields on the primary filled in, so its address and token are on screen to copy instead of
	 * hidden in the data folder. Only written when empty or stale, so a value the user typed is never overwritten.
	 */
	let filling = false;
	const fillShareFields = () => {
		if (filling || role() !== "primary") return;
		const s = settings();
		const url = publicUrl();
		const token = adminToken();
		const want: Record<string, unknown> = {};
		if (url && s.shareUrl !== url) want.shareUrl = url;
		if (token && s.shareToken !== token) want.shareToken = token;
		// The code is just the two above packed together, so it is kept in step with them: one field to copy.
		const packed = url && token ? packCode(url, token) : "";
		if (packed && s.shareCode !== packed) want.shareCode = packed;
		if (!Object.keys(want).length) return;
		filling = true;
		try { pi.settings.set({ ...s, ...want }); } finally { filling = false; }
	};

	/**
	 * A follower with an address and the primary's code needs nothing else: redeem the code for the token and save it.
	 * The code is cleared once used, so it never lingers in the settings file.
	 */
	let fetching = false;
	const fillPeerToken = async () => {
		if (fetching || role() !== "follower") return;
		const s = settings();
		const url = String(s.remoteUrl ?? "").trim().replace(/\/+$/, "");
		const pasted = String(s.shareCode ?? "").trim();
		if (!pasted || String(s.remoteToken ?? "").trim()) return;
		fetching = true;
		try {
			const packed = unpackCode(pasted);
			pi.settings.set({ ...settings(), remoteUrl: packed.url, remoteToken: packed.token, shareCode: "" });
			log(`took the address and token from the connection code (${packed.url})`);
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			log(lastError);
		} finally {
			fetching = false;
		}
	};

	const refresh = () => {
		fillShareFields();
		void fillPeerToken();
		arm();
	};

	fillShareFields();
	void fillPeerToken();
	arm();
	pi.settings.onChange(refresh);
	pi.on("extension_unload", () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		try { db?.close(); } catch { /* already closed */ }
		db = undefined;
	});
};

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
