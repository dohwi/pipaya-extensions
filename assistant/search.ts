// Full-text index of every session's user and assistant messages (SQLite FTS5, trigram tokenizer so Korean and
// other languages without spaces between words are found too). Its own database in the extension's data folder:
// the server's pipaya.db is never touched.
import { Database } from "bun:sqlite";
import { plainText } from "./text.ts";

export interface Hit {
	sessionId: string;
	seq: number;
	role: string;
	createdAt: number;
	snippet: string;
}

const MAX_TEXT = 8000;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The words of a query; a quoted phrase stays one term. */
export function terms(query: string): string[] {
	const out: string[] = [];
	for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
		const t = (m[1] ?? m[2] ?? "").trim();
		if (t) out.push(t);
	}
	return out.slice(0, 8);
}

function snippetAround(text: string, words: string[], width = 90): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const w of words) {
		at = lower.indexOf(w.toLowerCase());
		if (at >= 0) break;
	}
	if (at < 0) at = 0;
	const from = Math.max(0, at - width);
	const to = Math.min(text.length, at + width);
	return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

export class SearchIndex {
	private db: Database;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run(`CREATE TABLE IF NOT EXISTS msgs (
			id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
			created_at INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE(session_id, seq))`);
		this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS msgs_fts USING fts5(text, content='msgs', content_rowid='id', tokenize='trigram')");
		this.db.run("CREATE TRIGGER IF NOT EXISTS msgs_ai AFTER INSERT ON msgs BEGIN INSERT INTO msgs_fts(rowid, text) VALUES (new.id, new.text); END");
		this.db.run("CREATE TRIGGER IF NOT EXISTS msgs_ad AFTER DELETE ON msgs BEGIN INSERT INTO msgs_fts(msgs_fts, rowid, text) VALUES ('delete', old.id, old.text); END");
		this.db.run("CREATE TABLE IF NOT EXISTS progress (session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)");
	}

	close(): void {
		this.db.close();
	}

	/** Seq of the last message looked at for a session (-1 when none). */
	lastSeq(sessionId: string): number {
		const row = this.db.query("SELECT last_seq FROM progress WHERE session_id = ?").get(sessionId) as { last_seq: number } | null;
		return row?.last_seq ?? -1;
	}

	/** Adds a message (only its words; tool output is not indexed). Safe to call twice for the same seq. */
	add(sessionId: string, seq: number, message: any, createdAt: number): void {
		const text = plainText(message).slice(0, MAX_TEXT);
		if (text) this.db.query("INSERT OR IGNORE INTO msgs (session_id, seq, role, created_at, text) VALUES (?, ?, ?, ?, ?)").run(sessionId, seq, message.role, createdAt, text);
		this.db.query("INSERT INTO progress (session_id, last_seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)").run(sessionId, seq);
	}

	addMany(sessionId: string, messages: { seq: number; createdAt: number; message: any }[]): void {
		this.db.transaction(() => {
			for (const m of messages) this.add(sessionId, m.seq, m.message, m.createdAt);
		})();
	}

	drop(sessionId: string): void {
		this.db.query("DELETE FROM msgs WHERE session_id = ?").run(sessionId);
		this.db.query("DELETE FROM progress WHERE session_id = ?").run(sessionId);
	}

	clear(): void {
		this.db.run("DELETE FROM msgs");
		this.db.run("DELETE FROM progress");
	}

	count(): { messages: number; sessions: number } {
		const r = this.db.query("SELECT COUNT(*) AS m, COUNT(DISTINCT session_id) AS s FROM msgs").get() as { m: number; s: number };
		return { messages: r.m, sessions: r.s };
	}

	sessionIds(): string[] {
		return (this.db.query("SELECT session_id FROM progress").all() as { session_id: string }[]).map((r) => r.session_id);
	}

	/**
	 * Matching messages, best first. Every term must appear. Terms of three or more characters use the FTS index
	 * (ranked by bm25); a shorter one (a two-syllable Korean word) falls back to a LIKE scan, newest first.
	 */
	search(query: string, opts: { limit?: number; exclude?: string } = {}): Hit[] {
		const words = terms(query);
		if (!words.length) return [];
		const limit = Math.min(Math.max(opts.limit ?? 60, 1), 500);
		const exclude = opts.exclude ?? "";
		type Row = { session_id: string; seq: number; role: string; created_at: number; text: string; snip?: string };
		let rows: Row[];
		if (words.every((w) => [...w].length >= 3)) {
			const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" AND ");
			rows = this.db
				.query(`SELECT m.session_id, m.seq, m.role, m.created_at, m.text, snippet(msgs_fts, 0, '«', '»', '…', 16) AS snip
					FROM msgs_fts JOIN msgs m ON m.id = msgs_fts.rowid
					WHERE msgs_fts MATCH ? AND m.session_id != ? ORDER BY bm25(msgs_fts) LIMIT ?`)
				.all(match, exclude, limit) as Row[];
		} else {
			const where = words.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
			rows = this.db
				.query(`SELECT session_id, seq, role, created_at, text FROM msgs WHERE ${where} AND session_id != ? ORDER BY created_at DESC LIMIT ?`)
				.all(...words.map((w) => `%${escapeLike(w)}%`), exclude, limit) as Row[];
		}
		return rows.map((r) => ({
			sessionId: r.session_id,
			seq: r.seq,
			role: r.role,
			createdAt: r.created_at,
			snippet: (r.snip ?? snippetAround(r.text, words)).replace(/\s+/g, " ").trim(),
		}));
	}
}
