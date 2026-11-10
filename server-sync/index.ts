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
			const dir = process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya");
			return readFileSync(join(dir, "token"), "utf8").trim();
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
		if (res.status === 403 || res.status === 429) throw new Error("the code is wrong or has expired; make a new one on the primary");
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
	 * A follower with an address and the primary's code needs nothing else: redeem the code for a device token and save
	 * it. The code is cleared once used, so it never lingers in the settings file.
	 */
	let fetching = false;
	const fillPeerToken = async () => {
		if (fetching || role() !== "follower") return;
		const s = settings();
		const url = String(s.remoteUrl ?? "").trim().replace(/\/+$/, "");
		const pasted = String(s.shareCode ?? "").trim();
		if (!url || !pasted || String(s.remoteToken ?? "").trim()) return;
		fetching = true;
		try {
			const token = await redeemPeerCode(url, pasted);
			pi.settings.set({ ...settings(), remoteToken: token, shareCode: "" });
			log(`redeemed the peer's code at ${url}`);
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			log(lastError);
		} finally {
			fetching = false;
		}
	};

	const refresh = () => {
		void fillPeerToken();
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
