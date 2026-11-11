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
| 확장 설정 | every extension's `settings.json` on the primary | **off** |

A key listed in `keys` belongs to no box and always comes along. A setting saved before 0.8.0 has no boxes: everything
counts as checked, as before.

**확장 설정** copies each extension's stored settings from the primary (`<dataDir>/extensions/<id>/settings.json`) and
saves them here through this server's own `PUT /extensions/:id/settings`, so running extensions and open apps hear the
change. Keys that look like a credential (`token`, `secret`, `password`, `apiKey`, …, the app's own list) are never
sent by the primary, and the follower keeps its own values for them. This extension's settings are never copied, and an
extension the primary lacks is left alone. Environment variables (`PIPAYA_FLAG_*`) are process environment, not
settings: they are not synced.

## What it reads, runs and sends

- **Reads** the server's own SQLite database (`PIPAYA_DB`, or `<PIPAYA_DATA_DIR|~/.pipaya>/pipaya.db`) — only the `settings` table and the event counter.
- **Network**: the follower talks to exactly one URL, the `remoteUrl` you configure: `POST /pairing/redeem` once to trade the code for a token, then `POST /server-extensions/server-sync/methods/snapshot` with that token. With 확장 설정 checked it also calls its own server at `127.0.0.1:$PIPAYA_PORT` to save them. The primary only answers its own `/pairing` when asked for a code. Nothing else is sent anywhere.
- The remote token is stored in the extension's own settings file (`extensions/server-sync/settings.json`, mode 0600), is never logged and never appears in the status below.

## Roles

- **primary** — keeps its own settings, serves them to the peer. It never writes anything and never polls.
- **follower** — polls the primary every `intervalSeconds` (minimum 15) and applies what it sees: rows are overwritten, rows the primary lacks are deleted. Its own conflicting edits do not survive. A failed pull is logged and retried with a growing wait (2× per miss, at most 8 intervals), so a primary that is down is not hammered.

Both sides install this same extension; only the role differs. The follower holds a **device token** it redeemed from the primary's pairing code — revocable on the primary, never its admin token.

## Setup

1. Install the extension on both servers (Settings → Server extensions → `dohwi/pipaya-extensions`, folder `server-sync`).
2. **Primary** (`기준`): nothing to fill in. `POST .../methods/code` returns this server's address and a one-time
   **연결 코드** (a pairing code, the app's own `POST /pairing`), valid for two minutes.
3. **Follower** (`팔로워`): put the primary's address in `상대 서버 주소` and the code in `연결 코드`, then save. The
   follower redeems the code at `POST /pairing/redeem` and stores the **device token** it gets back — revocable on the
   primary (`DELETE /devices/tokens/:id`), never the primary's admin token. The code is cleared once used.
4. The first pull happens within one interval; `POST /server-extensions/server-sync/methods/sync` forces one
   immediately and returns what changed.

The form follows the role: a **primary** shows only the status and the role (the status line gives its own address
and where to get a code); a **follower** also shows the address and the code. The app's [링크 복사] link
(`pipaya://connect?u=…&c=…`) can be pasted into the code field alone — it carries the address too. The two fields are
hidden with the settings field `when` (app 0.8.6+); an older app ignores it and shows every field.

**상태** says what is happening without opening anything:

- `● 기준 서버 — 다른 서버가 이 서버의 설정을 가져갑니다` on the primary
- `● 연결됨 — 3분 전 확인, 2개 항목 가져옴` on a follower that is working
- `✕ 연결 실패 — <why>` on one that is not, `○ 기준 서버 주소를 입력하세요` / `○ 기준 서버의 연결 코드를 붙여넣으세요` before it is set up

The extension rewrites it after every pull and every 30 seconds (so "3분 전" stays true), and straight away after a
save: the form posts every field back, this one included, so a fresh page would otherwise show an empty box until
the next pull. Typing over it is harmless.

It is an ordinary string setting on purpose. A `readonly` field would read better, but that field type only exists in
apps newer than the extension, and an extension must not require an app release to be usable.

## Methods

- `snapshot` — the primary's side: `{ keys, settings }`.
- `code` — the primary's side: `{ url, code }`, a fresh pairing code for this server.
- `connect` — the follower's side: `{ url, code }` (or `{ url, token }`) connects and pulls once, returning the status.
- `sync` — one pull now (follower only): `{ applied, ...status }`.
- `status` — `{ role, url, intervalSeconds, keys, lastSyncAt, lastApplied, lastError }`, so the health of a sync can be checked without reading the log.

The follower also emits an ephemeral `synced` event (`{ keys, at }`) to connected clients whenever a pull changed something.
