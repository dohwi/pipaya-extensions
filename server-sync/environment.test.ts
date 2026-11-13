// The environment parts beyond settings rows: skill files, helper roles, AGENTS.md, client extensions, providers and
// installed server extensions. Two homes and two data folders, a stand-in for each server's own routes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "server-sync-env-"));
const side = (name: string) => {
	const home = join(root, name, "home");
	const data = join(root, name, "data");
	mkdirSync(home, { recursive: true });
	mkdirSync(data, { recursive: true });
	const db = join(data, "pipaya.db");
	const d = new Database(db);
	d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
	d.exec("CREATE TABLE client_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)");
	d.exec("CREATE TABLE custom_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
	d.exec("CREATE TABLE credentials (provider_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
	d.close();
	return { home, data, db };
};
const P = side("primary");
const F = side("follower");
const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
const sql = (file: string, q: string, ...args: unknown[]) => { const d = new Database(file); d.query(q).run(...args); d.close(); };
const rows = (file: string, q: string) => { const d = new Database(file); const r = d.query(q).all(); d.close(); return r as Record<string, unknown>[]; };

/** Point the process environment at one side (each real server is its own process). */
const use = (s: typeof P) => {
	process.env.PIPAYA_DB = s.db;
	process.env.PIPAYA_DATA_DIR = s.data;
	process.env.PIPAYA_TOKEN = s === P ? "primary-admin" : "follower-admin";
};
/** Run a call as one side; for an async call, the follower's side is put back after every await of the primary. */
const as = <T>(s: typeof P, fn: () => T): T => {
	use(s);
	try { return fn(); } finally { use(F); }
};

const boot = (s: typeof P, settings: Record<string, unknown>) => {
	const methods = new Map<string, (p?: unknown) => unknown>();
	as(s, () => factory({
		home: s.home,
		dataDir: mkdtempSync(join(root, "ext-")),
		settings: { get: () => settings, set: (n: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, n); return settings; }, onChange: () => () => {} },
		log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => void methods.set(n, f), emit: () => {}, on: () => {},
	}));
	return methods;
};

let primary: Map<string, (p?: unknown) => unknown>;
let peer: ReturnType<typeof Bun.serve>;
let self: ReturnType<typeof Bun.serve>;
let primarySelf: ReturnType<typeof Bun.serve>;
const calls: { method: string; path: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
	primary = boot(P, { role: "primary" });
	peer = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.text();
			const method = new URL(req.url).pathname.split("/").pop()!;
			process.env.PIPAYA_PORT = String(primarySelf.port);
			try {
				return await as(P, async () => Response.json({ result: await primary.get(method)!(body ? JSON.parse(body) : null) }));
			} catch (e) {
				return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
			} finally {
				process.env.PIPAYA_PORT = String(self.port);
			}
		},
	});
	// The follower's own server: the routes server-sync calls to apply what it pulled.
	self = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? null : await req.json();
			calls.push({ method: req.method, path: url.pathname, body });
			const key = url.pathname.match(/^\/client-settings\/(\w+)$/)?.[1];
			if (key) { sql(F.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES (?, ?, ?)", key, JSON.stringify((body as { value: unknown }).value), Date.now()); return Response.json({ applied: true }); }
			const provider = url.pathname.match(/^\/configuration\/providers\/([a-z0-9_-]+)$/)?.[1];
			if (provider) { sql(F.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES (?, ?)", provider, JSON.stringify({ ...(body as object), id: provider })); return Response.json({}); }
			if (url.pathname === "/server-extensions/reload") return Response.json({ extensions: [] });
			const settingsOf = url.pathname.match(/^\/extensions\/([a-z0-9-]+)\/settings$/)?.[1];
			if (settingsOf && req.method === "PUT") {
				write(join(F.data, "extensions", settingsOf, "settings.json"), JSON.stringify((body as { settings: unknown }).settings));
				return Response.json({ applied: true });
			}
			const keyOf = url.pathname.match(/^\/providers\/([a-z0-9_-]+)\/credential$/)?.[1];
			if (keyOf && req.method === "PUT") {
				if (keyOf === "unknown") return new Response("no", { status: 404 });
				sql(F.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES (?, ?)", keyOf, JSON.stringify({ type: "api_key", key: (body as { key: string }).key }));
				return Response.json({ ok: true });
			}
			if (url.pathname === "/server-extensions/install") {
				const b = body as { id: string };
				write(join(F.data, "extensions", b.id, "package.json"), JSON.stringify({ version: "0.2.3" }));
				return Response.json({ extensions: [] });
			}
			return new Response("no", { status: 404 });
		},
	});
	// The primary's own server: what `push` saves goes through its routes.
	primarySelf = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? null : await req.json();
			const settingsOf = url.pathname.match(/^\/extensions\/([a-z0-9-]+)\/settings$/)?.[1];
			if (settingsOf && req.method === "PUT") {
				write(join(P.data, "extensions", settingsOf, "settings.json"), JSON.stringify((body as { settings: unknown }).settings));
				return Response.json({ applied: true });
			}
			const provider = url.pathname.match(/^\/configuration\/providers\/([a-z0-9_-]+)$/)?.[1];
			if (provider) { sql(P.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES (?, ?)", provider, JSON.stringify({ ...(body as object), id: provider })); return Response.json({}); }
			return new Response("no", { status: 404 });
		},
	});
	// The marketplace, as the follower reads it.
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("pipaya-marketplace")) return Response.json({ extensions: [
			{ id: "guard", kind: "server", version: "0.2.3", source: { type: "git", repo: "dohwi/pipaya-extensions", dir: "guard", ref: "guard-v0.2.3", commit: "a".repeat(40) } },
		] });
		return realFetch(input as string, init);
	}) as typeof fetch;
	process.env.PIPAYA_PORT = String(self.port);
});

afterAll(() => {
	globalThis.fetch = realFetch;
	delete process.env.PIPAYA_PORT;
	peer.stop(true);
	self.stop(true);
	primarySelf.stop(true);
	rmSync(root, { recursive: true, force: true });
});

const follower = (extra: Record<string, unknown>) => {
	const settings: Record<string, unknown> = { role: "follower", remoteUrl: `http://127.0.0.1:${peer.port}`, remoteToken: "t", ...extra };
	const methods = boot(F, settings);
	const sync = () => as(F, () => methods.get("sync")!()) as Promise<{ applied: string[] }>;
	return { methods, settings, sync };
};

describe("environment parts", () => {
	test("nothing beyond settings rows moves unless its box is checked", async () => {
		write(join(P.home, ".agents", "AGENTS.md"), "primary rules");
		const f = follower({});
		const res = await f.sync();
		expect(res.applied.some((k) => k.includes(":") || k === "agents-md")).toBe(false);
		expect(existsSync(join(F.home, ".agents", "AGENTS.md"))).toBe(false);
	});

	test("skill folders are made identical; a skill only here, and a symlinked one, stay", async () => {
		write(join(P.home, ".agents", "skills", "writer", "SKILL.md"), "---\nname: writer\n---\nprimary");
		write(join(P.home, ".agents", "skills", "writer", "refs", "style.md"), "style");
		write(join(F.home, ".agents", "skills", "writer", "SKILL.md"), "old");
		write(join(F.home, ".agents", "skills", "writer", "stale.md"), "gone after sync");
		write(join(F.home, ".agents", "skills", "mine", "SKILL.md"), "follower only");
		const f = follower({ syncAgent: true });
		const res = await f.sync();
		expect(res.applied).toContain("skill:writer");
		expect(readFileSync(join(F.home, ".agents", "skills", "writer", "SKILL.md"), "utf8")).toContain("primary");
		expect(readFileSync(join(F.home, ".agents", "skills", "writer", "refs", "style.md"), "utf8")).toBe("style");
		expect(existsSync(join(F.home, ".agents", "skills", "writer", "stale.md"))).toBe(false);
		expect(readFileSync(join(F.home, ".agents", "skills", "mine", "SKILL.md"), "utf8")).toBe("follower only");
		expect((await f.sync()).applied.filter((k) => k.startsWith("skill:"))).toEqual([]);
	});

	test("helper roles and AGENTS.md", async () => {
		write(join(P.home, ".agents", "subagents", "explore.md"), "---\nname: explore\n---\nread");
		write(join(P.home, ".agents", "AGENTS.md"), "primary rules");
		rmSync(join(F.home, ".agents", "AGENTS.md"), { force: true });
		const f = follower({ syncAgent: true });
		const res = await f.sync();
		// The skill was already made identical by the test before; what is new here is the helper role and AGENTS.md.
		expect(res.applied).toEqual(expect.arrayContaining(["helper:explore", "agents-md"]));
		expect(readFileSync(join(F.home, ".agents", "AGENTS.md"), "utf8")).toBe("primary rules");
		expect(readFileSync(join(F.home, ".agents", "subagents", "explore.md"), "utf8")).toContain("read");
	});

	test("client extensions go through this server's client-settings route", async () => {
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([{ manifest: { id: "quota-monitor" } }]));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensionStates', ?, 1)", JSON.stringify({ "quota-monitor": true }));
		const f = follower({ syncExtensions: true });
		const res = await f.sync();
		expect(res.applied).toEqual(expect.arrayContaining(["client:extensions", "client:extensionStates"]));
		expect(calls.some((c) => c.path === "/client-settings/extensions")).toBe(true);
		expect((await f.sync()).applied.filter((k) => k.startsWith("client:"))).toEqual([]);
	});

	test("providers come without any secret, through the configuration route", async () => {
		sql(P.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES ('cliproxy', ?)", JSON.stringify({ id: "cliproxy", name: "CLIProxy", baseUrl: "http://ai.local:8317/v1", api: "openai-completions", authRequired: true, models: [], apiKey: "never" }));
		sql(P.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('cliproxy', ?)", JSON.stringify({ type: "api_key", key: "sk-primary" }));
		const f = follower({ syncProviders: true });
		const res = await f.sync();
		expect(res.applied).toContain("provider:cliproxy");
		const sent = calls.find((c) => c.path === "/configuration/providers/cliproxy")!.body as Record<string, unknown>;
		expect(sent.baseUrl).toBe("http://ai.local:8317/v1");
		expect(JSON.stringify(sent)).not.toContain("never");
		expect(rows(F.db, "SELECT * FROM credentials")).toEqual([]);
	});

	test("server extensions are installed at the primary's version from the marketplace; server-sync itself never", async () => {
		write(join(P.data, "extensions", "guard", "package.json"), JSON.stringify({ version: "0.2.3" }));
		write(join(P.data, "extensions", "server-sync", "package.json"), JSON.stringify({ version: "9.9.9" }));
		write(join(P.data, "extensions", "local-only", "package.json"), JSON.stringify({ version: "1.0.0" }));
		const f = follower({ syncExtensions: true });
		const res = await f.sync();
		expect(res.applied).toContain("srv:guard");
		const installs = calls.filter((c) => c.path === "/server-extensions/install").map((c) => (c.body as { id: string }).id);
		expect(installs).toEqual(["guard"]);
		// Same version now: nothing to install.
		expect((await f.sync()).applied.filter((k) => k.startsWith("srv:"))).toEqual([]);
	});
});

describe("what the primary sees and what a peer cannot do", () => {
	test("a path from the peer cannot leave the folder it is written to", async () => {
		const evil = Bun.serve({ port: 0, fetch: () => Response.json({ result: { keys: [], settings: {}, environment: {
			skills: { "../escape": { "SKILL.md": "x" }, ok: { "../../outside.md": "x", "SKILL.md": "fine", ".hidden": "x" } },
			subagents: { "../x.md": "x", "role.md": "fine" },
		} } }) });
		try {
			const settings: Record<string, unknown> = { role: "follower", remoteUrl: `http://127.0.0.1:${evil.port}`, remoteToken: "t", syncAgent: true, syncSubagentFiles: true };
			const methods = boot(F, settings);
			const res = (await as(F, () => methods.get("sync")!())) as { applied: string[] };
			expect(res.applied.sort()).toEqual(["helper:role", "skill:ok"]);
			expect(existsSync(join(F.home, ".agents", "escape"))).toBe(false);
			expect(existsSync(join(F.home, ".agents", "skills", "outside.md"))).toBe(false);
			expect(existsSync(join(F.home, ".agents", "x.md"))).toBe(false);
			expect(existsSync(join(F.home, ".agents", "skills", "ok", ".hidden"))).toBe(false);
		} finally {
			evil.stop(true);
		}
	});

	test("the follower names itself when it redeems the link", async () => {
		const seen: string[] = [];
		const pairing = Bun.serve({ port: 0, async fetch(req) {
			if (new URL(req.url).pathname === "/pairing/redeem") { seen.push(((await req.json()) as { name: string }).name); return Response.json({ token: "dev" }); }
			return Response.json({ result: { keys: [], settings: {} } });
		} });
		try {
			const named = boot(F, { role: "follower", followerName: "집 데스크톱" });
			await as(F, () => named.get("connect")!({ url: `http://127.0.0.1:${pairing.port}`, code: "c" }));
			expect(seen.at(-1)).toBe("집 데스크톱");
			const plainOne = boot(F, { role: "follower" });
			await as(F, () => plainOne.get("connect")!({ url: `http://127.0.0.1:${pairing.port}`, code: "c" }));
			expect(seen.at(-1)).toMatch(/^Server Sync · \S+/);
			expect(seen.at(-1)).not.toBe("server-sync follower");
		} finally {
			pairing.stop(true);
		}
	});
});

describe("extensions that are not in the marketplace", () => {
	test("are reported, not copied, until their own box is checked; then their code comes over with this server's settings kept", async () => {
		write(join(P.data, "extensions", "my-tool", "package.json"), JSON.stringify({ version: "0.1.0", pipaya: { title: "My tool" } }));
		write(join(P.data, "extensions", "my-tool", "index.ts"), "export default (pi) => pi.log('primary build');");
		write(join(P.data, "extensions", "my-tool", "lib", "util.ts"), "export const x = 1;");
		write(join(P.data, "extensions", "my-tool", "settings.json"), JSON.stringify({ mode: "primary" }));
		write(join(P.data, "extensions", "my-tool", "node_modules", "dep", "index.js"), "never copied");
		write(join(F.data, "extensions", "my-tool", "settings.json"), JSON.stringify({ mode: "mine" }));

		const off = follower({ syncExtensions: true });
		const r1 = await off.sync();
		expect(r1.applied).not.toContain("srv:my-tool");
		expect(existsSync(join(F.data, "extensions", "my-tool", "index.ts"))).toBe(false);

		calls.length = 0;
		const on = follower({ syncExtensions: true, syncLocalExtensions: true });
		const r2 = await on.sync();
		expect(r2.applied).toContain("srv:my-tool");
		expect(readFileSync(join(F.data, "extensions", "my-tool", "index.ts"), "utf8")).toContain("primary build");
		expect(readFileSync(join(F.data, "extensions", "my-tool", "lib", "util.ts"), "utf8")).toContain("x = 1");
		// The code is the primary's; its settings values follow the same box as every extension's (확장).
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "my-tool", "settings.json"), "utf8"))).toEqual({ mode: "primary" });
		expect(existsSync(join(F.data, "extensions", "my-tool", "node_modules"))).toBe(false);
		expect(calls.some((c) => c.path === "/server-extensions/reload")).toBe(true);
		// The same code again: nothing to copy, nothing to reload.
		calls.length = 0;
		expect((await on.sync()).applied).not.toContain("srv:my-tool");
		expect(calls.some((c) => c.path === "/server-extensions/reload")).toBe(false);
	});

	test("~/.agents/extensions comes along with the same box, files and folders", async () => {
		write(join(P.home, ".agents", "extensions", "korean.ts"), "export default () => {};");
		write(join(P.home, ".agents", "extensions", "tools", "index.ts"), "export default () => {};");
		const off = follower({ syncExtensions: true });
		expect((await off.sync()).applied.some((k) => k.startsWith("agent-ext:"))).toBe(false);
		const on = follower({ syncExtensions: true, syncLocalExtensions: true });
		const res = await on.sync();
		expect(res.applied).toEqual(expect.arrayContaining(["agent-ext:korean", "agent-ext:tools"]));
		expect(existsSync(join(F.home, ".agents", "extensions", "korean.ts"))).toBe(true);
		// The copy box without the install box means nothing.
		const alone = follower({ syncLocalExtensions: true });
		rmSync(join(F.home, ".agents", "extensions"), { recursive: true, force: true });
		expect((await alone.sync()).applied.some((k) => k.startsWith("agent-ext:"))).toBe(false);
	});
});

describe("one box for installed extensions", () => {
	test("it turns on both what runs in the server and the apps' list", async () => {
		write(join(P.data, "extensions", "guard", "package.json"), JSON.stringify({ version: "0.2.3" }));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([{ manifest: { id: "quota-monitor", version: "0.6.2" } }]));
		rmSync(join(F.data, "extensions", "guard"), { recursive: true, force: true });
		sql(F.db, "DELETE FROM client_settings");
		const res = await follower({ syncExtensions: true }).sync();
		expect(res.applied).toEqual(expect.arrayContaining(["srv:guard", "client:extensions"]));
	});

	test("every box of 0.8–0.12 becomes one of today's four, and the old keys are gone", () => {
		const run = (given: Record<string, unknown>) => { const a: Record<string, unknown> = { role: "follower", ...given }; boot(F, a); return a; };
		const all = run({ syncModels: true, syncSkillFiles: true, syncClientExtensions: true });
		expect([all.syncApp, all.syncExtensions, all.syncAgent]).toEqual([true, true, true]);
		for (const k of ["syncModels", "syncSkillFiles", "syncClientExtensions", "syncInstalled"]) expect(k in all).toBe(false);
		// Nothing was ever on beyond the defaults: app settings on, the rest off.
		const fresh = run({ syncModels: true, syncWorkdir: true, syncMcp: true, syncSkills: true, syncTools: true, syncHistory: true });
		expect([fresh.syncApp, fresh.syncExtensions, fresh.syncAgent]).toEqual([true, false, false]);
		// Every old app group off: the app box is off.
		const none = run({ syncModels: false, syncWorkdir: false, syncMcp: false, syncSkills: false, syncTools: false, syncHistory: false });
		expect(none.syncApp).toBe(false);
		// The old "확장 설정 값" box was called syncExtensions: it still turns extensions on.
		const values = run({ syncExtensions: true, syncInstalled: false });
		expect(values.syncExtensions).toBe(true);
		// An explicit choice of today is never overwritten by an old key.
		expect(run({ syncApp: false, syncModels: true }).syncApp).toBe(false);
	});
});

describe("a pulled extension that lacks a secret here", () => {
	test("the page says what to type, and only for extensions that are on and need a required secret", async () => {
		const manifest = (id: string, fields: unknown[]) => ({ manifest: { id, name: id.toUpperCase(), settings: fields } });
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([
			manifest("needs-key", [{ key: "origin", label: "주소", required: true }, { key: "httpToken", label: "관리 키", required: true, secret: true }]),
			manifest("has-key", [{ key: "httpToken", label: "관리 키", required: true, secret: true }]),
			manifest("off-one", [{ key: "apiKey", label: "키", required: true }]),
			manifest("no-secret", [{ key: "origin", label: "주소", required: true }]),
		]));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensionStates', ?, 1)", JSON.stringify({ "needs-key": true, "has-key": true, "no-secret": true }));
		write(join(F.data, "extensions", "has-key", "settings.json"), JSON.stringify({ httpToken: "mine" }));
		rmSync(join(F.data, "extensions", "needs-key"), { recursive: true, force: true });
		const panels: string[] = [];
		const settings: Record<string, unknown> = { role: "follower", remoteUrl: `http://127.0.0.1:${peer.port}`, remoteToken: "t", syncExtensions: true };
		as(F, () => factory({
			home: F.home, dataDir: mkdtempSync(join(root, "ext-")),
			settings: { get: () => settings, set: (n: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, n); return settings; }, onChange: () => () => {} },
			ui: { setPanel: (n: unknown) => void panels.push(JSON.stringify(n)), onEvent: () => {} },
			log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => { if (n === "sync") (globalThis as Record<string, unknown>).__sync = f; }, emit: () => {}, on: () => {},
		}));
		await as(F, () => (globalThis as unknown as { __sync: () => Promise<unknown> }).__sync());
		const page = panels.at(-1)!;
		expect(page).toContain("needs-input");
		expect(page).toContain("NEEDS-KEY");
		expect(page).toContain("입력할 값: 관리 키");
		expect(page).not.toContain("HAS-KEY");
		expect(page).not.toContain("OFF-ONE");
		expect(page).not.toContain("NO-SECRET");
	});
});

describe("secrets: only when both sides allow it", () => {
	const seedSecrets = () => {
		sql(P.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('cliproxy', ?)", JSON.stringify({ type: "api_key", key: "sk-primary" }));
		sql(P.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('anthropic', ?)", JSON.stringify({ type: "oauth", access: "login-token", refresh: "r" }));
		sql(P.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('voice_input', ?)", JSON.stringify({ type: "api_key", key: "voice-key" }));
		sql(F.db, "DELETE FROM credentials");
		write(join(P.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://x", httpToken: "tok-primary" }));
		write(join(F.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://mine" }));
	};
	const primaryAllows = async (on: boolean) => { primary = boot(P, on ? { role: "primary", shareSecrets: true } : { role: "primary" }); };
	const keysHere = () => rows(F.db, "SELECT provider_id, data FROM credentials").map((r) => r.provider_id).sort();

	test("a follower that asks gets nothing while the primary has not allowed it", async () => {
		seedSecrets();
		await primaryAllows(false);
		const res = await follower({ syncProviders: true, syncSecrets: true, syncExtensions: true }).sync();
		expect(keysHere()).toEqual([]);
		expect(res.applied.some((k) => k.startsWith("key:"))).toBe(false);
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8")).httpToken).toBeUndefined();
	});

	test("the primary allowing it is not enough: the follower must ask too", async () => {
		seedSecrets();
		await primaryAllows(true);
		await follower({ syncProviders: true, syncExtensions: true }).sync();
		expect(keysHere()).toEqual([]);
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8")).httpToken).toBeUndefined();
	});

	test("both on: api keys and extension tokens arrive; a login and the voice key never do", async () => {
		seedSecrets();
		await primaryAllows(true);
		const res = await follower({ syncProviders: true, syncSecrets: true, syncExtensions: true }).sync();
		expect(res.applied).toContain("key:cliproxy");
		expect(keysHere()).toEqual(["cliproxy"]);
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8")).httpToken).toBe("tok-primary");
	});

	test("a secret already on this server is never replaced", async () => {
		seedSecrets();
		sql(F.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('cliproxy', ?)", JSON.stringify({ type: "api_key", key: "sk-mine" }));
		write(join(F.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://mine", httpToken: "tok-mine" }));
		await primaryAllows(true);
		await follower({ syncProviders: true, syncSecrets: true, syncExtensions: true }).sync();
		expect(JSON.parse(rows(F.db, "SELECT data FROM credentials WHERE provider_id = 'cliproxy'")[0]!.data as string).key).toBe("sk-mine");
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8")).httpToken).toBe("tok-mine");
	});
});

describe("two ways: what changed on one side goes to the other, the primary wins a conflict", () => {
	const row = (file: string, key: string) => {
		const r = rows(file, `SELECT data FROM settings WHERE key = '${key}'`)[0];
		return r ? JSON.parse(r.data as string) : undefined;
	};
	const setRow = (file: string, key: string, v: unknown) => sql(file, "INSERT OR REPLACE INTO settings (key, data) VALUES (?, ?)", key, JSON.stringify(v));
	const dropRow = (file: string, key: string) => sql(file, "DELETE FROM settings WHERE key = ?", key);
	const extOf = (s: typeof P, id: string) => JSON.parse(readFileSync(join(s.data, "extensions", id, "settings.json"), "utf8"));
	let f: ReturnType<typeof follower>;
	const dataDir = mkdtempSync(join(root, "two-way-"));

	test("the first sync only pulls, as before: a follower's own value does not overwrite the primary", async () => {
		primary = boot(P, { role: "primary" });
		setRow(P.db, "default_model", { provider: "a", model: "primary" });
		setRow(F.db, "default_model", { provider: "a", model: "follower-old" });
		// one follower, one history file, through the whole describe
		const settings: Record<string, unknown> = { role: "follower", remoteUrl: `http://127.0.0.1:${peer.port}`, remoteToken: "t", syncApp: true, syncExtensions: true, syncAgent: true, syncProviders: true };
		const methods = new Map<string, (p?: unknown) => unknown>();
		as(F, () => factory({
			home: F.home, dataDir,
			settings: { get: () => settings, set: (n: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, n); return settings; }, onChange: () => () => {} },
			log: () => {}, registerMethod: (n: string, fn: (p?: unknown) => unknown) => void methods.set(n, fn), emit: () => {}, on: () => {},
		}));
		f = { methods, settings, sync: () => as(F, () => methods.get("sync")!()) as Promise<{ applied: string[] }> };
		await f.sync();
		expect(row(F.db, "default_model").model).toBe("primary");
		expect(row(P.db, "default_model").model).toBe("primary");
	});

	test("a change made on the follower goes up to the primary and stays on both", async () => {
		setRow(F.db, "default_model", { provider: "a", model: "follower-new" });
		const res = await f.sync();
		expect(res.applied).toContain("up:default_model");
		expect(row(P.db, "default_model").model).toBe("follower-new");
		await f.sync(); // nothing flips back
		expect(row(F.db, "default_model").model).toBe("follower-new");
		expect(row(P.db, "default_model").model).toBe("follower-new");
	});

	test("a change made on the primary still comes down", async () => {
		setRow(P.db, "default_model", { provider: "a", model: "primary-2" });
		await f.sync();
		expect(row(F.db, "default_model").model).toBe("primary-2");
	});

	test("both changed the same item: the primary wins", async () => {
		setRow(P.db, "default_model", { provider: "a", model: "primary-3" });
		setRow(F.db, "default_model", { provider: "a", model: "follower-3" });
		await f.sync();
		expect(row(F.db, "default_model").model).toBe("primary-3");
		expect(row(P.db, "default_model").model).toBe("primary-3");
	});

	test("a row removed on the follower is removed on the primary; one removed on the primary goes here", async () => {
		setRow(P.db, "image_model", { provider: "a", model: "img" });
		await f.sync();
		expect(row(F.db, "image_model")).toBeDefined();
		dropRow(F.db, "image_model");
		await f.sync();
		expect(row(P.db, "image_model")).toBeUndefined();
		setRow(P.db, "system_model", { provider: "a", model: "sys" });
		await f.sync();
		dropRow(P.db, "system_model");
		await f.sync();
		expect(row(F.db, "system_model")).toBeUndefined();
	});

	test("an unchecked box neither pulls nor pushes", async () => {
		f.settings.syncApp = false;
		setRow(F.db, "default_model", { provider: "a", model: "only-here" });
		await f.sync();
		expect(row(P.db, "default_model").model).toBe("primary-3");
		f.settings.syncApp = true;
		await f.sync(); // turned on again: starts by pulling, like the first time
		expect(row(F.db, "default_model").model).toBe("primary-3");
	});

	test("extension settings go up without any secret, and the primary's own secret stays", async () => {
		write(join(P.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://p", httpToken: "tok-primary" }));
		write(join(F.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://p" }));
		await f.sync();
		write(join(F.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://changed-here", httpToken: "tok-follower" }));
		const res = await f.sync();
		expect(res.applied).toContain("up:ext:quota-monitor");
		expect(extOf(P, "quota-monitor")).toEqual({ httpOrigin: "http://changed-here", httpToken: "tok-primary" });
		expect(extOf(F, "quota-monitor").httpToken).toBe("tok-follower");
	});

	test("a skill made or edited on the follower goes up; a skill only on the follower from before stays there", async () => {
		write(join(F.home, ".agents", "skills", "new-here", "SKILL.md"), "made on the follower");
		await f.sync();
		expect(readFileSync(join(P.home, ".agents", "skills", "new-here", "SKILL.md"), "utf8")).toBe("made on the follower");
		write(join(F.home, ".agents", "skills", "new-here", "SKILL.md"), "edited on the follower");
		await f.sync();
		expect(readFileSync(join(P.home, ".agents", "skills", "new-here", "SKILL.md"), "utf8")).toBe("edited on the follower");
	});

	test("AGENTS.md and helper roles edited on the follower go up", async () => {
		write(join(P.home, ".agents", "AGENTS.md"), "rules v1");
		await f.sync();
		write(join(F.home, ".agents", "AGENTS.md"), "rules v2 from the follower");
		write(join(F.home, ".agents", "subagents", "fresh.md"), "a helper made on the follower");
		await f.sync();
		expect(readFileSync(join(P.home, ".agents", "AGENTS.md"), "utf8")).toBe("rules v2 from the follower");
		expect(readFileSync(join(P.home, ".agents", "subagents", "fresh.md"), "utf8")).toBe("a helper made on the follower");
	});

	test("a model connection changed on the follower goes up, without a key", async () => {
		sql(P.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES ('mine', ?)", JSON.stringify({ id: "mine", name: "Mine", baseUrl: "http://a/v1", models: [] }));
		await f.sync();
		sql(F.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES ('mine', ?)", JSON.stringify({ id: "mine", name: "Mine", baseUrl: "http://b/v1", models: [], apiKey: "sk-leak" }));
		await f.sync();
		const there = JSON.parse(rows(P.db, "SELECT data FROM custom_providers WHERE id = 'mine'")[0]!.data as string);
		expect(there.baseUrl).toBe("http://b/v1");
		expect(there.apiKey).toBeUndefined();
	});

	test("the primary takes nothing while it is not a primary", async () => {
		const other = boot(P, { role: "follower" });
		await expect(Promise.resolve(as(P, () => other.get("push")!({ settings: { default_model: 1 } })))).rejects.toThrow(/not a primary/);
		primary = boot(P, { role: "primary" });
	});
});
