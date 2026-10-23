import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;
const DAY = 24 * 3600_000;

run("session-retention (needs PIPAYA_APP=<pipaya>/server)", () => {
	let app: any, dir = "", home = "", ws = "", upstream: any, db: any;
	const api = async (method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: "Bearer t", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const idle = async (id: string) => { for (let i = 0; i < 300; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(20); } throw new Error("never idle"); };
	const call = async (method: string, body: unknown = {}) => (await api("POST", `/server-extensions/session-retention/methods/${method}`, body)).json?.result;
	const make = async () => (await api("POST", "/sessions", { cwd: ws, approval: "auto" })).json.id as string;
	const exists = async (id: string) => (await api("GET", `/sessions/${id}`)).status === 200;

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import(join(SERVER!, "test/support/openai-upstream.ts"));
		const { Database } = await import("bun:sqlite");
		dir = mkdtempSync(join(tmpdir(), "session-retention-"));
		home = join(dir, "home"); ws = join(dir, "ws");
		mkdirSync(join(home, ".agents", "templates"), { recursive: true }); mkdirSync(ws, { recursive: true });
		writeFileSync(join(home, ".agents", "templates", "review.md"), "---\ndescription: Review a change\n---\nReview this: $ARGUMENTS");
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "session-retention"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "t", workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 0, logLevel: "silent" }, { strictResponses: true, home, extensionDirs: [join(dir, "ext"), join(SERVER!, "test/support/ext")] });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
		db = new Database(join(dir, "db.sqlite"), { strict: true });
	});
	afterAll(async () => { db?.close(); await app?.close(); upstream?.stop(); rmSync(dir, { recursive: true, force: true }); });

	test("loads without an error", async () => {
		const e = (await api("GET", "/server-extensions")).json.extensions.find((x: any) => x.name === "session-retention");
		expect(e && !e.error).toBe(true);
	});

	const aged = async (days: number) => {
		const id = await make();
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() - days * DAY });
		return id;
	};

	test("off until a policy is set; then it deletes old sessions and keeps the rest", async () => {
		const old = await aged(45), edge = await aged(29), fresh = await aged(0);
		expect((await call("run")).deleted).toBe(0);
		const set = await call("setPolicy", { enabled: true, days: 30, onlyClosed: false });
		expect(set.policy).toEqual({ enabled: true, days: 30, onlyClosed: false });
		expect(set.due).toBeGreaterThanOrEqual(1);
		expect((await call("run")).deleted).toBeGreaterThanOrEqual(1);
		expect(await exists(old)).toBe(false);
		expect(await exists(edge)).toBe(true);
		expect(await exists(fresh)).toBe(true);
		expect((await call("info")).lastRun).toBeGreaterThan(0);
	});

	test("a policy outside 1..3650 days is refused", async () => {
		expect((await api("POST", "/server-extensions/session-retention/methods/setPolicy", { enabled: true, days: 0 })).status).toBe(400);
	});

	test("with only-closed, an old active session is kept", async () => {
		await call("setPolicy", { enabled: true, days: 30, onlyClosed: true });
		const active = await aged(90), closed = await aged(90);
		await api("PATCH", `/sessions/${closed}`, { closed: true });
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id: closed, t: Date.now() - 90 * DAY });
		await call("run");
		expect(await exists(active)).toBe(true);
		expect(await exists(closed)).toBe(false);
	});

	test("a session that is waiting for the user is never deleted, however old", async () => {
		await call("setPolicy", { enabled: true, days: 1, onlyClosed: false });
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: `!ask_user ${JSON.stringify({ question: "Still here?" })}` });
		for (let i = 0; i < 100 && !(await api("GET", `/questions?sessionId=${id}`)).json.questions.length; i++) await Bun.sleep(20);
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() - 400 * DAY });
		await call("run");
		expect(await exists(id)).toBe(true);
		await api("POST", `/sessions/${id}/abort`);
	});
});
