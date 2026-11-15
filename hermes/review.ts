// The learning loop: a model reads a stretch of conversation (or the user's past messages) and answers with memory
// operations and skill changes, which are applied here one by one. A bad operation is reported, never fatal.
import { MemoryError, type MemoryStore, type Operation, TARGETS } from "./memory.ts";
import { parseJsonObject, PROFILE_SYSTEM, profileInput, REVIEW_SYSTEM, reviewInput } from "./prompts.ts";
import { SkillError, type SkillLibrary } from "./skills.ts";
import { type StoredLike, plainText, transcriptOf } from "./text.ts";

export type Complete = (req: { system: string; input: string; maxTokens?: number; signal?: AbortSignal }) => Promise<{ text: string }>;

export interface Outcome {
	at: number;
	kind: "review" | "profile";
	sessionId?: string;
	title?: string;
	summary: string;
	changes: string[];
	errors: string[];
}

const MAX_OPS = 20;

/** Applies a model's answer. Each store's batch is atomic; each skill action stands alone. */
export function applyAnswer(answer: Record<string, any>, memory: MemoryStore, skills: SkillLibrary | null): { changes: string[]; errors: string[] } {
	const changes: string[] = [];
	const errors: string[] = [];
	for (const target of TARGETS) {
		const ops = answer[target];
		if (!Array.isArray(ops) || !ops.length) continue;
		try {
			const before = memory.read(target).length;
			const after = memory.apply(target, ops.slice(0, MAX_OPS) as Operation[]).length;
			changes.push(`${target === "user" ? "USER.md" : "MEMORY.md"}: ${ops.length} op(s), ${before} → ${after} entries`);
		} catch (e) {
			errors.push(`${target}: ${e instanceof MemoryError ? e.message : String(e)}`);
		}
	}
	const actions = skills && Array.isArray(answer.skills) ? answer.skills.slice(0, MAX_OPS) : [];
	for (const a of actions) {
		try {
			switch (a?.action) {
				case "create":
					skills!.create(a.name, a.description, a.body);
					changes.push(`skill ${a.name}: created`);
					break;
				case "update":
					skills!.update(a.name, { description: a.description, body: a.body });
					changes.push(`skill ${a.name}: updated`);
					break;
				case "patch":
					skills!.patch(a.name, a.old_text, a.new_text, a.file_path);
					changes.push(`skill ${a.name}: patched${a.file_path ? ` ${a.file_path}` : ""}`);
					break;
				case "write_file":
					skills!.writeFile(a.name, a.file_path, a.content);
					changes.push(`skill ${a.name}: wrote ${a.file_path}`);
					break;
				default:
					errors.push(`skills: unknown action ${JSON.stringify(a?.action)}`);
			}
		} catch (e) {
			errors.push(`skill ${a?.name}: ${e instanceof SkillError ? e.message : String(e)}`);
		}
	}
	return { changes, errors };
}

const storeText = (memory: MemoryStore, target: "user" | "memory") => memory.read(target).join("\n§\n");

/** Every skill by name and description; the editable ones also with their SKILL.md, within `budget` characters. */
export function skillCatalog(skills: SkillLibrary | null, editOthers: boolean, budget = 20_000): string {
	if (!skills) return "(skill learning is off)";
	const lines: string[] = [];
	let left = budget;
	for (const s of skills.list()) {
		const editable = s.ownedByHermes || editOthers;
		lines.push(`- ${s.name}${editable ? " [editable]" : ""}: ${s.description.slice(0, 200)}`);
		if (!editable || left <= 0) continue;
		try {
			const body = skills.view(s.name);
			if (body.length > left) continue;
			left -= body.length;
			lines.push(`  <skill name="${s.name}">\n${body}\n  </skill>`);
		} catch {
			/* unreadable: name only */
		}
	}
	return lines.join("\n");
}

/** Messages a person typed: not a peer's message, a schedule's prompt or a server note. */
export function isHumanTurn(m: StoredLike): boolean {
	if (m.message?.role !== "user") return false;
	const text = plainText(m.message);
	return !!text && !text.startsWith("[from ");
}

export async function reviewConversation(o: {
	complete: Complete;
	memory: MemoryStore;
	skills: SkillLibrary | null;
	editOthers: boolean;
	messages: StoredLike[];
	fromSeq: number;
	maxChars: number;
	signal?: AbortSignal;
}): Promise<Omit<Outcome, "at" | "kind">> {
	const input = reviewInput({
		userBlock: storeText(o.memory, "user"),
		memoryBlock: storeText(o.memory, "memory"),
		skills: skillCatalog(o.skills, o.editOthers),
		transcript: transcriptOf(o.messages, o.maxChars),
		fromSeq: o.fromSeq,
	});
	const reply = await o.complete({ system: REVIEW_SYSTEM, input, maxTokens: 6000, signal: o.signal });
	return finish(reply.text, o.memory, o.skills);
}

export async function buildProfile(o: { complete: Complete; memory: MemoryStore; samples: string; signal?: AbortSignal }): Promise<Omit<Outcome, "at" | "kind">> {
	const input = profileInput({ userBlock: storeText(o.memory, "user"), memoryBlock: storeText(o.memory, "memory"), samples: o.samples });
	const reply = await o.complete({ system: PROFILE_SYSTEM, input, maxTokens: 4000, signal: o.signal });
	return finish(reply.text, o.memory, null);
}

function finish(text: string, memory: MemoryStore, skills: SkillLibrary | null): Omit<Outcome, "at" | "kind"> {
	const answer = parseJsonObject(text);
	if (!answer) return { summary: "The model did not answer with JSON; nothing was changed.", changes: [], errors: [text.slice(0, 300)] };
	const { changes, errors } = applyAnswer(answer, memory, skills);
	const summary = typeof answer.summary === "string" && answer.summary.trim() ? answer.summary.trim().slice(0, 300) : changes.length ? "Updated." : "Nothing to save.";
	return { summary, changes, errors };
}

/** The user's own words from many sessions, newest first, clipped to `max` characters. */
export function userSamples(sessions: { title: string; messages: StoredLike[] }[], max: number, perMessage = 400): string {
	const out: string[] = [];
	let size = 0;
	for (const s of sessions) {
		const lines = s.messages.filter(isHumanTurn).map((m) => {
			const t = plainText(m.message).replace(/\s+/g, " ");
			return `- ${t.length > perMessage ? `${t.slice(0, perMessage)}…` : t}`;
		});
		if (!lines.length) continue;
		const block = `### ${s.title}\n${lines.join("\n")}`;
		if (size + block.length > max) {
			const room = max - size;
			if (room > 200) out.push(block.slice(0, room));
			break;
		}
		out.push(block);
		size += block.length + 2;
	}
	return out.join("\n\n");
}
