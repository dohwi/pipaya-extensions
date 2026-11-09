// The mirror logic, apart from the extension wiring so it can be tested without a server.
import { createHash } from "node:crypto";

/** Rows mirrored by default (see index.ts for why these). */
export const SYNCED_KEYS = [
	"default_model", "default_workdir", "system_model", "image_model",
	"mcp_servers", "compaction", "retention", "skills",
	"disabled_tools", "disabled_subagents", "delegate_policy",
] as const;

/** Never mirrored: per-device identity, token-adjacent or local-only rows. */
export const NEVER_SYNCED = new Set(["device_id", "default_approval", "voice_input", "retention_state", "session_retention_state"]);

export interface DatabaseLike {
	query(sql: string): { get(...p: unknown[]): any; all(...p: unknown[]): any; run(...p: unknown[]): unknown };
}

export interface Snapshot {
	rev: number;
	settings: Record<string, unknown>;
}

/** The effective key list: the built-ins plus the user's extras, minus the never-synced. */
export function effectiveKeys(extra: string | undefined): string[] {
	const list = String(extra ?? "").split(",").map((k) => k.trim()).filter(Boolean);
	return [...new Set([...SYNCED_KEYS, ...list])].filter((k) => !NEVER_SYNCED.has(k));
}

/** The rows we mirror from the settings table: key -> parsed value, only the keys present. */
export function readSettings(db: DatabaseLike, keys: readonly string[]): Record<string, unknown> {
	const rows = db.query(`SELECT key, data FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as { key: string; data: string }[];
	const out: Record<string, unknown> = {};
	for (const r of rows) {
		try { out[r.key] = JSON.parse(r.data); } catch { /* a damaged row is not ours to fix */ }
	}
	return out;
}

/** The server's event counter: it grows with every settings write, so it works as a revision. */
export function readRev(db: DatabaseLike): number {
	const row = db.query("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined;
	return row?.seq ?? 0;
}

/** Writes the peer's rows over ours; a key the peer lacks is deleted. Returns the keys that changed. */
export function applySnapshot(db: DatabaseLike, keys: readonly string[], peer: Record<string, unknown>): string[] {
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
export const hashOf = (settings: Record<string, unknown>) =>
	createHash("sha256").update(JSON.stringify(Object.keys(settings).sort().map((k) => [k, settings[k]]))).digest("hex");
