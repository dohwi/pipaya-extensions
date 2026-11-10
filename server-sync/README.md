# server-sync

Server extension. Mirrors the settings of one pipaya server (the **primary**) onto another (the **follower**), so two servers you use behave the same without configuring each by hand.

The settings page is in Korean: `pipaya.settings` labels are plain strings with no per-language form, and the author's servers are Korean.

## What it syncs

Rows of the server's `settings` table only:

`default_model`, `default_workdir`, `system_model`, `image_model`, `mcp_servers`, `compaction`, `retention`, `skills`, `disabled_tools`, `disabled_subagents`, `delegate_policy`

Extra keys can be added in the settings form (`keys`, comma separated). Keys that are per-device or secret-adjacent (`device_id`, `voice_input`, retention run state) are never synced, even when listed.

**The primary decides the list.** The follower asks for exactly the keys the primary says it mirrors, so a row that is missing on the primary means "deleted there" and is deleted here too — it never means "this side happens to mirror one more key".

**Never synced:** conversations, sessions, events, credentials (API keys), installed extension code. Those stay per-server.

## What it reads, runs and sends

- **Reads** the server's own SQLite database (`PIPAYA_DB`, or `<PIPAYA_DATA_DIR|~/.pipaya>/pipaya.db`) — only the `settings` table and the event counter.
- **Network**: the follower talks to exactly one URL, the `remoteUrl` you configure, sending `POST /server-extensions/server-sync/methods/snapshot` with the `remoteToken` you configure as the Bearer header. Nothing else is sent anywhere; the primary makes no network calls at all.
- The remote token is stored in the extension's own settings file (`extensions/server-sync/settings.json`, mode 0600), is never logged and never appears in the status below.

## Roles

- **primary** — keeps its own settings, serves them to the peer. It never writes anything and never polls.
- **follower** — polls the primary every `intervalSeconds` (minimum 15) and applies what it sees: rows are overwritten, rows the primary lacks are deleted. Its own conflicting edits do not survive. A failed pull is logged and retried with a growing wait (2× per miss, at most 8 intervals), so a primary that is down is not hammered.

Both sides install this same extension; only the role differs. The token you put in the follower is the **primary server's admin token** (its `dataDir/token`), because the snapshot route needs admin rights.

## Setup

1. Install the extension on both servers (Settings → Server extensions → `dohwi/pipaya-extensions`, folder `server-sync`).
2. On the primary: leave the role as `primary` (기준). Nothing else needed.
3. On the follower: set the role to `follower` (팔로워), the peer address to the primary's base URL (e.g. `http://100.85.51.107:8790`), and the peer token to the primary's admin token.
4. The first pull happens within one interval; `POST /server-extensions/server-sync/methods/sync` forces one immediately and returns what changed.

## Methods

- `snapshot` — the primary's side: `{ keys, settings }`.
- `sync` — one pull now (follower only): `{ applied, ...status }`.
- `status` — `{ role, url, intervalSeconds, keys, lastSyncAt, lastApplied, lastError }`, so the health of a sync can be checked without reading the log.

The follower also emits an ephemeral `synced` event (`{ keys, at }`) to connected clients whenever a pull changed something.
