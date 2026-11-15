# assistant

Server extension. Gives you one session to talk to: it remembers you and your setup, finds what you discussed
before, and hands longer work to other sessions. The idea of a small, self-maintained memory comes from
[Hermes Agent](https://github.com/NousResearch/hermes-agent); the code and prompts here are written for pipaya.

## Use

- Type `/assistant` in any session, or press "Open assistant" on the extension's page. It opens the assistant
  session (and creates it the first time).
- `/assistant new` (or "Start fresh"): closes the current assistant after a last review and starts a new one with the
  same memory. Do this now and then: a short conversation is cheaper than a long one.
- `/assistant profile` (or "Learn from past chats"): builds the profile from what you wrote in your last 80 sessions.
  Worth doing once after installing.
- `/assistant learn`: review the current assistant conversation now.
- The page shows the memory sizes, the last reviews, and a form to edit the memory by hand (one entry per line).

## How it keeps the cost down

- **Only the assistant pays.** Its guide, its memory and its tools (`remember`, `recall`) go into the assistant
  session only. Other sessions get nothing extra.
- **Small prompt.** A one-line base prompt instead of the coding default, a guide of about 250 tokens, and memory
  capped at 1,500 + 2,500 characters (about 1,000 tokens when full). Unchanged memory gives the same prompt on every
  call, so the provider's prompt cache keeps working.
- **No file editing tools.** The assistant has `read`, `ls`, `grep`, `bash`, `ask_user`, `remember`, `recall` and the
  server's `peer`, `delegate`, `schedule`; writing code is a worker's job.
- **Cheap reviews.** A review reads only the messages since the last one (tool output cut to 120 characters, at most
  20,000 characters), runs every 8 of your messages, and answers in at most 1,000 tokens. Map the `assistant` model
  role to a small model.
- **Search costs no model calls.** `recall` uses a local full-text index (SQLite FTS5, works for Korean).

## Memory

Two kinds of one-line entries, each with an id (`p3`, `n7`) so the model can edit or drop one exactly:

- **profile**: you: language, tone, level of detail, how you want work reported, standing rules.
- **note**: your environment: machines, paths, projects, tools, conventions.

A change that would go over a kind's limit is refused whole; the model has to drop or shorten entries in the same
call. Exact duplicates are ignored.

## What it reads, writes and sends

- **Reads** every session's messages through `pi.sessions` to index them, and the assistant's messages to review them.
  It never opens the server's database.
- **Writes** `memory.json`, `search.sqlite` and `history.json` in its data folder
  (`<dataDir>/extension-data/assistant/`).
- **Sends** to the model of the `assistant` role: the new part of an assistant conversation for a review, and up to
  30,000 characters of your own messages for "Learn from past chats". Nothing else leaves the server.
