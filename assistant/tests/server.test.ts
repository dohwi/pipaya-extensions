import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;

run("assistant (needs PIPAYA_APP=<pipaya>/server)", () => {
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
		expect((await api("POST", `/sessions/${id}/messages`, { text })).status).toBeLessThan(300);
		await idle(id);
	};
	const toolText = async (id: string, tool: string) => {
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		return JSON.stringify(msgs.filter((m: any) => m.role === "toolResult" && m.toolName === tool).at(-1)?.content ?? "");
	};
	const last = () => upstream.requests.at(-1)?.body;
	const systemOf = (body: any) => {
		const sys = body?.messages?.find((m: any) => m.role === "system" || m.role === "developer");
		return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
	};
	const toolNames = (body: any) => (body?.tools ?? []).map((t: any) => t.function?.name ?? t.name);
	const ext = async () => (await api("GET", "/server-extensions")).json.extensions.find((x: any) => x.name === "assistant");
	const open = async () => (await api("POST", "/server-extensions/assistant/methods/open", {})).json.result.id as string;

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import(join(SERVER!, "test/support/openai-upstream.ts"));
		dir = mkdtempSync(join(tmpdir(), "assistant-"));
		ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "assistant"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "t", workspaceRoot: ws, logLevel: "silent" }, { strictResponses: true, home: dir, extensionDirs: [join(dir, "ext")] });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
		await api("PUT", "/extensions/assistant/settings", { settings: { review: false } });
	});
	afterAll(async () => {
		await app?.close();
		upstream?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads with its tools, settings form and page", async () => {
		const e = await ext();
		expect(e.error).toBeUndefined();
		expect(e.tools).toEqual(expect.arrayContaining(["remember", "recall"]));
		expect(e.panel?.type).toBe("stack");
	});

	test("an ordinary session gets nothing extra: no guide, no memory, no tools", async () => {
		const s = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(s, "hello");
		expect(systemOf(last())).not.toContain("# How you work");
		expect(toolNames(last())).not.toContain("remember");
		expect(toolNames(last())).not.toContain("recall");
	});

	test("the assistant session has a short prompt, its own tools and no write/edit", async () => {
		const id = await open();
		expect(await open()).toBe(id); // opening again returns the same one
		await say(id, "hi");
		const body = last();
		expect(systemOf(body)).toContain("personal assistant");
		expect(systemOf(body)).toContain("# How you work");
		expect(systemOf(body)).not.toContain("capable coding assistant");
		expect(toolNames(body)).toEqual(expect.arrayContaining(["remember", "recall", "peer", "delegate"]));
		expect(toolNames(body)).not.toContain("write");
		expect(toolNames(body)).not.toContain("edit");
	});

	test("remember saves an entry that the next run already sees", async () => {
		const id = await open();
		await say(id, `!remember ${JSON.stringify({ changes: [{ op: "add", kind: "profile", text: "Replies in Korean, short" }] })}`);
		expect(await toolText(id, "remember")).toContain("Saved (p1)");
		await say(id, "next");
		expect(systemOf(last())).toContain("- [p1] Replies in Korean, short");
		const data = JSON.parse(readFileSync(join(dir, "extension-data", "assistant", "memory.json"), "utf8"));
		expect(data.entries[0].text).toBe("Replies in Korean, short");
	});

	test("an add over the budget is refused and nothing changes", async () => {
		const id = await open();
		await say(id, `!remember ${JSON.stringify({ changes: [{ op: "add", kind: "note", text: "x".repeat(450) }, { op: "add", kind: "note", text: "y".repeat(450) }, { op: "add", kind: "note", text: "z".repeat(450) }, { op: "add", kind: "note", text: "w".repeat(450) }, { op: "add", kind: "note", text: "v".repeat(450) }, { op: "add", kind: "note", text: "u".repeat(450) }] })}`);
		expect(await toolText(id, "remember")).toContain("Not saved");
	});

	test("recall finds other sessions' words, Korean included, and reads around a hit", async () => {
		const other = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await say(other, "텔레그램 게이트웨이 설정 메모");
		const id = await open();
		await say(id, `!recall ${JSON.stringify({ query: "게이트웨이" })}`);
		expect(await toolText(id, "recall")).toContain(other);
		await say(id, `!recall ${JSON.stringify({ session: other, around: 0 })}`);
		expect(await toolText(id, "recall")).toContain("텔레그램 게이트웨이");
	});

	test("its tools refuse to run in another session", async () => {
		const s = (await api("POST", "/sessions", { cwd: ws, tools: ["read", "remember"] })).json.id as string;
		await say(s, `!remember ${JSON.stringify({})}`);
		expect(await toolText(s, "remember")).toContain("belongs to the assistant session");
	});

	test("/assistant new closes the old assistant and opens a fresh one with the same memory", async () => {
		const old = await open();
		await say(old, "/assistant new");
		const next = await open();
		expect(next).not.toBe(old);
		expect((await api("GET", `/sessions/${old}`)).json.closed).toBe(true);
		await say(next, "hello again");
		expect(systemOf(last())).toContain("Replies in Korean, short");
	});

	test("a review with a model that does not answer JSON changes nothing and is listed", async () => {
		const id = await open();
		await say(id, "I always want short answers");
		const before = readFileSync(join(dir, "extension-data", "assistant", "memory.json"), "utf8");
		await say(id, "/assistant learn");
		for (let i = 0; i < 100 && !JSON.stringify((await ext()).panel).includes("No usable answer"); i++) await Bun.sleep(30);
		expect(JSON.stringify((await ext()).panel)).toContain("No usable answer");
		expect(readFileSync(join(dir, "extension-data", "assistant", "memory.json"), "utf8")).toBe(before);
	});

	test("the page's form replaces the memory", async () => {
		const r = await api("POST", "/server-extensions/assistant/panel/event", { event: { type: "submit", id: "memory-form", values: { "profile-text": "Replies in Korean, short\nName: Dohwi", "note-text": "Ubuntu 24.04" } } });
		expect(r.status).toBeLessThan(300);
		const data = JSON.parse(readFileSync(join(dir, "extension-data", "assistant", "memory.json"), "utf8"));
		expect(data.entries.map((e: any) => [e.id, e.text])).toEqual([["p1", "Replies in Korean, short"], ["p8", "Name: Dohwi"], ["n9", "Ubuntu 24.04"]].map(([id, t]) => [expect.stringMatching(id === "p1" ? /^p1$/ : /^[pn]\d+$/), t]));
	});
});
