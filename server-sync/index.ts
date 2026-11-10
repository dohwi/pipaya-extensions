// server-sync: mirrors the pipaya `settings` table of a primary server onto this one.
//
// Roles (chosen in the settings form):
//   - "primary": serves its settings to the peer (the `snapshot` method below) and changes nothing itself.
//   - "follower": polls the primary and applies what it sees. Its own conflicting edits are overwritten.
//
// Only the keys in `keys()` are mirrored; see store.ts for the list and the rules.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { applySnapshot, effectiveKeys, hashOf, mirrorKeys, readSettings, type Snapshot } from "./store.ts";

/** How often a failing pull is retried at most (the base interval is multiplied by 2 per miss, up to this). */
const MAX_BACKOFF = 8;

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

	/** The server's own db, opened lazily at the same path the server process uses. */
	const dbo = (): Database => {
		if (!db) {
			const path = process.env.PIPAYA_DB ?? join(process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya"), "pipaya.db");
			db = new Database(path);
			db.exec("PRAGMA busy_timeout = 5000");
		}
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

	// ---- what the peer reads: the rows it mirrors and the keys they cover ----

	pi.registerMethod("snapshot", (): Snapshot => {
		const list = keys();
		return { keys: list, settings: readSettings(dbo(), list) };
	});

	pi.registerMethod("status", () => status());

	// ---- the follower's pull ----

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

	arm();
	pi.settings.onChange(arm);
	pi.on("extension_unload", () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		try { db?.close(); } catch { /* already closed */ }
		db = undefined;
	});
};
