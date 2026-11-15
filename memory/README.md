# memory

Server extension. Gives you one main session to talk to: it remembers you and your setup, finds what you discussed
before, and hands longer work to other sessions.

## Use

- Type `/memory` in any session, or press "Open main session" on the extension's page. It opens the main session
  (and creates it the first time).
- `/memory new` (or "Start fresh"): closes the current main session after a last review and starts a new one with the
  same memory. Do this now and then: a short conversation is cheaper than a long one.
- The page shows the memory sizes, the index size and the result of the last review.

## How it keeps the cost down

- **Only the main session pays.** Its guide, its memory and its tools (`remember`, `recall`) go into that session
  only. Other sessions get nothing extra, and the two tools refuse to run anywhere else.
- **Small prompt.** A one-line base prompt instead of the coding default, a guide of about 250 tokens, and memory
  capped at 1,500 + 2,500 characters (about 1,000 tokens when full). Unchanged memory gives the same prompt on every
  call, so the provider's prompt cache keeps working.
- **No file editing tools.** The main session has `read`, `ls`, `grep`, `bash`, `ask_user`, `remember`, `recall` and
  the server's `peer`, `delegate`, `schedule`; writing code is a worker's job.
- **Cheap reviews.** A review reads only the messages since the last one (tool output cut to 120 characters, at most
  20,000 characters), runs every 8 of your messages, and answers in at most 1,000 tokens. Map the `memory` model role
  to a small model.
- **Search costs no model calls.** `recall` uses a local full-text index (SQLite FTS5, works for Korean).

## Memory

Two kinds of one-line entries, each with an id (`p3`, `n7`) so the model can edit or drop one exactly:

- **profile**: you: language, tone, level of detail, how you want work reported, standing rules.
- **note**: your environment: machines, paths, projects, tools, conventions.

A change that would go over a kind's limit is refused whole; the model has to drop or shorten entries in the same
call. Exact duplicates are ignored. To correct an entry, tell the main session.

## What it reads, writes and sends

- **Reads** every session's messages through `pi.sessions` to index them, and the main session's messages to review
  them. It never opens the server's database.
- **Writes** `memory.json` and `search.sqlite` in its data folder (`<dataDir>/extension-data/memory/`).
- **Sends** the new part of the main session's conversation to the model of the `memory` role for a review. Nothing
  else leaves the server.
