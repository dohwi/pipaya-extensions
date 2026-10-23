import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTemplates, expandTemplate, parseTemplateCall, limitTemplateText, templateMarker } from "../templates.ts";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-templates-")));
	const home = join(root, "home");
	const repo = join(root, "repo");
	const cwd = join(repo, "packages", "app");
	mkdirSync(join(home, ".agents", "templates"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(repo, ".git"));
	return { root, home, repo, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const put = (dir: string, file: string, text: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), text);
};

describe("template discovery", () => {
	test("global + project (cwd up to repo root); nearer wins; description from frontmatter or first line", () => {
		const f = fixture();
		try {
			put(join(f.home, ".agents", "templates"), "review.md", "---\ndescription: Global review\n---\nReview $ARGUMENTS");
			put(join(f.home, ".agents", "templates"), "plain.md", "# Plain title\nDo the thing.");
			put(join(f.repo, ".agents", "templates"), "review.md", "Project review");
			put(join(f.cwd, ".agents", "templates"), "deploy.md", "Deploy it");
			put(join(f.root, ".agents", "templates"), "outside.md", "above the repo");
			const r = discoverTemplates(f.cwd, { home: f.home });
			expect(r.templates.map((t) => [t.name, t.scope])).toEqual([["deploy", "project"], ["plain", "global"], ["review", "project"]]);
			expect(r.templates.find((t) => t.name === "plain")!.description).toBe("Plain title");
			expect(r.templates.find((t) => t.name === "review")!.description).toBe("Project review");
			expect(r.warnings.some((w) => w.message.includes('name "review" is already provided'))).toBe(true);
		} finally { f.cleanup(); }
	});

	test("skips invalid names and empty bodies with a warning", () => {
		const f = fixture();
		try {
			const dir = join(f.home, ".agents", "templates");
			put(dir, "Bad_Name.md", "x");
			put(dir, "empty.md", "---\ndescription: d\n---\n   \n");
			put(dir, "notes.txt", "ignored");
			const r = discoverTemplates(f.cwd, { home: f.home });
			expect(r.templates).toEqual([]);
			expect(r.warnings.length).toBe(2);
		} finally { f.cleanup(); }
	});
});

describe("template calls", () => {
	test("parses only a call at the start of the message", () => {
		expect(parseTemplateCall("/prompt:review src/a.ts\nplease")).toEqual({ name: "review", args: "src/a.ts\nplease" });
		expect(parseTemplateCall("  /prompt:review")).toEqual({ name: "review", args: "" });
		expect(parseTemplateCall("hello /prompt:review")).toBeNull();
		expect(parseTemplateCall("/prompt:Bad")).toBeNull();
	});

	test("expands $ARGUMENTS or appends the arguments", () => {
		expect(expandTemplate("Review $ARGUMENTS now", "a.ts")).toBe("Review a.ts now");
		expect(expandTemplate("Review things\n", "a.ts")).toBe("Review things\n\na.ts");
		expect(expandTemplate("Review things", "")).toBe("Review things");
	});

	test("marker records the template name and the typed call", () => {
		const m = templateMarker("review", "/prompt:review a.ts");
		expect(m.startsWith("<pipaya-template>")).toBe(true);
		expect(JSON.parse(m.slice("<pipaya-template>".length, m.indexOf("</pipaya-template>")))).toEqual({ name: "review", call: "/prompt:review a.ts" });
	});

	test("very long text is cut", () => {
		expect(limitTemplateText("short")).toBe("short");
		expect(limitTemplateText("x".repeat(70_000)).endsWith("\n[cut]")).toBe(true);
	});
});
