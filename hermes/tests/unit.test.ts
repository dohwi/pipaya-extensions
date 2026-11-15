import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOperations, MemoryError, MemoryStore, parseEntries } from "../memory.ts";
import { parseJsonObject } from "../prompts.ts";
import { applyAnswer, isHumanTurn, userSamples } from "../review.ts";
import { SearchIndex, terms } from "../search.ts";
import { SkillError, SkillLibrary } from "../skills.ts";
import { plainText, transcriptOf } from "../text.ts";

const root = mkdtempSync(join(tmpdir(), "hermes-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
	const d = join(root, String(n++));
	mkdirSync(d, { recursive: true });
	return d;
};

test("memory: a batch can make room and add in one go; the limit is checked on the result", () => {
	const start = ["a".repeat(40), "b".repeat(40)];
	expect(() => applyOperations(start, [{ action: "add", content: "c".repeat(40) }], 100)).toThrow(MemoryError);
	const next = applyOperations(start, [{ action: "remove", old_text: "aaaa" }, { action: "add", content: "c".repeat(40) }], 100);
	expect(next).toEqual(["b".repeat(40), "c".repeat(40)]);
});

test("memory: patch and remove need text found in exactly one entry", () => {
	const start = ["likes tea", "likes coffee"];
	expect(() => applyOperations(start, [{ action: "remove", old_text: "likes" }], 1000)).toThrow(/2 entries/);
	expect(() => applyOperations(start, [{ action: "remove", old_text: "juice" }], 1000)).toThrow(/no entry/);
	expect(applyOperations(start, [{ action: "patch", old_text: "tea", content: "likes green tea" }], 1000)).toEqual(["likes green tea", "likes coffee"]);
	expect(applyOperations(start, [{ action: "add", content: "likes tea" }], 1000)).toEqual(start);
	expect(() => applyOperations(start, [{ action: "add", content: "x\n§\ny" }], 1000)).toThrow(/§/);
});

test("memory: the store round-trips multi-line entries and builds the prompt block", () => {
	const store = new MemoryStore(fresh(), () => ({ user: 500, memory: 500 }));
	expect(store.block()).toBe("");
	store.apply("user", [{ action: "add", content: "Replies in Korean\nand short" }, { action: "add", content: "Uses bun" }]);
	expect(store.read("user")).toEqual(["Replies in Korean\nand short", "Uses bun"]);
	expect(parseEntries(readFileSync(store.path("user"), "utf8"))).toEqual(store.read("user"));
	expect(store.block()).toContain("USER PROFILE");
	expect(store.block()).not.toContain("MEMORY (your");
	expect(() => store.replace("memory", "x".repeat(600))).toThrow(MemoryError);
});

test("search: finds Korean words of any length and English phrases, newest session excluded on request", () => {
	const index = new SearchIndex(join(fresh(), "s.sqlite"));
	const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
	index.addMany("s1", [
		{ seq: 0, createdAt: 1, message: user("텔레그램 봇 연결은 어떻게 했지?") },
		{ seq: 1, createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "We used the grammy library." }, { type: "toolCall", name: "bash", arguments: {} }] } },
		{ seq: 2, createdAt: 3, message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "secret output" }] } },
	]);
	index.addMany("s2", [{ seq: 0, createdAt: 4, message: user("배포 스크립트 고쳐줘 <pipaya-hint>hidden</pipaya-hint>") }]);
	expect(index.search("텔레그램").map((h) => h.sessionId)).toEqual(["s1"]);
	expect(index.search("봇").map((h) => h.sessionId)).toEqual(["s1"]); // one syllable: LIKE fallback
	expect(index.search("\"grammy library\"")[0]!.seq).toBe(1);
	expect(index.search("secret")).toEqual([]); // tool output is not indexed
	expect(index.search("배포", { exclude: "s2" })).toEqual([]);
	expect(index.lastSeq("s1")).toBe(2);
	index.drop("s1");
	expect(index.count()).toEqual({ messages: 1, sessions: 1 });
	expect(terms('a "b c" d')).toEqual(["a", "b c", "d"]);
	index.close();
});

test("skills: Hermes may only change its own skills unless allowed; support files stay inside the skill", () => {
	const dir = fresh();
	let allowOthers = false;
	const lib = new SkillLibrary(() => dir, () => allowOthers);
	mkdirSync(join(dir, "mine-by-hand"));
	writeFileSync(join(dir, "mine-by-hand", "SKILL.md"), "---\nname: mine-by-hand\ndescription: hand written\n---\nbody\n");
	lib.create("git-release", "How to release", "1. tag\n2. push");
	expect(lib.list().map((s) => [s.name, s.ownedByHermes])).toEqual([["git-release", true], ["mine-by-hand", false]]);
	expect(() => lib.create("git-release", "x", "y")).toThrow(SkillError);
	expect(() => lib.create("Bad Name", "x", "y")).toThrow(SkillError);
	lib.patch("git-release", "2. push", "2. push --tags");
	expect(lib.view("git-release")).toContain("push --tags");
	expect(() => lib.patch("git-release", "nope", "x")).toThrow(/not found/);
	expect(() => lib.patch("git-release", "---", "x")).toThrow(/2 times/);
	lib.writeFile("git-release", "references/ci.md", "notes");
	expect(lib.view("git-release", "references/ci.md")).toBe("notes");
	expect(lib.view("git-release")).toContain("references/ci.md");
	for (const bad of ["../x.md", "references/../../x.md", "SKILL.md", "other/x.md", "references"]) expect(() => lib.writeFile("git-release", bad, "x")).toThrow(SkillError);
	expect(() => lib.update("mine-by-hand", { body: "changed" })).toThrow(/not made by Hermes/);
	allowOthers = true;
	lib.update("mine-by-hand", { body: "changed" });
	expect(readFileSync(join(dir, "mine-by-hand", "SKILL.md"), "utf8")).toContain("description: hand written");
	const target = fresh();
	writeFileSync(join(target, "SKILL.md"), "---\nname: linked\ndescription: d\ncreated-by: hermes\n---\nb\n");
	symlinkSync(target, join(dir, "linked"));
	expect(() => lib.update("linked", { body: "x" })).toThrow(/linked folder/);
});

test("review: a model answer is applied op by op; one bad op is reported, the rest still lands", () => {
	const memory = new MemoryStore(fresh(), () => ({ user: 300, memory: 300 }));
	const skillDir = fresh();
	const lib = new SkillLibrary(() => skillDir);
	const answer = parseJsonObject('Sure:\n```json\n{"user":[{"action":"add","content":"Prefers Korean replies"}],"memory":[{"action":"remove","old_text":"nothing"}],"skills":[{"action":"create","name":"ko-reply","description":"d","body":"b"},{"action":"explode"}],"summary":"ok"}\n```')!;
	const { changes, errors } = applyAnswer(answer, memory, lib);
	expect(memory.read("user")).toEqual(["Prefers Korean replies"]);
	expect(changes).toHaveLength(2);
	expect(errors).toHaveLength(2);
	expect(parseJsonObject("no json here")).toBeNull();
});

test("text: only what people wrote counts as a human turn; transcripts keep the newest part", () => {
	const msg = (seq: number, t: string) => ({ seq, role: "user", createdAt: seq, message: { role: "user", content: [{ type: "text", text: t }] } });
	expect(isHumanTurn(msg(0, "hello"))).toBe(true);
	expect(isHumanTurn(msg(0, "[from @alpha, another session on this server; ...]\nhi"))).toBe(false);
	expect(isHumanTurn(msg(0, "[from the server: @x ended]"))).toBe(false);
	expect(plainText({ role: "user", content: "<pipaya-note>x</pipaya-note>" })).toBe("");
	const t = transcriptOf([msg(0, "a".repeat(100)), msg(1, "last")], 50);
	expect(t).toContain("last");
	expect(t).toContain("left out");
	expect(userSamples([{ title: "S", messages: [msg(0, "hi there")] }], 1000)).toContain("- hi there");
	expect(existsSync(root)).toBe(true);
});
