import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;

run("hermes (needs PIPAYA_APP=<pipaya>/server)", () => {
	let app: any, dir = "", ws = "", upstream: any;
	const api = async (method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: "Bearer t", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const idle = async (id: string) => {
		for (let i = 0; i < 300; i++) {
			if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(20);
		}
		throw new Error("never idle");
	};
	const say = async (id: string, text: string) => {
		const r = await api("POST", `/sessions/${id}/messages`, { text });
		expect(r.status).toBeLessThan(300);
		await idle(id);
	};
	const toolText = async (id: string, tool: string) => {
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		const hit = msgs.filter((m: any) => m.role === "toolResult" && m.toolName === tool).at(-1);
		return JSON.stringify(hit?.content ?? "");
	};
	const lastSystem = () => {
		const req = upstream.requests.at(-1);
		const sys = req?.body?.messages?.find((m: any) => m.role === "system" || m.role === "developer");
		return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
	};
	const ext = async () => (await api("GET", "/server-extensions")).json.extensions.find((x: any) => x.name === "hermes");
	const memDir = () => join(dir, "extension-data", "hermes", "memories");

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import(join(SERVER!, "test/support/openai-upstream.ts"));
		dir = mkdtempSync(join(tmpdir(), "hermes-"));
		ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "hermes"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "t", workspaceRoot: ws, logLevel: "silent" }, { strictResponses: true, home: dir, extensionDirs: [join(dir, "ext")] });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
		await api("PUT", "/extensions/hermes/settings", { settings: { review: false } });
	});
	afterAll(async () => {
		await app?.close();
		upstream?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads with its tools, command, settings form and page", async () => {
		const e = await ext();
		expect(e.error).toBeUndefined();
		expect(e.tools).toEqual(expect.arrayContaining(["memory", "session_search", "skill_manage"]));
		expect(e.settings.map((f: any) => f.key)).toContain("reviewTurns");
		expect(e.panel?.type).toBe("stack");
	});

	test("memory tool writes USER.md; the next session gets it in its system prompt, the running one keeps its snapshot", async () => {
		const a = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(a, "hello");
		expect(lastSystem()).not.toContain("USER PROFILE (who");
		await say(a, `!memory ${JSON.stringify({ target: "user", operations: [{ action: "add", content: "Replies in Korean, short" }] })}`);
		expect(await toolText(a, "memory")).toContain("Saved.");
		expect(readFileSync(join(memDir(), "USER.md"), "utf8")).toContain("Replies in Korean, short");
		await say(a, "again");
		expect(lastSystem()).not.toContain("Replies in Korean, short");
		const b = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(b, "hi");
		expect(lastSystem()).toContain("USER PROFILE (who");
		expect(lastSystem()).toContain("Replies in Korean, short");
	});

	test("an add over the limit is refused and shows the entries", async () => {
		const a = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(a, `!memory ${JSON.stringify({ target: "memory", operations: [{ action: "add", content: "x".repeat(3000) }] })}`);
		expect(await toolText(a, "memory")).toContain("Not saved");
		expect(existsSync(join(memDir(), "MEMORY.md"))).toBe(false);
	});

	test("session_search finds words from other sessions, Korean included", async () => {
		const a = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(a, "텔레그램 게이트웨이 설정 메모");
		const b = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(b, `!session_search ${JSON.stringify({ query: "게이트웨이" })}`);
		const found = await toolText(b, "session_search");
		expect(found).toContain(a);
		await say(b, `!session_search ${JSON.stringify({ session_id: a })}`);
		expect(await toolText(b, "session_search")).toContain("텔레그램 게이트웨이");
	});

	test("skill_manage creates a skill the server lists", async () => {
		const a = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(a, `!skill_manage ${JSON.stringify({ action: "create", name: "release-flow", description: "How this user releases a package", body: "1. bump\n2. tag" })}`);
		expect(await toolText(a, "skill_manage")).toContain("Created skill");
		const skills = (await api("GET", `/skills?cwd=${encodeURIComponent(ws)}`)).json.skills.map((s: any) => s.name);
		expect(skills).toContain("release-flow");
	});

	test("/hermes on marks the session as the orchestrator and adds the orchestrator prompt", async () => {
		const a = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(a, "/hermes on");
		expect(lastSystem()).toContain("You are Hermes");
		const other = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(other, "plain");
		expect(lastSystem()).not.toContain("You are Hermes");
		const opened = await api("POST", "/server-extensions/hermes/methods/open", {});
		expect(opened.json.result?.id ?? opened.json.id).toBe(a);
	});

	test("/hermes learn with a model that does not answer JSON changes nothing and records why", async () => {
		const a = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(a, "I always want short answers");
		const before = readFileSync(join(memDir(), "USER.md"), "utf8");
		await say(a, "/hermes learn");
		for (let i = 0; i < 100; i++) {
			const items = JSON.stringify((await ext()).panel);
			if (items.includes("did not answer with JSON")) break;
			await Bun.sleep(30);
		}
		expect(JSON.stringify((await ext()).panel)).toContain("did not answer with JSON");
		expect(readFileSync(join(memDir(), "USER.md"), "utf8")).toBe(before);
	});

	test("the page's memory form replaces the stores", async () => {
		const r = await api("POST", "/server-extensions/hermes/panel/event", { event: { type: "submit", id: "memory-form", values: { "user-md": "Name: Dohwi\n§\nKorean", "memory-md": "Ubuntu 24.04" } } });
		expect(r.status).toBeLessThan(300);
		expect(readFileSync(join(memDir(), "USER.md"), "utf8")).toBe("Name: Dohwi\n§\nKorean\n");
		expect(readFileSync(join(memDir(), "MEMORY.md"), "utf8")).toBe("Ubuntu 24.04\n");
	});
});
