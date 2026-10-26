import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastUser, parseModels, parseResponse, picturePath, previousPicturePath, replyText, requestBody } from "../lib.ts";

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const user = (text: string, extra: any[] = []) => ({ role: "user", content: [{ type: "text", text }, ...extra] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("lib", () => {
	test("reads the newest user message without app blocks", () => {
		const r = lastUser([user("old"), assistant("x"), user("a red cat", [{ type: "text", text: "<pipaya-files>…" }, { type: "image", data: PNG, mimeType: "image/png" }])]);
		expect(r).toEqual({ text: "a red cat", images: [{ data: PNG, mimeType: "image/png" }] });
	});
	test("finds the last picture a reply linked", () => {
		expect(previousPicturePath([assistant("![a](.pipaya/generated/a.png)"), user("x"), assistant("![b](.pipaya/generated/b.png)")])).toBe(".pipaya/generated/b.png");
		expect(previousPicturePath([assistant("![a](../etc/passwd)")])).toBeUndefined();
	});
	test("builds the request and parses the answer", () => {
		const body = requestBody("m", "cat", [{ data: PNG, mimeType: "image/png" }], true);
		expect(body.modalities).toEqual(["image", "text"]);
		expect(body.messages[0]!.content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
		const out = parseResponse({ choices: [{ message: { content: " here ", images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }, { image_url: "https://x" }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
		expect(out).toEqual({ text: "here", pictures: [{ mimeType: "image/png", data: PNG }], usage: { input: 3, output: 4 } });
	});
	test("names files and writes the reply", () => {
		expect(picturePath("image/jpeg", 36, "abc")).toBe(".pipaya/generated/10-abc.jpg");
		expect(replyText("a [red]\ncat", "ok", ["p.png"])).toBe("ok\n\n![a  red  cat](p.png)");
		expect(parseModels("a/b, c\nbad model, a/b")).toEqual(["a/b", "c", "bad", "model"]);
	});
});

// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;

run("image-generation in a server (needs PIPAYA_APP=<pipaya>/server)", () => {
	let app: any, dir = "", ws = "", upstream: any;
	const seen: any[] = [];
	const api = async (method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: "Bearer t", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const idle = async (id: string) => { for (let i = 0; i < 300; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(20); } throw new Error("never idle"); };

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		dir = mkdtempSync(join(tmpdir(), "image-generation-"));
		ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "image-generation"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = Bun.serve({
			port: 0,
			fetch: async (req) => {
				seen.push({ auth: req.headers.get("authorization"), body: await req.json() });
				return Response.json({ id: "r1", choices: [{ message: { content: "Here", images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
			},
		});
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "t", workspaceRoot: ws, logLevel: "silent" }, { strictResponses: true, home: join(dir, "home"), extensionDirs: [join(dir, "ext")] });
		expect((await api("PUT", "/extensions/image-generation/settings", { settings: { apiKey: "sk-test", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, models: "img/one" } })).status).toBe(200);
	});
	afterAll(async () => { await app?.close(); upstream?.stop(); rmSync(dir, { recursive: true, force: true }); });

	test("lists its model and answers a chat with a saved picture, then edits it", async () => {
		const ext = (await api("GET", "/server-extensions")).json.extensions.find((x: any) => x.name === "image-generation");
		expect(ext && !ext.error).toBe(true);
		const models = (await api("GET", "/models")).json.models.filter((m: any) => m.provider === "image-generation");
		expect(models.map((m: any) => [m.id, m.configured])).toEqual([["img/one", true]]);

		const id = (await api("POST", "/sessions", { cwd: ws, provider: "image-generation", model: "img/one" })).json.id;
		expect((await api("POST", `/sessions/${id}/messages`, { text: "a red cat" })).status).toBeLessThan(300);
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		const reply = msgs.at(-1).message;
		expect(reply.stopReason).toBe("stop");
		const path = /\]\((\.pipaya\/generated\/[^)]+\.png)\)/.exec(reply.content[0].text)?.[1];
		expect(path && existsSync(join(ws, path))).toBe(true);
		expect(readFileSync(join(ws, path!)).toString("base64")).toBe(PNG);
		expect(seen[0].auth).toBe("Bearer sk-test");
		expect(seen[0].body.model).toBe("img/one");

		await api("POST", `/sessions/${id}/messages`, { text: "make it blue" });
		await idle(id);
		expect(seen[1].body.messages[0].content.map((c: any) => c.type)).toEqual(["text", "image_url"]);
	});
});
