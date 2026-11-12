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
	d.exec("CREATE TABLE credentials (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
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
const calls: { method: string; path: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
	primary = boot(P, { role: "primary" });
	peer = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.text();
			return as(P, async () => Response.json({ result: await primary.get("snapshot")!(body ? JSON.parse(body) : null) }));
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
			if (url.pathname === "/server-extensions/install") {
				const b = body as { id: string };
				write(join(F.data, "extensions", b.id, "package.json"), JSON.stringify({ version: "0.2.3" }));
				return Response.json({ extensions: [] });
			}
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
		const f = follower({ syncSkillFiles: true });
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
		const f = follower({ syncSubagentFiles: true, syncAgentsMd: true });
		const res = await f.sync();
		expect(res.applied).toEqual(expect.arrayContaining(["helper:explore", "agents-md"]));
		expect(readFileSync(join(F.home, ".agents", "AGENTS.md"), "utf8")).toBe("primary rules");
	});

	test("client extensions go through this server's client-settings route", async () => {
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([{ manifest: { id: "quota-monitor" } }]));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensionStates', ?, 1)", JSON.stringify({ "quota-monitor": true }));
		const f = follower({ syncClientExtensions: true });
		const res = await f.sync();
		expect(res.applied).toEqual(expect.arrayContaining(["client:extensions", "client:extensionStates"]));
		expect(calls.some((c) => c.path === "/client-settings/extensions")).toBe(true);
		expect((await f.sync()).applied.filter((k) => k.startsWith("client:"))).toEqual([]);
	});

	test("providers come without any secret, through the configuration route", async () => {
		sql(P.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES ('cliproxy', ?)", JSON.stringify({ id: "cliproxy", name: "CLIProxy", baseUrl: "http://ai.local:8317/v1", api: "openai-completions", authRequired: true, models: [], apiKey: "never" }));
		sql(P.db, "INSERT OR REPLACE INTO credentials (id, data) VALUES ('cliproxy', 'secret')");
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
		const f = follower({ syncServerExtensions: true });
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
			const settings: Record<string, unknown> = { role: "follower", remoteUrl: `http://127.0.0.1:${evil.port}`, remoteToken: "t", syncSkillFiles: true, syncSubagentFiles: true };
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
