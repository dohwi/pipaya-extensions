// memory: one main session that remembers the user and hands work to other sessions.
// Only that session pays for it: its guide, its memory and its two tools (`remember`, `recall`) are left out of every
// other session. Memory is a few short lines, kept up to date by the session itself and by a small background review
// that reads only the messages since the last one.
import { join } from "node:path";
import { isHumanTurn, type ReviewResult, review } from "./learn.ts";
import { BASE_PROMPT, GUIDE } from "./prompts.ts";
import { type Hit, SearchIndex } from "./search.ts";
import { type Change, DEFAULT_BUDGET, type Kind, MemoryError, MemoryStore } from "./store.ts";
import { describe as describeMessage, type StoredLike } from "./text.ts";

const DEFAULTS = {
	review: true,
	reviewTurns: 8,
	role: "memory",
	profileLimit: DEFAULT_BUDGET.profile,
	noteLimit: DEFAULT_BUDGET.note,
};
type Settings = typeof DEFAULTS;

/** The main session answers and hands off; writing files is a worker's job, so `write` and `edit` are left out. */
const TOOLS = ["read", "ls", "grep", "bash", "ask_user", "remember", "recall"];
const PAGE = 200;
const REVIEW_CHARS = 20_000;
const MARK = "main";
const REVIEWED_KEY = "reviewedSeq";

const text = (s: unknown) => ({ content: [{ type: "text" as const, text: String(s) }] });
const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export default (pi: any) => {
	const T = pi.Type;
	const settings = (): Settings => {
		let raw: Record<string, unknown> = {};
		try {
			raw = pi.settings.get() ?? {};
		} catch {
			/* no settings store: defaults */
		}
		const s = { ...DEFAULTS, ...raw } as Settings;
		s.reviewTurns = num(s.reviewTurns, DEFAULTS.reviewTurns, 1, 100);
		s.profileLimit = num(s.profileLimit, DEFAULTS.profileLimit, 200, 20_000);
		s.noteLimit = num(s.noteLimit, DEFAULTS.noteLimit, 200, 20_000);
		s.role = typeof s.role === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(s.role) ? s.role : DEFAULTS.role;
		return s;
	};

	const memory = new MemoryStore(pi.dataDir, () => {
		const s = settings();
		return { profile: s.profileLimit, note: s.noteLimit };
	});
	const index = new SearchIndex(join(pi.dataDir, "search.sqlite"));
	const life = new AbortController();

	const isMain = (id: string) => {
		try {
			return pi.sessions.data.get(id, MARK) === true;
		} catch {
			return false;
		}
	};
	const current = () => (pi.sessions.list({ closed: false, limit: 1000 }) as { id: string }[]).find((s) => isMain(s.id));

	// ── search index over every session (no model calls) ───────────────────────
	let indexing = false;
	const syncSession = async (id: string) => {
		for (;;) {
			if (life.signal.aborted) return;
			const page = pi.sessions.messages(id, PAGE, { after: index.lastSeq(id) }) as StoredLike[];
			if (!page.length) return;
			index.addMany(id, page);
			if (page.length < PAGE) return;
			await Bun.sleep(0);
		}
	};
	const backfill = async () => {
		indexing = true;
		render();
		try {
			const known = new Set<string>();
			for (const s of pi.sessions.list({ limit: 5000 })) {
				known.add(s.id);
				await syncSession(s.id);
				await Bun.sleep(0);
			}
			for (const id of index.sessionIds()) if (!known.has(id)) index.drop(id);
		} catch (e) {
			pi.log("memory: indexing failed", e);
		} finally {
			indexing = false;
			render();
		}
	};
	// The message is already stored when this runs; reading from the last indexed seq also catches up a session the
	// first fill has not reached yet.
	pi.on("message_end", (e: any) => {
		syncSession(e.sessionId).catch((err) => pi.log("memory: index update failed", err));
	});
	const unsubscribe = pi.subscribe((e: any) => {
		const id = (e.data as { id?: string } | null)?.id;
		if (id) index.drop(id);
	}, { types: ["session_deleted"] });

	// ── prompt: guide + memory, only in the main session ───────────────────────
	// Read on every run: unchanged memory gives the same prompt (the provider's cache keeps working); a change costs
	// one uncached call and is seen at once.
	pi.on("before_agent_start", (e: any) => {
		if (!isMain(e.sessionId)) return undefined;
		const block = memory.block();
		return { appendSystemPrompt: block ? `${GUIDE}\n\n${block}` : GUIDE };
	});

	// The tools do nothing outside the main session, in case someone adds them to another one by hand.
	pi.on("tool_call", (e: any) =>
		(e.toolName === "remember" || e.toolName === "recall") && !isMain(e.sessionId)
			? { block: true, reason: "this tool belongs to the main session" }
			: undefined,
	);

	// ── background review, one at a time ───────────────────────────────────────
	let queue: Promise<unknown> = Promise.resolve();
	const pending = new Set<string>();
	let reviewing = false;
	let lastReview: (ReviewResult & { at: number }) | null = null;

	const newSince = (sessionId: string) => {
		const reviewed = Number(pi.sessions.data.get(sessionId, REVIEWED_KEY) ?? -1);
		return (pi.sessions.messages(sessionId, PAGE) as StoredLike[]).filter((m) => m.seq > reviewed);
	};

	const reviewSession = (sessionId: string) => {
		if (pending.has(sessionId)) return;
		pending.add(sessionId);
		queue = queue.then(async () => {
			if (life.signal.aborted) return;
			reviewing = true;
			render();
			try {
				const fresh = newSince(sessionId);
				if (!fresh.some(isHumanTurn)) return;
				const out = await review({
					complete: (req) => pi.models.complete({ role: settings().role, ...req, signal: life.signal }),
					memory,
					messages: fresh,
					maxChars: REVIEW_CHARS,
				});
				pi.sessions.data.set(sessionId, REVIEWED_KEY, fresh.at(-1)!.seq);
				lastReview = { at: Date.now(), ...out };
			} catch (e) {
				if (!life.signal.aborted) lastReview = { at: Date.now(), summary: "Review failed.", changes: [], error: e instanceof Error ? e.message : String(e) };
			} finally {
				pending.delete(sessionId);
				reviewing = false;
				render();
			}
		});
	};

	pi.on("agent_end", (e: any) => {
		const s = settings();
		if (!s.review || !isMain(e.sessionId)) return;
		try {
			if (newSince(e.sessionId).filter(isHumanTurn).length >= s.reviewTurns) reviewSession(e.sessionId);
		} catch (err) {
			pi.log("memory: review check failed", err);
		}
	});

	// ── tools (main session only) ──────────────────────────────────────────────
	pi.registerTool({
		name: "remember",
		label: "Memory",
		defaultActive: false,
		description:
			"Change long-term memory (shown in your prompt). No `changes`: list entries. Change: {op:'add',kind:'profile'|'note',text} | {op:'edit',id,text} | {op:'drop',id}; ids like p3/n7. profile = the user, note = their environment. All changes apply together; when a kind is full, drop or shorten entries in the same call.",
		parameters: T.Object({
			changes: T.Optional(
				T.Array(
					T.Object({
						op: T.Union([T.Literal("add"), T.Literal("edit"), T.Literal("drop")]),
						kind: T.Optional(T.Union([T.Literal("profile"), T.Literal("note")])),
						id: T.Optional(T.String({ maxLength: 20 })),
						text: T.Optional(T.String({ maxLength: 500 })),
					}),
					{ maxItems: 20 },
				),
			),
		}),
		execute: async (_id: string, p: { changes?: Change[] }) => {
			if (!p.changes?.length) return text(memory.summary());
			try {
				const added = memory.apply(p.changes);
				render();
				return text(`Saved${added.length ? ` (${added.join(", ")})` : ""}.`);
			} catch (e) {
				if (e instanceof MemoryError) return { ...text(`Not saved: ${e.message}\n\n${memory.summary()}`), details: { error: true } };
				throw e;
			}
		},
	});

	const formatHits = (hits: Hit[], sessions: number) => {
		const groups = new Map<string, Hit[]>();
		for (const h of hits) {
			let g = groups.get(h.sessionId);
			if (!g) {
				if (groups.size >= sessions) continue;
				g = [];
				groups.set(h.sessionId, g);
			}
			if (g.length < 3) g.push(h);
		}
		if (!groups.size) return "No matches.";
		return [...groups.entries()]
			.map(([id, g]) => {
				const info = pi.sessions.get(id);
				return `${info?.title ?? "(deleted)"} [${id}${info ? `, ${when(info.updatedAt)}` : ""}]\n${g.map((h) => `  #${h.seq} ${h.role}: ${h.snippet}`).join("\n")}`;
			})
			.join("\n");
	};

	pi.registerTool({
		name: "recall",
		label: "Past conversations",
		defaultActive: false,
		description:
			"Search every earlier conversation on this server. `query`: words that must all appear (\"a phrase\" = one term) → sessions with message numbers. `session`+`around`: read around a hit. `session` alone: its latest messages. Nothing: recent sessions.",
		parameters: T.Object({
			query: T.Optional(T.String({ maxLength: 200 })),
			session: T.Optional(T.String({ maxLength: 80 })),
			around: T.Optional(T.Integer({ minimum: 0 })),
			count: T.Optional(T.Integer({ minimum: 1, maximum: 40 })),
		}),
		execute: async (_id: string, p: { query?: string; session?: string; around?: number; count?: number }, ctx: any) => {
			if (p.session) {
				const info = pi.sessions.get(p.session);
				if (!info) return text(`No session ${p.session}.`);
				const n = p.count ?? 12;
				const msgs = (p.around !== undefined
					? pi.sessions.messages(p.session, n, { after: Math.max(-1, p.around - Math.ceil(n / 2) - 1) })
					: pi.sessions.messages(p.session, n)) as StoredLike[];
				const body = msgs.map((m) => describeMessage(m, { toolChars: 150, textChars: 1200 })).filter(Boolean).join("\n");
				return text(`${info.title} [${info.id}, ${info.cwd}]\n${body || "(no messages)"}`);
			}
			if (p.query?.trim()) return text(formatHits(index.search(p.query, { limit: 200, exclude: ctx?.sessionId }), p.count ?? 5));
			const n = p.count ?? 5;
			const recent = (pi.sessions.list({ limit: n + 1 }) as any[]).filter((s) => s.id !== ctx?.sessionId).slice(0, n);
			return text(recent.map((s) => `${s.title} [${s.id}, ${when(s.updatedAt)}]${s.purpose ? ` ${s.purpose}` : ""}`).join("\n") || "No other sessions.");
		},
	});

	// ── opening the main session ───────────────────────────────────────────────
	const create = async () => {
		const s = await pi.sessions.create({ title: "Assistant", systemPrompt: BASE_PROMPT, tools: TOOLS });
		pi.sessions.data.set(s.id, MARK, true);
		pi.sessions.update(s.id, { purpose: "Main contact: remembers the user, hands work to other sessions" });
		render();
		return s;
	};
	const open = async () => current() ?? (await create());
	/** A long conversation gets expensive: close it (after a last review) and start a new one with the same memory. */
	const fresh = async () => {
		const old = current();
		if (old) {
			reviewSession(old.id);
			pi.sessions.update(old.id, { closed: true });
		}
		return create();
	};
	pi.registerMethod("open", async () => ({ id: (await open()).id }));
	pi.registerMethod("fresh", async () => ({ id: (await fresh()).id }));

	pi.registerCommand("memory", {
		description: "Open the main session that remembers you; `new` starts a fresh one with the same memory",
		args: "[new]",
		handler: async (args: string) => {
			if (args.trim().toLowerCase() === "new") await fresh();
			else await open();
		},
	});

	// ── extension page: status and two buttons ─────────────────────────────────
	const hasUi = typeof pi.ui?.setPanel === "function";
	function render() {
		if (!hasUi) return;
		try {
			const c = index.count();
			const stat = (kind: Kind, id: string, ko: string, en: string) => ({
				type: "stat",
				id,
				label: { ko, en },
				value: `${memory.used(kind)}/${memory.limit(kind)}`,
				hint: { ko: `항목 ${memory.entries(kind).length}개`, en: `${memory.entries(kind).length} entries` },
			});
			const state = reviewing ? { ko: "대화 복기 중", en: "Reviewing" } : indexing ? { ko: "대화 색인 중", en: "Indexing" } : { ko: "대기", en: "Idle" };
			const last = lastReview;
			pi.ui.setPanel({
				type: "card",
				id: "status",
				title: { ko: "상태", en: "Status" },
				children: [
					{ type: "badge", id: "state", text: state, tone: reviewing || indexing ? "info" : "neutral" },
					{
						type: "grid",
						id: "stats",
						columns: 3,
						children: [
							stat("profile", "profile-size", "사용자 프로필", "Profile"),
							stat("note", "note-size", "환경 메모", "Notes"),
							{ type: "stat", id: "index-size", label: { ko: "색인된 메시지", en: "Indexed messages" }, value: String(c.messages), hint: { ko: `세션 ${c.sessions}개`, en: `${c.sessions} sessions` } },
						],
					},
					...(last
						? [{ type: "alert", id: "last-review", tone: last.error ? "danger" : "info", text: `${when(last.at)} · ${[last.summary, ...last.changes, ...(last.error ? [last.error] : [])].join(" · ")}`.slice(0, 2000) }]
						: []),
					{
						type: "stack",
						id: "actions",
						direction: "horizontal",
						children: [
							{ type: "button", id: "open", variant: "primary", label: { ko: "메인 세션 열기", en: "Open main session" } },
							{ type: "button", id: "fresh", label: { ko: "새 대화로 시작", en: "Start fresh" } },
						],
					},
				],
			});
		} catch (e) {
			pi.log("memory: page failed", e);
		}
	}
	if (hasUi) {
		pi.ui.onEvent(async (e: any) => {
			if (e.type !== "action") return;
			if (e.id === "open") await open();
			else if (e.id === "fresh") await fresh();
		});
	}

	render();
	const start = setTimeout(() => void backfill(), 1000);
	pi.on("extension_unload", () => {
		clearTimeout(start);
		life.abort();
		unsubscribe?.();
		try {
			index.close();
		} catch {
			/* already closed */
		}
	});
};
