import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;
const DAY = 24 * 3600_000;

run("prompt-templates (needs PIPAYA_APP=<pipaya>/server)", () => {
	let app: any, dir = "", home = "", ws = "", upstream: any, db: any;
	const api = async (method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: "Bearer t", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const idle = async (id: string) => { for (let i = 0; i < 300; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(20); } throw new Error("never idle"); };
	const call = async (method: string, body: unknown = {}) => (await api("POST", `/server-extensions/prompt-templates/methods/${method}`, body)).json?.result;
	const make = async () => (await api("POST", "/sessions", { cwd: ws })).json.id as string;
	const exists = async (id: string) => (await api("GET", `/sessions/${id}`)).status === 200;

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import(join(SERVER!, "test/support/openai-upstream.ts"));
		const { Database } = await import("bun:sqlite");
		dir = mkdtempSync(join(tmpdir(), "prompt-templates-"));
		home = join(dir, "home"); ws = join(dir, "ws");
		mkdirSync(join(home, ".agents", "templates"), { recursive: true }); mkdirSync(ws, { recursive: true });
		writeFileSync(join(home, ".agents", "templates", "review.md"), "---\ndescription: Review a change\n---\nReview this: $ARGUMENTS");
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "prompt-templates"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "t", workspaceRoot: ws, logLevel: "silent" }, { strictResponses: true, home, extensionDirs: [join(dir, "ext"), join(SERVER!, "test/support/ext")] });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
		db = new Database(join(dir, "db.sqlite"), { strict: true });
	});
	afterAll(async () => { db?.close(); await app?.close(); upstream?.stop(); rmSync(dir, { recursive: true, force: true }); });

	test("loads without an error", async () => {
		const e = (await api("GET", "/server-extensions")).json.extensions.find((x: any) => x.name === "prompt-templates");
		expect(e && !e.error).toBe(true);
	});

	test("lists the templates of a directory as a command family", async () => {
		const r = (await api("GET", `/server-extensions/commands?cwd=${encodeURIComponent(ws)}`)).json.families.find((f: any) => f.prefix === "prompt");
		expect(r.entries).toEqual([{ name: "review", description: "Review a change" }]);
	});

	test("/prompt:name is sent as the expanded text with a marker note, and titles the session by the name", async () => {
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: "/prompt:review the diff" });
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		const user = JSON.stringify(msgs.find((m: any) => m.role === "user"));
		expect(user).toContain("Review this: the diff");
		expect(user).toContain("<pipaya-note>");
		expect(user).toContain("/prompt:review the diff");
		expect((await api("GET", `/sessions/${id}`)).json.title).toBe("review");
	});

	test("an unknown template is sent as typed", async () => {
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: "/prompt:nope hi" });
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		const user = JSON.stringify(msgs.find((m: any) => m.role === "user"));
		expect(user).toContain("/prompt:nope hi");
		expect(user).not.toContain("<pipaya-note>");
	});
});
