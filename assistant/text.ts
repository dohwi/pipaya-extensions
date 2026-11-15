// Turning stored messages into plain text: for the search index and for the transcript the background review reads.

export interface StoredLike {
	seq: number;
	role: string;
	createdAt: number;
	message: any;
}

/** Blocks the server adds to a user message for the model (`<pipaya-...>`) are not something the user wrote. */
const hidden = (text: string) => text.trimStart().startsWith("<pipaya-");
/** Server blocks (`<pipaya-hint>…</pipaya-hint>`) inside a text are cut out too. */
const scrub = (text: string) => text.replace(/<(pipaya-[a-z-]+)>[\s\S]*?<\/\1>/g, "").trim();

/** The words of a message: user and assistant text only (no thinking, no tool calls). */
export function plainText(message: any): string {
	if (!message || (message.role !== "user" && message.role !== "assistant")) return "";
	const c = message.content;
	if (typeof c === "string") return hidden(c) ? "" : scrub(c);
	if (!Array.isArray(c)) return "";
	return c
		.filter((b: any) => b?.type === "text" && typeof b.text === "string" && !hidden(b.text))
		.map((b: any) => scrub(b.text))
		.filter(Boolean)
		.join("\n");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line or block per message, tool calls and results shortened. */
export function describe(m: StoredLike, opts: { toolChars?: number; textChars?: number } = {}): string {
	const tool = opts.toolChars ?? 300;
	const text = opts.textChars ?? 4000;
	const msg = m.message ?? {};
	if (msg.role === "user") {
		const t = plainText(msg);
		return t ? `[#${m.seq} user] ${clip(t, text)}` : "";
	}
	if (msg.role === "assistant") {
		const parts: string[] = [];
		const t = plainText(msg);
		if (t) parts.push(clip(t, text));
		if (Array.isArray(msg.content)) {
			for (const b of msg.content) if (b?.type === "toolCall") parts.push(`→ ${b.name}(${clip(JSON.stringify(b.arguments ?? {}), tool)})`);
		}
		return parts.length ? `[#${m.seq} assistant] ${parts.join("\n")}` : "";
	}
	if (msg.role === "toolResult") {
		const body = Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : String(msg.content ?? "");
		return `[#${m.seq} ${msg.toolName ?? "tool"}${msg.isError ? " error" : ""}] ${clip(body.trim(), tool)}`;
	}
	return "";
}

/** A transcript that fits in `max` characters; when too long, the newest part is kept. */
export function transcriptOf(messages: StoredLike[], max: number, opts: { toolChars?: number; textChars?: number } = {}): string {
	const lines = messages.map((m) => describe(m, opts)).filter(Boolean);
	const out: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (size + line.length + 1 > max) {
			out.unshift("[… earlier messages left out]");
			break;
		}
		out.unshift(line);
		size += line.length + 1;
	}
	return out.join("\n");
}
