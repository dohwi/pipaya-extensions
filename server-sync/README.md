# server-sync

Server extension. Mirrors the settings of one pipaya server (the **primary**) onto another (the **follower**), so two servers you use behave the same without configuring each by hand.

The settings page is in Korean: `pipaya.settings` labels are plain strings with no per-language form, and the author's servers are Korean.

One file on purpose (`index.ts`): a server from before 0.8.4 busts the module cache for the entry file alone, so a
folder extension kept running its old helper after a reload and failed with "Export named X not found".

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
2. **Primary** (`기준`): the page fills in `이 서버 주소` and `이 서버 관리자 토큰` by itself — the token read from
   `dataDir/token`, the address from this machine's Tailscale/LAN interface (edit it if the peer should dial something
   else). Press **새 연결 코드** to pack both into one `연결 코드` string.
3. **Follower** (`팔로워`): paste that `연결 코드` and save. The address and token come out of the code, so there is
   nothing else to type. (An admin token typed by hand still works, for a peer too old to issue codes.)
4. The first pull happens within one interval; `POST /server-extensions/server-sync/methods/sync` forces one
   immediately and returns what changed.

The connection code is not a secret of its own: it carries the primary's admin token, so treat it like the token —
it is shown only on the primary's own settings page, and the follower clears it from its settings once unpacked.

## Methods

- `snapshot` — the primary's side: `{ keys, settings }`.
- `code` — the primary's side: packs its address and admin token into one `연결 코드` (also written to the page).
- `connect` — the follower's side: `{ code }` (or `{ url, token }`) connects and pulls once, returning the status.
- `sync` — one pull now (follower only): `{ applied, ...status }`.
- `status` — `{ role, url, intervalSeconds, keys, lastSyncAt, lastApplied, lastError }`, so the health of a sync can be checked without reading the log.

The follower also emits an ephemeral `synced` event (`{ keys, at }`) to connected clients whenever a pull changed something.
