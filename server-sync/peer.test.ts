// A follower connecting to a primary by address alone, over real HTTP: the `connection` hand-out and `connect`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "server-sync-peer-"));
const primaryDb = join(dir, "primary.db");
const followerDb = join(dir, "follower.db");

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
		const result = (await follower.methods.get("connect")!({ code: made.result.code })) as {
			applied: string[];
			role: string;
			url: string;
			lastError: string | null;
		};
		expect(result.role).toBe("follower");
		expect(result.url).toBe(`http://127.0.0.1:${server!.port}`);
		expect(result.lastError).toBeNull();
		expect(result.applied.sort()).toEqual(["default_model", "skills"]);
		// The token came from the peer, not from the caller.
		expect(follower.settings.remoteToken).toBe("primary-admin-token");

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

	test("a malformed code is refused before anything is saved", async () => {
		seed(followerDb, {});
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		await expect(Promise.resolve(follower.methods.get("connect")!({ code: "not-a-code" }))).rejects.toThrow(/not a connection code/);
		expect(follower.settings.role).toBe("primary");
	});

	test("a code without an address or token is refused", async () => {
		seed(followerDb, {});
		const follower = boot(followerDb, dir, "follower-admin-token", { role: "primary" });
		const empty = Buffer.from(JSON.stringify({ u: "", t: "" }), "utf8").toString("base64url");
		await expect(Promise.resolve(follower.methods.get("connect")!({ code: empty }))).rejects.toThrow(/incomplete/);
		expect(follower.settings.role).toBe("primary");
	});
});
