// Pure parts of image-generation: what is sent upstream, what comes back, and the reply the chat shows.
// No imports from pipaya or pi-ai: an installed extension has no node_modules.

/** Where generated pictures land, relative to the session's working directory. */
export const GENERATED_DIR = ".pipaya/generated";
const GENERATED_LINK = /\]\((\.pipaya\/generated\/[\w.-]+)\)/g;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export interface Picture { data: string; mimeType: string }
type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Msg = { role: string; content: string | Block[] };

/** The text and pictures of the newest user message. Blocks the app adds for the model (`<pipaya-…`) are left out. */
export function lastUser(messages: readonly Msg[]): { text: string; images: Picture[] } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return { text: m.content, images: [] };
		const text = m.content.flatMap((c) => (c.type === "text" && c.text && !c.text.startsWith("<pipaya-") ? [c.text] : [])).join("\n");
		const images = m.content.flatMap((c) => (c.type === "image" && c.data && c.mimeType ? [{ data: c.data, mimeType: c.mimeType }] : []));
		return { text, images };
	}
	return { text: "", images: [] };
}

/** The path of the newest picture this chat made (from the last assistant reply that links one), so "make it bluer" edits it. */
export function previousPicturePath(messages: readonly Msg[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		const text = typeof m.content === "string" ? m.content : m.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
		const hit = [...text.matchAll(GENERATED_LINK)].pop();
		if (hit) return hit[1];
	}
	return undefined;
}

export const mimeOfPath = (path: string): string | undefined => MIME[path.split(".").pop()!.toLowerCase()];

/** Chat-completions body with image output (OpenRouter and compatible endpoints). */
export function requestBody(model: string, text: string, images: Picture[], textOut: boolean) {
	return {
		model,
		messages: [{ role: "user", content: [{ type: "text", text }, ...images.map((p) => ({ type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } }))] }],
		stream: false,
		modalities: textOut ? ["image", "text"] : ["image"],
	};
}

/** Text and pictures out of a chat-completions answer; pictures only as `data:` URLs. */
export function parseResponse(body: any): { text: string; pictures: Picture[]; usage?: { input: number; output: number } } {
	const message = body?.choices?.[0]?.message ?? {};
	const text = typeof message.content === "string" ? message.content.trim() : "";
	const pictures: Picture[] = [];
	for (const image of Array.isArray(message.images) ? message.images : []) {
		const url = typeof image?.image_url === "string" ? image.image_url : image?.image_url?.url;
		const m = typeof url === "string" ? /^data:([^;]+);base64,(.+)$/.exec(url) : null;
		if (m) pictures.push({ mimeType: m[1]!, data: m[2]! });
	}
	const u = body?.usage;
	return { text, pictures, ...(u ? { usage: { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 } } : {}) };
}

/** A file name for a picture under GENERATED_DIR. */
export const picturePath = (mimeType: string, now = Date.now(), rand = Math.random().toString(36).slice(2, 8)): string =>
	`${GENERATED_DIR}/${now.toString(36)}-${rand}.${EXT[mimeType] ?? "png"}`;

/** The reply text: the model's words (if any), then each picture as a markdown image the chat shows. */
export function replyText(prompt: string, text: string, paths: string[]): string {
	const alt = prompt.trim().replace(/[\[\]\n]/g, " ").slice(0, 80);
	return [...(text ? [text] : []), ...paths.map((p) => `![${alt}](${p})`)].join("\n\n");
}

/** Model ids from the settings field (comma or newline separated), without duplicates. */
export const parseModels = (value: unknown): string[] =>
	[...new Set(String(value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^[\w./:-]{1,200}$/.test(s)))];
