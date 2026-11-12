# server-sync

Server extension. Makes one pipaya server (the **follower**) match another (the **primary**): its settings and, box by box, what is installed there — server and client extensions, extension settings, skill files, helper roles, the global AGENTS.md and model providers — so two servers you use behave the same without configuring each by hand.

The settings page is in Korean: `pipaya.settings` labels are plain strings with no per-language form, and the author's servers are Korean.

One file on purpose (`index.ts`): a server from before 0.8.4 busts the module cache for the entry file alone, so a
folder extension kept running its old helper after a reload and failed with "Export named X not found".

## What it syncs

Settings rows of the server's `settings` table:

`default_model`, `default_workdir`, `system_model`, `image_model`, `mcp_servers`, `compaction`, `retention`, `skills`, `disabled_tools`, `disabled_subagents`, `delegate_policy`

Extra keys can be added in the settings form (`keys`, comma separated). Keys that are per-device or secret-adjacent (`device_id`, retention run state) are never synced, even when listed.

**The primary decides the list.** The follower asks for exactly the keys the primary says it mirrors, so a row that is missing on the primary means "deleted there" and is deleted here too — it never means "this side happens to mirror one more key".

**Never synced:** conversations, sessions, events, credentials (API keys, tokens, passwords), and this extension's own settings. Those stay per-server.

## What a follower picks

A follower's form has one box per group; an unchecked group keeps this server's own value and is never touched.

| Box | Rows | Default |
|---|---|---|
| 모델 | `default_model`, `system_model`, `image_model` | on |
| 기본 작업 디렉터리 | `default_workdir` | on |
| MCP 서버 | `mcp_servers` | on |
| 스킬 켜기·끄기 | `skills` | on |
| 도구·도우미 설정 | `disabled_tools`, `disabled_subagents`, `delegate_policy` | on |
| 대화 압축·보관 기간 | `compaction`, `retention` | on |
| 서버 확장 설치 | server extensions in `<dataDir>/extensions`, installed at the primary's version | **off** |
| 확장 설정 | every extension's `settings.json` on the primary | **off** |
| 클라이언트 확장 목록 | `client_settings` rows `extensions`, `extensionStates` | **off** |
| 스킬 파일 | folders in `~/.agents/skills` | **off** |
| 도우미 역할 파일 | `~/.agents/subagents/*.md` | **off** |
| 전역 AGENTS.md | `~/.agents/AGENTS.md` | **off** |
| 모델 연결 | `custom_providers` (address and models, no key) | **off** |

A key listed in `keys` belongs to no box and always comes along. A setting saved before 0.8.0 has no boxes: everything
counts as checked, as before.

**확장 설정** copies each extension's stored settings from the primary (`<dataDir>/extensions/<id>/settings.json`) and
saves them here through this server's own `PUT /extensions/:id/settings`, so running extensions and open apps hear the
change. Keys that look like a credential (`token`, `secret`, `password`, `apiKey`, …, the app's own list) are never
sent by the primary, and the follower keeps its own values for them. This extension's settings are never copied, and an
extension the primary lacks is left alone. Environment variables (`PIPAYA_FLAG_*`) are process environment, not
settings: they are not synced.

The boxes after it make the follower match what is installed, never by removing what it has on its own:

- **서버 확장 설치**: the primary lists its server extensions and versions; the follower installs each one it lacks
  (or has at another version) from the marketplace's pinned git source through its own `POST /server-extensions/install`.
  One not in the marketplace at that version (a hand-copied build) is logged and skipped. This extension is never
  installed, updated or removed this way, and an extension only on the follower stays.
- **클라이언트 확장 목록**: the apps' client extension list and on/off states, written through `PUT /client-settings/:key`
  so open apps reload them.
- **스킬 파일**: each skill folder on the primary is made identical here (text files up to 512 KB, 200 files and 2 MB per
  skill; files it lacks are removed from that folder). A skill only here, and a symlinked skill folder, stay.
- **도우미 역할 파일**, **전역 AGENTS.md**: the files are made identical; a role only here stays.
- **모델 연결**: each custom provider's address, API type and model list, through `PUT /configuration/providers/:id`.
  The API key is never sent: set it once in Settings → Models on each server.

Paths sent by a peer are checked part by part (no `..`, no hidden files) and can only land inside the folder they
belong to.

## What it reads, runs and sends

- **Reads** the server's own SQLite database (`PIPAYA_DB`, or `<PIPAYA_DATA_DIR|~/.pipaya>/pipaya.db`): the `settings` table, and with the boxes above `client_settings` and `custom_providers` (never `credentials`). On the primary it also reads `~/.agents/{skills,subagents,AGENTS.md}` and the extension folders when a follower asks for them.
- **Writes** on the follower, only for checked boxes: settings rows, `~/.agents/{skills,subagents,AGENTS.md}`, and the rest through its own server's routes (install, `/extensions/:id/settings`, `/client-settings/:key`, `/configuration/providers/:id`).
- **Network**: the follower talks to exactly one URL, the `remoteUrl` you configure: `POST /pairing/redeem` once to trade the code for a token, then `POST /server-extensions/server-sync/methods/snapshot` with that token. With the boxes above it also calls its own server (at its bound address, `PIPAYA_HOST`/`PIPAYA_PORT`) to save what it pulled, and reads the marketplace index (`raw.githubusercontent.com/dohwi/pipaya-marketplace`) to find an extension's pinned source. The primary only answers its own `/pairing` when asked for a code. Nothing else is sent anywhere.
- The device token is stored in the extension's own data folder (`extension-data/server-sync/peer.json`, mode 0600), not in its settings: the app's form saves only the fields it shows, so a token kept there was wiped by the next save. It is never logged and never appears in the status below. A token an older version kept in the settings moves there on load.

## Roles

- **primary** — keeps its own settings, serves them to the peer. It never writes anything and never polls.
- **follower** — polls the primary every `intervalSeconds` (minimum 15) and applies what it sees: rows are overwritten, rows the primary lacks are deleted. Its own conflicting edits do not survive. A failed pull is logged and retried with a growing wait (2× per miss, at most 8 intervals), so a primary that is down is not hammered.

Both sides install this same extension; only the role differs. The follower holds a **device token** it redeemed from the primary's pairing code — revocable on the primary, never its admin token. The primary's Devices tab lists it under **기준 서버에 보일 이름**, or `Server Sync · <host> (<address>)` when that is empty.

## Setup

1. Install the extension on both servers (Settings → Server extensions → `dohwi/pipaya-extensions`, folder `server-sync`).
2. **Primary** (`기준`): nothing to fill in. `POST .../methods/code` returns this server's address and a one-time
   **연결 코드** (a pairing code, the app's own `POST /pairing`), valid for two minutes.
3. **Follower** (`팔로워`): put the primary's address in `상대 서버 주소` and the code in `연결 코드`, then save. The
   follower redeems the code at `POST /pairing/redeem` and stores the **device token** it gets back — revocable on the
   primary (`DELETE /devices/tokens/:id`), never the primary's admin token. The code is cleared once used.
   A code the primary turns down (wrong, expired or already used) is tried
   once and reported on the page; paste a new link to try again.
4. The first pull follows the redeemed code at once; `POST /server-extensions/server-sync/methods/sync` forces one
   any time and returns what changed.

The form follows the role: a **primary** shows only the role; a **follower** also shows the address, the link field
and what to pull. The app's link (Devices tab → [연결 링크 복사], app 0.8.7+; or Add phone → [링크 복사])
(`pipaya://connect?u=…&c=…`) can be pasted into the link field alone — it carries the address too.

### The page (app 0.8.8+)

Above the form, **현재 상태** is drawn by the extension (`pi.ui.setPanel`), not stored in its settings:

- **Primary**: a `기준 서버` badge, this server's address and where to get a link for a follower.
- **Follower**: `연결됨` / `연결 중` / `연결 실패` / `연결 안 됨` with when it last checked; the primary's address, how many
  items the last pull changed and when the next one runs; what it pulled; the last error, if any; and two buttons:
  **지금 동기화** (pull now) and **연결 해제** (forget the address and the token; revoke the token on the primary's
  Devices tab too).

It refreshes after every pull and every 30 seconds. On an app older than 0.8.8 (no `pi.ui`) there is no page: the
extension still works, and `POST .../methods/status` reports the same state. A `statusText` field left by an older
version is removed from the settings on load.

## Methods

- `snapshot` — the primary's side: `{ keys, settings }`.
- `code` — the primary's side: `{ url, code }`, a fresh pairing code for this server.
- `connect` — the follower's side: `{ url, code }` (or `{ url, token }`) connects and pulls once, returning the status.
- `sync` — one pull now (follower only): `{ applied, ...status }`.
- `status` — `{ role, url, intervalSeconds, keys, syncExtensions, lastSyncAt, lastApplied, lastError, status }`, so the health of a sync can be checked without reading the log.

The follower also emits an ephemeral `synced` event (`{ keys, at }`) to connected clients whenever a pull changed something.
