// prompt-templates: a long prompt saved as `<name>.md`, called with `/prompt:name [arguments]`.
// Global: ~/.agents/templates. Project: .agents/templates from the working directory up to the repository root.
import { existsSync, readFileSync } from "node:fs";
import { expandTemplate, limitTemplateText, listTemplates, splitTemplate } from "./templates.ts";

const body = (path: string): string | null => {
	try {
		return existsSync(path) ? splitTemplate(readFileSync(path, "utf8")).body : null;
	} catch {
		return null;
	}
};

export default (pi: any) => {
	// `/prompt:name args` is sent as the template's text; the note tells the reader which template it was and folds the long text.
	pi.registerCommands("prompt", {
		label: "Prompt templates",
		list: (cwd: string) => listTemplates(pi.defaultCwd(), cwd, pi.home).templates.map((t) => ({ name: t.name, description: t.description })),
		run: (name: string, args: string, ctx: { cwd: string }) => {
			const found = listTemplates(pi.defaultCwd(), ctx.cwd, pi.home).templates.find((t) => t.name === name);
			const text = found ? body(found.path) : null;
			if (text === null) return `/prompt:${name}${args ? ` ${args}` : ""}`; // unknown: sent as typed
			return { prompt: limitTemplateText(expandTemplate(text, args)), note: { text: `Prompt template: ${name}`, collapse: true, data: { name } }, title: name };
		},
	});
};
