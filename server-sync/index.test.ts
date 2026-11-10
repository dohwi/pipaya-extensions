// Drives the extension as the server does: a fake `pi`, a throwaway sqlite file, and the methods a client calls.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "server-sync-"));
const file = join(dir, "pipaya.db");
process.env.PIPAYA_DB = file;
process.env.PIPAYA_DATA_DIR = dir;
process.env.PIPAYA_TOKEN = "admin-token-for-tests";
process.env.PIPAYA_PORT = "8790";

const seed = (rows: Record<string, unknown>) => {
	const db = new Database(file);
	db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
	db.exec("DELETE FROM settings");
	for (const [k, v] of Object.entries(rows)) db.query("INSERT INTO settings (key, data) VALUES (?, ?)").run(k, JSON.stringify(v));
	db.close();
};

interface Harness {
	methods: Map<string, (params?: unknown) => unknown>;
	events: { type: string; data: unknown }[];
	unload(): void;
}

/** Load the extension once with the given settings; `unload` runs its `extension_unload` handlers. */
const boot = (settings: Record<string, unknown>): Harness => {
	const methods = new Map<string, (params?: unknown) => unknown>();
	const events: { type: string; data: unknown }[] = [];
	const hooks = new Map<string, (() => void)[]>();
	const pi = {
		settings: {
			get: () => settings,
			set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
			onChange: () => () => {},
		},
		log: () => {},
		registerMethod: (name: string, fn: (params?: unknown) => unknown) => void methods.set(name, fn),
		emit: (_sid: unknown, type: string, data: unknown) => void events.push({ type, data }),
		on: (event: string, fn: () => void) => void hooks.set(event, [...(hooks.get(event) ?? []), fn]),
	};
	factory(pi);
	return { methods, events, unload: () => { for (const fn of hooks.get("extension_unload") ?? []) fn(); } };
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

describe("connection code", () => {
	test("the code carries this server's address and admin token", () => {
		const h = boot({ role: "primary" });
		const made = h.methods.get("code")!() as { code: string; url: string };
		expect(made.url).toMatch(/^http:\/\/.+:8790$/);
		const packed = JSON.parse(Buffer.from(made.code, "base64url").toString("utf8")) as { u: string; t: string };
		expect(packed.t).toBe("admin-token-for-tests");
		expect(packed.u).toBe(made.url);
		// The code is also put on the page so it can be copied.
		h.unload();
	});

	test("an address the user typed wins over the detected one", () => {
		const h = boot({ role: "primary", shareUrl: "http://peer.example:1234/" });
		const made = h.methods.get("code")!() as { code: string };
		const packed = JSON.parse(Buffer.from(made.code, "base64url").toString("utf8")) as { u: string };
		expect(packed.u).toBe("http://peer.example:1234");
		h.unload();
	});
});

describe("share fields", () => {
	test("a primary fills its address, token and the code that packs them", () => {
		const settings: Record<string, unknown> = { role: "primary" };
		const methods = new Map<string, (p?: unknown) => unknown>();
		const pi = {
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: () => () => {},
			},
			log: () => {},
			registerMethod: (n: string, fn: (p?: unknown) => unknown) => void methods.set(n, fn),
			emit: () => {},
			on: () => {},
		};
		factory(pi);
		expect(settings.shareToken).toBe("admin-token-for-tests");
		expect(String(settings.shareUrl)).toMatch(/^http:\/\/.+:8790$/);
		// The code is ready to copy without pressing anything.
		const packed = JSON.parse(Buffer.from(String(settings.shareCode), "base64url").toString("utf8")) as { u: string; t: string };
		expect(packed.t).toBe("admin-token-for-tests");
		expect(packed.u).toBe(settings.shareUrl);
	});

	test("a follower with only a connection code takes the address and token from it", async () => {
		const packed = Buffer.from(JSON.stringify({ u: "http://127.0.0.1:9", t: "from-the-code" }), "utf8").toString("base64url");
		const settings: Record<string, unknown> = { role: "follower", shareCode: packed };
		const pi = {
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: () => () => {},
			},
			log: () => {},
			registerMethod: () => {},
			emit: () => {},
			on: () => {},
		};
		factory(pi);
		// The unpacking is started at load time; give it a moment to land.
		for (let i = 0; i < 50 && !settings.remoteToken; i++) await Bun.sleep(20);
		expect(settings.remoteToken).toBe("from-the-code");
		expect(settings.remoteUrl).toBe("http://127.0.0.1:9");
		expect(settings.shareCode).toBe("");
	});

	test("a primary keeps a value the user typed", () => {
		const settings: Record<string, unknown> = { role: "primary", shareUrl: "http://typed:1" };
		const pi = {
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: () => () => {},
			},
			log: () => {},
			registerMethod: () => {},
			emit: () => {},
			on: () => {},
		};
		factory(pi);
		expect(settings.shareUrl).toBe("http://typed:1");
		expect(settings.shareToken).toBe("admin-token-for-tests");
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
