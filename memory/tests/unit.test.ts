import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReply, isHumanTurn } from "../learn.ts";
import { parseJsonObject } from "../prompts.ts";
import { SearchIndex, terms } from "../search.ts";
import { MemoryError, MemoryStore } from "../store.ts";
import { plainText, transcriptOf } from "../text.ts";

const root = mkdtempSync(join(tmpdir(), "memory-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
	const d = join(root, String(n++));
	mkdirSync(d, { recursive: true });
	return d;
};
const store = (profile = 100, note = 100) => new MemoryStore(fresh(), () => ({ profile, note }), () => 1);

test("memory: entries get stable ids; edit and drop address them", () => {
	const m = store();
	expect(m.apply([{ op: "add", kind: "profile", text: "Korean replies" }, { op: "add", kind: "note", text: "Ubuntu 24.04" }])).toEqual(["p1", "n2"]);
	m.apply([{ op: "edit", id: "p1", text: "Korean replies,   short" }, { op: "drop", id: "n2" }]);
	expect(m.entries().map((e) => [e.id, e.text])).toEqual([["p1", "Korean replies, short"]]);
	expect(m.apply([{ op: "add", kind: "profile", text: "uses bun" }])).toEqual(["p3"]); // ids are never reused
	expect(() => m.apply([{ op: "drop", id: "n2" }])).toThrow(/no entry/);
});

test("memory: all or nothing, and the budget is checked on the result", () => {
	const m = store(40, 100);
	m.apply([{ op: "add", kind: "profile", text: "a".repeat(30) }]);
	expect(() => m.apply([{ op: "add", kind: "profile", text: "b".repeat(20) }])).toThrow(MemoryError);
	expect(() => m.apply([{ op: "add", kind: "note", text: "kept?" }, { op: "explode" } as any])).toThrow(MemoryError);
	expect(m.entries("note")).toEqual([]);
	m.apply([{ op: "drop", id: "p1" }, { op: "add", kind: "profile", text: "b".repeat(20) }]);
	expect(m.used("profile")).toBe(20);
	m.apply([{ op: "add", kind: "profile", text: "B".repeat(20) }]); // same text, other case: not added twice
	expect(m.entries("profile")).toHaveLength(1);
});

test("memory: the prompt block lists entries with their ids, and is empty when nothing is saved", () => {
	const m = store(500, 500);
	m.apply([{ op: "add", kind: "profile", text: "one" }, { op: "add", kind: "note", text: "two" }]);
	expect(m.block()).toBe("## About the user\n- [p1] one\n## Environment\n- [n2] two");
	expect(store().block()).toBe("");
});

test("learn: a reply is applied whole; a bad change or a non-JSON reply changes nothing", () => {
	const m = store(500, 500);
	const ok = applyReply('```json\n{"changes":[{"op":"add","kind":"profile","text":"Wants short answers"}],"summary":"saved"}\n```', m);
	expect(ok.changes).toEqual(["+ profile: Wants short answers"]);
	const bad = applyReply('{"changes":[{"op":"add","kind":"note","text":"x"},{"op":"drop","id":"zz"}]}', m);
	expect(bad.error).toContain("no entry");
	expect(m.entries("note")).toEqual([]);
	expect(applyReply("Nothing to keep.", m).error).toBeDefined();
	expect(applyReply('{"changes":[],"summary":"Nothing."}', m)).toEqual({ summary: "Nothing.", changes: [] });
	expect(parseJsonObject('noise {"a": "}"} tail')).toEqual({ a: "}" });
});

test("search: Korean of any length, phrases, and no tool output", () => {
	const index = new SearchIndex(join(fresh(), "s.sqlite"));
	const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
	index.addMany("s1", [
		{ seq: 0, createdAt: 1, message: user("텔레그램 봇 연결은 어떻게 했지?") },
		{ seq: 1, createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "We used the grammy library." }] } },
		{ seq: 2, createdAt: 3, message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "secret output" }] } },
	]);
	index.addMany("s2", [{ seq: 0, createdAt: 4, message: user("배포 스크립트 <pipaya-hint>hidden</pipaya-hint>") }]);
	expect(index.search("텔레그램").map((h) => h.sessionId)).toEqual(["s1"]);
	expect(index.search("봇").map((h) => h.sessionId)).toEqual(["s1"]);
	expect(index.search('"grammy library"')[0]!.seq).toBe(1);
	expect(index.search("secret")).toEqual([]);
	expect(index.search("hidden")).toEqual([]);
	expect(index.search("배포", { exclude: "s2" })).toEqual([]);
	expect(index.lastSeq("s1")).toBe(2);
	index.drop("s1");
	expect(index.count()).toEqual({ messages: 1, sessions: 1 });
	expect(terms('a "b c" d')).toEqual(["a", "b c", "d"]);
	index.close();
});

test("text: human turns and short transcripts", () => {
	const msg = (seq: number, t: string) => ({ seq, role: "user", createdAt: seq, message: { role: "user", content: [{ type: "text", text: t }] } });
	expect(isHumanTurn(msg(0, "hello"))).toBe(true);
	expect(isHumanTurn(msg(0, "[from @alpha, another session on this server; ...]\nhi"))).toBe(false);
	expect(isHumanTurn(msg(0, "[from the server: @x ended]"))).toBe(false);
	expect(plainText({ role: "user", content: "<pipaya-note>x</pipaya-note>" })).toBe("");
	const t = transcriptOf([msg(0, "a".repeat(100)), msg(1, "last")], 50);
	expect(t).toContain("last");
	expect(t).toContain("left out");
});
