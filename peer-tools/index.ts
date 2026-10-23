import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { nameInLang, nextMemberName, poolForLang, poolOfName } from "./names.ts";
// peer-tools: lets an agent message and read the other active sessions of this server, by `@name` or `@group`.
const MAX_SENDS_PER_RUN = 10;
const MESSAGE_CHARS = 600;
const TOTAL_CHARS = 6000;
const HINT_OPEN = "<pipaya-hint>";
// The tool list is built once per session, but sessions come and go later: never put names in a description.
const NOTE = " Sessions are the user's @names; an unknown name is rejected with the current list.";

/** The checked-out branch of the repository holding `cwd` (a worktree too), read from HEAD without starting git. */
function branchOf(cwd: string): string | null {
	try {
		for (let dir = resolve(cwd), i = 0; i < 12; i++, dir = dirname(dir)) {
			const dot = join(dir, ".git");
			if (existsSync(dot)) {
				let gitDir = dot;
				if (statSync(dot).isFile()) {
					const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
					if (!target) return null;
					gitDir = isAbsolute(target) ? target : resolve(dir, target);
				}
				return /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]?.trim() ?? null;
			}
			if (dirname(dir) === dir) break;
		}
	} catch {}
	return null;
}

const handle = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Newest lines first until the total cap; long lines are cut. */
function cap(lines: string[]): string {
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.length > MESSAGE_CHARS ? `${lines[i]!.slice(0, MESSAGE_CHARS)}…` : lines[i]!;
		if (size + line.length > TOTAL_CHARS && kept.length) break;
		kept.unshift(line);
		size += line.length + 1;
	}
	const dropped = lines.length - kept.length;
	return `${dropped > 0 ? `[${dropped} older message(s) left out; ask for fewer/more with count]\n` : ""}${kept.join("\n")}`;
}

const oneLine = (s: string, max: number) => {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The member a `@name` token starts with: the longest known name, not cut out of a longer ASCII word (Korean particles may follow: @미나랑). */
export function memberAt(token: string, names: readonly string[]): string | null {
	const low = token.toLowerCase();
	let best: string | null = null;
	for (const n of names) {
		const l = n.toLowerCase();
		if (!low.startsWith(l) || (best && n.length <= best.length)) continue;
		if (/[a-z0-9_-]$/.test(l) && /^[a-z0-9_-]/.test(low.slice(l.length))) continue;
		best = n;
	}
	return best;
}

/** Names written as `@name` in a message, limited to known ones, in order of appearance, without repeats. */
export function mentioned(text: string, names: readonly string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const name = memberAt(m[1]!, names);
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/** What a group is called in a message: its name with whitespace turned into "-" so the tag stays one token. */
export const groupHandle = (name: string) => name.trim().replace(/\s+/g, "-");

const MAX_LISTED = 12;
const MAX_HINT_CHARS = 3000;
const SNIPPET_CHARS = 100;
const READ_NOTE =
	"This is only an index. Do not guess what they did: read a session with peer_read (a few messages) only when you need its words, and prefer git (branch, log, diff in its directory) for the work itself. Use peer_send to give a session work (to a whole tagged group, pass the group name as `to` once).";

export interface Brief { name: string; purpose: string; cwd: string; branch: string | null; running: boolean; last: string }

export function briefLine(b: Brief): string {
	const parts = [`@${b.name}${b.purpose ? ` (${oneLine(b.purpose, 60)})` : ""}`, b.running ? "working" : "idle"];
	if (b.branch) parts.push(`branch ${b.branch}`);
	parts.push(b.cwd);
	if (b.last) parts.push(`last: "${oneLine(b.last, SNIPPET_CHARS)}"`);
	return parts.join(" · ");
}

export function groupHint(groups: readonly { handle: string; members: readonly Brief[] }[]): string {
	const blocks = groups.map((g) => {
		const shown = g.members.slice(0, MAX_LISTED);
		const more = g.members.length - shown.length;
		const lines = shown.map((m) => `- ${briefLine(m)}`);
		if (more > 0) lines.push(`- (+${more} more; peer_read by name if needed)`);
		return `Group @${g.handle} (${g.members.length} sessions):\n${lines.join("\n")}`;
	});
	let body = blocks.join("\n");
	if (body.length > MAX_HINT_CHARS) body = `${body.slice(0, MAX_HINT_CHARS)}\n[index cut]`;
	return `${HINT_OPEN}The user tagged ${groups.length === 1 ? "a group" : "groups"} of sessions on this server (they run independently).\n${body}\n${READ_NOTE}</pipaya-hint>`;
}

export function memberBriefHint(members: readonly Brief[]): string {
	return `${HINT_OPEN}The user mentioned other sessions (agents) on this server:\n${members.slice(0, MAX_LISTED).map((m) => `- ${briefLine(m)}`).join("\n")}\n${READ_NOTE}</pipaya-hint>`;
}

export default (pi: any) => {
	const T = pi.Type;
	/** `peer_send` calls in each session's current run; keeps two sessions from answering each other forever. */
	const sends = new Map<string, number>();
	pi.on("agent_start", (e: { sessionId: string }) => void sends.delete(e.sessionId));
	pi.on("session_shutdown", (e: { sessionId: string }) => void sends.delete(e.sessionId));

	/**
	 * The active sessions with their `@name`. Names live in this extension's own session values (`pi.sessions.data`); a session
	 * that has none yet, or shares one with an older session (e.g. after being reopened), gets the next free name here.
	 */
	const named = (): any[] => {
		const active: any[] = [...pi.sessions.list({ closed: false })].sort((a, b) => a.createdAt - b.createdAt);
		const stored: Record<string, string> = pi.sessions.data.list("name");
		const taken = new Set<string>(pi.groups.list().map((g: any) => groupHandle(g.name).toLowerCase()));
		const lang = pi.settings.get().language as string | undefined;
		const seen = new Set<string>();
		for (const sess of active) { const n = stored[sess.id]; if (typeof n === "string" && n && !seen.has(n.toLowerCase())) seen.add(n.toLowerCase()); }
		const used = new Set<string>([...seen, ...taken]);
		const done = new Set<string>();
		return active.map((sess) => {
			let name = stored[sess.id];
			if (typeof name !== "string" || !name || done.has(name.toLowerCase())) {
				name = nextMemberName(used, typeof name === "string" && name ? poolOfName(name) : poolForLang(lang));
				used.add(name.toLowerCase());
				pi.sessions.data.set(sess.id, "name", name);
				pi.emit(null, "names_changed", {}, { ephemeral: true });
			}
			done.add(name.toLowerCase());
			return { ...sess, name };
		});
	};
	const peers = (self: string) => named().filter((s: any) => s.id !== self);
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const find = (self: string, name: string) => {
		const all = peers(self);
		const peer = all.find((p: any) => same(p.name, name));
		if (!peer) throw new Error(`session @${name} not found (sessions: ${all.map((p: any) => `@${p.name}`).join(", ") || "none"})`);
		return peer;
	};
	/** A one-line picture of a session for a tag: role, state, branch, directory and its last words. Never the transcript. */
	const brief = (id: string): Brief | null => {
		const r = named().find((x: any) => x.id === id);
		if (!r) return null;
		const lastAssistant = [...pi.sessions.messages(id, 6)].reverse().find((x: any) => x.message.role === "assistant");
		const content = Array.isArray(lastAssistant?.message.content) ? lastAssistant.message.content : [];
		const last = content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join(" ");
		return { name: r.name, purpose: r.purpose, cwd: r.cwd, branch: branchOf(r.cwd), running: r.running, last };
	};

	// `@name` / `@group` in a user message: add a short index of those sessions (never transcripts) as a hint block.
	pi.on("input", (e: { sessionId: string; text: string }) => {
		const all = peers(e.sessionId);
		if (!all.length) return;
		const names = all.map((p: any) => p.name);
		const groups: { name: string; sessionIds: string[] }[] = pi.groups.list();
		const parts: { type: "text"; text: string }[] = [];
		const handles = groups.map((g) => groupHandle(g.name)).filter(Boolean);
		const tagged = mentioned(e.text, handles).filter((h) => { const m = mentioned(e.text, names).find((n) => same(n, h)); return !m; });
		const found = tagged.map((h) => {
			const g = groups.find((x) => groupHandle(x.name) === h)!;
			return { handle: h, members: g.sessionIds.filter((sid) => sid !== e.sessionId).flatMap((sid) => { const b = brief(sid); return b ? [b] : []; }) };
		}).filter((g) => g.members.length);
		if (found.length) parts.push({ type: "text", text: groupHint(found) });
		const asked = mentioned(e.text, names);
		if (asked.length) {
			const briefs = asked.flatMap((n) => { const p = all.find((x: any) => x.name === n); const b = p && brief(p.id); return b ? [b] : []; });
			parts.push({ type: "text", text: briefs.length ? memberBriefHint(briefs) : `${HINT_OPEN}The user mentioned ${asked.map((n) => `@${n}`).join(", ")}: other sessions (agents) on this server. Use peer_send to give them work or ask them something, and peer_read to look at what they said or did. Do not guess what they did.</pipaya-hint>` });
		}
		if (parts.length) return { parts };
	});

	// For the `peer-names` client extension: who can be addressed right now (names, roles and groups). Read-only.
	pi.registerMethod("overview", () => ({
		sessions: named().map((s: any) => ({ id: s.id, name: s.name, title: s.title, purpose: s.purpose, cwd: s.cwd })),
		groups: pi.groups.list().map((g: any) => ({ name: g.name, handle: groupHandle(g.name), sessionIds: g.sessionIds })),
	}));

	// A client extension (peer-names) tells which UI language the user switched to: every name becomes its twin in it (민수 <-> Minsu).
	pi.registerMethod("localize", (p: { lang?: unknown }) => {
		const lang = typeof p?.lang === "string" && p.lang.length <= 35 ? p.lang : "";
		if (!lang) throw new Error("lang is required");
		pi.settings.set({ ...pi.settings.get(), language: lang });
		const active = named();
		const stored: Record<string, string> = pi.sessions.data.list("name");
		const used = new Set<string>(active.map((s: any) => s.name.toLowerCase()));
		let renamed = 0;
		for (const [id, name] of Object.entries(stored)) {
			let next = nameInLang(name, lang);
			if (next === name) continue;
			if (active.some((s: any) => s.id === id) && used.has(next.toLowerCase())) next = nextMemberName(used, poolForLang(lang));
			used.add(next.toLowerCase());
			pi.sessions.data.set(id, "name", next);
			renamed++;
		}
		if (renamed) pi.emit(null, "names_changed", {}, { ephemeral: true });
		return { renamed };
	});

	const reply = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text", text }], details });

	pi.registerTool({
		name: "peer_send",
		label: "Message another session",
		description:
			"Send a message to another active session, addressed by name (without @). A group name (e.g. a tagged @group) sends it to every other session in that group. It runs independently, sees only what you write here, and does not answer unless you ask it to reply with peer_send." + NOTE,
		parameters: T.Object({
			to: T.String({ minLength: 1, maxLength: 60, description: "Member name, without @" }),
			message: T.String({ minLength: 1, maxLength: 8000, description: "What to tell or ask; include all context it needs" }),
		}),
		alwaysActive: true,
		switchable: true,
		async execute(_id: string, p: { to: string; message: string }, ctx: { sessionId: string }) {
			const name = p.to.replace(/^@/, "");
			const all = peers(ctx.sessionId);
			const isSession = all.some((s: any) => same(s.name, name));
			// A group handle (e.g. App-Development) fans the message out to every other active session in that group.
			const group = isSession ? undefined : pi.groups.list().find((g: any) => same(handle(g.name), name));
			const targets = group ? all.filter((s: any) => group.sessionIds.includes(s.id)) : [find(ctx.sessionId, name)];
			if (group && !targets.length) throw new Error(`no active sessions in group @${name} other than yourself`);
			const count = (sends.get(ctx.sessionId) ?? 0) + 1;
			if (count > MAX_SENDS_PER_RUN) throw new Error(`at most ${MAX_SENDS_PER_RUN} peer messages per run; stop and report to the user instead`);
			sends.set(ctx.sessionId, count);
			const self = pi.sessions.data.get(ctx.sessionId, "name") ?? named().find((x: any) => x.id === ctx.sessionId)?.name;
			const text = `[from @${self}, another session on this server; answer with peer_send to @${self} only if a reply is needed]\n${p.message}`;
			const done = await Promise.all(targets.map(async (t: any) => {
				await pi.sessions.send(t.id, text);
				return `@${t.name}${t.running ? " (busy; waits for its turn to end)" : ""}`;
			}));
			return reply(`Sent to ${group ? `group @${name}: ` : ""}${done.join(", ")}. They work on their own; use peer_read to check on them later.`, { to: p.to });
		},
	});

	pi.registerTool({
		name: "peer_read",
		label: "Read another session",
		description: "Read what another session has recently said and done (text only, newest last), addressed by name (without @)." + NOTE,
		parameters: T.Object({
			from: T.String({ minLength: 1, maxLength: 60, description: "Member name, without @" }),
			count: T.Optional(T.Integer({ minimum: 1, maximum: 40, description: "How many recent messages (default 10)" })),
		}),
		alwaysActive: true,
		switchable: true,
		async execute(_id: string, p: { from: string; count?: number }, ctx: { sessionId: string }) {
			const peer = find(ctx.sessionId, p.from.replace(/^@/, ""));
			const rows = pi.sessions.messages(peer.id, Math.min(40, Math.max(1, p.count ?? 10)));
			if (!rows.length) return reply(`@${peer.name} has no messages yet.`, { from: p.from });
			const lines = rows.map(({ message: m }: any) => {
				const parts = (Array.isArray(m.content) ? m.content : []) as { type: string; text?: string; name?: string }[];
				const body = parts.map((c) => (c.type === "text" && !c.text?.startsWith(HINT_OPEN) ? c.text : c.type === "toolCall" ? `[tool ${c.name}]` : "")).filter(Boolean).join(" ");
				return `${m.role === "user" ? "user" : m.role === "assistant" ? `@${peer.name}` : m.role}: ${body}`;
			});
			return reply(`${peer.running ? `@${peer.name} is still working.\n` : ""}${cap(lines)}`, { from: p.from });
		},
	});
};
