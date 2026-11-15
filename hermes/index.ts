// Hermes: the learning loop of Nous Research's Hermes Agent, on top of pipaya.
// - memory: USER.md + MEMORY.md, bounded, put into every session's system prompt as a snapshot taken at its first run
// - session_search: full-text search over every past conversation (own FTS5 index in the extension's data folder)
// - skill_manage: the agent writes and improves skills in ~/.agents/skills
// - background review: after a few turns a model reads the conversation and updates memory and skills
// - orchestrator mode: one session the user talks to, which hands work to other sessions (peer, delegate, schedule)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMITS, MemoryError, MemoryStore, type Operation, type Target } from "./memory.ts";
import { ORCHESTRATOR, TOOL_GUIDE } from "./prompts.ts";
import { buildProfile, isHumanTurn, type Outcome, reviewConversation, userSamples } from "./review.ts";
import { type Hit, SearchIndex } from "./search.ts";
import { SkillError, SkillLibrary } from "./skills.ts";
import { describe as describeMessage, type StoredLike } from "./text.ts";

const DEFAULTS = {
	inject: true,
	review: true,
	reviewTurns: 6,
	learnSkills: true,
	editOtherSkills: false,
	role: "hermes",
	userLimit: DEFAULT_LIMITS.user,
	memoryLimit: DEFAULT_LIMITS.memory,
};
type Settings = typeof DEFAULTS;

const PAGE = 200;
const REVIEW_CHARS = 60_000;
const PROFILE_CHARS = 40_000;
const HISTORY = 20;
const ORCH_KEY = "orchestrator";
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
			/* settings not available: defaults */
		}
		const s = { ...DEFAULTS, ...raw } as Settings;
		s.reviewTurns = num(s.reviewTurns, DEFAULTS.reviewTurns, 1, 100);
		s.userLimit = num(s.userLimit, DEFAULTS.userLimit, 200, 20_000);
		s.memoryLimit = num(s.memoryLimit, DEFAULTS.memoryLimit, 200, 20_000);
		s.role = typeof s.role === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(s.role) ? s.role : DEFAULTS.role;
		return s;
	};

	const memory = new MemoryStore(join(pi.dataDir, "memories"), () => {
		const s = settings();
		return { user: s.userLimit, memory: s.memoryLimit };
	});
	const library = new SkillLibrary(() => join(pi.home, ".agents", "skills"), () => settings().editOtherSkills);
	const index = new SearchIndex(join(pi.dataDir, "search.sqlite"));
	const life = new AbortController();

	// ── history of reviews (for the page) ──────────────────────────────────────
	const historyFile = join(pi.dataDir, "history.json");
	let history: Outcome[] = [];
	try {
		if (existsSync(historyFile)) history = JSON.parse(readFileSync(historyFile, "utf8"));
	} catch {
		history = [];
	}
	const remember = (o: Outcome) => {
		history = [o, ...history].slice(0, HISTORY);
		try {
			writeFileSync(historyFile, JSON.stringify(history));
		} catch (e) {
			pi.log("hermes: cannot write history", e);
		}
		render();
	};

	// ── search index: backfill once, then follow new messages ─────────────────
	let indexing = false;
	const syncSession = async (id: string) => {
		for (;;) {
			if (life.signal.aborted) return;
			const after = index.lastSeq(id);
			const page = pi.sessions.messages(id, PAGE, { after }) as StoredLike[];
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
			pi.log("hermes: indexing failed", e);
		} finally {
			indexing = false;
			render();
		}
	};
	// The message is stored before this hook runs. Reading from the last indexed seq (instead of adding just this one)
	// keeps a session that the first backfill has not reached yet from being marked as done past its older messages.
	pi.on("message_end", (e: any) => {
		syncSession(e.sessionId).catch((err) => pi.log("hermes: index update failed", err));
	});
	const unsubscribe = pi.subscribe((e: any) => {
		const id = (e.data as { id?: string } | null)?.id;
		if (id) {
			index.drop(id);
			snapshots.delete(id);
		}
	}, { types: ["session_deleted"] });

	// ── memory snapshot per session (frozen, so the model's prompt cache keeps working) ──
	const snapshots = new Map<string, string>();
	pi.on("before_agent_start", (e: any) => {
		const s = settings();
		const parts: string[] = [];
		let orchestrator = false;
		try {
			orchestrator = pi.sessions.data.get(e.sessionId, ORCH_KEY) === true;
		} catch {
			/* unknown session */
		}
		if (orchestrator) parts.push(ORCHESTRATOR);
		if (s.inject) {
			let snap = snapshots.get(e.sessionId);
			if (snap === undefined) {
				snap = memory.block();
				snapshots.set(e.sessionId, snap);
			}
			parts.push(TOOL_GUIDE);
			if (snap) parts.push(snap);
		}
		return parts.length ? { appendSystemPrompt: parts.join("\n\n") } : undefined;
	});

	// ── background review ──────────────────────────────────────────────────────
	const complete = (req: { system: string; input: string; maxTokens?: number; signal?: AbortSignal }) =>
		pi.models.complete({ role: settings().role, system: req.system, input: req.input, maxTokens: req.maxTokens, signal: AbortSignal.any([life.signal, ...(req.signal ? [req.signal] : [])]) });

	let queue: Promise<unknown> = Promise.resolve();
	const pending = new Set<string>();
	let busy: string | null = null;
	const enqueue = (key: string, job: () => Promise<void>) => {
		if (pending.has(key)) return false;
		pending.add(key);
		queue = queue.then(async () => {
			if (life.signal.aborted) return;
			busy = key;
			render();
			try {
				await job();
			} catch (e) {
				if (!life.signal.aborted) pi.log(`hermes: ${key} failed`, e);
			} finally {
				pending.delete(key);
				busy = null;
				render();
			}
		});
		return true;
	};

	const reviewSession = (sessionId: string, manual = false) =>
		enqueue(`review:${sessionId}`, async () => {
			const s = settings();
			const info = pi.sessions.get(sessionId);
			if (!info) return;
			const reviewed = Number(pi.sessions.data.get(sessionId, REVIEWED_KEY) ?? -1);
			const messages = pi.sessions.messages(sessionId, PAGE) as StoredLike[];
			const fresh = messages.filter((m) => m.seq > reviewed);
			const last = messages.at(-1)?.seq ?? reviewed;
			if (!fresh.some(isHumanTurn)) {
				if (manual) remember({ at: Date.now(), kind: "review", sessionId, title: info.title, summary: "Nothing new to review.", changes: [], errors: [] });
				return;
			}
			try {
				const out = await reviewConversation({
					complete,
					memory,
					skills: s.learnSkills ? library : null,
					editOthers: s.editOtherSkills,
					messages,
					fromSeq: fresh[0]?.seq ?? 0,
					maxChars: REVIEW_CHARS,
				});
				pi.sessions.data.set(sessionId, REVIEWED_KEY, last);
				remember({ at: Date.now(), kind: "review", sessionId, title: info.title, ...out });
				if (manual) pi.notify({ title: "Hermes", body: out.summary, sessionId, key: `hermes-review-${sessionId}` });
			} catch (e) {
				remember({ at: Date.now(), kind: "review", sessionId, title: info.title, summary: "Review failed.", changes: [], errors: [e instanceof Error ? e.message : String(e)] });
			}
		});

	pi.on("agent_end", (e: any) => {
		const s = settings();
		if (!s.review) return;
		try {
			const reviewed = Number(pi.sessions.data.get(e.sessionId, REVIEWED_KEY) ?? -1);
			const recent = (pi.sessions.messages(e.sessionId, PAGE) as StoredLike[]).filter((m) => m.seq > reviewed);
			if (recent.filter(isHumanTurn).length >= s.reviewTurns) reviewSession(e.sessionId);
		} catch (err) {
			pi.log("hermes: review check failed", err);
		}
	});

	const profile = () =>
		enqueue("profile", async () => {
			const sessions = (pi.sessions.list({ limit: 80 }) as { id: string; title: string }[]).map((s) => ({ title: s.title, messages: pi.sessions.messages(s.id, PAGE) as StoredLike[] }));
			const samples = userSamples(sessions, PROFILE_CHARS);
			if (!samples) {
				remember({ at: Date.now(), kind: "profile", summary: "No messages to learn from yet.", changes: [], errors: [] });
				return;
			}
			try {
				const out = await buildProfile({ complete, memory, samples });
				remember({ at: Date.now(), kind: "profile", ...out });
				pi.notify({ title: "Hermes", body: out.summary, key: "hermes-profile" });
			} catch (e) {
				remember({ at: Date.now(), kind: "profile", summary: "Profile analysis failed.", changes: [], errors: [e instanceof Error ? e.message : String(e)] });
			}
		});

	// ── tools ──────────────────────────────────────────────────────────────────
	const Op = T.Object({
		action: T.Union([T.Literal("add"), T.Literal("patch"), T.Literal("remove")]),
		content: T.Optional(T.String({ maxLength: 4000, description: "add: the new entry. patch: the entry's full new text." })),
		old_text: T.Optional(T.String({ maxLength: 1000, description: "patch, remove: text found in exactly one current entry." })),
	});
	pi.registerTool({
		name: "memory",
		label: "Memory",
		alwaysActive: true,
		switchable: true,
		description: [
			"Save durable facts to persistent memory that survives across sessions. Memory is put into the system prompt of every new session, so keep entries compact and high-signal.",
			"HOW: make ALL changes to one target in ONE call via `operations` (each {action, content?, old_text?}). The batch applies atomically and the character limit is checked on the result only, so one call can remove or shorten stale entries AND add new ones.",
			"WHEN: only facts that apply to every session: who the user is, stable preferences, environment facts, standing conventions. Procedures and pitfalls of a kind of task go into a skill (skill_manage).",
			"TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).",
			"SKIP: trivial or easily re-discovered facts, raw data, task progress, completed-work logs (session_search finds those). Omit `operations` to just view a store.",
		].join("\n"),
		parameters: T.Object({
			target: T.Union([T.Literal("user"), T.Literal("memory")], { description: "'user' for the user profile (USER.md), 'memory' for your notes (MEMORY.md)." }),
			operations: T.Optional(T.Array(Op, { maxItems: 20 })),
		}),
		execute: async (_id: string, p: { target: Target; operations?: Operation[] }) => {
			if (!p.operations?.length) return text(memory.view(p.target));
			try {
				memory.apply(p.target, p.operations);
				render();
				return text(`Saved. ${memory.view(p.target)}\n(Applies to new sessions; this one keeps its snapshot.)`);
			} catch (e) {
				if (e instanceof MemoryError) return { ...text(`Not saved: ${e.message}\n${memory.view(p.target)}`), details: { error: true } };
				throw e;
			}
		},
	});

	const formatHits = (hits: Hit[], sessions: number) => {
		const groups = new Map<string, Hit[]>();
		for (const h of hits) {
			const g = groups.get(h.sessionId) ?? [];
			if (!groups.has(h.sessionId)) {
				if (groups.size >= sessions) continue;
				groups.set(h.sessionId, g);
			}
			if (g.length < 3) g.push(h);
		}
		if (!groups.size) return "No matching messages.";
		return [...groups.entries()]
			.map(([id, g]) => {
				const info = pi.sessions.get(id);
				const head = `## ${info?.title ?? "(deleted session)"} — session_id ${id}${info ? `, last used ${when(info.updatedAt)}` : ""}`;
				return `${head}\n${g.map((h) => `- [#${h.seq} ${h.role}, ${when(h.createdAt)}] ${h.snippet}`).join("\n")}`;
			})
			.join("\n\n");
	};

	pi.registerTool({
		name: "session_search",
		label: "Search past conversations",
		alwaysActive: true,
		switchable: true,
		description: [
			"Search or read past conversations on this server (every session, closed ones too). Results are the stored messages, no summaries.",
			"`query` = find sessions whose user or assistant messages contain every word (a quoted phrase stays one term); best matches first, grouped by session with the message seq.",
			"`session_id` + `around_seq` = read the messages around one hit. `session_id` alone = the newest messages of that session. No arguments = the most recently used sessions.",
			"Use it for 'what did we decide about X', 'where did we leave Y', or to recall a preference before asking the user again. It searches history only: when the user gave a direct source (file, URL, live system), check that first.",
		].join("\n"),
		parameters: T.Object({
			query: T.Optional(T.String({ maxLength: 200 })),
			session_id: T.Optional(T.String({ maxLength: 80 })),
			around_seq: T.Optional(T.Integer({ minimum: 0 })),
			count: T.Optional(T.Integer({ minimum: 1, maximum: 60, description: "messages to read (default 20) or sessions to list (default 5)" })),
		}),
		execute: async (_id: string, p: { query?: string; session_id?: string; around_seq?: number; count?: number }, ctx: any) => {
			if (p.session_id) {
				const info = pi.sessions.get(p.session_id);
				if (!info) return text(`No session ${p.session_id}.`);
				const n = p.count ?? 20;
				const msgs = (p.around_seq !== undefined
					? pi.sessions.messages(p.session_id, n, { after: Math.max(-1, p.around_seq - Math.ceil(n / 2) - 1) })
					: pi.sessions.messages(p.session_id, n)) as StoredLike[];
				const body = msgs.map((m) => describeMessage(m, { toolChars: 200, textChars: 2000 })).filter(Boolean).join("\n");
				return text(`# ${info.title} (session_id ${info.id}, ${info.cwd}, last used ${when(info.updatedAt)})\n${body || "(no messages)"}`);
			}
			if (p.query?.trim()) {
				const hits = index.search(p.query, { limit: 200, exclude: ctx?.sessionId });
				return text(formatHits(hits, p.count ?? 5));
			}
			const recent = (pi.sessions.list({ limit: (p.count ?? 5) + 1 }) as any[]).filter((s) => s.id !== ctx?.sessionId).slice(0, p.count ?? 5);
			return text(recent.map((s) => `- ${s.title} — session_id ${s.id}, ${s.cwd}, last used ${when(s.updatedAt)}${s.purpose ? `\n  ${s.purpose}` : ""}`).join("\n") || "No other sessions.");
		},
	});

	pi.registerTool({
		name: "skill_manage",
		label: "Manage skills",
		alwaysActive: true,
		switchable: true,
		description: [
			"Create and improve skills in ~/.agents/skills (they load in new sessions). A skill is how to do a class of task for THIS user: the procedure, commands that work, the order, the user's preferences for the result, the pitfalls.",
			"Actions: list; view (name, file_path?); create (name, description, body); update (name, description?, body?); patch (name, old_text, new_text, file_path?) replaces one exact unique piece of text; write_file (name, file_path, content) adds references/<topic>.md, templates/... or scripts/....",
			"Prefer patching a skill that covers the class of task over creating a new one; names are class-level kebab-case, never a one-off task. View before you patch. Skills you did not create are read-only unless the user allowed editing them.",
		].join("\n"),
		parameters: T.Object({
			action: T.Union(["list", "view", "create", "update", "patch", "write_file"].map((a) => T.Literal(a))),
			name: T.Optional(T.String({ maxLength: 64 })),
			description: T.Optional(T.String({ maxLength: 1024 })),
			body: T.Optional(T.String({ maxLength: 20_000 })),
			old_text: T.Optional(T.String({ maxLength: 20_000 })),
			new_text: T.Optional(T.String({ maxLength: 20_000 })),
			file_path: T.Optional(T.String({ maxLength: 200 })),
			content: T.Optional(T.String({ maxLength: 40_000 })),
		}),
		execute: async (_id: string, p: any) => {
			try {
				const need = (k: string) => {
					if (typeof p[k] !== "string") throw new SkillError(`${k} is required for ${p.action}`);
					return p[k] as string;
				};
				switch (p.action) {
					case "list": {
						const all = library.list();
						const edit = settings().editOtherSkills;
						return text(all.length ? all.map((s) => `- ${s.name}${s.ownedByHermes || edit ? "" : " (read-only)"}: ${s.description}`).join("\n") : "No skills in ~/.agents/skills yet.");
					}
					case "view":
						return text(library.view(need("name"), p.file_path));
					case "create":
						if (!settings().learnSkills) throw new SkillError("skill learning is switched off in the Hermes settings");
						library.create(need("name"), need("description"), need("body"));
						render();
						return text(`Created skill ${p.name}. New sessions see it.`);
					case "update":
						library.update(need("name"), { description: p.description, body: p.body });
						return text(`Updated skill ${p.name}.`);
					case "patch":
						library.patch(need("name"), need("old_text"), need("new_text"), p.file_path);
						return text(`Patched ${p.file_path ?? "SKILL.md"} of ${p.name}.`);
					case "write_file":
						library.writeFile(need("name"), need("file_path"), need("content"));
						return text(`Wrote ${p.file_path} in ${p.name}.`);
					default:
						throw new SkillError(`unknown action ${p.action}`);
				}
			} catch (e) {
				if (e instanceof SkillError) return { ...text(`Error: ${e.message}`), details: { error: true } };
				throw e;
			}
		},
	});

	// ── orchestrator session ───────────────────────────────────────────────────
	const openOrchestrator = async () => {
		const existing = (pi.sessions.list({ closed: false, limit: 1000 }) as { id: string }[]).find((s) => pi.sessions.data.get(s.id, ORCH_KEY) === true);
		if (existing) return existing;
		const s = await pi.sessions.create({ title: "Hermes" });
		pi.sessions.data.set(s.id, ORCH_KEY, true);
		pi.sessions.update(s.id, { purpose: "Orchestrator: the user's single point of contact" });
		render();
		return s;
	};
	pi.registerMethod("open", async () => {
		const s = await openOrchestrator();
		return { id: s.id };
	});

	pi.registerCommand("hermes", {
		description: "Hermes: on | off | learn | profile | status",
		args: "[on|off|learn|profile|status]",
		handler: async (args: string, ctx: any) => {
			const verb = (args.trim().split(/\s+/)[0] || "on").toLowerCase();
			switch (verb) {
				case "on":
					pi.sessions.data.set(ctx.sessionId, ORCH_KEY, true);
					render();
					return {
						prompt: "Hermes orchestrator mode is now on for this session. In two or three lines: say what you know about me from USER PROFILE (or that it is empty) and how I should work with you.",
						note: { text: "Hermes: orchestrator on" },
					};
				case "off":
					pi.sessions.data.delete(ctx.sessionId, ORCH_KEY);
					render();
					return;
				case "learn":
					reviewSession(ctx.sessionId, true);
					return;
				case "profile":
					profile();
					return;
				case "status": {
					const u = memory.usage("user");
					const m = memory.usage("memory");
					const c = index.count();
					return {
						prompt: `Report this Hermes status to me in one short paragraph: USER.md ${u.used}/${u.limit} chars (${u.entries} entries), MEMORY.md ${m.used}/${m.limit} chars (${m.entries} entries), ${c.messages} messages of ${c.sessions} sessions indexed, last review: ${history[0] ? `${history[0].summary} (${when(history[0].at)})` : "none"}.`,
						note: { text: "Hermes: status" },
					};
				}
				default:
					return `/hermes ${args}`;
			}
		},
	});

	// ── settings page ──────────────────────────────────────────────────────────
	const hasUi = typeof pi.ui?.setPanel === "function";
	let lastError = "";
	function render() {
		if (!hasUi) return;
		try {
			const u = memory.usage("user");
			const m = memory.usage("memory");
			const c = index.count();
			const own = library.list().filter((s) => s.ownedByHermes).length;
			const orch = (() => {
				try {
					return Object.keys(pi.sessions.data.list(ORCH_KEY) ?? {}).length;
				} catch {
					return 0;
				}
			})();
			const state = busy?.startsWith("review:")
				? { ko: "대화 복기 중", en: "Reviewing a conversation" }
				: busy === "profile"
					? { ko: "프로필 분석 중", en: "Analyzing your profile" }
					: indexing
						? { ko: "대화 색인 중", en: "Indexing conversations" }
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
									{ type: "stat", id: "user", label: { ko: "사용자 프로필", en: "User profile" }, value: `${u.used}/${u.limit}`, hint: { ko: `항목 ${u.entries}개`, en: `${u.entries} entries` } },
									{ type: "stat", id: "memory", label: { ko: "메모", en: "Notes" }, value: `${m.used}/${m.limit}`, hint: { ko: `항목 ${m.entries}개`, en: `${m.entries} entries` } },
									{ type: "stat", id: "index", label: { ko: "색인된 메시지", en: "Indexed messages" }, value: String(c.messages), hint: { ko: `세션 ${c.sessions}개`, en: `${c.sessions} sessions` } },
									{ type: "stat", id: "skills", label: { ko: "직접 만든 스킬", en: "Skills it wrote" }, value: String(own) },
									{ type: "stat", id: "orch", label: { ko: "오케스트레이터 세션", en: "Orchestrator sessions" }, value: String(orch) },
								],
							},
							...(lastError ? [{ type: "alert", id: "error", tone: "danger", text: lastError }] : []),
							{
								type: "stack",
								id: "actions",
								direction: "horizontal",
								children: [
									{ type: "button", id: "open", variant: "primary", label: { ko: "Hermes 세션 열기", en: "Open Hermes session" } },
									{ type: "button", id: "profile", label: { ko: "과거 대화로 프로필 분석", en: "Build profile from past chats" }, disabled: pending.has("profile") },
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
								emptyText: { ko: "아직 없습니다. 대화가 몇 번 오가면 자동으로 복기합니다.", en: "Nothing yet. Conversations are reviewed after a few turns." },
								items: history.slice(0, 8).map((o, i) => ({
									id: `h${i}`,
									title: `${when(o.at)} · ${o.kind === "profile" ? "profile" : (o.title ?? "review").slice(0, 60)}`,
									description: [o.summary, ...o.changes, ...o.errors.map((e) => `! ${e}`)].join(" · ").slice(0, 480),
									...(o.errors.length ? { badge: "error" } : o.changes.length ? { badge: `${o.changes.length}` } : {}),
								})),
							},
						],
					},
					{
						type: "card",
						id: "edit",
						title: { ko: "메모리 직접 고치기", en: "Edit memory" },
						description: { ko: "항목은 § 한 줄로 나눕니다. 저장하면 새 세션부터 반영됩니다.", en: "Separate entries with a line holding only §. New sessions see the change." },
						children: [
							{
								type: "form",
								id: "memory-form",
								submitLabel: { ko: "메모리 저장", en: "Save memory" },
								children: [
									{ type: "textarea", id: "user-md", label: "USER.md", rows: 8, value: memory.read("user").join("\n§\n") },
									{ type: "textarea", id: "memory-md", label: "MEMORY.md", rows: 8, value: memory.read("memory").join("\n§\n") },
								],
							},
						],
					},
				],
			});
		} catch (e) {
			pi.log("hermes: panel failed", e);
		}
	}
	if (hasUi) {
		pi.ui.onEvent(async (e: any) => {
			lastError = "";
			if (e.type === "action" && e.id === "open") await openOrchestrator();
			else if (e.type === "action" && e.id === "profile") profile();
			else if (e.type === "action" && e.id === "reindex") {
				index.clear();
				void backfill();
			} else if (e.type === "submit" && e.id === "memory-form") {
				try {
					const user = memory.replace("user", String(e.values["user-md"] ?? ""));
					const notes = memory.replace("memory", String(e.values["memory-md"] ?? ""));
					pi.log(`hermes: memory saved by hand (${user.length} + ${notes.length} entries)`);
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
				}
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
