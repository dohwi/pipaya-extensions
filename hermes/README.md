# hermes

Server extension. Brings the learning loop of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(Nous Research, MIT) to pipaya, so the agent remembers who you are, finds what you discussed before and writes down
how you like things done. One session can be the orchestrator you talk to, handing work to the others.

| Hermes Agent | Here |
|---|---|
| `MEMORY.md` + `USER.md`, bounded, frozen snapshot in the system prompt | the same two files, same limits (2,200 / 1,375 characters, adjustable), added at a session's first run and kept for its life |
| `memory` tool (batched add / patch / remove) | `memory` tool, same shape |
| `session_search` (FTS5 over past sessions) | `session_search`: own FTS5 index (trigram, so Korean works), plus reading around a hit |
| `skill_manage` | `skill_manage` on `~/.agents/skills`, the folder the server already loads skills from |
| background review after a turn (forked agent) | after every *N* of your messages (default 6) a one-shot model call reads the conversation and answers with memory and skill changes |
| Honcho user modeling | "Build profile from past chats": reads what you wrote across the last 80 sessions and updates `USER.md` |
| gateway, cron, subagents | not ported: pipaya already has paired devices and push, `schedule`, `peer` and `delegate` |

## Use

- **Orchestrator.** Type `/hermes on` in a session (or press "Open Hermes session" on the extension's page). That
  session gets a prompt that makes it plan, hand lasting work to other sessions with `peer`, searches to `delegate`,
  recurring work to `schedule`, and report back. `/hermes off` turns it back into a normal session.
- `/hermes learn` reviews the current session now; `/hermes profile` builds the profile from past chats;
  `/hermes status` reports the sizes.
- The extension's page shows the stores, the index, the last reviews, and a form to edit `USER.md` / `MEMORY.md` by hand
  (entries are separated by a line holding only `§`).

Every session (not only the orchestrator) gets the memory block and the three tools. Each tool can be switched off
in Settings → Tools.

## What it reads, writes and sends

- **Reads** every session's messages through `pi.sessions` (to index them and to review them). It never opens the
  server's database.
- **Writes** `memories/USER.md`, `memories/MEMORY.md`, `search.sqlite` and `history.json` in its data folder
  (`<dataDir>/extension-data/hermes/`), and skill folders in `~/.agents/skills/<name>/`. A skill it creates carries
  `created-by: hermes`; skills it did not create are read-only unless "Let it edit skills it did not write" is on.
  Support files are limited to `references/`, `templates/` and `scripts/` inside the skill.
- **Sends** conversation text (the last ~60,000 characters of a session for a review, up to ~40,000 characters of
  your own messages for a profile) to the model of the role named in the settings (default `hermes`, which falls
  back to the server's default model). Map that role to a cheap model in Settings → Models to keep the cost down,
  or turn the automatic review off.
- Tool output is not indexed; only what you and the assistant wrote.

## Limits

- The memory snapshot is fixed when a session first runs (as in Hermes, to keep the prompt cache): a change shows in
  sessions that start afterwards. A server restart takes a fresh snapshot.
- The review is a one-shot call, not an agent with tools: it sees every skill's name and description and the full
  `SKILL.md` of the editable ones (up to ~20,000 characters in total), not their support files. A patch that does not
  match is reported on the page and skipped.
- Reviews run one at a time, in the background; a failed one is listed on the page and changes nothing.
