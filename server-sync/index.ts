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
import { applySnapshot, effectiveKeys, hashOf, readRev, readSettings } from "./store.ts";

export default (pi: any) => {
	let db: Database | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let busy = false;

	const cfg = (): { url: string; token: string; interval: number } => {
		const s = (pi.settings.get() ?? {}) as Record<string, unknown>;
		return {
			url: String(s.remoteUrl ?? "").replace(/\/+$/, ""),
			token: String(s.remoteToken ?? ""),
			interval: Math.max(15, Number(s.intervalSeconds ?? 60)),
		};
	};

	const keys = (): string[] => {
		const s = (pi.settings.get() ?? {}) as Record<string, unknown>;
		return effectiveKeys(String(s.keys ?? ""));
	};

	/** The server's own db, opened lazily at the same path the server process uses. */
	const dbo = (): Database => {
		if (!db) {
			const path = process.env.PIPAYA_DB ?? join(process.env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya"), "pipaya.db");
			db = new Database(path);
			db.exec("PRAGMA busy_timeout = 5000");
		}
		return db;
	};

	const log = (msg: string) => pi.log(`[server-sync] ${msg}`);

	// ---- what the peer reads: the full mirror set, plus a revision for cheap change checks ----

	pi.registerMethod("snapshot", (): { rev: number; settings: Record<string, unknown> } => ({ rev: readRev(dbo()), settings: readSettings(dbo(), keys()) }));

	// ---- the follower's pull ----

	/** Pull the primary's snapshot and mirror it. Returns the keys changed (empty when already equal). */
	const syncNow = async (): Promise<string[]> => {
		const { url, token } = cfg();
		if (!url || !token) throw new Error("remoteUrl and remoteToken must be set");
		const res = await fetch(`${url}/server-extensions/server-sync/methods/snapshot`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "null",
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`peer answered ${res.status}`);
		const body = (await res.json()) as { result?: { settings?: Record<string, unknown> } };
		const peer = body.result?.settings;
		if (!peer || typeof peer !== "object") throw new Error("peer returned no settings");
		if (hashOf(peer) === hashOf(readSettings(dbo(), keys()))) return [];
		return applySnapshot(dbo(), keys(), peer);
	};

	pi.registerMethod("sync", async () => ({ applied: await syncNow() }));

	// Poll the primary. A miss is logged and retried on the next tick; the loop never throws.
	const arm = () => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (busy) return;
			busy = true;
			syncNow()
				.then((changed) => { if (changed.length) log(`applied: ${changed.join(", ")}`); })
				.catch((e) => log(`sync failed: ${e instanceof Error ? e.message : String(e)}`))
				.finally(() => { busy = false; });
		}, cfg().interval * 1000);
	};

	arm();
	pi.settings.onChange(arm);
	pi.on("extension_unload", () => { if (timer) clearInterval(timer); });
};
