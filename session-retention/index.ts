// session-retention: deletes sessions that have not been used for a while. The server never does this by itself.
// Turn it on with PIPAYA_FLAG_RETENTION_DAYS=30 (optionally PIPAYA_FLAG_RETENTION_ONLY_CLOSED=1), or call the `setPolicy`
// method, or fill in the form in Settings (the choice is saved in this extension's settings and wins over the flags).
// A session that is running, or waiting for an answer, is never deleted, whatever its age.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 24 * 3600_000;
const EVERY_MS = 3600_000;

interface Policy { enabled: boolean; days: number; onlyClosed: boolean }
interface State { lastRun: number | null; lastDeleted: number }

export default (pi: any) => {
	pi.registerFlag("retention_days", { type: "string", description: "Delete sessions not used for this many days (empty = never)" });
	pi.registerFlag("retention_only_closed", { type: "boolean", default: false, description: "Only delete sessions that are closed" });

	const file = (name: string) => join(pi.dataDir, name);
	const read = <T>(name: string): Partial<T> | null => {
		try { return existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : null; } catch { return null; }
	};
	const policy = (): Policy => {
		// The settings form (Settings > server extensions) and `setPolicy` both write pi.settings; it wins over the older policy.json and the flags.
		const form = pi.settings.get() as Partial<Policy>;
		const saved = Object.keys(form).length ? form : read<Policy>("policy.json");
		if (saved) return { enabled: saved.enabled === true, days: Math.max(1, Math.floor(Number(saved.days) || 30)), onlyClosed: saved.onlyClosed === true };
		const days = Math.floor(Number(pi.getFlag("retention_days")));
		return { enabled: days >= 1, days: days >= 1 ? days : 30, onlyClosed: pi.getFlag("retention_only_closed") === true };
	};
	const state = (): State => ({ lastRun: null, lastDeleted: 0, ...(read<State>("state.json") ?? {}) });

	/** Sessions the policy matches now, oldest first. */
	const candidates = (p: Policy, now = Date.now()): string[] => {
		const out: any[] = [];
		for (let before: number | undefined, i = 0; i < 200; i++) {
			const page = pi.sessions.list({ limit: 500, before, closed: p.onlyClosed ? true : undefined });
			out.push(...page);
			if (page.length < 500) break;
			before = page[page.length - 1].updatedAt;
		}
		return out.filter((s) => s.updatedAt < now - p.days * DAY && !s.busy).sort((a, b) => a.updatedAt - b.updatedAt).map((s) => s.id);
	};

	const run = (now = Date.now()) => {
		const p = policy();
		if (!p.enabled) return 0;
		let deleted = 0;
		for (const id of candidates(p, now)) if (pi.sessions.delete(id)) deleted++;
		writeFileSync(file("state.json"), JSON.stringify({ lastRun: now, lastDeleted: deleted }));
		if (deleted) pi.log(`deleted ${deleted} session(s) not used for ${p.days} days`);
		return deleted;
	};

	const info = () => {
		const p = policy();
		return { policy: p, ...state(), due: p.enabled ? candidates(p).length : 0 };
	};

	pi.registerMethod("info", () => info());
	pi.registerMethod("setPolicy", (params: Partial<Policy> | null) => {
		const days = Math.floor(Number(params?.days));
		if (!(days >= 1 && days <= 3650)) throw new Error("days must be between 1 and 3650");
		pi.settings.set({ enabled: params?.enabled === true, days, onlyClosed: params?.onlyClosed === true });
		pi.emit(null, "policy_changed", info().policy);
		return info();
	});
	pi.registerMethod("run", () => ({ deleted: run() }));

	const timer = setInterval(() => { try { run(); } catch (e) { pi.log("clean-up failed", String(e)); } }, EVERY_MS);
	// Shortly after start, so a server that was off for a while does not wait a full hour.
	const first = setTimeout(() => { try { run(); } catch (e) { pi.log("clean-up failed", String(e)); } }, 30_000);
	timer.unref?.();
	first.unref?.();
	pi.on("extension_unload", () => { clearInterval(timer); clearTimeout(first); });
};
