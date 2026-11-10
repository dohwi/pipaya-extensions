// Exercises the extension wiring itself: a fake `pi`, a throwaway sqlite file, and the methods a client calls.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "server-sync-"));
const file = join(dir, "pipaya.db");
process.env.PIPAYA_DB = file;

const seed = (rows: Record<string, unknown>) => {
	const db = new Database(file);
	db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
	db.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT)");
	db.exec("DELETE FROM settings");
	for (const [k, v] of Object.entries(rows)) db.query("INSERT INTO settings (key, data) VALUES (?, ?)").run(k, JSON.stringify(v));
	db.close();
};

interface Harness {
	methods: Map<string, (params?: unknown) => unknown>;
	events: { type: string; data: unknown }[];
	set(value: Record<string, unknown>): void;
	unload(): void;
}

/** Load the extension once with the given settings; `unload` runs its `extension_unload` handlers. */
const boot = (settings: Record<string, unknown>): Harness => {
	const methods = new Map<string, (params?: unknown) => unknown>();
	const events: { type: string; data: unknown }[] = [];
	const hooks = new Map<string, (() => void)[]>();
	let current = settings;
	const pi = {
		settings: { get: () => current, onChange: () => () => {} },
		log: () => {},
		registerMethod: (name: string, fn: (params?: unknown) => unknown) => void methods.set(name, fn),
		emit: (_sid: unknown, type: string, data: unknown) => void events.push({ type, data }),
		on: (event: string, fn: () => void) => void hooks.set(event, [...(hooks.get(event) ?? []), fn]),
	};
	factory(pi);
	return {
		methods,
		events,
		set: (value) => { current = value; },
		unload: () => { for (const fn of hooks.get("extension_unload") ?? []) fn(); },
	};
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("snapshot", () => {
	beforeEach(() => seed({ default_model: { provider: "a", model: "b" }, skills: { global: {} }, device_id: "x", unrelated: 1 }));

	test("serves the mirror set with the keys it covers", () => {
		const h = boot({ role: "primary" });
		const snap = h.methods.get("snapshot")!() as { keys: string[]; settings: Record<string, unknown> };
		expect(snap.keys).toContain("default_model");
		expect(snap.keys).not.toContain("device_id");
		expect(snap.settings).toEqual({ default_model: { provider: "a", model: "b" }, skills: { global: {} } });
		h.unload();
	});

	test("extra keys from the settings form are mirrored too", () => {
		const h = boot({ role: "primary", keys: "unrelated" });
		const snap = h.methods.get("snapshot")!() as { keys: string[]; settings: Record<string, unknown> };
		expect(snap.keys).toContain("unrelated");
		expect(snap.settings.unrelated).toBe(1);
		h.unload();
	});
});

describe("status", () => {
	test("reports the role, the keys and the interval floor", () => {
		const h = boot({ role: "follower", remoteUrl: "http://peer:1/", intervalSeconds: 2 });
		const st = h.methods.get("status")!() as Record<string, unknown>;
		expect(st.role).toBe("follower");
		expect(st.url).toBe("http://peer:1");
		expect(st.intervalSeconds).toBe(15);
		expect(st.lastSyncAt).toBeNull();
		expect(st.lastError).toBeNull();
		expect(Array.isArray(st.keys)).toBe(true);
		h.unload();
	});
});

describe("sync", () => {
	test("refuses to pull on the primary", async () => {
		const h = boot({ role: "primary" });
		await expect(Promise.resolve(h.methods.get("sync")!())).rejects.toThrow(/primary/);
		h.unload();
	});

	test("says what is missing instead of calling out", async () => {
		const h = boot({ role: "follower" });
		await expect(Promise.resolve(h.methods.get("sync")!())).rejects.toThrow(/peer server URL/);
		h.unload();
	});

	test("records a failed pull in the status", async () => {
		// Nothing listens on this port: the pull must fail without throwing out of the method call chain.
		const h = boot({ role: "follower", remoteUrl: "http://127.0.0.1:9", remoteToken: "t" });
		await expect(Promise.resolve(h.methods.get("sync")!())).rejects.toThrow();
		const st = h.methods.get("status")!() as { lastError: string | null; lastSyncAt: number | null };
		expect(st.lastError).toBeTruthy();
		expect(st.lastSyncAt).toBeNull();
		h.unload();
	});
});
