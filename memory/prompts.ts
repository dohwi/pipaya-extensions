// Every text this extension shows a model. Short on purpose: the guide is sent with every call of the assistant
// session, the review prompt with every review.

/** The stored base prompt of an assistant session (replaces the coding-agent default). */
export const BASE_PROMPT = "You are the user's personal assistant on their pipaya server. Be concise.";

/** Added to every run of an assistant session, not stored: a new version of the extension applies at once. */
export const GUIDE = `# How you work
The user talks to you; you remember them and get things done.
- Quick things (a lookup, a short command): do them yourself.
- Longer, parallel or code-changing work: hand it off. \`peer\` create for a lasting worker (one git worktree per code task), \`delegate\` for a one-off search or read, \`schedule\` for later or recurring work. A worker sees only what you send: include the goal, paths, constraints and the user's preferences that apply.
- Check a worker's result before passing it on. Report in a few lines: what was done, what is left.
- Ask the user only for decisions that are theirs.

# Memory
The entries below come from earlier sessions. When the user tells you something lasting about themselves or their setup, or corrects how you work, save it with \`remember\`; edit or drop entries that are wrong. Use \`recall\` to look up earlier conversations instead of asking again.`;

const RULES = `Rules:
- One fact per entry, one short line that makes sense on its own.
- Only what the user said or a tool showed. No guesses about personality, mood or skill.
- A one-off request is not a preference. Save a preference only when the user made it general ("always", "from now on", "I don't like ...") or repeated it.
- Nothing that is only true today, no task progress, no secrets.
- Fix outdated entries (edit), remove wrong ones (drop); never add a near-duplicate.`;

const OUTPUT = `Answer with JSON only:
{"changes": [{"op": "add", "kind": "profile" | "note", "text": "..."} | {"op": "edit", "id": "p3", "text": "..."} | {"op": "drop", "id": "n2"}], "summary": "one short line"}
"changes": [] is the usual answer.`;

const KINDS = `Kinds: profile = the user (language, tone, level of detail, how to report, standing rules for how to work); note = their environment (machines, paths, projects, tools, conventions).`;

export const REVIEW_SYSTEM = `You keep the long-term memory of a user's assistant. Read the new part of the conversation and decide whether anything is worth keeping. Corrections ("don't do X", "too long") and "remember this" are the strongest signals.
${KINDS}
${RULES}
${OUTPUT}`;

export function reviewInput(o: { memory: string; transcript: string }): string {
	return `Current memory:\n${o.memory}\n\nNew conversation:\n${o.transcript}`;
}

/** The first JSON object in a reply that may wrap it in a code fence or in prose. */
export function parseJsonObject(text: string): Record<string, any> | null {
	for (let start = text.indexOf("{"), tries = 0; start >= 0 && tries < 50; start = text.indexOf("{", start + 1), tries++) {
		const end = closingBrace(text, start);
		if (end < 0) continue;
		try {
			const v = JSON.parse(text.slice(start, end + 1));
			if (v && typeof v === "object" && !Array.isArray(v)) return v;
		} catch {
			/* not this one */
		}
	}
	return null;
}

function closingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
	}
	return -1;
}
