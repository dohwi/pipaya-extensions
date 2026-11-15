// Learning from conversations: a one-shot model call reads text and answers with memory changes, applied all or none.
import { type Change, MemoryError, type MemoryStore } from "./store.ts";
import { parseJsonObject, PROFILE_SYSTEM, profileInput, REVIEW_SYSTEM, reviewInput } from "./prompts.ts";
import { plainText, type StoredLike, transcriptOf } from "./text.ts";

export type Complete = (req: { system: string; input: string; maxTokens?: number }) => Promise<{ text: string }>;

export interface Outcome {
	at: number;
	kind: "review" | "profile";
	sessionId?: string;
	title?: string;
	summary: string;
	changes: string[];
	error?: string;
}

const MAX_CHANGES = 20;

/** A message a person typed (not another session's message, a server report or a scheduled prompt). */
export function isHumanTurn(m: StoredLike): boolean {
	if (m.message?.role !== "user") return false;
	const text = plainText(m.message);
	return !!text && !text.startsWith("[from ");
}

const describe = (c: Change) => (c.op === "add" ? `+ ${c.kind}: ${c.text}` : c.op === "edit" ? `~ ${c.id}: ${c.text}` : `- ${c.id}`);

/** Applies a model reply. Nothing changes when it is not JSON or when any change is invalid. */
export function applyReply(text: string, memory: MemoryStore): Omit<Outcome, "at" | "kind"> {
	const answer = parseJsonObject(text);
	if (!answer || !Array.isArray(answer.changes)) return { summary: "No usable answer from the model; nothing changed.", changes: [], error: text.slice(0, 300) };
	const changes = (answer.changes as Change[]).slice(0, MAX_CHANGES);
	const summary = typeof answer.summary === "string" && answer.summary.trim() ? answer.summary.trim().slice(0, 300) : changes.length ? "Updated." : "Nothing to keep.";
	if (!changes.length) return { summary, changes: [] };
	try {
		memory.apply(changes);
		return { summary, changes: changes.map(describe) };
	} catch (e) {
		return { summary: "The changes were refused; nothing changed.", changes: [], error: e instanceof MemoryError ? e.message : String(e) };
	}
}

export const memoryText = (memory: MemoryStore) =>
	`profile:\n${memory.listing("profile") || "(empty)"}\nnote:\n${memory.listing("note") || "(empty)"}`;

export async function review(o: { complete: Complete; memory: MemoryStore; messages: StoredLike[]; fromSeq: number; maxChars: number }) {
	const input = reviewInput({ memory: memoryText(o.memory), transcript: transcriptOf(o.messages, o.maxChars), fromSeq: o.fromSeq });
	return applyReply((await o.complete({ system: REVIEW_SYSTEM, input, maxTokens: 2000 })).text, o.memory);
}

export async function buildProfile(o: { complete: Complete; memory: MemoryStore; samples: string }) {
	const input = profileInput({ memory: memoryText(o.memory), samples: o.samples });
	return applyReply((await o.complete({ system: PROFILE_SYSTEM, input, maxTokens: 2000 })).text, o.memory);
}

/** The user's own words from many sessions, newest first, within `max` characters. */
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
			if (max - size > 200) out.push(block.slice(0, max - size));
			break;
		}
		out.push(block);
		size += block.length + 2;
	}
	return out.join("\n\n");
}
