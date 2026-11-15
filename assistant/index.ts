// assistant: one session that remembers the user and hands work to other sessions.
// Only that session pays for it: its guide, its memory and its two tools (`remember`, `recall`) are left out of every
// other session. Memory is a few short lines; it is updated by the assistant itself and by a small background review
// that reads only the messages since the last one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProfile, isHumanTurn, type Outcome, review, userSamples } from "./learn.ts";
import { BASE_PROMPT, GUIDE } from "./prompts.ts";
import { type Hit, SearchIndex } from "./search.ts";
import { type Change, DEFAULT_BUDGET, type Kind, MemoryError, MemoryStore } from "./store.ts";
import { describe as describeMessage, type StoredLike } from "./text.ts";

const DEFAULTS = {
	review: true,
	reviewTurns: 8,
	role: "assistant",
	profileLimit: DEFAULT_BUDGET.profile,
	noteLimit: DEFAULT_BUDGET.note,
};
type Settings = typeof DEFAULTS;

/** The assistant answers and hands off; writing files is a worker's job, so `write` and `edit` are left out. */
const TOOLS = ["read", "ls", "grep", "bash", "ask_user", "remember", "recall"];
const PAGE = 200;
const REVIEW_CHARS = 20_000;
const PROFILE_CHARS = 30_000;
const PROFILE_SESSIONS = 80;
const HISTORY = 20;
const MARK = "assistant";
const REVIEWED_KEY = "reviewedSeq";

const text = (s: unknown) => ({ content: [{ type: "text" as const, text: String(s) }] });
const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

	const isAssistant = (id: string) => {
		try {
			return pi.sessions.data.get(id, MARK) === true;
		} catch {
			return false;
		}
	};
	const current = () => (pi.sessions.list({ closed: false, limit: 1000 }) as { id: string }[]).find((s) => isAssistant(s.id));

	// ── what was learned, for the page ─────────────────────────────────────────
	const historyFile = join(pi.dataDir, "history.json");
	let history: Outcome[] = [];
	try {
		if (existsSync(historyFile)) history = JSON.parse(readFileSync(historyFile, "utf8"));
	} catch {
		history = [];
	}
	const record = (o: Outcome) => {
		history = [o, ...history].slice(0, HISTORY);
		try {
			writeFileSync(historyFile, JSON.stringify(history));
		} catch (e) {
			pi.log("assistant: cannot write history", e);
		}
		render();
	};

	// ── search index over every session (no model calls, no tokens) ───────────
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
		if (indexing) return;
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
			pi.log("assistant: indexing failed", e);
		} finally {
			indexing = false;
			render();
		}
	};
	// The message is already stored when this runs; reading from the last indexed seq also catches up a session the
	// first fill has not reached yet.
	pi.on("message_end", (e: any) => {
		syncSession(e.sessionId).catch((err) => pi.log("assistant: index update failed", err));
	});
	const unsubscribe = pi.subscribe((e: any) => {
		const id = (e.data as { id?: string } | null)?.id;
		if (id) index.drop(id);
	}, { types: ["session_deleted"] });

	// ── the assistant's prompt: guide + memory, only in its own session ────────
	// Read on every run: unchanged memory gives the same prompt (the provider's cache keeps working); a change costs
	// one uncached call and is seen at once.
	pi.on("before_agent_start", (e: any) => {
		if (!isAssistant(e.sessionId)) return undefined;
		const block = memory.block();
		return { appendSystemPrompt: block ? `${GUIDE}\n\n${block}` : GUIDE };
	});

	// Its tools do nothing outside it, in case a user adds them to another session by hand.
	pi.on("tool_call", (e: any) =>
		(e.toolName === "remember" || e.toolName === "recall") && !isAssistant(e.sessionId)
			? { block: true, reason: "this tool belongs to the assistant session" }
			: undefined,
	);

	// ── background work, one job at a time ─────────────────────────────────────
	const complete = (req: { system: string; input: string; maxTokens?: number }) =>
		pi.models.complete({ role: settings().role, ...req, signal: life.signal });
	let queue: Promise<unknown> = Promise.resolve();
	const pending = new Set<string>();
	let busy: string | null = null;
	const enqueue = (key: string, job: () => Promise<void>) => {
		if (pending.has(key)) return;
		pending.add(key);
		queue = queue.then(async () => {
			if (life.signal.aborted) return;
			busy = key;
			render();
			try {
				await job();
			} catch (e) {
				if (!life.signal.aborted) pi.log(`assistant: ${key} failed`, e);
			} finally {
				pending.delete(key);
				busy = null;
				render();
			}
		});
	};

	const newSince = (sessionId: string) => {
		const reviewed = Number(pi.sessions.data.get(sessionId, REVIEWED_KEY) ?? -1);
		return (pi.sessions.messages(sessionId, PAGE) as StoredLike[]).filter((m) => m.seq > reviewed);
	};

	const reviewSession = (sessionId: string, manual = false) =>
		enqueue(`review:${sessionId}`, async () => {
			const info = pi.sessions.get(sessionId);
			if (!info) return;
			const fresh = newSince(sessionId);
			const base = { at: Date.now(), kind: "review" as const, sessionId, title: info.title };
			if (!fresh.some(isHumanTurn)) {
				if (manual) record({ ...base, summary: "Nothing new since the last review.", changes: [] });
				return;
			}
			try {
				const out = await review({ complete, memory, messages: fresh, maxChars: REVIEW_CHARS });
				pi.sessions.data.set(sessionId, REVIEWED_KEY, fresh.at(-1)!.seq);
				record({ ...base, ...out });
			} catch (e) {
				record({ ...base, summary: "Review failed.", changes: [], error: errorText(e) });
			}
		});

	pi.on("agent_end", (e: any) => {
		const s = settings();
		if (!s.review || !isAssistant(e.sessionId)) return;
		try {
			if (newSince(e.sessionId).filter(isHumanTurn).length >= s.reviewTurns) reviewSession(e.sessionId);
		} catch (err) {
			pi.log("assistant: review check failed", err);
		}
	});

	const profile = () =>
		enqueue("profile", async () => {
			const base = { at: Date.now(), kind: "profile" as const };
			const sessions = (pi.sessions.list({ limit: PROFILE_SESSIONS }) as { id: string; title: string }[]).map((s) => ({ title: s.title, messages: pi.sessions.messages(s.id, PAGE) as StoredLike[] }));
			const samples = userSamples(sessions, PROFILE_CHARS);
			if (!samples) return record({ ...base, summary: "No messages to learn from yet.", changes: [] });
			try {
				record({ ...base, ...(await buildProfile({ complete, memory, samples })) });
			} catch (e) {
				record({ ...base, summary: "Profile analysis failed.", changes: [], error: errorText(e) });
			}
		});

	// ── tools (only in the assistant session) ──────────────────────────────────
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

	// ── opening the assistant ──────────────────────────────────────────────────
	const create = async () => {
		const s = await pi.sessions.create({ title: "Assistant", systemPrompt: BASE_PROMPT, tools: TOOLS });
		pi.sessions.data.set(s.id, MARK, true);
		pi.sessions.update(s.id, { purpose: "Personal assistant: remembers the user, hands work to other sessions" });
		pi.notify({ title: "Assistant", body: "Ready", sessionId: s.id, key: "assistant-open" });
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

	pi.registerCommand("assistant", {
		description: "Assistant: learn (review this session now), profile (learn from past chats), new (start a fresh assistant)",
		args: "[learn|profile|new]",
		handler: async (args: string, ctx: any) => {
			const verb = args.trim().toLowerCase();
			if (verb === "learn") reviewSession(ctx.sessionId, true);
			else if (verb === "profile") profile();
			else if (verb === "new") await fresh();
			else await open();
		},
	});

	// ── extension page ─────────────────────────────────────────────────────────
	const hasUi = typeof pi.ui?.setPanel === "function";
	let lastError = "";
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
			const state = busy?.startsWith("review:")
				? { ko: "대화 복기 중", en: "Reviewing" }
				: busy === "profile"
					? { ko: "프로필 분석 중", en: "Learning from past chats" }
					: indexing
						? { ko: "대화 색인 중", en: "Indexing" }
						: { ko: "대기", en: "Idle" };
			pi.ui.setPanel({
				type: "stack",
				id: "root",
				gap: "large",
				children: [
					{
						type: "card",
						id: "status",
						title: { ko: "상태", en: "Status" },
						children: [
							{ type: "badge", id: "state", text: state, tone: busy || indexing ? "info" : "neutral" },
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
							...(lastError ? [{ type: "alert", id: "error", tone: "danger", text: lastError }] : []),
							{
								type: "stack",
								id: "actions",
								direction: "horizontal",
								children: [
									{ type: "button", id: "open", variant: "primary", label: { ko: "도우미 열기", en: "Open assistant" } },
									{ type: "button", id: "fresh", label: { ko: "새 대화로 시작", en: "Start fresh" } },
									{ type: "button", id: "profile", label: { ko: "과거 대화로 프로필 만들기", en: "Learn from past chats" }, disabled: pending.has("profile") },
									{ type: "button", id: "reindex", label: { ko: "검색 색인 다시 만들기", en: "Rebuild search index" }, disabled: indexing },
								],
							},
						],
					},
					{
						type: "card",
						id: "recent",
						title: { ko: "최근 학습", en: "Recent learning" },
						children: [
							{
								type: "list",
								id: "history",
								emptyText: { ko: "아직 없습니다. 도우미와 대화가 쌓이면 자동으로 복기합니다.", en: "Nothing yet. Assistant conversations are reviewed as they grow." },
								items: history.slice(0, 8).map((o, i) => ({
									id: `h${i}`,
									title: `${when(o.at)} · ${o.kind === "profile" ? "profile" : (o.title ?? "review").slice(0, 60)}`,
									description: [o.summary, ...o.changes, ...(o.error ? [`! ${o.error}`] : [])].join(" · ").slice(0, 480),
									...(o.error ? { badge: "error" } : o.changes.length ? { badge: String(o.changes.length) } : {}),
								})),
							},
						],
					},
					{
						type: "card",
						id: "edit",
						title: { ko: "메모리 직접 고치기", en: "Edit memory" },
						description: { ko: "한 줄에 하나씩 씁니다.", en: "One entry per line." },
						children: [
							{
								type: "form",
								id: "memory-form",
								submitLabel: { ko: "메모리 저장", en: "Save memory" },
								children: [
									{ type: "textarea", id: "profile-text", label: { ko: "사용자 프로필", en: "Profile" }, rows: 8, value: memory.entries("profile").map((e) => e.text).join("\n") },
									{ type: "textarea", id: "note-text", label: { ko: "환경 메모", en: "Notes" }, rows: 8, value: memory.entries("note").map((e) => e.text).join("\n") },
								],
							},
						],
					},
				],
			});
		} catch (e) {
			pi.log("assistant: page failed", e);
		}
	}
	if (hasUi) {
		pi.ui.onEvent(async (e: any) => {
			lastError = "";
			try {
				if (e.type === "action" && e.id === "open") await open();
				else if (e.type === "action" && e.id === "fresh") await fresh();
				else if (e.type === "action" && e.id === "profile") profile();
				else if (e.type === "action" && e.id === "reindex") {
					index.clear();
					void backfill();
				} else if (e.type === "submit" && e.id === "memory-form") {
					memory.replace("profile", String(e.values["profile-text"] ?? "").split("\n"));
					memory.replace("note", String(e.values["note-text"] ?? "").split("\n"));
				}
			} catch (err) {
				lastError = errorText(err);
			}
			render();
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
