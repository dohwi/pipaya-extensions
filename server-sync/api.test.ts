// A server with `pi.api` and `pi.server` (app 0.9.4+): everything this extension does to its own server goes through
// the server's routes, never its token file, its address or (for anything the app has a route for) its database.
// Each side gets a stand-in for its own server's routes that stores what a real one stores (normalizing like it does).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "server-sync-api-"));
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
	return { name, home, data, db, calls: [] as { method: string; path: string; body: unknown }[] };
};
type Side = ReturnType<typeof side>;
const P = side("primary");
const F = side("follower");

const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
const sql = (file: string, q: string, ...args: unknown[]) => { const d = new Database(file); d.query(q).run(...args); d.close(); };
const all = (file: string, q: string, ...args: unknown[]) => { const d = new Database(file); const r = d.query(q).all(...args); d.close(); return r as Record<string, any>[]; };
const row = (s: Side, key: string) => { const r = all(s.db, "SELECT data FROM settings WHERE key = ?", key)[0]; return r ? JSON.parse(r.data) : undefined; };
const setRow = (s: Side, key: string, v: unknown) => sql(s.db, "INSERT OR REPLACE INTO settings (key, data) VALUES (?, ?)", key, JSON.stringify(v));
const dropRow = (s: Side, key: string) => sql(s.db, "DELETE FROM settings WHERE key = ?", key);

/** The extension finds its server's database through the environment, which is per process: one side at a time. */
const use = (s: Side) => {
	process.env.PIPAYA_DB = s.db;
	process.env.PIPAYA_DATA_DIR = s.data;
};

const MODELS = new Set(["echo/one", "echo/two"]);
const TOGGLEABLE = ["web_fetch", "generate_image", "delegate"];
const fail = (status: number, message: string) => ({ status, body: { error: { code: "invalid_request", message } } });

/**
 * One side's own server, as `pi.api.request` reaches it: the routes server-sync uses, storing what the app stores. It
 * normalizes like the app (compaction gains its threshold, delegate its roles, tools their order, helper switches are
 * kept sorted) and refuses what the app refuses (an unknown model, a folder that is not there).
 */
const routes = (s: Side) => async (method: string, path: string, body?: any): Promise<{ status: number; body: any }> => {
	s.calls.push({ method, path, body });
	use(s);
	const put = (key: string, v: unknown) => setRow(s, key, v);
	const exts = join(s.data, "extensions");
	const model = (m: any) => m === null || MODELS.has(`${m.provider}/${m.model}`);
	const view = (key: string, defaults: Record<string, unknown>) => ({ status: 200, body: { settings: { ...defaults, ...(row(s, key) ?? {}) }, defaults } });
	if (method === "GET" && path === "/extensions/settings") {
		const out: Record<string, unknown> = {};
		for (const id of readdirSync(exts, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
			try { out[id] = { value: JSON.parse(readFileSync(join(exts, id, "settings.json"), "utf8")), updatedAt: 1 }; } catch { /* none */ }
		}
		return { status: 200, body: { settings: out } };
	}
	const ext = path.match(/^\/extensions\/([a-z0-9-]+)\/settings$/)?.[1];
	if (ext && method === "PUT") { write(join(exts, ext, "settings.json"), JSON.stringify(body.settings)); return { status: 200, body: { value: body.settings, updatedAt: 2, applied: true } }; }
	const client = path.match(/^\/client-settings\/(\w+)$/)?.[1];
	if (client && method === "GET") {
		const r = all(s.db, "SELECT data, updated_at FROM client_settings WHERE key = ?", client)[0];
		return r ? { status: 200, body: { value: JSON.parse(r.data), updatedAt: r.updated_at } } : fail(404, "setting not found");
	}
	if (client && method === "PUT") { sql(s.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES (?, ?, 3)", client, JSON.stringify(body.value)); return { status: 200, body: { value: body.value, updatedAt: 3, applied: true } }; }
	if (method === "GET" && path === "/configuration") {
		const providers = all(s.db, "SELECT id, data FROM custom_providers ORDER BY id").map((r) => {
			const p = { ...JSON.parse(r.data), id: r.id };
			return { ...p, models: (p.models ?? []).map((m: object) => ({ ...m, thinkingSource: { kind: "default", levels: [] } })), configured: true, hasStoredKey: false };
		});
		return { status: 200, body: { providers, defaults: row(s, "default_model") ?? null } };
	}
	const provider = path.match(/^\/configuration\/providers\/([a-z0-9_-]+)$/)?.[1];
	if (provider && method === "PUT") { sql(s.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES (?, ?)", provider, JSON.stringify({ ...body, id: provider })); return { status: 200, body: {} }; }
	if (method === "GET" && path === "/providers") {
		const stored = new Map(all(s.db, "SELECT provider_id, data FROM credentials").map((r) => [r.provider_id, JSON.parse(r.data).type]));
		const ids = new Set([...stored.keys(), ...all(s.db, "SELECT id FROM custom_providers").map((r) => r.id), "anthropic"]);
		return { status: 200, body: { providers: [...ids].map((id) => ({ id, storedCredential: stored.get(id) ?? null })) } };
	}
	const credential = path.match(/^\/providers\/([a-z0-9_-]+)\/credential$/)?.[1];
	if (credential && method === "PUT") {
		if (!all(s.db, "SELECT id FROM custom_providers WHERE id = ?", credential).length) return fail(404, "provider not found");
		sql(s.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES (?, ?)", credential, JSON.stringify({ type: "api_key", key: body.key }));
		return { status: 200, body: { ok: true } };
	}
	if (method === "GET" && path === "/server-extensions") {
		const list = readdirSync(exts, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
			try { return [{ name: e.name, path: join(exts, e.name, "index.ts"), version: JSON.parse(readFileSync(join(exts, e.name, "package.json"), "utf8")).version }]; } catch { return []; }
		});
		// the owner's own extension in ~/.agents/extensions is not an install
		list.push({ name: "mine", path: join(s.home, ".agents", "extensions", "mine.ts"), version: "1.0.0" });
		return { status: 200, body: { extensions: list, commands: [] } };
	}
	if (method === "POST" && path === "/server-extensions/install") { write(join(exts, body.id, "package.json"), JSON.stringify({ version: "0.2.3" })); return { status: 200, body: { extensions: [] } }; }
	if (method === "POST" && path === "/server-extensions/reload") return { status: 200, body: { extensions: [] } };
	if (method === "POST" && path === "/pairing") return { status: 200, body: { code: "pairing-code-from-api", expiresAt: Date.now() + 120_000 } };
	// ---- settings rows, as each route stores them ----
	if (path === "/configuration/defaults" && method === "PUT") {
		if (body === null) { dropRow(s, "default_model"); return { status: 200, body: { defaults: null } }; }
		if (!model(body)) return fail(400, "unknown provider/model");
		put("default_model", body);
		return { status: 200, body: { defaults: body } };
	}
	if (path === "/configuration/workdir" && method === "PUT") {
		if (body.path === null) { dropRow(s, "default_workdir"); return { status: 200, body: {} }; }
		try { readdirSync(body.path); } catch { return fail(400, `not an existing directory: ${body.path}`); }
		put("default_workdir", body.path);
		return { status: 200, body: {} };
	}
	if (path === "/mcp" && method === "PUT") { put("mcp_servers", body.servers.map((c: any) => ({ ...c, name: c.name.trim() }))); return { status: 200, body: { servers: [] } }; }
	if (path === "/configuration/tools" && method === "PUT") {
		const bad = body.disabled.find((n: string) => !TOGGLEABLE.includes(n));
		if (bad) return fail(400, `${bad} cannot be switched off`);
		put("disabled_tools", TOGGLEABLE.filter((n) => body.disabled.includes(n)));
		return { status: 200, body: {} };
	}
	if (path === "/configuration/delegate" && method === "PUT") {
		if (body.models.some((m: string) => !MODELS.has(m))) return fail(400, "unknown model");
		put("delegate_policy", { ...body, roles: body.roles ?? row(s, "delegate_policy")?.roles ?? "defined" });
		return { status: 200, body: {} };
	}
	const role = path.match(/^\/configuration\/subagents\/([^/]+)\/enabled$/)?.[1];
	if (role && method === "PUT") {
		const name = decodeURIComponent(role);
		const dir = body.scope === "global" ? join(s.home, ".agents", "subagents") : join(s.home, "work", ".agents", "subagents");
		try { readFileSync(join(dir, `${name}.md`)); } catch { return fail(404, `helper role "${name}" not found`); }
		const next = new Set<string>(row(s, "disabled_subagents") ?? []);
		if (body.enabled) next.delete(`${body.scope}/${name}`); else next.add(`${body.scope}/${name}`);
		put("disabled_subagents", [...next].sort());
		return { status: 200, body: {} };
	}
	const single: Record<string, [string, Record<string, unknown>]> = {
		"/system-model": ["system_model", { model: null }],
		"/image-model": ["image_model", { model: null }],
		"/compaction": ["compaction", { auto: true, model: null, thresholdPercent: 90 }],
		"/retention": ["retention", { enabled: false, days: 30, onlyClosed: true }],
	};
	const one = single[path];
	if (one && method === "GET") return view(one[0], one[1]);
	if (one && method === "PUT") {
		if ("model" in body && !model(body.model)) return fail(400, `unknown model ${body.model.provider}/${body.model.model}`);
		put(one[0], one[0] === "compaction" ? { ...body, thresholdPercent: body.thresholdPercent ?? row(s, "compaction")?.thresholdPercent ?? 90 } : body);
		return view(one[0], one[1]);
	}
	return fail(404, `route not found: ${method} ${path}`);
};

const settingsOf = (initial: Record<string, unknown>) => {
	const settings = { ...initial };
	return {
		settings,
		api: { get: () => settings, set: (n: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, n); return settings; }, onChange: () => () => {} },
	};
};

/** One instance on one side, with `pi.api` and `pi.server` (unless `old`). */
const boot = (s: Side, initial: Record<string, unknown>, o: { urls?: string[]; panels?: string[] } = {}) => {
	const methods = new Map<string, (p?: unknown) => unknown>();
	const { settings, api } = settingsOf(initial);
	const hooks: (() => void)[] = [];
	use(s);
	factory({
		home: s.home,
		dataDir: mkdtempSync(join(root, `${s.name}-ext-`)),
		settings: api,
		api: { request: routes(s) },
		server: { info: () => ({ port: 8787, host: "0.0.0.0", urls: o.urls ?? ["http://192.168.0.5:8787", "http://100.64.0.7:8787"] }) },
		...(o.panels ? { ui: { setPanel: (n: unknown) => void o.panels!.push(JSON.stringify(n)), onEvent: () => {} } } : {}),
		log: () => {}, registerMethod: (n: string, f: (p?: unknown) => unknown) => void methods.set(n, f), emit: () => {},
		on: (ev: string, fn: () => void) => { if (ev === "extension_unload") hooks.push(fn); },
	});
	return { methods, settings, unload: () => hooks.forEach((f) => f()) };
};

let primary: ReturnType<typeof boot>;
let peer: ReturnType<typeof Bun.serve>;
/** Calls that left the process other than to the primary: the old way of reaching this server itself. */
const strays: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
	// The old way would need these: with `pi.api` nothing reads them.
	delete process.env.PIPAYA_TOKEN;
	delete process.env.PIPAYA_PORT;
	delete process.env.PIPAYA_HOST;
	primary = boot(P, { role: "primary" });
	peer = Bun.serve({
		port: 0,
		async fetch(req) {
			const text = await req.text();
			const name = new URL(req.url).pathname.split("/").pop()!;
			// The primary is another process: its side stays in effect until its answer is ready.
			use(P);
			try {
				return Response.json({ result: await primary.methods.get(name)!(text ? JSON.parse(text) : null) });
			} catch (e) {
				return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
			} finally {
				use(F);
			}
		},
	});
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("pipaya-marketplace")) return Response.json({ extensions: [
			{ id: "guard", kind: "server", version: "0.2.3", source: { type: "git", repo: "dohwi/pipaya-extensions", dir: "guard", ref: "guard-v0.2.3", commit: "a".repeat(40) } },
		] });
		if (!url.startsWith(`http://127.0.0.1:${peer.port}/`)) strays.push(url);
		return realFetch(input as string, init);
	}) as typeof fetch;
	mkdirSync(join(P.data, "extensions"), { recursive: true });
	mkdirSync(join(F.data, "extensions"), { recursive: true });
});

afterAll(() => {
	globalThis.fetch = realFetch;
	peer.stop(true);
	rmSync(root, { recursive: true, force: true });
});

const follower = (extra: Record<string, unknown>, o: { panels?: string[] } = {}) => {
	const h = boot(F, { role: "follower", remoteUrl: `http://127.0.0.1:${peer.port}`, remoteToken: "t", ...extra }, o);
	const sync = async () => { use(F); return (await h.methods.get("sync")!()) as { applied: string[] }; };
	return { ...h, sync };
};
const pathsOf = (s: Side, method = "PUT") => s.calls.filter((c) => c.method === method).map((c) => c.path);
const bodyOf = (s: Side, path: string) => s.calls.filter((c) => c.method === "PUT" && c.path === path).at(-1)?.body;

describe("this server itself, through pi.api and pi.server", () => {
	test("the connection code comes from POST /pairing, at the address pi.server.info gives (Tailscale first)", async () => {
		P.calls.length = 0;
		const made = (await primary.methods.get("code")!()) as { url: string; code: string };
		expect(made).toEqual({ url: "http://100.64.0.7:8787", code: "pairing-code-from-api" });
		expect(P.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /pairing"]);
		const lan = boot(P, { role: "primary" }, { urls: ["http://192.168.0.5:8787"] });
		expect(((await lan.methods.get("code")!()) as { url: string }).url).toBe("http://192.168.0.5:8787");
		const none = boot(P, { role: "primary" }, { urls: [] });
		await expect(Promise.resolve(none.methods.get("code")!())).rejects.toThrow(/no address to share/);
		expect(strays).toEqual([]);
	});

	test("what a primary serves is read through its routes: extension settings, the apps' rows, providers, installs", async () => {
		write(join(P.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://p", httpToken: "tok" }));
		write(join(P.data, "extensions", "server-sync", "settings.json"), JSON.stringify({ role: "primary" }));
		write(join(P.data, "extensions", "guard", "package.json"), JSON.stringify({ version: "0.2.3" }));
		write(join(P.data, "extensions", "server-sync", "package.json"), JSON.stringify({ version: "9.9.9" }));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([{ manifest: { id: "quota-monitor" } }]));
		sql(P.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES ('echo', ?)", JSON.stringify({ name: "Echo", baseUrl: "http://e/v1", api: "openai-completions", authRequired: false, models: [{ id: "one" }], apiKey: "never" }));
		P.calls.length = 0;
		use(P);
		const snap = (await primary.methods.get("snapshot")!({ extensions: true, parts: ["serverExtensions", "clientExtensions", "providers"] })) as any;
		expect(snap.extensions).toEqual({ "quota-monitor": { httpOrigin: "http://p" } });
		expect(snap.environment.serverExtensions).toEqual([{ id: "guard", version: "0.2.3" }]);
		expect(snap.environment.clientExtensions).toEqual({ list: [{ manifest: { id: "quota-monitor" } }], states: null });
		// stored as the server stores it: what GET /configuration adds to describe a connection is not part of it
		expect(snap.environment.providers).toEqual({ echo: { id: "echo", name: "Echo", baseUrl: "http://e/v1", api: "openai-completions", authRequired: false, models: [{ id: "one" }] } });
		expect(P.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
			"GET /client-settings/extensionStates", "GET /client-settings/extensions", "GET /configuration", "GET /extensions/settings", "GET /server-extensions",
		]);
	});
});

describe("settings rows go through the app's routes", () => {
	const work = join(root, "work-here");
	mkdirSync(work, { recursive: true });
	let f: ReturnType<typeof follower>;
	const panels: string[] = [];

	test("each row is saved by its route, in the shape the route takes; a row with no route is written directly", async () => {
		write(join(F.home, ".agents", "subagents", "explore.md"), "---\nname: explore\n---\n");
		for (const [k, v] of Object.entries({
			default_model: { provider: "echo", model: "one" },
			default_workdir: work,
			system_model: { model: { provider: "echo", model: "two" } },
			image_model: { model: { provider: "echo", model: "one" } },
			// as an app before the threshold stored it: the follower's route adds it
			compaction: { auto: false, model: null },
			retention: { enabled: true, days: 10, onlyClosed: false },
			mcp_servers: [{ name: "remote", enabled: false, transport: "http", url: "http://mcp.local/x" }],
			disabled_tools: ["delegate", "web_fetch"],
			// as an app before the role policy stored it
			delegate_policy: { policy: "any", models: [], maxConcurrent: 2, maxCalls: 5, maxTurns: 10 },
			disabled_subagents: ["global/explore"],
			skills: { global: { writer: false }, projects: {} },
			my_extra: { any: "thing" },
		})) setRow(P, k, v);
		primary = boot(P, { role: "primary", keys: "my_extra" });
		F.calls.length = 0;
		f = follower({ syncApp: true }, { panels });
		const res = await f.sync();
		expect(res.applied.sort()).toEqual(["compaction", "default_model", "default_workdir", "delegate_policy", "disabled_subagents", "disabled_tools", "image_model", "mcp_servers", "my_extra", "retention", "skills", "system_model"]);
		expect(pathsOf(F).sort()).toEqual([
			"/compaction", "/configuration/defaults", "/configuration/delegate", "/configuration/subagents/explore/enabled", "/configuration/tools", "/configuration/workdir",
			"/image-model", "/mcp", "/retention", "/system-model",
		]);
		expect(bodyOf(F, "/configuration/defaults")).toEqual({ provider: "echo", model: "one" });
		expect(bodyOf(F, "/configuration/workdir")).toEqual({ path: work });
		expect(bodyOf(F, "/mcp")).toEqual({ servers: [{ name: "remote", enabled: false, transport: "http", url: "http://mcp.local/x" }] });
		expect(bodyOf(F, "/configuration/tools")).toEqual({ disabled: ["delegate", "web_fetch"] });
		expect(bodyOf(F, "/configuration/subagents/explore/enabled")).toEqual({ scope: "global", enabled: false });
		expect(bodyOf(F, "/system-model")).toEqual({ model: { provider: "echo", model: "two" } });
		// what the routes stored, normalized their way
		expect(row(F, "compaction")).toEqual({ auto: false, model: null, thresholdPercent: 90 });
		expect(row(F, "delegate_policy").roles).toBe("defined");
		expect(row(F, "disabled_tools")).toEqual(["web_fetch", "delegate"]);
		// no route: written as they are
		expect(row(F, "skills")).toEqual({ global: { writer: false }, projects: {} });
		expect(row(F, "my_extra")).toEqual({ any: "thing" });
		expect(strays).toEqual([]);
	});

	test("a value a route stores differently is not a change: the next syncs move nothing, either way", async () => {
		F.calls.length = 0;
		P.calls.length = 0;
		expect((await f.sync()).applied).toEqual([]);
		expect((await f.sync()).applied).toEqual([]);
		expect(pathsOf(F)).toEqual([]);
		// the primary's rows were not touched by the follower's differently stored copies
		expect(row(P, "compaction")).toEqual({ auto: false, model: null });
		expect(row(P, "disabled_tools")).toEqual(["delegate", "web_fetch"]);
	});

	test("a change on the follower goes up and is saved there by the primary's own route; then all is quiet", async () => {
		await routes(F)("PUT", "/compaction", { auto: true, model: null, thresholdPercent: 70 });
		P.calls.length = 0;
		const res = await f.sync();
		expect(res.applied).toEqual(["up:compaction"]);
		expect(pathsOf(P)).toEqual(["/compaction"]);
		expect(row(P, "compaction")).toEqual({ auto: true, model: null, thresholdPercent: 70 });
		expect((await f.sync()).applied).toEqual([]);
	});

	test("a change on the primary still comes down through the route", async () => {
		setRow(P, "retention", { enabled: false, days: 30, onlyClosed: true });
		F.calls.length = 0;
		expect((await f.sync()).applied).toEqual(["retention"]);
		expect(bodyOf(F, "/retention")).toEqual({ enabled: false, days: 30, onlyClosed: true });
		expect((await f.sync()).applied).toEqual([]);
	});

	test("a row removed on the primary: a route that clears it does, the others get their route's default", async () => {
		dropRow(P, "default_model");
		dropRow(P, "image_model");
		dropRow(P, "mcp_servers");
		F.calls.length = 0;
		const res = await f.sync();
		expect(res.applied.sort()).toEqual(["default_model", "image_model", "mcp_servers"]);
		expect(bodyOf(F, "/configuration/defaults")).toBeNull();
		expect(row(F, "default_model")).toBeUndefined();
		expect(bodyOf(F, "/image-model")).toEqual({ model: null });
		expect(bodyOf(F, "/mcp")).toEqual({ servers: [] });
		// stored as the defaults now, which is what "no row" means: nothing moves after
		expect((await f.sync()).applied).toEqual([]);
		expect(row(P, "image_model")).toBeUndefined();
	});

	test("a value this server refuses (a model it does not have) is not written; the page says so and the next sync tries again", async () => {
		setRow(P, "system_model", { model: { provider: "elsewhere", model: "big" } });
		const before = row(F, "system_model");
		const res = await f.sync();
		expect(res.applied).not.toContain("system_model");
		expect(row(F, "system_model")).toEqual(before);
		expect(panels.at(-1)).toContain("이 서버가 받아들이지 않은 항목");
		expect(panels.at(-1)).toContain("unknown model elsewhere/big");
		F.calls.length = 0;
		await f.sync();
		expect(pathsOf(F)).toEqual(["/system-model"]);
		// once the primary's value is one this server takes, it comes down and the note goes away
		setRow(P, "system_model", { model: { provider: "echo", model: "one" } });
		expect((await f.sync()).applied).toEqual(["system_model"]);
		expect(panels.at(-1)).not.toContain("이 서버가 받아들이지 않은 항목");
	});

	test("a value the primary refuses stays the primary's: it comes back down, the follower's is not forced on it", async () => {
		await routes(F)("PUT", "/configuration/defaults", { provider: "echo", model: "two" });
		// the primary no longer has that model
		MODELS.delete("echo/two");
		try {
			const res = await f.sync();
			expect(res.applied).not.toContain("up:default_model");
			expect(row(P, "default_model")).toBeUndefined();
			// the primary's (no row) wins the next pull
			await f.sync();
			expect(row(F, "default_model")).toBeUndefined();
		} finally {
			MODELS.add("echo/two");
		}
	});

	test("a helper switched off for a role this server does not have yet: the list is written as is", async () => {
		setRow(P, "disabled_subagents", ["global/explore", "global/not-here"]);
		F.calls.length = 0;
		expect((await f.sync()).applied).toEqual(["disabled_subagents"]);
		expect(row(F, "disabled_subagents")).toEqual(["global/explore", "global/not-here"]);
		expect((await f.sync()).applied).toEqual([]);
	});
});

describe("the rest through pi.api", () => {
	test("extension settings, the apps' list, connections, keys and installs use this server's routes", async () => {
		write(join(P.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://p", httpToken: "tok-primary" }));
		write(join(F.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ httpOrigin: "http://mine" }));
		sql(P.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('echo', ?)", JSON.stringify({ type: "api_key", key: "sk-p" }));
		primary = boot(P, { role: "primary", shareSecrets: true });
		F.calls.length = 0;
		const f = follower({ syncApp: false, syncExtensions: true, syncProviders: true, syncSecrets: true });
		const res = await f.sync();
		expect(res.applied).toEqual(expect.arrayContaining(["srv:guard", "ext:quota-monitor", "client:extensions", "provider:echo", "key:echo"]));
		expect(pathsOf(F).sort()).toEqual(["/client-settings/extensions", "/configuration/providers/echo", "/extensions/quota-monitor/settings", "/providers/echo/credential"]);
		expect(pathsOf(F, "POST")).toEqual(["/server-extensions/install"]);
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8"))).toEqual({ httpOrigin: "http://p", httpToken: "tok-primary" });
		expect(bodyOf(F, "/configuration/providers/echo")).toEqual({ name: "Echo", baseUrl: "http://e/v1", api: "openai-completions", authRequired: false, models: [{ id: "one" }] });
		// all equal now: nothing moves, and a key already here is never sent again
		F.calls.length = 0;
		expect((await f.sync()).applied).toEqual([]);
		expect(pathsOf(F)).toEqual([]);
		expect(strays).toEqual([]);
	});

	test("an install reloads every extension, this one too: the old instance stops touching anything", async () => {
		const panels: string[] = [];
		const f = follower({ syncApp: false, syncExtensions: true }, { panels });
		const before = panels.length;
		f.unload();
		F.calls.length = 0;
		await expect(f.sync()).rejects.toThrow(/reloaded its extensions/);
		expect(F.calls).toEqual([]);
		// the page belongs to the new instance now
		expect(panels.length).toBe(before);
	});
});
