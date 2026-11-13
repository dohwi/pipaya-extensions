// Drives the extension as the server does: a fake `pi`, a throwaway sqlite file, and the methods a client calls.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { decide } from "./index.ts";

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

	test("serves the mirror set with the keys it covers", async () => {
		const h = boot({ role: "primary" });
		const snap = await h.methods.get("snapshot")!() as { keys: string[]; settings: Record<string, unknown> };
		expect(snap.keys).toContain("default_model");
		expect(snap.keys).not.toContain("device_id");
		expect(snap.settings).toEqual({ default_model: { provider: "a", model: "b" }, skills: { global: {} } });
		h.unload();
	});

	test("extra keys from the settings form are mirrored too", async () => {
		const h = boot({ role: "primary", keys: "unrelated" });
		const snap = await h.methods.get("snapshot")!() as { keys: string[]; settings: Record<string, unknown> };
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

describe("the status line (status method; older apps have no page)", () => {
	const line = (methods: Map<string, (p?: unknown) => unknown>) => (methods.get("status")!() as { status: { ko: string; en: string } }).status;
	const bootPlain = (settings: Record<string, unknown>) => {
		const methods = new Map<string, (p?: unknown) => unknown>();
		factory({
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
				onChange: () => () => {},
			},
			log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => void methods.set(n, f), emit: () => {}, on: () => {},
		});
		return methods;
	};

	test("a primary says what it is, and nothing is written into the settings", () => {
		const settings: Record<string, unknown> = { role: "primary" };
		const methods = bootPlain(settings);
		expect(line(methods).ko).toMatch(/^● 기준 서버/);
		expect(line(methods).en).toMatch(/^● Primary/);
		expect("statusText" in settings).toBe(false);
	});

	test("a follower with no address says so, and a failed pull says it failed", async () => {
		const settings: Record<string, unknown> = { role: "follower" };
		const methods = bootPlain(settings);
		expect(line(methods).ko).toMatch(/주소를 입력하세요/);
		settings.remoteUrl = "http://127.0.0.1:9";
		settings.remoteToken = "t";
		await expect(Promise.resolve(methods.get("sync")!())).rejects.toThrow();
		expect(line(methods).ko).toMatch(/^✕ 연결 실패/);
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
		// Record the pull timer (the first one runs after 3 s, the rest after the interval) and whether it is cancelled.
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			const h = realSet(() => {}, 0);
			if (ms === 3_000 || (ms ?? 0) >= 15_000) { pulls.push(ms!); live.add(h); }
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
			settings.syncApp = false;
			onChange!();
			expect(pulls.length).toBe(1);
			expect(live.size).toBe(1);
			// A new interval does restart it.
			settings.intervalSeconds = 120;
			onChange!();
			// Still nothing pulled, so the restarted timer also checks within seconds.
			expect(pulls).toEqual([3_000, 3_000]);
			expect(live.size).toBe(1);
		} finally {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		}
	});
});

describe("this extension's own settings", () => {
	test("are never applied from a primary, even one that sends them", async () => {
		const puts: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/methods/snapshot")) {
				// An old or tampered primary: its own server-sync settings ride along with another extension's.
				return Response.json({ result: { keys: [], settings: {}, extensions: {
					"server-sync": { role: "primary", remoteUrl: "http://elsewhere:1" },
					"quota-monitor": { language: "ko" },
				} } });
			}
			if (init?.method === "PUT") { puts.push(new URL(url).pathname); return Response.json({ applied: true }); }
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		try {
			const h = boot({ role: "follower", remoteUrl: "http://primary:1", remoteToken: "t", syncExtensions: true });
			const res = (await h.methods.get("sync")!()) as { applied: string[] };
			expect(res.applied.filter((k) => k.startsWith("ext:"))).toEqual(["ext:quota-monitor"]);
			expect(res.applied.some((k) => k.includes("server-sync"))).toBe(false);
			expect(puts).toEqual(["/extensions/quota-monitor/settings"]);
			h.unload();
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("are never served to a follower", async () => {
		const root = join(dir, "extensions");
		mkdirSync(join(root, "server-sync"), { recursive: true });
		writeFileSync(join(root, "server-sync", "settings.json"), JSON.stringify({ role: "primary" }));
		mkdirSync(join(root, "guard"), { recursive: true });
		writeFileSync(join(root, "guard", "settings.json"), JSON.stringify({ mode: "strict" }));
		const h = boot({ role: "primary" });
		const snap = await h.methods.get("snapshot")!({ extensions: true }) as { extensions: Record<string, unknown> };
		expect(Object.keys(snap.extensions)).toEqual(["guard"]);
		h.unload();
	});
});

describe("the page (pi.ui, app 0.8.8+)", () => {
	const bootWithUi = (settings: Record<string, unknown>) => {
		const methods = new Map<string, (p?: unknown) => unknown>();
		const panels: unknown[] = [];
		let handler: ((e: { type: string; id: string }) => Promise<void> | void) | undefined;
		let onChange: (() => void) | undefined;
		const hooks: (() => void)[] = [];
		factory({
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); onChange?.(); return settings; },
				onChange: (fn: () => void) => { onChange = fn; return () => {}; },
			},
			dataDir: mkdtempSync(join(dir, "ui-")),
			ui: { setPanel: (node: unknown) => void panels.push(node), onEvent: (fn: typeof handler) => { handler = fn; } },
			log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => void methods.set(n, f), emit: () => {},
			on: (ev: string, fn: () => void) => { if (ev === "extension_unload") hooks.push(fn); },
		});
		const last = () => JSON.stringify(panels.at(-1));
		return { methods, panels, last, click: (id: string) => handler!({ type: "action", id }), unload: () => hooks.forEach((f) => f()) };
	};

	test("the status goes to the page, not into the settings, and an old status field is dropped", () => {
		const settings: Record<string, unknown> = { role: "primary", statusText: "● 기준 서버 — old" };
		const h = bootWithUi(settings);
		expect("statusText" in settings).toBe(false);
		expect(h.last()).toContain("기준 서버");
		expect(h.last()).toContain("연결 링크 복사");
		h.unload();
	});

	test("a follower without a link is told where to get one; a failed pull shows as an alert with a retry button", async () => {
		const settings: Record<string, unknown> = { role: "follower" };
		const h = bootWithUi(settings);
		expect(h.last()).toContain("연결 안 됨");
		expect(h.last()).not.toContain("\"sync\"");
		h.unload();

		const failing = bootWithUi({ role: "follower", remoteUrl: "http://127.0.0.1:9", remoteToken: "t" });
		await failing.click("sync");
		const page = JSON.parse(failing.last());
		const flat = JSON.stringify(page);
		expect(flat).toContain("연결 실패");
		expect(flat).toContain("\"type\":\"alert\"");
		expect(flat).toContain("\"id\":\"sync\"");
		expect(flat).not.toContain("동기화 중");
		failing.unload();
	});

	test("disconnect forgets the address and the token", async () => {
		const settings: Record<string, unknown> = { role: "follower", remoteUrl: "http://127.0.0.1:9", remoteToken: "t" };
		const h = bootWithUi(settings);
		await h.click("disconnect");
		expect(settings.remoteUrl).toBe("");
		expect((h.methods.get("status")!() as { url: string }).url).toBe("");
		expect(h.last()).toContain("연결 안 됨");
		h.unload();
	});
});

describe("the primary's page says whether secrets can leave", () => {
	test("a warning only while sharing is on", () => {
		const page = (extra: Record<string, unknown>) => {
			const panels: string[] = [];
			factory({
				dataDir: mkdtempSync(join(dir, "pri-")),
				settings: { get: () => ({ role: "primary", ...extra }), set: () => ({}), onChange: () => () => {} },
				ui: { setPanel: (n: unknown) => void panels.push(JSON.stringify(n)), onEvent: () => {} },
				log: () => {}, registerMethod: () => {}, emit: () => {}, on: () => {},
			});
			return panels.at(-1)!;
		};
		expect(page({})).toContain("secrets-off");
		expect(page({})).not.toContain("secrets-on");
		expect(page({ shareSecrets: true })).toContain("secrets-on");
		expect(page({ shareSecrets: true })).toContain("모델 API 키");
	});
});

describe("the page after a pull", () => {
	test("is redrawn once the pull is over, so 'now' does not stay on screen", async () => {
		const settings: Record<string, unknown> = { role: "follower", remoteUrl: "http://127.0.0.1:9", remoteToken: "t" };
		const panels: string[] = [];
		const timers: (() => void)[] = [];
		const realSet = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => { if (ms === 3_000) { timers.push(fn); return realSet(() => {}, 0); } return realSet(fn, ms); }) as typeof setTimeout;
		try {
			factory({
				dataDir: mkdtempSync(join(dir, "after-")),
				settings: { get: () => settings, set: (n: Record<string, unknown>) => { Object.assign(settings, n); return settings; }, onChange: () => () => {} },
				ui: { setPanel: (n: unknown) => void panels.push(JSON.stringify(n)), onEvent: () => {} },
				log: () => {}, registerMethod: () => {}, emit: () => {}, on: () => {},
			});
		} finally {
			globalThis.setTimeout = realSet;
		}
		expect(timers.length).toBe(1);
		timers[0]!(); // the first timed pull starts: the page says "now" while it runs
		await Bun.sleep(5);
		await Bun.sleep(400); // the pull to a closed port fails quickly
		const last = panels.at(-1)!;
		expect(last).not.toContain('"value":{"ko":"지금"');
		expect(last).toContain("연결 실패");
	});
});

describe("decide: one item of a two-way sync", () => {
	const b = (p: string, f = p) => ({ p, f });
	const later = { first: false, deletes: true };
	const files = { first: false, deletes: false };
	test("equal, or only stored differently: nothing to do", () => {
		expect(decide("x", "x", b("x"), later)).toBe("same");
		expect(decide("px", "fx", b("px", "fx"), later)).toBe("same");
	});
	test("changed on one side goes to the other", () => {
		expect(decide("x", "y", b("x"), later)).toBe("push");
		expect(decide("y", "x", b("x"), later)).toBe("pull");
	});
	test("changed on both: the primary wins", () => {
		expect(decide("p2", "f2", b("x"), later)).toBe("pull");
	});
	test("the first sync only pulls; an item only here stays", () => {
		expect(decide("x", "y", undefined, { first: true, deletes: true })).toBe("pull");
		expect(decide("", "y", undefined, { first: true, deletes: false })).toBe("keep");
	});
	test("made here after the first sync goes up; one marked 'only here' stays", () => {
		expect(decide("", "y", undefined, later)).toBe("push");
		expect(decide("", "y", "local", later)).toBe("keep");
	});
	test("a removed row travels; a removed file comes back, and one removed on the primary stays here", () => {
		expect(decide("x", "", b("x"), later)).toBe("push");
		expect(decide("", "x", b("x"), later)).toBe("pull");
		expect(decide("x", "", b("x"), files)).toBe("pull");
		expect(decide("", "x", b("x"), files)).toBe("keep");
	});
});
