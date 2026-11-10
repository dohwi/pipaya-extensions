import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;

run("guard (needs PIPAYA_APP=<pipaya>/server)", () => {
	let app: any, dir = "", ws = "", upstream: any;
	const api = async (method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: "Bearer t", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const idle = async (id: string) => { for (let i = 0; i < 300; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(20); } throw new Error("never idle"); };
	const save = (settings: Record<string, unknown>) => api("PUT", "/extensions/guard/settings", { settings });

	/**
	 * Run one command through the agent. `blocked` is guard's own refusal: a command it lets through may still fail on
	 * its own (rm refuses "/" by itself), so the reason is what tells the two apart.
	 */
	const runCommand = async (command: string) => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: `!bash ${JSON.stringify({ command })}` });
		await idle(id);
		const result = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message).find((m: any) => m.role === "toolResult" && m.toolName === "bash");
		const text = JSON.stringify(result?.content ?? "");
		return { blocked: text.includes("refused by guard"), text };
	};

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import(join(SERVER!, "test/support/openai-upstream.ts"));
		dir = mkdtempSync(join(tmpdir(), "guard-"));
		ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "guard"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "t", workspaceRoot: ws, logLevel: "silent" }, { strictResponses: true, home: dir, extensionDirs: [join(dir, "ext")] });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});
	afterAll(async () => { await app?.close(); upstream?.stop(); rmSync(dir, { recursive: true, force: true }); });

	test("loads with its four toggles, all on by default", async () => {
		const e = (await api("GET", "/server-extensions")).json.extensions.find((x: any) => x.name === "guard");
		expect(e.error).toBeUndefined();
		expect(e.settings.map((f: any) => [f.key, f.type, f.default])).toEqual([
			["wipe", "boolean", true], ["disk", "boolean", true], ["fork", "boolean", true], ["permissions", "boolean", true],
		]);
	});

	test("blocks a destructive command before anything is saved", async () => {
		expect((await runCommand("rm -rf /tmp/guard-never-created")).blocked).toBe(false);
		expect((await runCommand("rm -rf /")).blocked).toBe(true);
		expect((await runCommand(":(){ :|:& };:")).blocked).toBe(true);
	});

	test("a toggle that is off lets its own commands through and keeps the others", async () => {
		expect((await save({ wipe: false, disk: true, fork: true, permissions: true })).status).toBe(200);
		expect((await runCommand("rm -rf /")).blocked).toBe(false);
		expect((await runCommand(":(){ :|:& };:")).blocked).toBe(true);
		expect((await save({ wipe: true, disk: true, fork: true, permissions: true })).status).toBe(200);
		expect((await runCommand("rm -rf /")).blocked).toBe(true);
	});

	test("the recursive flag counts on either side, and a plain chmod still passes", async () => {
		expect((await runCommand("chmod 777 -R /")).blocked).toBe(true);
		expect((await runCommand("chown root:root --recursive /")).blocked).toBe(true);
		expect((await runCommand("chmod 644 /etc/hostname")).blocked).toBe(false);
	});
});
