// Two real pipaya servers, each its own process, with this extension installed: the rows go through the app's routes
// and stay quiet afterwards, both ways. Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;

run("two real servers (needs PIPAYA_APP=<pipaya>/server)", () => {
	const root = mkdtempSync(join(tmpdir(), "server-sync-real-"));
	type Server = { url: string; token: string; proc: ReturnType<typeof Bun.spawn> };
	let P: Server, F: Server, upstream: any, ECHO: any, echoBody: any;
	const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
	const api = async (s: Server, method: string, path: string, body?: unknown) => {
		const r = await fetch(`${s.url}${path}`, { method, headers: { authorization: `Bearer ${s.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		const text = await r.text();
		return { status: r.status, json: text ? JSON.parse(text) : null };
	};
	const start = async (name: string): Promise<Server> => {
		const dir = join(root, name);
		const data = join(dir, "data");
		mkdirSync(join(data, "extensions", "server-sync"), { recursive: true });
		mkdirSync(join(dir, "home"), { recursive: true });
		mkdirSync(join(dir, "work"), { recursive: true });
		for (const f of ["index.ts", "package.json"]) copyFileSync(join(import.meta.dir, f), join(data, "extensions", "server-sync", f));
		const port = freePort();
		const proc = Bun.spawn(["bun", join(SERVER!, "src/index.ts")], {
			cwd: SERVER!,
			// Only what a real server is started with: nothing of the other tests' environment (PIPAYA_DB) leaks in. No
			// PIPAYA_TOKEN: the server writes its token file, which is removed once it runs (below).
			env: { PATH: process.env.PATH, HOME: join(dir, "home"), PIPAYA_DATA_DIR: data, PIPAYA_PORT: String(port), PIPAYA_HOST: "127.0.0.1", PIPAYA_WORKSPACE: join(dir, "work"), PIPAYA_LOG_LEVEL: "silent", PIPAYA_PUSH_FCM: "0" },
			stdout: "ignore", stderr: "ignore",
		});
		const url = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 200; i++) {
			try {
				if ((await fetch(`${url}/health`)).ok) {
					// The token stays in the server's memory; without the file, the old way of reaching itself (the token
					// file) fails with 401, so everything below passes only through pi.api.
					const token = readFileSync(join(data, "token"), "utf8").trim();
					rmSync(join(data, "token"));
					return { url, token, proc };
				}
			} catch { /* starting */ }
			await Bun.sleep(50);
		}
		throw new Error(`${name} did not start`);
	};
	const sync = async () => {
		const r = await api(F, "POST", "/server-extensions/server-sync/methods/sync", {});
		if (r.status !== 200) throw new Error(JSON.stringify(r.json));
		return r.json.result.applied as string[];
	};

	beforeAll(async () => {
		({ ECHO_MODEL: ECHO, echoProviderBody: echoBody } = await import(join(SERVER!, "test/support/openai-upstream.ts")));
		upstream = (await import(join(SERVER!, "test/support/openai-upstream.ts"))).startEchoUpstream();
		[P, F] = await Promise.all([start("primary"), start("follower")]);
		for (const s of [P, F]) expect((await api(s, "PUT", "/configuration/providers/echo", echoBody(upstream.baseUrl))).status).toBe(200);
		expect((await api(P, "PUT", "/configuration/defaults", { provider: "echo", model: ECHO.id })).status).toBe(200);
		expect((await api(P, "PUT", "/compaction", { auto: false, model: null })).status).toBe(200);
		expect((await api(P, "PUT", "/retention", { enabled: true, days: 12, onlyClosed: false })).status).toBe(200);
		expect((await api(P, "PUT", "/system-model", { model: { provider: "echo", model: ECHO.id } })).status).toBe(200);
		expect((await api(P, "PUT", "/mcp", { servers: [{ name: "remote", enabled: false, transport: "http", url: "http://127.0.0.1:9/mcp" }] })).status).toBe(200);
		const toggleable = (await api(P, "GET", "/configuration")).json.tools.toggleable as string[];
		expect((await api(P, "PUT", "/configuration/tools", { disabled: toggleable.slice(0, 1) })).status).toBe(200);
		expect((await api(P, "PUT", "/configuration/delegate", { policy: "any", models: [], maxConcurrent: 2, maxCalls: 5, maxTurns: 10 })).status).toBe(200);
	}, 30_000);

	afterAll(async () => {
		for (const s of [P, F]) { s?.proc.kill(); await s?.proc.exited; }
		upstream?.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test("both load it with pi.api, and a follower connects with the primary's pairing code", async () => {
		for (const s of [P, F]) expect((await api(s, "GET", "/server-extensions/errors?extension=server-sync")).json.errors ?? []).toEqual([]);
		const { code } = (await api(P, "POST", "/pairing")).json;
		const r = await api(F, "POST", "/server-extensions/server-sync/methods/connect", { url: P.url, code });
		expect(r.status).toBe(200);
		expect(r.json.result.lastError).toBeNull();
		expect(r.json.result.applied.sort()).toEqual(["compaction", "default_model", "delegate_policy", "disabled_tools", "mcp_servers", "retention", "system_model"]);
	});

	test("the follower's own routes now answer what the primary's do", async () => {
		for (const path of ["/compaction", "/retention", "/system-model", "/image-model"]) expect((await api(F, "GET", path)).json.settings).toEqual((await api(P, "GET", path)).json.settings);
		const [p, f] = [(await api(P, "GET", "/configuration")).json, (await api(F, "GET", "/configuration")).json];
		expect(f.defaults).toEqual(p.defaults);
		expect(f.tools.disabled).toEqual(p.tools.disabled);
		expect(f.tools.delegate).toEqual(p.tools.delegate);
		expect((await api(F, "GET", "/mcp")).json.servers.map((s: any) => s.name)).toEqual(["remote"]);
	});

	test("nothing moves again, whichever way a route stored it", async () => {
		expect(await sync()).toEqual([]);
		expect(await sync()).toEqual([]);
	});

	test("a change on either side reaches the other through its route, then all is quiet", async () => {
		expect((await api(F, "PUT", "/retention", { enabled: false, days: 40, onlyClosed: true })).status).toBe(200);
		expect(await sync()).toEqual(["up:retention"]);
		expect((await api(P, "GET", "/retention")).json.settings).toEqual({ enabled: false, days: 40, onlyClosed: true });
		expect((await api(P, "PUT", "/compaction", { auto: true, model: null, thresholdPercent: 60 })).status).toBe(200);
		expect(await sync()).toEqual(["compaction"]);
		expect((await api(F, "GET", "/compaction")).json.settings).toEqual({ auto: true, model: null, thresholdPercent: 60 });
		expect(await sync()).toEqual([]);
	});

	test("a model the follower does not have is refused there, kept as its own and taken once it exists", async () => {
		const other = { ...echoBody(upstream.baseUrl, "Other"), models: [{ ...ECHO, id: "other-model" }] };
		expect((await api(P, "PUT", "/configuration/providers/other", other)).status).toBe(200);
		expect((await api(P, "PUT", "/image-model", { model: null })).status).toBe(200);
		expect((await api(P, "PUT", "/system-model", { model: { provider: "other", model: "other-model" } })).status).toBe(200);
		expect(await sync()).not.toContain("system_model");
		expect((await api(F, "GET", "/system-model")).json.settings.model.provider).toBe("echo");
		expect((await api(F, "PUT", "/configuration/providers/other", other)).status).toBe(200);
		expect(await sync()).toContain("system_model");
		expect((await api(F, "GET", "/system-model")).json.settings.model.provider).toBe("other");
		expect(await sync()).toEqual([]);
	});

	test("extension settings come through GET /extensions/settings and go in through PUT, credentials staying each side's own", async () => {
		expect((await api(P, "PUT", "/extensions/quota-monitor/settings", { settings: { httpOrigin: "http://p", httpToken: "tok-p" } })).status).toBe(200);
		expect((await api(F, "PUT", "/extensions/quota-monitor/settings", { settings: { httpOrigin: "http://f", httpToken: "tok-f" } })).status).toBe(200);
		expect((await api(F, "PUT", "/extensions/server-sync/settings", { settings: { syncExtensions: true }, keys: ["syncExtensions"] })).status).toBe(200);
		expect(await sync()).toContain("ext:quota-monitor");
		expect((await api(F, "GET", "/extensions/quota-monitor/settings")).json.value).toEqual({ httpOrigin: "http://p", httpToken: "tok-f" });
		expect(await sync()).toEqual([]);
		expect((await api(F, "PUT", "/extensions/quota-monitor/settings", { settings: { httpOrigin: "http://changed", httpToken: "tok-f" } })).status).toBe(200);
		expect(await sync()).toEqual(["up:ext:quota-monitor"]);
		expect((await api(P, "GET", "/extensions/quota-monitor/settings")).json.value).toEqual({ httpOrigin: "http://changed", httpToken: "tok-p" });
	});
});
