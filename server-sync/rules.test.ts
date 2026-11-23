import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { defaultRulesText, matchSyncPath, mayIncludeNamespace, parseSyncRules } from "./index.ts";

describe("gitignore-style sync rules engine", () => {
	test("parses comments, blank lines, CRLF, escapes, negation and last-rule-wins", () => {
		const { rules, warnings } = parseSyncRules([
			"# comment",
			"   # indented comment",
			"",
			"skills/*",
			"!skills/orchestrate",
			"skills/orchestrate/*.tmp\r",
			"\\#weird-name",
			"\\!bang-name",
		].join("\n"));
		expect(warnings).toEqual([]);
		expect(matchSyncPath(rules, "skills/other").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/other/SKILL.md").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/orchestrate").ignored).toBe(false);
		expect(matchSyncPath(rules, "skills/orchestrate/SKILL.md").ignored).toBe(false);
		expect(matchSyncPath(rules, "skills/orchestrate/notes.tmp").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/orchestrate/notes.tmp").matchedBy?.raw).toBe("skills/orchestrate/*.tmp");
		expect(matchSyncPath(rules, "settings/#weird-name").ignored).toBe(true);
		expect(matchSyncPath(rules, "settings/!bang-name").ignored).toBe(true);
	});

	test("supports whitelist mode (* + !pattern), ** deep globs, ? and special regex characters", () => {
		const { rules } = parseSyncRules([
			"*",
			"!settings/default_model",
			"!mcp/search",
			"!skills/orchestrate",
			"skills/**/draft?.md",
			"mcp/my.server+(1)[test]",
		].join("\n"));
		expect(matchSyncPath(rules, "settings/default_model").ignored).toBe(false);
		expect(matchSyncPath(rules, "settings/retention").ignored).toBe(true);
		expect(matchSyncPath(rules, "mcp/search").ignored).toBe(false);
		expect(matchSyncPath(rules, "mcp/other").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/orchestrate/SKILL.md").ignored).toBe(false);
		expect(matchSyncPath(rules, "skills/orchestrate/sub/draft1.md").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/orchestrate/sub/draft12.md").ignored).toBe(false);
		expect(matchSyncPath(rules, "mcp/my.server+(1)[test]").ignored).toBe(true);
		expect(matchSyncPath(rules, "mcp/myXserver+(1)[test]").ignored).toBe(true); // ignored by `*`, not by literal rule
		expect(matchSyncPath(rules, "mcp/my.server+(1)[test]").matchedBy?.raw).toBe("mcp/my.server+(1)[test]");
	});

	test("normalizes aliases (AGENTS.md, subagents/*.md, settings/mcp_servers) and trailing/leading slashes", () => {
		const { rules, warnings } = parseSyncRules([
			"AGENTS.md",
			"subagents/local-*.md",
			"settings/mcp_servers",
			"!mcp/shared",
			"/skills/browser-bridge/",
		].join("\n"));
		expect(warnings).toEqual([]);
		expect(matchSyncPath(rules, "agents-md").ignored).toBe(true);
		expect(matchSyncPath(rules, "subagents/local-dev").ignored).toBe(true);
		expect(matchSyncPath(rules, "subagents/review").ignored).toBe(false);
		expect(matchSyncPath(rules, "mcp/other").ignored).toBe(true);
		expect(matchSyncPath(rules, "mcp/shared").ignored).toBe(false);
		expect(matchSyncPath(rules, "skills/browser-bridge").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/browser-bridge/SKILL.md").ignored).toBe(true);
	});

	test("unanchored basename patterns match any segment while anchored patterns stay scoped", () => {
		const { rules } = parseSyncRules(["*.tmp", "browser-bridge", "/settings/default_workdir"].join("\n"));
		expect(matchSyncPath(rules, "skills/foo/a.tmp").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/foo/SKILL.md").ignored).toBe(false);
		expect(matchSyncPath(rules, "skills/browser-bridge/SKILL.md").ignored).toBe(true);
		expect(matchSyncPath(rules, "mcp/browser-bridge").ignored).toBe(true);
		expect(matchSyncPath(rules, "settings/default_workdir").ignored).toBe(true);
		expect(matchSyncPath(rules, "skills/default_workdir").ignored).toBe(false);
	});

	test("emits warnings for empty negation, unknown anchored namespace, oversized lines and caps", () => {
		const { rules, warnings } = parseSyncRules(["!", "skils/foo", "a".repeat(250)].join("\n"));
		expect(warnings.length).toBe(3);
		expect(warnings[0]!.message.en).toContain("empty pattern");
		expect(warnings[1]!.message.en).toContain("unknown namespace 'skils'");
		expect(warnings[2]!.message.en).toContain("too long");
		// Unknown namespace rule still compiles; empty & too-long lines are skipped.
		expect(rules.length).toBe(1);

		const many = Array.from({ length: 520 }, (_, i) => `skills/s${i}`).join("\n");
		const capped = parseSyncRules(many);
		expect(capped.rules.length).toBe(500);
		expect(capped.warnings.some((w) => w.message.en.includes("500"))).toBe(true);

		// ReDoS-proof DP glob matcher handles pathological wildcard patterns in linear/polynomial time.
		const evil = parseSyncRules("skills/*a*a*a*a*a*a*a*a*a*a*b\nskills/**/**/**/**/x").rules;
		const t0 = performance.now();
		expect(matchSyncPath(evil, `skills/${"a".repeat(120)}`).ignored).toBe(false);
		expect(matchSyncPath(evil, `skills/${"a/".repeat(40)}y`).ignored).toBe(false);
		expect(performance.now() - t0).toBeLessThan(100);
	});

	test("mayIncludeNamespace accurately detects namespace & extension sub-aspect reachability", () => {
		const defFollower = parseSyncRules(defaultRulesText("follower")).rules;
		expect(mayIncludeNamespace(defFollower, "settings")).toBe(true);
		expect(mayIncludeNamespace(defFollower, "mcp")).toBe(true);
		expect(mayIncludeNamespace(defFollower, "extensions", "settings")).toBe(false);
		expect(mayIncludeNamespace(defFollower, "extensions", "install")).toBe(false);
		expect(mayIncludeNamespace(defFollower, "skills")).toBe(false);
		expect(mayIncludeNamespace(defFollower, "agents-md")).toBe(false);
		expect(mayIncludeNamespace(defFollower, "providers")).toBe(false);

		const partialExt = parseSyncRules("*\n!extensions/quota-monitor/settings\n!secrets/providers/cliproxy").rules;
		expect(mayIncludeNamespace(partialExt, "extensions", "settings")).toBe(true);
		expect(mayIncludeNamespace(partialExt, "extensions", "install")).toBe(false);
		expect(mayIncludeNamespace(partialExt, "extensions", "client")).toBe(false);
		expect(mayIncludeNamespace(partialExt, "secrets/providers")).toBe(true);
		expect(mayIncludeNamespace(partialExt, "secrets/extensions")).toBe(false);
		expect(mayIncludeNamespace(partialExt, "skills")).toBe(false);
	});
});

// ---- End-to-end two-way server-sync tests with file-based syncignore ----

const SCHEMA = `
	CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
	CREATE TABLE client_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
	CREATE TABLE custom_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
	CREATE TABLE credentials (provider_id TEXT PRIMARY KEY, data TEXT NOT NULL);
`;

const sql = (file: string, q: string, ...p: unknown[]) => {
	const d = new Database(file);
	d.query(q).run(...(p as any[]));
	d.close();
};
const queryAll = (file: string, q: string) => {
	const d = new Database(file);
	const r = d.query(q).all() as Record<string, unknown>[];
	d.close();
	return r;
};
const row = (file: string, key: string) => {
	const r = queryAll(file, `SELECT data FROM settings WHERE key = '${key}'`)[0];
	return r ? JSON.parse(r.data as string) : undefined;
};
const setRow = (file: string, key: string, v: unknown) => sql(file, "INSERT OR REPLACE INTO settings (key, data) VALUES (?, ?)", key, JSON.stringify(v));
const dropRow = (file: string, key: string) => sql(file, "DELETE FROM settings WHERE key = ?", key);
const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };

describe("file-based syncignore end-to-end sync, agent tool & UI", () => {
	const root = mkdtempSync(join(tmpdir(), "server-sync-rules-"));
	const makeSide = (name: string) => {
		const dir = join(root, name);
		const data = join(dir, "data");
		const home = join(dir, "home");
		const extData = join(dir, "ext-data");
		const db = join(data, "pipaya.db");
		mkdirSync(data, { recursive: true });
		mkdirSync(home, { recursive: true });
		mkdirSync(extData, { recursive: true });
		new Database(db).exec(SCHEMA);
		return { dir, data, home, extData, db };
	};

	let P = makeSide("primary");
	let F = makeSide("follower");
	let peer: ReturnType<typeof Bun.serve> | undefined;
	let primaryMethods = new Map<string, (p?: unknown) => unknown>();
	const unloads: (() => void)[] = [];
	const unloadAll = () => { while (unloads.length) { try { unloads.pop()!(); } catch { /* ignore */ } } };

	const asSide = <T,>(side: typeof P, fn: () => T): T => {
		const prev = { db: process.env.PIPAYA_DB, data: process.env.PIPAYA_DATA_DIR, tok: process.env.PIPAYA_TOKEN };
		process.env.PIPAYA_DB = side.db;
		process.env.PIPAYA_DATA_DIR = side.data;
		process.env.PIPAYA_TOKEN = "adm";
		const restore = () => {
			for (const [k, v] of [["PIPAYA_DB", prev.db], ["PIPAYA_DATA_DIR", prev.data], ["PIPAYA_TOKEN", prev.tok]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		};
		try {
			const out = fn();
			if (out && typeof (out as Promise<unknown>).then === "function") return (out as Promise<unknown>).finally(restore) as T;
			restore();
			return out;
		} catch (e) {
			restore();
			throw e;
		}
	};

	/** Minimal TypeBox-like helper so `pi.registerTool` activates in tests. */
	const Type = {
		Object: (p: unknown) => ({ type: "object", properties: p }),
		Optional: (x: unknown) => x,
		String: (o?: unknown) => ({ type: "string", ...(o as object) }),
		Array: (i: unknown, o?: unknown) => ({ type: "array", items: i, ...(o as object) }),
	};

	const bootSide = (side: typeof P, initial: Record<string, unknown>, opts?: { ui?: boolean }) => {
		const settings = { ...initial };
		const methods = new Map<string, (p?: unknown) => unknown>();
		const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> }>();
		const panels: any[] = [];
		let onUiEvent: ((e: any) => Promise<void> | void) | undefined;
		const putDb = (key: string, v: unknown) => setRow(side.db, key, v);
		const apiRequest = async (method: string, path: string, body?: any) => {
			if (path === "/mcp" && method === "PUT") {
				putDb("mcp_servers", (body?.servers ?? []).map((c: any) => ({ ...c, name: String(c.name ?? "").trim() })));
				return { status: 200, body: { servers: body?.servers ?? [] } };
			}
			if (path === "/configuration/defaults" && method === "PUT") {
				if (body === null) dropRow(side.db, "default_model"); else putDb("default_model", body);
				return { status: 200, body: {} };
			}
			if (path === "/retention" && method === "PUT") { putDb("retention", body); return { status: 200, body: {} }; }
			if (path === "/retention" && method === "GET") return { status: 200, body: { defaults: { enabled: false, days: 30 } } };
			if (path === "/extensions/settings" && method === "GET") {
				const out: Record<string, { value: unknown }> = {};
				const dir = join(side.data, "extensions");
				if (existsSync(dir)) {
					for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
						if (!e.isDirectory()) continue;
						try { out[e.name] = { value: JSON.parse(readFileSync(join(dir, e.name, "settings.json"), "utf8")) }; } catch { /* ignore */ }
					}
				}
				return { status: 200, body: { settings: out } };
			}
			const extPut = path.match(/^\/extensions\/([^/]+)\/settings$/);
			if (extPut && method === "PUT") {
				write(join(side.data, "extensions", extPut[1]!, "settings.json"), JSON.stringify(body?.settings ?? {}));
				return { status: 200, body: {} };
			}
			if (path === "/server-extensions" && method === "GET") return { status: 200, body: { extensions: [] } };
			if (path === "/server-extensions/reload" && method === "POST") return { status: 200, body: {} };
			const cs = path.match(/^\/client-settings\/([^/]+)$/);
			if (cs && method === "GET") {
				const r = queryAll(side.db, `SELECT data FROM client_settings WHERE key = '${cs[1]}'`)[0];
				return r ? { status: 200, body: { value: JSON.parse(r.data as string) } } : { status: 404, body: {} };
			}
			if (cs && method === "PUT") {
				sql(side.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES (?, ?, 1)", cs[1]!, JSON.stringify(body?.value ?? null));
				return { status: 200, body: {} };
			}
			if (path === "/configuration" && method === "GET") {
				const providers = queryAll(side.db, "SELECT id, data FROM custom_providers").map((r) => ({ id: r.id, ...JSON.parse(r.data as string) }));
				return { status: 200, body: { providers } };
			}
			const prov = path.match(/^\/configuration\/providers\/([^/]+)$/);
			if (prov && method === "PUT") {
				sql(side.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES (?, ?)", prov[1]!, JSON.stringify({ id: prov[1]!, ...body }));
				return { status: 200, body: {} };
			}
			if (path === "/providers" && method === "GET") {
				const have = new Set(queryAll(side.db, "SELECT provider_id FROM credentials").map((r) => r.provider_id as string));
				const ids = new Set([...have, ...queryAll(side.db, "SELECT id FROM custom_providers").map((r) => r.id as string), "cliproxy"]);
				return { status: 200, body: { providers: [...ids].map((id) => ({ id, storedCredential: have.has(id) })) } };
			}
			const cred = path.match(/^\/providers\/([^/]+)\/credential$/);
			if (cred && method === "PUT") {
				sql(side.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES (?, ?)", cred[1]!, JSON.stringify({ type: "api_key", key: body?.key }));
				return { status: 200, body: {} };
			}
			return { status: 404, body: { error: { message: `unhandled ${method} ${path}` } } };
		};

		asSide(side, () => factory({
			home: side.home,
			dataDir: side.extData,
			Type,
			api: { request: (m: string, p: string, b?: unknown) => asSide(side, () => apiRequest(m, p, b)) },
			server: { info: () => ({ port: peer?.port ?? 0, host: "0.0.0.0", urls: [`http://127.0.0.1:${peer?.port ?? 0}`] }) },
			settings: {
				get: () => settings,
				set: (next: Record<string, unknown>) => {
					for (const k of Object.keys(settings)) delete settings[k];
					Object.assign(settings, next);
					return settings;
				},
				onChange: () => () => {},
			},
			...(opts?.ui ? {
				ui: {
					setPanel: (node: unknown) => { panels.push(node); },
					onEvent: (fn: (e: any) => Promise<void> | void) => { onUiEvent = fn; },
				},
			} : {}),
			log: () => {},
			registerMethod: (name: string, fn: (p?: unknown) => unknown) => void methods.set(name, fn),
			registerTool: (tool: any) => void tools.set(tool.name, tool),
			emit: () => {},
			on: () => {},
		}));

		return {
			settings,
			methods,
			tools,
			panels,
			uiEvent: (e: any) => asSide(side, () => onUiEvent?.(e)),
			call: <T = any>(name: string, p?: unknown) => asSide(side, () => methods.get(name)!(p)) as Promise<T>,
			sync: () => asSide(side, () => methods.get("sync")!()) as Promise<{ applied: string[]; keys: string[]; rulesFile: string }>,
			runTool: async (p: Record<string, unknown>) => {
				const res = await asSide(side, () => tools.get("server_sync_rules")!.execute("t1", p));
				return JSON.parse(res.content[0]!.text);
			},
		};
	};

	beforeAll(() => {
		peer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const { pathname } = new URL(req.url);
				const m = pathname.match(/^\/server-extensions\/server-sync\/methods\/([^/]+)$/);
				if (m && primaryMethods.has(m[1]!)) {
					const body = await req.json().catch(() => ({}));
					const result = await asSide(P, () => primaryMethods.get(m[1]!)!(body));
					return Response.json({ result });
				}
				return new Response("not found", { status: 404 });
			},
		});
	});

	afterAll(() => {
		unloadAll();
		peer?.stop(true);
		rmSync(root, { recursive: true, force: true });
	});

	const resetBoth = () => {
		unloadAll();
		P = makeSide(`p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		F = makeSide(`f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		const p = bootSide(P, { role: "primary" });
		primaryMethods = p.methods;
		const f = bootSide(F, { role: "follower", remoteUrl: `http://127.0.0.1:${peer!.port}`, remoteToken: "t" }, { ui: true });
		return { p, f };
	};

	test("per-server MCP sync merges around follower-ignored MCP servers both ways", async () => {
		const { f } = resetBoth();
		setRow(P.db, "mcp_servers", [
			{ name: "search", transport: "http", url: "http://search/mcp" },
			{ name: "docs", transport: "http", url: "http://docs/mcp" },
		]);
		setRow(F.db, "mcp_servers", [
			{ name: "local-obsidian", transport: "stdio", command: "obsidian-mcp" },
		]);
		// Direct file-based edit (no restart needed!)
		writeFileSync(join(F.extData, "syncignore"), "mcp/local-obsidian\n");

		await f.sync();
		expect(row(F.db, "mcp_servers").map((x: any) => x.name)).toEqual(["local-obsidian", "search", "docs"]);

		// Edit both synced (`search`) and ignored (`local-obsidian`) on follower: only `search` pushes up!
		setRow(F.db, "mcp_servers", [
			{ name: "local-obsidian", transport: "stdio", command: "obsidian-v2" },
			{ name: "search", transport: "http", url: "http://search-v2/mcp" },
			{ name: "docs", transport: "http", url: "http://docs/mcp" },
		]);
		const pushed = await f.sync();
		expect(pushed.applied).toContain("up:mcp_servers");
		expect(row(P.db, "mcp_servers")).toEqual([
			{ name: "search", transport: "http", url: "http://search-v2/mcp" },
			{ name: "docs", transport: "http", url: "http://docs/mcp" },
		]);

		// Primary deletes `docs`: follower removes `docs` while keeping `local-obsidian` intact!
		setRow(P.db, "mcp_servers", [{ name: "search", transport: "http", url: "http://search-v2/mcp" }]);
		await f.sync();
		expect(row(F.db, "mcp_servers")).toEqual([
			{ name: "local-obsidian", transport: "stdio", command: "obsidian-v2" },
			{ name: "search", transport: "http", url: "http://search-v2/mcp" },
		]);

		// Follower deletes `search`: primary deletes `search`, follower keeps `local-obsidian`!
		setRow(F.db, "mcp_servers", [{ name: "local-obsidian", transport: "stdio", command: "obsidian-v2" }]);
		await f.sync();
		expect(row(P.db, "mcp_servers")).toEqual([]);
		expect(row(F.db, "mcp_servers")).toEqual([{ name: "local-obsidian", transport: "stdio", command: "obsidian-v2" }]);
	});

	test("primary-ignored MCP servers and settings keys are hidden without deleting follower's local copy", async () => {
		const { f } = resetBoth();
		setRow(P.db, "default_model", { provider: "a", model: "p-model" });
		setRow(P.db, "retention", { enabled: true, days: 14 });
		setRow(P.db, "mcp_servers", [
			{ name: "shared", transport: "http", url: "http://shared" },
			{ name: "primary-secret-mcp", transport: "stdio", command: "secret" },
		]);
		setRow(F.db, "default_model", { provider: "b", model: "f-model" });
		setRow(F.db, "mcp_servers", [
			{ name: "primary-secret-mcp", transport: "stdio", command: "follower-own" },
		]);
		// Sync both initially? No, primary hides them from the start (and even if follower had them).
		writeFileSync(join(P.extData, "syncignore"), "settings/default_model\nmcp/primary-secret-mcp\n");
		writeFileSync(join(F.extData, "syncignore"), "");

		await f.sync();
		// Primary hid `default_model` & `mcp/primary-secret-mcp`: follower keeps its own values!
		expect(row(F.db, "default_model")).toEqual({ provider: "b", model: "f-model" });
		expect(row(F.db, "retention")).toEqual({ enabled: true, days: 14 });
		expect(row(F.db, "mcp_servers")).toEqual([
			{ name: "primary-secret-mcp", transport: "stdio", command: "follower-own" },
			{ name: "shared", transport: "http", url: "http://shared" },
		]);

		// Follower tries to push an edit to `primary-secret-mcp`: primary ignores it.
		setRow(F.db, "mcp_servers", [
			{ name: "primary-secret-mcp", transport: "stdio", command: "overwrite-attempt" },
			{ name: "shared", transport: "http", url: "http://shared" },
		]);
		await f.sync();
		expect(row(P.db, "mcp_servers").find((x: any) => x.name === "primary-secret-mcp").command).toBe("secret");
	});

	test("whitelist mode (* + !patterns) syncs only explicitly allowed items across categories", async () => {
		const { f } = resetBoth();
		setRow(P.db, "default_model", { provider: "a", model: "wanted" });
		setRow(P.db, "retention", { enabled: true, days: 99 });
		setRow(P.db, "mcp_servers", [
			{ name: "search", transport: "http", url: "http://search" },
			{ name: "private", transport: "http", url: "http://private" },
		]);
		write(join(P.home, ".agents", "skills", "orchestrate", "SKILL.md"), "# orchestrate");
		write(join(P.home, ".agents", "skills", "browser-bridge", "SKILL.md"), "# browser");
		write(join(P.home, ".agents", "AGENTS.md"), "# global agents");
		write(join(P.home, ".agents", "subagents", "review.md"), "# review");
		write(join(P.home, ".agents", "subagents", "local.md"), "# local");

		writeFileSync(join(F.extData, "syncignore"), [
			"*",
			"!settings/default_model",
			"!mcp/search",
			"!skills/orchestrate",
			"!subagents/review.md",
		].join("\n"));

		await f.sync();
		expect(row(F.db, "default_model")).toEqual({ provider: "a", model: "wanted" });
		expect(row(F.db, "retention")).toBeUndefined();
		expect(row(F.db, "mcp_servers")).toEqual([{ name: "search", transport: "http", url: "http://search" }]);
		expect(existsSync(join(F.home, ".agents", "skills", "orchestrate", "SKILL.md"))).toBe(true);
		expect(existsSync(join(F.home, ".agents", "skills", "browser-bridge", "SKILL.md"))).toBe(false);
		expect(existsSync(join(F.home, ".agents", "AGENTS.md"))).toBe(false);
		expect(existsSync(join(F.home, ".agents", "subagents", "review.md"))).toBe(true);
		expect(existsSync(join(F.home, ".agents", "subagents", "local.md"))).toBe(false);
	});

	test("file-level skill ignore preserves local ignored files and never sends them up", async () => {
		const { f } = resetBoth();
		write(join(P.home, ".agents", "skills", "my-skill", "SKILL.md"), "primary v1");
		write(join(P.home, ".agents", "skills", "my-skill", "draft.tmp"), "primary tmp");
		write(join(F.home, ".agents", "skills", "my-skill", "local.tmp"), "keep me");

		writeFileSync(join(F.extData, "syncignore"), "*.tmp\n");
		await f.sync();

		expect(readFileSync(join(F.home, ".agents", "skills", "my-skill", "SKILL.md"), "utf8")).toBe("primary v1");
		expect(existsSync(join(F.home, ".agents", "skills", "my-skill", "draft.tmp"))).toBe(false);
		// Locally ignored file inside a synced skill is NEVER pruned!
		expect(readFileSync(join(F.home, ".agents", "skills", "my-skill", "local.tmp"), "utf8")).toBe("keep me");

		// Editing the ignored file does NOT push to primary.
		write(join(F.home, ".agents", "skills", "my-skill", "local.tmp"), "edited locally");
		const res = await f.sync();
		expect(res.applied).toEqual([]);
		expect(existsSync(join(P.home, ".agents", "skills", "my-skill", "local.tmp"))).toBe(false);
	});

	test("extension sub-path rules filter settings and client states independently", async () => {
		const { f } = resetBoth();
		write(join(P.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ language: "en" }));
		write(join(F.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ language: "ko" }));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([
			{ manifest: { id: "quota-monitor", version: "0.6.7" } },
			{ manifest: { id: "shared-client", version: "1.0.0" } },
		]));
		sql(P.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensionStates', ?, 1)", JSON.stringify({ "quota-monitor": true, "shared-client": true }));
		sql(F.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensions', ?, 1)", JSON.stringify([
			{ manifest: { id: "local-only", version: "0.1.0" } },
		]));
		sql(F.db, "INSERT OR REPLACE INTO client_settings (key, data, updated_at) VALUES ('extensionStates', ?, 1)", JSON.stringify({ "local-only": true }));

		// Ignore quota-monitor settings, ignore local-only client state, sync everything else!
		writeFileSync(join(F.extData, "syncignore"), "extensions/quota-monitor/settings\nextensions/local-only/client\n");
		await f.sync();

		// quota-monitor settings stayed local ("ko"), while client extensions merged local-only + primary's!
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8")).language).toBe("ko");
		const clientList = JSON.parse(queryAll(F.db, "SELECT data FROM client_settings WHERE key = 'extensions'")[0]!.data as string);
		expect(clientList.map((x: any) => x.manifest.id).sort()).toEqual(["local-only", "quota-monitor", "shared-client"]);
		const clientStates = JSON.parse(queryAll(F.db, "SELECT data FROM client_settings WHERE key = 'extensionStates'")[0]!.data as string);
		expect(clientStates).toEqual({ "local-only": true, "quota-monitor": true, "shared-client": true });
	});

	test("security boundaries (secrets, local code, NEVER_SYNCED, server-sync) cannot be bypassed by ! rules", async () => {
		const { f } = resetBoth();
		setRow(P.db, "device_id", "primary-device-id");
		setRow(F.db, "device_id", "follower-device-id");
		sql(P.db, "INSERT OR REPLACE INTO credentials (provider_id, data) VALUES ('cliproxy', ?)", JSON.stringify({ type: "api_key", key: "sk-secret" }));
		write(join(P.data, "extensions", "quota-monitor", "settings.json"), JSON.stringify({ language: "en", apiToken: "tok-secret" }));
		write(join(P.home, ".agents", "extensions", "custom.ts"), "export default () => {};");

		// Try to force-include everything with ! rules while security switches are OFF.
		writeFileSync(join(F.extData, "syncignore"), [
			"!settings/device_id",
			"!extensions/server-sync",
			"!secrets/providers/cliproxy",
			"!secrets/extensions/quota-monitor",
			"!agent-extensions/custom.ts",
		].join("\n"));

		await f.sync();
		expect(row(F.db, "device_id")).toBe("follower-device-id");
		expect(queryAll(F.db, "SELECT provider_id FROM credentials")).toEqual([]);
		expect(JSON.parse(readFileSync(join(F.data, "extensions", "quota-monitor", "settings.json"), "utf8")).apiToken).toBeUndefined();
		expect(existsSync(join(F.home, ".agents", "extensions", "custom.ts"))).toBe(false);
	});

	test("re-including a previously ignored setting cleanly pulls primary's value", async () => {
		const { f } = resetBoth();
		setRow(P.db, "default_model", { provider: "a", model: "p1" });
		setRow(F.db, "default_model", { provider: "b", model: "f1" });
		writeFileSync(join(F.extData, "syncignore"), "settings/default_model\n");
		await f.sync();
		expect(row(F.db, "default_model").model).toBe("f1");

		// Remove the ignore rule: next sync pulls primary's value instead of pushing stale local value!
		writeFileSync(join(F.extData, "syncignore"), "");
		await f.sync();
		expect(row(F.db, "default_model").model).toBe("p1");
	});

	test("server_sync_rules agent tool supports inspect, test, add, remove, set, and reset", async () => {
		const { f } = resetBoth();
		setRow(F.db, "mcp_servers", [{ name: "search", url: "http://s" }, { name: "local-obs", command: "obs" }]);
		write(join(F.home, ".agents", "skills", "browser-bridge", "SKILL.md"), "# b");
		write(join(F.home, ".agents", "skills", "orchestrate", "SKILL.md"), "# o");
		write(join(F.home, ".agents", "AGENTS.md"), "# global");
		sql(F.db, "INSERT OR REPLACE INTO custom_providers (id, data) VALUES ('ollama', ?)", JSON.stringify({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", models: [] }));

		// 1. inspect (before file exists: uses defaults)
		const initial = await f.runTool({ action: "inspect" });
		expect(initial.exists).toBe(false);
		expect(initial.file).toBe(join(F.extData, "syncignore"));
		expect(initial.items.find((i: any) => i.path === "mcp/search").synced).toBe(true);
		expect(initial.items.find((i: any) => i.path === "skills/browser-bridge").synced).toBe(false);
		expect(initial.items.find((i: any) => i.path === "providers/ollama").synced).toBe(false);

		// 2. test (dry-run without writing disk)
		const dry = await f.runTool({
			action: "test",
			content: "mcp/local-obs\nskills/browser-bridge\n",
			paths: ["mcp/local-obs", "mcp/search", "skills/orchestrate/SKILL.md", "skills/browser-bridge/SKILL.md"],
		});
		expect(existsSync(join(F.extData, "syncignore"))).toBe(false);
		expect(dry.tested.map((t: any) => [t.path, t.synced])).toEqual([
			["mcp/local-obs", false],
			["mcp/search", true],
			["skills/orchestrate/SKILL.md", true],
			["skills/browser-bridge/SKILL.md", false],
		]);

		// 3. set (writes file and strips obsolete legacy keys if any)
		f.settings.syncMcpServers = false;
		const saved = await f.runTool({ action: "set", content: "# my rules\nmcp/local-obs\nskills/browser-bridge\n" });
		expect(saved.exists).toBe(true);
		expect("syncMcpServers" in f.settings).toBe(false);
		expect(saved.items.find((i: any) => i.path === "mcp/local-obs").synced).toBe(false);
		expect(saved.items.find((i: any) => i.path === "skills/orchestrate").synced).toBe(true);

		// 4. add (appends without duplicating existing line)
		const added = await f.runTool({ action: "add", patterns: ["mcp/local-obs", "providers/ollama"] });
		expect(added.items.find((i: any) => i.path === "providers/ollama").synced).toBe(false);
		expect(added.content.match(/mcp\/local-obs/g)?.length).toBe(1);

		// 5. remove (deletes exact line while keeping comments and other rules)
		const removed = await f.runTool({ action: "remove", patterns: ["providers/ollama"] });
		expect(removed.items.find((i: any) => i.path === "providers/ollama").synced).toBe(true);
		expect(removed.content).toContain("# my rules");

		// 6. reset (restores follower defaults)
		const reset = await f.runTool({ action: "reset" });
		expect(reset.items.find((i: any) => i.path === "skills/orchestrate").synced).toBe(false);
		expect(reset.items.find((i: any) => i.path === "mcp/local-obs").synced).toBe(true);
	});

	test("rules/setRules RPC methods and pi.ui rules editor card work end-to-end", async () => {
		const { f } = resetBoth();
		setRow(F.db, "mcp_servers", [{ name: "local-tool", command: "x" }, { name: "search", url: "http://s" }]);

		// Initial view shows active rules list (read-only) before opening editor
		const initPanel = JSON.stringify(f.panels.at(-1));
		expect(initPanel).toContain("rules-list");
		expect(initPanel).not.toContain("rules-editor");

		// Open rules editor via UI action
		await f.uiEvent({ type: "action", id: "rules-open" });
		const openPanel = JSON.stringify(f.panels.at(-1));
		expect(openPanel).toContain("rules-editor");
		expect(openPanel).not.toContain("rules-list");
		expect(openPanel).toContain("rules-form");
		expect(openPanel).toContain("mcp/local-tool");

		// Change textarea draft with an unknown namespace -> warning appears in preview
		await f.uiEvent({ type: "change", id: "rules-text-1", value: "skils/typo\nmcp/local-tool\n" });
		const warnPanel = JSON.stringify(f.panels.at(-1));
		expect(warnPanel).toContain("rules-warn");
		expect(warnPanel).toContain("skils");

		// Submit form -> saves syncignore to disk, closes editor, and returns to updated rules list
		await f.uiEvent({ type: "submit", id: "rules-form", values: { "rules-text-1": "mcp/local-tool\n" } });
		expect(readFileSync(join(F.extData, "syncignore"), "utf8")).toBe("mcp/local-tool\n");
		const afterSavePanel = JSON.stringify(f.panels.at(-1));
		expect(afterSavePanel).not.toContain("rules-editor");
		expect(afterSavePanel).toContain("rules-list");
		expect(afterSavePanel).toContain("mcp/local-tool");

		// Verify RPC `rules` and `setRules`
		const viaRpc = await f.call("rules");
		expect(viaRpc.exists).toBe(true);
		expect(viaRpc.items.find((i: any) => i.path === "mcp/local-tool").synced).toBe(false);
		await f.call("setRules", { content: "" });
		const afterRpc = await f.call("rules");
		expect(afterRpc.items.find((i: any) => i.path === "mcp/local-tool").synced).toBe(true);
	});
});
