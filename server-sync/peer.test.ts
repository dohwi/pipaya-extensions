// A follower connecting to a primary by address alone, over real HTTP: the `connection` hand-out and `connect`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { pairingLink } from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "server-sync-peer-"));
const primaryDb = join(dir, "primary.db");
const followerDb = join(dir, "follower.db");
const followerDir = join(dir, "follower");

const seed = (file: string, rows: Record<string, unknown>) => {
	const db = new Database(file);
	db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
	db.exec("DELETE FROM settings");
	for (const [k, v] of Object.entries(rows)) db.query("INSERT INTO settings (key, data) VALUES (?, ?)").run(k, JSON.stringify(v));
	db.close();
};

interface Harness {
	methods: Map<string, (params?: unknown) => unknown>;
	settings: Record<string, unknown>;
}

const boot = (file: string, dataDir: string, token: string, settings: Record<string, unknown>): Harness => {
	const methods = new Map<string, (params?: unknown) => unknown>();
	const pi = {
		settings: {
			get: () => settings,
			set: (next: Record<string, unknown>) => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, next); return settings; },
			onChange: () => () => {},
		},
		log: () => {},
		registerMethod: (name: string, fn: (params?: unknown) => unknown) => void methods.set(name, fn),
		emit: () => {},
		on: () => {},
	};
	// The extension reads the db path and token from the environment, which is per process: set it around the call.
	process.env.PIPAYA_DB = file;
	process.env.PIPAYA_DATA_DIR = dataDir;
	process.env.PIPAYA_TOKEN = token;
	factory(pi);
	return { methods, settings };
};

/** A tiny stand-in for a pipaya server: only the two methods this extension calls. */
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
	seed(primaryDb, { default_model: { provider: "p", model: "m" }, skills: { global: { guard: true } }, device_id: "no" });
	// The primary's own extension instance answers over HTTP.
	process.env.PIPAYA_DB = primaryDb;
	process.env.PIPAYA_DATA_DIR = dir;
	process.env.PIPAYA_TOKEN = "primary-admin-token";
	const primary = boot(primaryDb, dir, "primary-admin-token", { role: "primary" });
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			// The app's own pairing routes: a code in, a device token out.
			if (url.pathname === "/pairing" && req.method === "POST") return Response.json({ code: "the-code", expiresAt: Date.now() + 120_000 });
			if (url.pathname === "/pairing/redeem" && req.method === "POST") {
				const body = (await req.json()) as { code?: string };
				if (body.code !== "the-code") return new Response("bad code", { status: 403 });
				return Response.json({ token: "device-token-from-pairing" });
			}
			// The follower's own server, saving an extension's settings: write where the follower keeps them.
			const ext = url.pathname.match(/^\/extensions\/([a-z0-9-]+)\/settings$/)?.[1];
			if (ext && req.method === "PUT") {
				const body = (await req.json()) as { settings: unknown };
				mkdirSync(join(followerDir, "extensions", ext), { recursive: true });
				writeFileSync(join(followerDir, "extensions", ext, "settings.json"), JSON.stringify(body.settings));
				return Response.json({ value: body.settings, updatedAt: Date.now(), applied: true });
			}
			const name = url.pathname.match(/^\/server-extensions\/server-sync\/methods\/(\w+)$/)?.[1];
			const fn = name ? primary.methods.get(name) : undefined;
			if (!fn) return new Response("no such method", { status: 404 });
			// Two servers in one process: point the extension at the primary's db for the duration of the call, the way a
			// separate process would have it all along.
			const saved = { db: process.env.PIPAYA_DB, dir: process.env.PIPAYA_DATA_DIR, token: process.env.PIPAYA_TOKEN };
			process.env.PIPAYA_DB = primaryDb;
			process.env.PIPAYA_DATA_DIR = dir;
			process.env.PIPAYA_TOKEN = "primary-admin-token";
			try {
				// The body is the method's params, as the real server passes it.
				const body = await req.text();
				const params = body ? JSON.parse(body) : null;
				return Response.json({ result: (await fn(params)) ?? null });
			} catch (e) {
				return Response.json({ error: String(e) }, { status: 400 });
			} finally {
				process.env.PIPAYA_DB = saved.db;
				process.env.PIPAYA_DATA_DIR = saved.dir;
				process.env.PIPAYA_TOKEN = saved.token;
			}
		},
	});
});

afterAll(() => {
	server?.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

describe("connecting by address alone", () => {
	test("a follower takes the peer's token and pulls its settings", async () => {
		seed(followerDb, {});
		// The primary's code packs its address and token; the follower unpacks it without calling the peer.
		// The primary's own address is not where this test's stand-in listens, so the code is built for the loopback port.
		const made = { result: { code: Buffer.from(JSON.stringify({ u: `http://127.0.0.1:${server!.port}`, t: "primary-admin-token" }), "utf8").toString("base64url") } };
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		const result = (await follower.methods.get("connect")!({ url: `http://127.0.0.1:${server!.port}`, code: "the-code" })) as {
			applied: string[];
			role: string;
			url: string;
			lastError: string | null;
		};
		expect(result.role).toBe("follower");
		expect(result.url).toBe(`http://127.0.0.1:${server!.port}`);
		expect(result.lastError).toBeNull();
		expect(result.applied.sort()).toEqual(["default_model", "skills"]);
		// The token came from redeeming the code: a device token, not the primary's admin token.
		expect(follower.settings.remoteToken).toBe("device-token-from-pairing");

		// The extension keeps its own handle on the file; read through it rather than a second connection.
		const snap = follower.methods.get("snapshot")!() as { settings: Record<string, unknown> };
		expect(Object.keys(snap.settings).sort()).toEqual(["default_model", "skills"]);
	});

	test("a token passed in explicitly is used instead of asking", async () => {
		seed(followerDb, {});
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		const result = (await follower.methods.get("connect")!({ url: `http://127.0.0.1:${server!.port}`, token: "typed-by-hand" })) as { lastError: string | null };
		expect(follower.settings.remoteToken).toBe("typed-by-hand");
		// The peer does not check tokens, so the pull still succeeds; what matters is that the typed one was kept.
		expect(result.lastError).toBeNull();
	});

	test("an address that is not http(s) is refused before any call", async () => {
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		await expect(Promise.resolve(follower.methods.get("connect")!({ url: "file:///etc/passwd" }))).rejects.toThrow(/http/);
		await expect(Promise.resolve(follower.methods.get("connect")!({}))).rejects.toThrow(/address is required/);
	});

	test("a wrong code is reported as wrong or expired", async () => {
		seed(followerDb, {});
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		await expect(Promise.resolve(follower.methods.get("connect")!({ url: `http://127.0.0.1:${server!.port}`, code: "wrong" }))).rejects.toThrow(/wrong or has expired/);
		expect(follower.settings.role).toBe("primary");
	});

	test("the app's copied link alone fills the address and redeems the code", async () => {
		seed(followerDb, {});
		const settings: Record<string, unknown> = { role: "follower", shareCode: `pipaya://connect?u=${encodeURIComponent(`http://127.0.0.1:${server!.port}/`)}&c=the-code&n=ubuntu` };
		const follower = boot(followerDb, dir, "follower-admin-token", settings);
		for (let i = 0; i < 50 && !follower.settings.remoteToken; i++) await Bun.sleep(10);
		expect(follower.settings.remoteToken).toBe("device-token-from-pairing");
		expect(follower.settings.remoteUrl).toBe(`http://127.0.0.1:${server!.port}`);
		expect(follower.settings.shareCode).toBe("");
		expect(pairingLink("not a link")).toBeNull();
		expect(pairingLink("pipaya://connect?u=100.1.2.3:8787&c=x")).toEqual({ url: "http://100.1.2.3:8787", code: "x" });
	});

	test("a follower pulls only the groups it checked", async () => {
		seed(followerDb, { default_model: { provider: "mine", model: "mine" }, skills: { global: {} } });
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		follower.settings.syncModels = false;
		const result = (await follower.methods.get("connect")!({ url: `http://127.0.0.1:${server!.port}`, code: "the-code" })) as { applied: string[] };
		expect(result.applied).toEqual(["skills"]);
		const db = new Database(followerDb);
		const row = db.query("SELECT data FROM settings WHERE key = 'default_model'").get() as { data: string };
		db.close();
		expect(JSON.parse(row.data)).toEqual({ provider: "mine", model: "mine" });
	});

	test("extension settings come along only when checked, and credentials stay this server's own", async () => {
		const write = (root: string, id: string, value: unknown) => {
			mkdirSync(join(root, "extensions", id), { recursive: true });
			writeFileSync(join(root, "extensions", id, "settings.json"), JSON.stringify(value));
		};
		write(dir, "quota-monitor", { httpOrigin: "http://primary:1", language: "ko", apiToken: "primary-secret" });
		write(dir, "server-sync", { remoteToken: "never-sent" });
		write(followerDir, "quota-monitor", { httpOrigin: "http://mine:1", apiToken: "mine" });
		seed(followerDb, {});
		const follower = boot(followerDb, followerDir, "follower-admin-token", { role: "follower", remoteUrl: `http://127.0.0.1:${server!.port}`, remoteToken: "t" });
		process.env.PIPAYA_PORT = String(server!.port);
		const off = (await follower.methods.get("sync")!()) as { applied: string[] };
		expect(off.applied.some((k) => k.startsWith("ext:"))).toBe(false);

		follower.settings.syncExtensions = true;
		const on = (await follower.methods.get("sync")!()) as { applied: string[] };
		expect(on.applied).toContain("ext:quota-monitor");
		expect(on.applied).not.toContain("ext:server-sync");
		const saved = JSON.parse(readFileSync(join(followerDir, "extensions", "quota-monitor", "settings.json"), "utf8"));
		expect(saved).toEqual({ httpOrigin: "http://primary:1", language: "ko", apiToken: "mine" });
		// Nothing changed since: no second write.
		const again = (await follower.methods.get("sync")!()) as { applied: string[] };
		expect(again.applied).toEqual([]);
		delete process.env.PIPAYA_PORT;
	});

	test("an address alone is not enough", async () => {
		seed(followerDb, {});
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		await expect(Promise.resolve(follower.methods.get("connect")!({ url: `http://127.0.0.1:${server!.port}` }))).rejects.toThrow(/code are required/);
	});
});
