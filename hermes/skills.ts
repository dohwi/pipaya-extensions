// Skills the agent writes for itself, in the folder the pipaya server already reads (`~/.agents/skills`). A skill
// Hermes made carries `created-by: hermes` in its frontmatter; the others (hand-written, installed) are read-only
// unless the user allows editing them.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_BODY = 20_000;
export const MAX_FILE = 40_000;
export const OWNER_KEY = "created-by";
export const OWNER = "hermes";
const SUPPORT_DIRS = ["references", "templates", "scripts"];
const FRONT = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export class SkillError extends Error {}

export interface SkillInfo {
	name: string;
	description: string;
	ownedByHermes: boolean;
	dir: string;
}

export function parseSkill(text: string): { meta: Record<string, unknown>; body: string } | null {
	const m = FRONT.exec(text);
	if (!m) return null;
	try {
		const meta = Bun.YAML.parse(m[1]!);
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
		return { meta: meta as Record<string, unknown>, body: text.slice(m[0].length).trim() };
	} catch {
		return null;
	}
}

const render = (meta: Record<string, unknown>, body: string) => `---\n${Bun.YAML.stringify(meta, null, 2).trim()}\n---\n${body.trim()}\n`;

function writeAtomic(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

function cleanDescription(description: unknown): string {
	const d = typeof description === "string" ? description.trim().replace(/\s+/g, " ") : "";
	if (!d) throw new SkillError("a skill needs a description: the model decides from it when to use the skill");
	if (d.length > MAX_DESCRIPTION) throw new SkillError(`description is longer than ${MAX_DESCRIPTION} characters`);
	return d;
}

function cleanBody(body: unknown): string {
	const b = typeof body === "string" ? body.trim() : "";
	if (!b) throw new SkillError("body is empty");
	if (b.length > MAX_BODY) throw new SkillError(`body is longer than ${MAX_BODY} characters; move depth into references/ files`);
	return b;
}

export class SkillLibrary {
	constructor(private root: () => string, private editOthers: () => boolean = () => false) {}

	dir(name: string): string {
		if (typeof name !== "string" || name.length > MAX_NAME || !SKILL_NAME.test(name)) throw new SkillError(`invalid skill name "${String(name).slice(0, 80)}": lowercase letters, digits and single hyphens, at most ${MAX_NAME}`);
		return join(this.root(), name);
	}

	list(): SkillInfo[] {
		const root = this.root();
		if (!existsSync(root)) return [];
		const out: SkillInfo[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
			const file = join(root, entry.name, "SKILL.md");
			if (!existsSync(file)) continue;
			const parsed = parseSkill(readFileSync(file, "utf8"));
			if (!parsed) continue;
			const name = typeof parsed.meta.name === "string" && parsed.meta.name.trim() ? parsed.meta.name.trim() : entry.name;
			out.push({ name, description: String(parsed.meta.description ?? ""), ownedByHermes: parsed.meta[OWNER_KEY] === OWNER, dir: join(root, entry.name) });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	private find(name: string): SkillInfo {
		const skill = this.list().find((s) => s.name === name);
		if (!skill) throw new SkillError(`no skill "${name}" in ${this.root()}`);
		return skill;
	}

	private editable(name: string): SkillInfo {
		const skill = this.find(name);
		if (!skill.ownedByHermes && !this.editOthers()) throw new SkillError(`"${name}" was not made by Hermes and editing other skills is off; suggest the change to the user instead`);
		if (lstatSync(skill.dir).isSymbolicLink()) throw new SkillError(`"${name}" is a linked folder; edit its source instead`);
		return skill;
	}

	/** A support file path inside the skill: `references/x.md`, `templates/...` or `scripts/...`, nothing else. */
	private supportPath(skillDir: string, filePath: string): string {
		const rel = normalize(String(filePath ?? "")).replace(/^[/\\]+/, "");
		const first = rel.split(/[\\/]/)[0] ?? "";
		if (!SUPPORT_DIRS.includes(first) || rel.split(/[\\/]/).includes("..") || rel === first) {
			throw new SkillError(`file_path must be under ${SUPPORT_DIRS.map((d) => `${d}/`).join(", ")}`);
		}
		const full = join(skillDir, rel);
		if (!full.startsWith(skillDir + sep)) throw new SkillError("file_path leaves the skill folder");
		return full;
	}

	view(name: string, filePath?: string): string {
		const skill = this.find(name);
		if (filePath) {
			const full = this.supportPath(skill.dir, filePath);
			if (!existsSync(full)) throw new SkillError(`${filePath} does not exist in "${name}"`);
			return readFileSync(full, "utf8");
		}
		const text = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
		const files: string[] = [];
		for (const d of SUPPORT_DIRS) {
			const at = join(skill.dir, d);
			if (existsSync(at)) for (const f of readdirSync(at, { recursive: true }) as string[]) files.push(`${d}/${f}`);
		}
		return files.length ? `${text}\n\n[support files: ${files.join(", ")}]` : text;
	}

	create(name: string, description: string, body: string): SkillInfo {
		const dir = this.dir(name);
		if (existsSync(dir)) throw new SkillError(`a skill folder "${name}" already exists; update it instead`);
		writeAtomic(join(dir, "SKILL.md"), render({ name, description: cleanDescription(description), [OWNER_KEY]: OWNER }, cleanBody(body)));
		return this.find(name);
	}

	/** Rewrites the description and/or the body; every other frontmatter key stays. */
	update(name: string, changes: { description?: string; body?: string }): SkillInfo {
		const skill = this.editable(name);
		const file = join(skill.dir, "SKILL.md");
		const parsed = parseSkill(readFileSync(file, "utf8"));
		if (!parsed) throw new SkillError(`"${name}" has no valid frontmatter`);
		if (changes.description === undefined && changes.body === undefined) throw new SkillError("nothing to change: give description and/or body");
		const meta = { ...parsed.meta };
		if (changes.description !== undefined) meta.description = cleanDescription(changes.description);
		writeAtomic(file, render(meta, changes.body !== undefined ? cleanBody(changes.body) : parsed.body));
		return this.find(name);
	}

	/** Replaces one exact, unique piece of text in SKILL.md (or a support file). */
	patch(name: string, oldText: string, newText: string, filePath?: string): void {
		const skill = this.editable(name);
		const file = filePath ? this.supportPath(skill.dir, filePath) : join(skill.dir, "SKILL.md");
		if (!existsSync(file)) throw new SkillError(`${filePath ?? "SKILL.md"} does not exist in "${name}"`);
		const text = readFileSync(file, "utf8");
		if (!oldText) throw new SkillError("old_text is required");
		const count = text.split(oldText).length - 1;
		if (count !== 1) throw new SkillError(count ? `old_text occurs ${count} times; quote more of it` : "old_text was not found; view the skill again");
		const next = text.replace(oldText, () => newText ?? "");
		if (!filePath && !parseSkill(next)) throw new SkillError("the patch would break the frontmatter");
		writeAtomic(file, next);
	}

	writeFile(name: string, filePath: string, content: string): void {
		const skill = this.editable(name);
		if (typeof content !== "string" || content.length > MAX_FILE) throw new SkillError(`content must be text of at most ${MAX_FILE} characters`);
		writeAtomic(this.supportPath(skill.dir, filePath), content);
	}
}
