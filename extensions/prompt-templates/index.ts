// prompt-templates: a long prompt saved as `<name>.md`, called with `/prompt:name [arguments]`.
// Global: ~/.agents/templates. Project: .agents/templates from the working directory up to the repository root.
import { existsSync, readFileSync } from "node:fs";
import { expandTemplate, limitTemplateText, listTemplates, parseTemplateCall, splitTemplate, templateMarker } from "./templates.ts";

const body = (path: string): string | null => {
	try {
		return existsSync(path) ? splitTemplate(readFileSync(path, "utf8")).body : null;
	} catch {
		return null;
	}
};

export default (pi: any) => {
	// `/prompt:name args` is sent as the template's text; a marker block tells the client to show the short call as a note.
	pi.on("input", (e: { sessionId: string; text: string }, ctx: { cwd: string }) => {
		const call = parseTemplateCall(e.text);
		if (!call) return undefined;
		const found = listTemplates(pi.defaultCwd(), ctx.cwd, pi.home).templates.find((t) => t.name === call.name);
		const text = found ? body(found.path) : null;
		if (text === null) return undefined;
		return {
			text: limitTemplateText(expandTemplate(text, call.args)),
			parts: [{ type: "text", text: templateMarker(call.name, e.text.trim()) }],
			title: call.name,
		};
	});

	// The client lists them for the slash menu and the footer badge: `{ cwd? }` -> `{ cwd, templates, warnings }`.
	pi.registerMethod("list", (params: { cwd?: string } | null) => listTemplates(pi.defaultCwd(), params?.cwd, pi.home));
};
