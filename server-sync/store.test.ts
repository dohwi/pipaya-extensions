import { describe, expect, test } from "bun:test";
import { applySnapshot, effectiveKeys, hashOf, MAX_KEYS, mirrorKeys, NEVER_SYNCED, readSettings, type DatabaseLike } from "./store.ts";

/** A tiny in-memory stand-in for the sqlite handle: just enough of query().get/all/run over a Map. */
const memDb = (rows: Record<string, unknown> = {}): DatabaseLike & { data: Map<string, string> } => {
	const data = new Map(Object.entries(rows).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
	const q = (sql: string) => ({
		get: (...p: unknown[]) => {
			if (sql.startsWith("SELECT data FROM settings")) return data.has(String(p[0])) ? { data: data.get(String(p[0])) } : undefined;
			return undefined;
		},
		all: (...p: unknown[]) => {
			if (sql.startsWith("SELECT key, data")) return [...data].map(([key, d]) => ({ key, data: d }));
			return [];
		},
		run: (...p: unknown[]) => {
			if (sql.startsWith("DELETE")) data.delete(String(p[0]));
			else data.set(String(p[0]), String(p[1]));
			return { changes: 1 };
		},
	});
	return { query: q, data };
};

describe("effectiveKeys", () => {
	test("built-ins only by default", () => {
		expect(effectiveKeys("")).toEqual([...effectiveKeys("")]);
		expect(effectiveKeys("")).toContain("default_model");
		expect(effectiveKeys("")).not.toContain("device_id");
	});
	test("extras are appended, never-synced keys are dropped", () => {
		expect(effectiveKeys("device_id, custom_thing")).toEqual([...effectiveKeys(""), "custom_thing"]);
		expect(effectiveKeys("device_id, custom_thing").filter((k) => NEVER_SYNCED.has(k))).toEqual([]);
	});
	test("duplicates collapse", () => {
		expect(effectiveKeys("default_model").filter((k) => k === "default_model").length).toBe(1);
	});
});

describe("mirrorKeys", () => {
	const fallback = ["default_model", "skills"];
	test("the primary's list wins, so both sides agree on what a missing row means", () => {
		expect(mirrorKeys(["skills", "mcp_servers"], fallback)).toEqual(["skills", "mcp_servers"]);
	});
	test("the follower's own list is the fallback for an old or damaged primary", () => {
		expect(mirrorKeys(undefined, fallback)).toEqual(fallback);
		expect(mirrorKeys("skills", fallback)).toEqual(fallback);
		expect(mirrorKeys([42, "skills", ""], fallback)).toEqual(["skills"]);
	});
	test("never-synced keys are dropped and duplicates collapse", () => {
		expect(mirrorKeys(["device_id", "skills", "skills", "voice_input"], fallback)).toEqual(["skills"]);
	});
	test("the list is capped", () => {
		const many = Array.from({ length: MAX_KEYS + 20 }, (_, i) => `key${i}`);
		expect(mirrorKeys(many, fallback).length).toBe(MAX_KEYS);
	});
});

describe("readSettings", () => {
	test("parses present rows and skips damaged ones", () => {
		const db = memDb({ default_model: { provider: "a", model: "b" }, broken: "{not json" });
		const out = readSettings(db, ["default_model", "broken", "missing"]);
		expect(out).toEqual({ default_model: { provider: "a", model: "b" } });
	});
});

describe("applySnapshot", () => {
	test("writes missing and differing rows, keeps equal ones", () => {
		const db = memDb({ default_model: { provider: "old" } });
		const changed = applySnapshot(db, ["default_model", "skills"], { default_model: { provider: "new" }, skills: { global: {} } });
		expect(changed.sort()).toEqual(["default_model", "skills"]);
		expect(readSettings(db, ["default_model", "skills"])).toEqual({ default_model: { provider: "new" }, skills: { global: {} } });
	});
	test("deletes rows the peer lacks", () => {
		const db = memDb({ skills: { global: {} } });
		const changed = applySnapshot(db, ["skills", "mcp_servers"], {});
		expect(changed).toEqual(["skills"]);
		expect(readSettings(db, ["skills"])).toEqual({});
	});
	test("a no-op peer returns an empty change list", () => {
		const db = memDb({ skills: '{"global":{}}' });
		expect(applySnapshot(db, ["skills"], { skills: { global: {} } })).toEqual([]);
	});
});

describe("hashOf", () => {
	test("key order does not matter", () => {
		expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
		expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
	});
});
