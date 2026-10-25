import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs against a pipaya checkout: PIPAYA_APP=/path/to/pipaya/app/server bun test
const SERVER = process.env.PIPAYA_APP;
const run = SERVER ? describe : describe.skip;

run("peer-tools (needs PIPAYA_APP=<pipaya>/server)", () => {
	let app: any, base = "", dir = "", upstream: any;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const pane = (sessionId: string) => ({ type: "pane", sessionId });
	const split = (a: unknown, b: unknown, dir: "row" | "col" = "row", ratio = 0.5) => ({ type: "split", dir, ratio, a, b });
	const overview = async () => { const r = await api("POST", "/server-extensions/peer-tools/methods/overview", {}); return r.json.result ?? r.json; };
	const mk = async () => (await api("POST", "/sessions", {})).json?.id as string | undefined;

	beforeAll(async () => {
		const { buildApp } = await import(join(SERVER!, "src/app.ts"));
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import(join(SERVER!, "test/support/openai-upstream.ts"));
		dir = mkdtempSync(join(tmpdir(), "peer-tools-"));
		mkdirSync(join(dir, "ext"), { recursive: true });
		cpSync(join(import.meta.dir, ".."), join(dir, "ext", "peer-tools"), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/tests") });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: join(dir, "ws"), logLevel: "silent" }, { strictResponses: true, extensionDirs: [join(dir, "ext")] });
		await app.server.listen({ host: "0.0.0.0", port: 0 });
		base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});
	afterAll(async () => {
		await app?.close();
		upstream?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("carries its client half (peer-names), served by the server", async () => {
		const info = (await api("GET", "/server-extensions")).json.extensions.find((e: any) => e.name === "peer-tools");
		expect(info.companion).toBe("peer-names");
		const r = await api("GET", "/server-extensions/peer-tools/client");
		// servers from before `pipaya.client` answer 404; on a current one the package comes back as built
		if (info.clientPackage !== undefined) expect(r.json.package.manifest.id).toBe("peer-names");
	});

	test("the tools are listed as switchable", async () => {
		const toggleable = (await api("GET", "/configuration")).json.tools.toggleable as string[];
		expect(toggleable).toContain("peer_send");
		expect(toggleable).toContain("peer_read");
	});

		test("peer_send reaches any other session (no group needed) and peer_read shows its answer", async () => {
			const [a, b] = [(await mk())!, (await mk())!];
			const nameOf = async (id: string) => (await overview()).sessions.find((s: any) => s.id === id).name as string;
			const bName = await nameOf(b);
			const idle = async (id: string) => {
				for (let i = 0; i < 200; i++) {
					if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
					await Bun.sleep(25);
				}
			};
			upstream.requests.length = 0;
			await api("POST", `/sessions/${a}/messages`, { text: `!peer_send ${JSON.stringify({ to: bName, message: "hello peer" })}` });
			await idle(a);
			await Bun.sleep(100);
			await idle(b);
			const got = (await api("GET", `/sessions/${b}/messages`)).json;
			expect(JSON.stringify(got)).toContain("hello peer");
			expect(JSON.stringify(got)).toContain(`from @${await nameOf(a)}`);
			await api("POST", `/sessions/${a}/messages`, { text: `!peer_read ${JSON.stringify({ from: bName })}` });
			await idle(a);
			expect(JSON.stringify((await api("GET", `/sessions/${a}/messages`)).json)).toContain("hello peer");
			// an unknown name is a tool error, not a crash
			await api("POST", `/sessions/${a}/messages`, { text: `!peer_send ${JSON.stringify({ to: "nobody", message: "x" })}` });
			await idle(a);
			expect(JSON.stringify((await api("GET", `/sessions/${a}/messages`)).json)).toContain("session @nobody");
		});

		test("@name and @group in a message add an index hint, not a transcript", async () => {
			const [a, b, c] = [(await mk())!, (await mk())!, (await mk())!];
			const nameOf = async (id: string) => (await overview()).sessions.find((s: any) => s.id === id).name as string;
			await api("POST", "/groups", { name: "Hint Crew", layout: split(pane(b), pane(c)) });
			const idle = async (id: string) => { for (let i = 0; i < 200; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(25); } };
			await api("POST", `/sessions/${a}/messages`, { text: `hi @${await nameOf(b)} and @Hint-Crew` });
			await idle(a);
			const body = JSON.stringify((await api("GET", `/sessions/${a}/messages`)).json);
			expect(body).toContain("The user mentioned other sessions");
			expect(body).toContain("Group @Hint-Crew");
		});

		test("overview lists the addressable sessions and groups for the client extension", async () => {
			const [a, b] = [(await mk())!, (await mk())!];
			await api("POST", "/groups", { name: "Over View", layout: split(pane(a), pane(b)) });
			const o = await overview();
			expect(o.sessions.some((s: any) => s.id === a && s.name)).toBe(true);
			expect(o.groups.find((g: any) => g.name === "Over View")?.handle).toBe("Over-View");
		});

		test("every active session has its own name, a closed one gives it up, and names follow the UI language", async () => {
			const [a, b, c] = [(await mk())!, (await mk())!, (await mk())!];
			const names = async () => Object.fromEntries((await overview()).sessions.map((s: any) => [s.id, s.name]));
			const before = await names();
			expect(new Set([before[a], before[b], before[c]]).size).toBe(3);
			await api("PATCH", `/sessions/${c}`, { closed: true });
			const d = (await mk())!;
			expect((await names())[d]).toBe(before[c]);
			await api("PATCH", `/sessions/${c}`, { closed: false });
			const after = (await names())[c];
			expect(after).toBeTruthy();
			expect([before[a], before[b], (await names())[d]]).not.toContain(after);
			// the UI language switched: names become their romanized twins and back
			const call = async (lang: string) => (await api("POST", "/server-extensions/peer-tools/methods/localize", { lang })).json.result;
			expect((await call("en")).renamed).toBeGreaterThan(0);
			const en = await names();
			expect(en[a]).toMatch(/^[A-Za-z]+\d*$/);
			expect(new Set(Object.values(en)).size).toBe(Object.values(en).length);
			await call("ko");
			expect((await names())[a]).toBe(before[a]);
			// a session made while the language is English gets an English name
			await call("en");
			const e = (await mk())!;
			expect((await names())[e]).toMatch(/^[A-Za-z]+\d*$/);
			await call("ko");
		});

		test("peer_send to a group name reaches every other session in that group", async () => {
			const [a, b, c] = [(await mk())!, (await mk())!, (await mk())!];
			const idle = async (id: string) => {
				for (let i = 0; i < 200; i++) {
					if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
					await Bun.sleep(25);
				}
			};
			const g = (await api("POST", "/groups", { name: "Fan Out", layout: split(pane(a), split(pane(b), pane(c))) })).json;
			await api("POST", `/sessions/${a}/messages`, { text: `!peer_send ${JSON.stringify({ to: "Fan-Out", message: "to everyone" })}` });
			await idle(a);
			await Bun.sleep(100);
			await Promise.all([idle(b), idle(c)]);
			for (const id of [b, c]) expect(JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json)).toContain("to everyone");
			// the sender is not among the targets
			expect(JSON.stringify((await api("GET", `/sessions/${a}/messages`)).json)).not.toContain("from @");
			await api("DELETE", `/groups/${g.id}`);
		});
});
