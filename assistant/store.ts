// Long-term memory: short entries of two kinds, each with a stable id the model refers to.
//   profile: about the user (preferences, style, standing rules)
//   note:    about the environment (machines, projects, conventions)
// Each kind has a character budget; a change that would go over it is refused whole, so stale entries have to be
// dropped or shortened in the same batch instead of being pushed out silently.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Kind = "profile" | "note";
export const KINDS: Kind[] = ["profile", "note"];
export const DEFAULT_BUDGET: Record<Kind, number> = { profile: 1500, note: 2500 };
const PREFIX: Record<Kind, string> = { profile: "p", note: "n" };
const MAX_ENTRY = 500;

export interface Entry {
	id: string;
	kind: Kind;
	text: string;
	updatedAt: number;
}

export type Change =
	| { op: "add"; kind: Kind; text: string }
	| { op: "edit"; id: string; text: string }
	| { op: "drop"; id: string };

interface FileShape {
	next: number;
	entries: Entry[];
}

export class MemoryError extends Error {}

/** One line, trimmed. Entries are facts, not documents. */
export function clean(text: unknown): string {
	const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
	if (!t) throw new MemoryError("text is empty");
	if (t.length > MAX_ENTRY) throw new MemoryError(`an entry is at most ${MAX_ENTRY} characters; split it or say it shorter`);
	return t;
}

const key = (t: string) => t.toLowerCase();

export class MemoryStore {
	private file: string;

	constructor(dir: string, private budget: () => Record<Kind, number> = () => DEFAULT_BUDGET, private now: () => number = Date.now) {
		mkdirSync(dir, { recursive: true });
		this.file = join(dir, "memory.json");
	}

	private load(): FileShape {
		if (!existsSync(this.file)) return { next: 1, entries: [] };
		try {
			const data = JSON.parse(readFileSync(this.file, "utf8"));
			return { next: Number(data.next) || 1, entries: Array.isArray(data.entries) ? data.entries : [] };
		} catch {
			throw new MemoryError(`${this.file} is not valid JSON; fix or remove it`);
		}
	}

	private save(data: FileShape): void {
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, this.file);
	}

	entries(kind?: Kind): Entry[] {
		const all = this.load().entries;
		return kind ? all.filter((e) => e.kind === kind) : all;
	}

	used(kind: Kind, entries = this.entries()): number {
		return entries.filter((e) => e.kind === kind).reduce((n, e) => n + e.text.length, 0);
	}

	limit(kind: Kind): number {
		return this.budget()[kind];
	}

	/** Applies every change or none. Returns the ids that were added. */
	apply(changes: Change[]): string[] {
		if (!Array.isArray(changes) || !changes.length) throw new MemoryError("no changes given");
		const data = this.load();
		const entries = data.entries.map((e) => ({ ...e }));
		const added: string[] = [];
		const at = this.now();
		changes.forEach((c, i) => {
			const where = `changes[${i}]`;
			const find = (id: unknown) => {
				const hit = entries.findIndex((e) => e.id === id);
				if (hit < 0) throw new MemoryError(`${where}: no entry ${JSON.stringify(id)}`);
				return hit;
			};
			switch (c?.op) {
				case "add": {
					if (!KINDS.includes(c.kind)) throw new MemoryError(`${where}: kind must be profile or note`);
					const text = clean(c.text);
					if (entries.some((e) => e.kind === c.kind && key(e.text) === key(text))) return;
					const id = `${PREFIX[c.kind]}${data.next++}`;
					entries.push({ id, kind: c.kind, text, updatedAt: at });
					added.push(id);
					return;
				}
				case "edit": {
					const hit = find(c.id);
					entries[hit] = { ...entries[hit]!, text: clean(c.text), updatedAt: at };
					return;
				}
				case "drop":
					entries.splice(find(c.id), 1);
					return;
				default:
					throw new MemoryError(`${where}: op must be add, edit or drop`);
			}
		});
		for (const kind of KINDS) {
			const used = this.used(kind, entries);
			if (used > this.limit(kind) && used > this.used(kind, data.entries)) {
				throw new MemoryError(`${kind} would be ${used}/${this.limit(kind)} characters; drop or shorten entries in the same call`);
			}
		}
		this.save({ next: data.next, entries });
		return added;
	}

	/**
	 * Replaces one kind with the given lines (the settings page). A line equal to an existing entry keeps its id, so
	 * hand edits do not renumber everything the model may have seen.
	 */
	replace(kind: Kind, lines: string[]): void {
		const data = this.load();
		const old = data.entries.filter((e) => e.kind === kind);
		const kept: Entry[] = [];
		const seen = new Set<string>();
		for (const line of lines) {
			if (!line.trim()) continue;
			const text = clean(line);
			if (seen.has(key(text))) continue;
			seen.add(key(text));
			kept.push(old.find((e) => key(e.text) === key(text)) ?? { id: `${PREFIX[kind]}${data.next++}`, kind, text, updatedAt: this.now() });
		}
		const used = kept.reduce((n, e) => n + e.text.length, 0);
		if (used > this.limit(kind)) throw new MemoryError(`${kind} would be ${used}/${this.limit(kind)} characters`);
		this.save({ next: data.next, entries: [...data.entries.filter((e) => e.kind !== kind), ...kept] });
	}

	/** Entries as the model reads them: `- [p3] text`. */
	listing(kind: Kind): string {
		return this.entries(kind).map((e) => `- [${e.id}] ${e.text}`).join("\n");
	}

	/** What goes into the system prompt; empty when nothing is saved. */
	block(): string {
		const profile = this.listing("profile");
		const notes = this.listing("note");
		if (!profile && !notes) return "";
		return [...(profile ? ["## About the user", profile] : []), ...(notes ? ["## Environment", notes] : [])].join("\n");
	}

	/** The tool's answer: live state with sizes. */
	summary(): string {
		return KINDS.map((k) => `${k}: ${this.used(k)}/${this.limit(k)} chars\n${this.listing(k) || "(empty)"}`).join("\n\n");
	}
}
