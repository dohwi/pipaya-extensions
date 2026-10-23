// peer-tools: lets an agent message and read the other active sessions of this server, by `@name` or `@group`.
const MAX_SENDS_PER_RUN = 10;
const MESSAGE_CHARS = 600;
const TOTAL_CHARS = 6000;
const HINT_OPEN = "<pipaya-hint>";
// The tool list is built once per session, but sessions come and go later: never put names in a description.
const NOTE = " Sessions are the user's @names; an unknown name is rejected with the current list.";

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

export default (pi: any) => {
	const T = pi.Type;
	/** `peer_send` calls in each session's current run; keeps two sessions from answering each other forever. */
	const sends = new Map<string, number>();
	pi.on("agent_start", (e: { sessionId: string }) => void sends.delete(e.sessionId));
	pi.on("session_shutdown", (e: { sessionId: string }) => void sends.delete(e.sessionId));

	const peers = (self: string) => pi.sessions.list({ closed: false }).filter((s: any) => s.id !== self && s.name);
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const find = (self: string, name: string) => {
		const all = peers(self);
		const peer = all.find((p: any) => same(p.name, name));
		if (!peer) throw new Error(`session @${name} not found (sessions: ${all.map((p: any) => `@${p.name}`).join(", ") || "none"})`);
		return peer;
	};
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
		mutating: false,
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
			const self = pi.sessions.get(ctx.sessionId)?.name;
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
		mutating: false,
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
