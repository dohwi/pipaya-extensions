import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAX_SKILL_DESCRIPTION = 1024;
const MAX_SKILL_NAME = 64;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function findRepoRoot(start: string): string | null {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return null;
	}
}

/**
 * Prompt templates: a long prompt saved as `<name>.md` and called with `/prompt:name [arguments]`.
 * Global: `<home>/.agents/templates`. Project: `.agents/templates` from cwd up to the repository root.
 * Optional frontmatter: `description` (shown in menus; defaults to the first line of the body) and `name`.
 */
export interface Template {
	name: string;
	description: string;
	/** Absolute path of the .md file. */
	path: string;
	scope: "global" | "project";
}

export interface TemplateWarning {
	path: string;
	message: string;
}

export interface TemplateList {
	cwd: string;
	templates: Template[];
	warnings: TemplateWarning[];
}

export const TEMPLATE_CALL_PREFIX = "/prompt:";
export const MAX_TEMPLATES = 200;
const MAX_TEMPLATE_BYTES = 128 * 1024;
const MAX_INLINE_TEMPLATE_CHARS = 60_000;

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** Splits optional YAML frontmatter from the prompt body. Invalid YAML is treated as no frontmatter. */
export function splitTemplate(text: string): { meta: Record<string, unknown>; body: string } {
	const m = FRONTMATTER.exec(text);
	if (!m) return { meta: {}, body: text };
	try {
		const data = Bun.YAML.parse(m[1]!);
		if (data && typeof data === "object" && !Array.isArray(data)) return { meta: data as Record<string, unknown>, body: text.slice(m[0].length) };
	} catch { /* fall through */ }
	return { meta: {}, body: text };
}

function firstLine(body: string): string {
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/^[#>\-*\s]+/, "").trim();
		if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
	}
	return "";
}

function loadTemplate(file: string, scope: Template["scope"], warnings: TemplateWarning[]): Template | null {
	let text: string;
	try {
		if (statSync(file).size > MAX_TEMPLATE_BYTES) {
			warnings.push({ path: file, message: `Skipped: template is larger than ${MAX_TEMPLATE_BYTES / 1024} KB` });
			return null;
		}
		text = readFileSync(file, "utf8");
	} catch (e) {
		warnings.push({ path: file, message: `Unable to read template: ${e instanceof Error ? e.message : String(e)}` });
		return null;
	}
	const { meta, body } = splitTemplate(text);
	const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : basename(file).replace(/\.md$/i, "");
	if (name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name)) {
		warnings.push({ path: file, message: `Skipped: invalid template name "${name.slice(0, 80)}" (lowercase letters, digits and single hyphens, max ${MAX_SKILL_NAME})` });
		return null;
	}
	if (!body.trim()) {
		warnings.push({ path: file, message: "Skipped: template body is empty" });
		return null;
	}
	const given = typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
	const description = (given || firstLine(body)).slice(0, MAX_SKILL_DESCRIPTION);
	return { name, description, path: file, scope };
}

export function discoverTemplates(cwd: string, opts: { home?: string } = {}): { templates: Template[]; warnings: TemplateWarning[] } {
	const home = opts.home ?? homedir();
	const globalDir = join(home, ".agents", "templates");
	const globalReal = real(globalDir);
	const start = real(cwd) ?? resolve(cwd);
	const repo = findRepoRoot(start);

	const roots: { dir: string; scope: Template["scope"] }[] = [];
	for (let dir = start; ; dir = dirname(dir)) {
		const candidate = join(dir, ".agents", "templates");
		// The global directory sits under home, an ancestor of most workspaces; never mistake it for a project one.
		const id = real(candidate);
		if (id === null || id !== globalReal) roots.push({ dir: candidate, scope: "project" });
		if (dir === repo || dirname(dir) === dir) break;
	}
	roots.push({ dir: globalDir, scope: "global" });

	const warnings: TemplateWarning[] = [];
	const byName = new Map<string, Template>();
	const seen = new Set<string>();
	for (const root of roots) {
		if (!isDir(root.dir)) continue;
		let entries;
		try {
			entries = readdirSync(root.dir, { withFileTypes: true });
		} catch (e) {
			warnings.push({ path: root.dir, message: `Unable to list templates directory: ${e instanceof Error ? e.message : String(e)}` });
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (entry.name.startsWith(".") || !/\.md$/i.test(entry.name)) continue;
			const file = join(root.dir, entry.name);
			try { if (!statSync(file).isFile()) continue; } catch { continue; }
			const id = real(file) ?? file;
			if (seen.has(id)) continue;
			seen.add(id);
			const template = loadTemplate(file, root.scope, warnings);
			if (!template) continue;
			const existing = byName.get(template.name);
			if (existing) {
				warnings.push({ path: file, message: `Skipped: name "${template.name}" is already provided by ${existing.path}` });
				continue;
			}
			if (byName.size >= MAX_TEMPLATES) {
				warnings.push({ path: file, message: `Skipped: more than ${MAX_TEMPLATES} templates found` });
				continue;
			}
			byName.set(template.name, template);
		}
	}
	return { templates: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), warnings };
}

/** Same cwd rules as skills: a directory that does not exist yet resolves to its nearest existing ancestor. */
export function resolveCwd(base: string, input?: string): string {
	let abs = resolve(base, input?.trim() || ".");
	while (!isDir(abs)) {
		const parent = dirname(abs);
		if (parent === abs) throw new Error(`cwd is not a directory: ${abs}`);
		abs = parent;
	}
	return abs;
}

export function listTemplates(base: string, cwdInput: string | undefined, home: string): TemplateList {
	const cwd = resolveCwd(base, cwdInput);
	return { cwd, ...discoverTemplates(cwd, { home }) };
}

/** `/prompt:name rest…` at the very start of a message -> name + arguments. */
export function parseTemplateCall(text: string): { name: string; args: string } | null {
	const m = /^\s*\/prompt:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(text);
	return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : null;
}

/** `$ARGUMENTS` is replaced by what followed the call; without a placeholder the arguments are appended. */
export function expandTemplate(body: string, args: string): string {
	const text = body.trim();
	if (/\$ARGUMENTS\b/.test(text)) return text.replace(/\$ARGUMENTS\b/g, () => args);
	return args ? `${text}\n\n${args}` : text;
}

/** Reads a template and returns its body without frontmatter; null when it cannot be read. */
export function readTemplateBody(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		return splitTemplate(readFileSync(path, "utf8")).body;
	} catch {
		return null;
	}
}

/** Keeps a very long expanded template within the inline limit. */
export function limitTemplateText(expanded: string): string {
	return expanded.length > MAX_INLINE_TEMPLATE_CHARS ? `${expanded.slice(0, MAX_INLINE_TEMPLATE_CHARS)}\n[cut]` : expanded;
}

/** Note stored next to the expanded text: which template was used and what the user typed. The client shows it under the bubble. */
export function templateMarker(name: string, call: string): string {
	return `<pipaya-template>${JSON.stringify({ name, call })}</pipaya-template>`;
}
