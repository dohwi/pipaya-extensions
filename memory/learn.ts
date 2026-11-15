// Background review: a one-shot model call reads the new part of a conversation and answers with memory changes,
// which are applied all or none.
import { parseJsonObject, REVIEW_SYSTEM, reviewInput } from "./prompts.ts";
import { type Change, MemoryError, type MemoryStore } from "./store.ts";
import { plainText, type StoredLike, transcriptOf } from "./text.ts";

export type Complete = (req: { system: string; input: string; maxTokens?: number }) => Promise<{ text: string }>;

export interface ReviewResult {
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
export function applyReply(text: string, memory: MemoryStore): ReviewResult {
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

const memoryText = (memory: MemoryStore) =>
	`profile:\n${memory.listing("profile") || "(empty)"}\nnote:\n${memory.listing("note") || "(empty)"}`;

/** Reads only the messages since the last review (tool output cut short), so a review costs little. */
export async function review(o: { complete: Complete; memory: MemoryStore; messages: StoredLike[]; maxChars: number }): Promise<ReviewResult> {
	const input = reviewInput({ memory: memoryText(o.memory), transcript: transcriptOf(o.messages, o.maxChars, { toolChars: 120, textChars: 1500 }) });
	return applyReply((await o.complete({ system: REVIEW_SYSTEM, input, maxTokens: 1000 })).text, o.memory);
}
