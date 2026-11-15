// Two bounded stores, as in Hermes Agent: USER.md (who the user is) and MEMORY.md (the agent's notes on the environment).
// Entries are separated by a line holding only `§`. A write that would go past the limit fails instead of dropping
// entries, so the agent (or the background review) has to make room itself.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Target = "user" | "memory";
export const TARGETS: Target[] = ["user", "memory"];
export const FILES: Record<Target, string> = { user: "USER.md", memory: "MEMORY.md" };
export const DEFAULT_LIMITS: Record<Target, number> = { user: 1375, memory: 2200 };
const SEP = "\n§\n";

export interface Operation {
	action: "add" | "patch" | "remove";
	/** add: the new entry. patch: the entry's new text. */
	content?: string;
	/** patch, remove: a piece of text found in exactly one entry. */
	old_text?: string;
}

export const parseEntries = (text: string): string[] =>
	text.split(/\r?\n§\r?\n|^§\r?\n|\r?\n§$/m).map((e) => e.trim()).filter(Boolean);

export const joinEntries = (entries: string[]): string => entries.join(SEP);

/** Size the limit counts: the entries and their separators. */
export const sizeOf = (entries: string[]): number => joinEntries(entries).length;

export class MemoryError extends Error {}

/** Applies a batch to a copy of `entries`; the limit is checked on the result only, so one batch can make room and add. */
export function applyOperations(entries: string[], ops: Operation[], limit: number): string[] {
	if (!Array.isArray(ops) || !ops.length) throw new MemoryError("operations must be a non-empty array");
	const next = [...entries];
	const find = (old: string | undefined, i: number) => {
		const needle = (old ?? "").trim();
		if (!needle) throw new MemoryError(`operations[${i}]: old_text is required for patch and remove`);
		const hits = next.flatMap((e, at) => (e.includes(needle) ? [at] : []));
		if (!hits.length) throw new MemoryError(`operations[${i}]: no entry contains ${JSON.stringify(needle.slice(0, 80))}`);
		if (hits.length > 1) throw new MemoryError(`operations[${i}]: ${hits.length} entries contain ${JSON.stringify(needle.slice(0, 80))}; quote more of the one you mean`);
		return hits[0]!;
	};
	ops.forEach((op, i) => {
		const content = typeof op?.content === "string" ? op.content.trim() : "";
		if (/(^|\n)\s*§\s*(\n|$)/.test(content)) throw new MemoryError(`operations[${i}]: an entry cannot hold a line with only §`);
		switch (op?.action) {
			case "add":
				if (!content) throw new MemoryError(`operations[${i}]: content is required for add`);
				if (next.includes(content)) return; // the same fact twice is one entry
				next.push(content);
				return;
			case "patch": {
				if (!content) throw new MemoryError(`operations[${i}]: content is required for patch`);
				next[find(op.old_text, i)] = content;
				return;
			}
			case "remove":
				next.splice(find(op.old_text, i), 1);
				return;
			default:
				throw new MemoryError(`operations[${i}]: action must be add, patch or remove`);
		}
	});
	const size = sizeOf(next);
	if (size > limit) throw new MemoryError(`over the limit: ${size}/${limit} characters. Remove or shorten stale entries in the same batch.`);
	return next;
}

export class MemoryStore {
	constructor(private dir: string, private limits: () => Record<Target, number> = () => DEFAULT_LIMITS) {
		mkdirSync(dir, { recursive: true });
	}

	path(target: Target): string {
		return join(this.dir, FILES[target]);
	}

	limit(target: Target): number {
		return this.limits()[target];
	}

	read(target: Target): string[] {
		const file = this.path(target);
		return existsSync(file) ? parseEntries(readFileSync(file, "utf8")) : [];
	}

	private write(target: Target, entries: string[]): void {
		const file = this.path(target);
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, entries.length ? `${joinEntries(entries)}\n` : "");
		renameSync(tmp, file);
	}

	apply(target: Target, ops: Operation[]): string[] {
		const next = applyOperations(this.read(target), ops, this.limit(target));
		this.write(target, next);
		return next;
	}

	/** Replaces a whole store (the settings page). */
	replace(target: Target, text: string): string[] {
		const entries = parseEntries(text);
		const size = sizeOf(entries);
		if (size > this.limit(target)) throw new MemoryError(`over the limit: ${size}/${this.limit(target)} characters`);
		this.write(target, entries);
		return entries;
	}

	usage(target: Target): { used: number; limit: number; entries: number } {
		const entries = this.read(target);
		return { used: sizeOf(entries), limit: this.limit(target), entries: entries.length };
	}

	/** The block that goes into the system prompt. Empty stores are left out. */
	block(): string {
		const parts: string[] = [];
		for (const [target, title] of [["user", "USER PROFILE (who the user is)"], ["memory", "MEMORY (your personal notes)"]] as const) {
			const entries = this.read(target);
			if (!entries.length) continue;
			const { used, limit } = this.usage(target);
			const bar = "═".repeat(46);
			parts.push(`${bar}\n${title} [${Math.round((used / limit) * 100)}% — ${used}/${limit} chars]\n${bar}\n${joinEntries(entries)}`);
		}
		return parts.join("\n\n");
	}

	/** What the memory tool answers with: the live state of one store. */
	view(target: Target): string {
		const { used, limit, entries } = this.usage(target);
		const list = this.read(target);
		return `${FILES[target]}: ${entries} entries, ${used}/${limit} chars${list.length ? `\n${joinEntries(list)}` : " (empty)"}`;
	}
}
