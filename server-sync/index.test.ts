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
	test("the code is a pairing code the peer mints, and it is not the admin token", async () => {
		// The extension asks its own server for a pairing code; stand in for that one call.
		const seen: { url: string; auth: string | null }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			seen.push({ url: String(input), auth: init?.headers?.authorization ?? null });
			return Response.json({ code: "one-time-code", expiresAt: Date.now() + 120_000 });
		}) as typeof fetch;
		try {
			const h = boot({ role: "primary" });
			const made = (await h.methods.get("code")!()) as { url: string; code: string };
			expect(made.code).toBe("one-time-code");
			expect(made.url).toMatch(/^http:\/\/.+:8790$/);
			expect(seen[0]!.url).toBe(`${made.url}/pairing`);
			// The code is requested with this server's admin token; the code itself is what the follower gets.
			expect(seen[0]!.auth).toBe("Bearer admin-token-for-tests");
			h.unload();
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("the status line on the page", () => {
	test("a primary says what it is", () => {
		const settings: Record<string, unknown> = { role: "primary" };
		const methods = new Map<string, (p?: unknown) => unknown>();
		const pi = {
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: () => () => {},
			},
			log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => void methods.set(n, f), emit: () => {}, on: () => {},
		};
		factory(pi);
		expect(String(settings.statusText)).toMatch(/^● 기준 서버/);
		expect(((methods.get("status")!() as { status: { en: string } }).status.en)).toMatch(/^● Primary/);
	});

	test("a follower with no address says so, and one with an address says it is connected", async () => {
		const settings: Record<string, unknown> = { role: "follower" };
		const methods = new Map<string, (p?: unknown) => unknown>();
		const pi = {
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: () => () => {},
			},
			log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => void methods.set(n, f), emit: () => {}, on: () => {},
		};
		factory(pi);
		expect(String(settings.statusText)).toMatch(/주소를 입력하세요/);
		// Saving an address and a token is what a follower does; the line then reports the connection.
		settings.remoteUrl = "http://127.0.0.1:9";
		settings.remoteToken = "t";
		await expect(Promise.resolve(methods.get("sync")!())).rejects.toThrow();
		// The pull failed, so the line says that instead of pretending to be connected.
		expect(String(settings.statusText)).toMatch(/^✕ 연결 실패/);
	});
});

describe("the status line survives a save from the form", () => {
	test("a save that blanks it is written back at once", () => {
		const settings: Record<string, unknown> = { role: "primary" };
		let onChange: (() => void) | undefined;
		const pi = {
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: (fn: () => void) => { onChange = fn; return () => {}; },
			},
			log: () => {}, registerMethod: () => {}, emit: () => {}, on: () => {},
		};
		factory(pi);
		expect(String(settings.statusText)).toMatch(/^● 기준 서버/);
		// The form posts every field back, the status one included, and a fresh page holds "".
		settings.statusText = "";
		onChange!();
		expect(String(settings.statusText)).toMatch(/^● 기준 서버/);
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

describe("the pull timer", () => {
	test("a settings write that changes nothing that matters does not push the next pull back", () => {
		const settings: Record<string, unknown> = { role: "follower", remoteUrl: "http://127.0.0.1:9", remoteToken: "t", intervalSeconds: 60 };
		let onChange: (() => void) | undefined;
		const pulls: number[] = [];
		const realSet = globalThis.setTimeout;
		const realClear = globalThis.clearTimeout;
		const live = new Set<unknown>();
		// Record the pull timer (the only one of 15 s or more) and whether it is ever cancelled.
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			const h = realSet(() => {}, 0);
			if ((ms ?? 0) >= 15_000) { pulls.push(ms!); live.add(h); }
			return h;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((h: unknown) => { live.delete(h); realClear(h as never); }) as typeof clearTimeout;
		try {
			factory({
				settings: {
					get: () => settings,
					set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); onChange?.(); return settings; },
					onChange: (fn: () => void) => { onChange = fn; return () => {}; },
				},
				log: () => {}, registerMethod: () => {}, emit: () => {}, on: () => {},
			});
			expect(pulls.length).toBe(1);
			// The status line rewriting itself, a checkbox saved: same peer, same interval.
			for (let i = 0; i < 5; i++) { settings.statusText = `tick ${i}`; onChange!(); }
			settings.syncModels = false;
			onChange!();
			expect(pulls.length).toBe(1);
			expect(live.size).toBe(1);
			// A new interval does restart it.
			settings.intervalSeconds = 120;
			onChange!();
			expect(pulls).toEqual([60_000, 120_000]);
			expect(live.size).toBe(1);
		} finally {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		}
	});
});
