# server-sync

An extension that keeps one pipaya server (the **follower**) and another (the **primary**) in step, both ways,: its settings and, box by box, what is installed there — extensions, their settings, skill files, helper roles, the global AGENTS.md and model providers — so two servers you use behave the same without configuring each by hand.

The settings page is in Korean: `pipaya.settings` labels are plain strings with no per-language form, and the author's servers are Korean.

One file on purpose (`index.ts`): a server from before 0.8.4 busts the module cache for the entry file alone, so a
folder extension kept running its old helper after a reload and failed with "Export named X not found".

## What it syncs

Settings rows of the server's `settings` table:

`default_model`, `default_workdir`, `system_model`, `image_model`, `mcp_servers`, `compaction`, `retention`, `skills`, `disabled_tools`, `disabled_subagents`, `delegate_policy`

Extra keys can be added in the settings form (`keys`, comma separated). Keys that are per-device or secret-adjacent (`device_id`, retention run state) are never synced, even when listed.

**The primary decides the list.** The follower asks for exactly the keys the primary says it mirrors, so a row that is missing on the primary means "deleted there" and is deleted here too — it never means "this side happens to mirror one more key".

**Never synced:** conversations, sessions, events, logins (oauth), and this extension's own settings. Those stay per-server. API keys and tokens only with the option in "Secrets" below.

## Both ways, the primary wins

A follower and its primary are kept in step **both ways**. What was changed on one side since the last sync goes to the
other; when both changed the same item, the primary's value wins. The follower keeps what both had at the last sync
(hashes only, never values) in `extension-data/server-sync/sync-base.json` to tell "changed here" from "changed there".

| Item | Both ways | Only primary → follower |
|---|---|---|
| Settings rows (앱 설정) | yes, removals too | |
| Extension settings values | yes, without tokens or keys | tokens/keys with the secrets option |
| Skill folders, helper roles, AGENTS.md | yes, new and edited ones (a removed file comes back) | |
| Model connections | yes, without the API key | API keys with the secrets option |
| Extension installs and code, the apps' extension list and on/off | | yes |

- The **first sync** of each box (a new connection, a box just turned on) only pulls, as before: the primary's values
  are taken, and what was only on the follower stays there and is not sent up.
- A follower's change is sent to the primary's `push` method, which saves it through the primary's own routes (so its
  apps hear about it). It takes only what it mirrors anyway, never a secret, an install or code, and only while its
  role is primary. The primary keeps its own secrets when it takes extension settings.
- A primary older than 0.14.0 has no `push`: the follower then only pulls, as before.
- Turning a box off forgets its history; turned on again it starts by pulling.
- **Per-PC values.** The working directory is taken only when that folder exists on the receiving PC (both ways); otherwise each server keeps its own, and the follower's page says so. MCP servers have their own sub-box for a PC that runs a different set.

## What a follower picks

A follower's form has a few boxes; an unchecked box keeps this server's own value and is never touched.

| Box | What it matches | Default |
|---|---|---|
| 앱 설정 | `default_model`, `system_model`, `image_model`, `default_workdir` (only when that folder exists on the other PC), `skills` (on/off), `disabled_tools`, `disabled_subagents`, `delegate_policy`, `compaction`, `retention` | on |
| └ MCP 서버도 맞추기 | `mcp_servers` (off: each PC keeps its own list, for an MCP that runs a program installed on one PC) | on |
| 확장 | extensions installed at the primary's version, the apps' extension list and on/off states, and every extension's settings values | **off** |
| └ 직접 만든 확장도 복사 | the code of extensions not in the marketplace, and `~/.agents/extensions` (needs 확장) | **off** |
| 스킬·도우미·AGENTS.md | `~/.agents/skills` folders, `~/.agents/subagents/*.md`, `~/.agents/AGENTS.md` | **off** |
| 모델 연결 | `custom_providers` (address, API type and models) | **off** |
| API 키·토큰도 가져오기 | model API keys and the tokens in extension settings (see "Secrets") | **off** |

The primary has one switch of its own, **비밀값 내보내기 허용** (off by default), for the same reason.

A key listed in `keys` belongs to no box and always comes along. A setting saved before 0.8.0 has no boxes: everything
counts as checked, as before. The boxes of 0.8–0.12 (up to fifteen of them) are folded into these on load: a box that
was on stays on, and the old keys are removed.

**What 확장 does.** The primary lists its extensions and versions; the follower installs each one it lacks (or has at
another version) from the marketplace's pinned git source through its own `POST /server-extensions/install`. One not in
the marketplace at that version (made by hand, or a newer local build) is shown on the page and skipped, unless
**직접 만든 확장도 복사** is checked: then its files come from the primary as they are (text files, no `node_modules`,
without its `settings.json`/`settings.at`, which stay this server's own), are swapped in whole and loaded with
`POST /server-extensions/reload`. The same option copies `~/.agents/extensions`. That code runs inside this server
unreviewed: check it only for a primary you trust. This extension is never installed, updated or removed this way, and an
extension only on the follower stays.

The same box matches the apps' extension list and on/off states (`PUT /client-settings/:key`, so open apps reload them)
and copies each extension's stored settings (`<dataDir>/extensions/<id>/settings.json`) through this server's own
`PUT /extensions/:id/settings`. Environment variables (`PIPAYA_FLAG_*`) are process environment, not settings: they are
not synced. This extension's own settings are never copied.

**스킬·도우미·AGENTS.md**: each skill folder on the primary is made identical here (text files up to 512 KB, 200 files
and 2 MB per skill; files it lacks are removed from that folder); helper roles and AGENTS.md are made identical. A skill
or role only here, and a symlinked skill folder, stay.

**모델 연결**: each custom provider's address, API type and model list, through `PUT /configuration/providers/:id`.

Paths sent by a peer are checked part by part (no `..`, no hidden files) and can only land inside the folder they
belong to.

## Secrets

Tokens and keys are not copied by default. Both sides must agree, and either one can stop it:

- the **primary** turns on 비밀값 내보내기 허용 (otherwise it sends none, whatever the follower asks);
- the **follower** turns on API 키·토큰도 가져오기.

Then it carries the model API keys (credentials of type `api_key`, set on the follower through its own
`PUT /providers/:id/credential`) and the secret-looking keys of each extension's settings file (`token`, `secret`,
`password`, `apiKey`, …). **A value this server already has is never replaced**, so a key typed here wins. A login
(`oauth`) is tied to the server it was made on and is never copied, nor is the voice-input key.

What it cannot copy: a secret an app keeps only on the device (a field marked `secret` in a client extension's settings,
such as Quota Monitor's management key) never reaches the server, so there is nothing on the primary to read. The page
lists those extensions and the values to type in once. Everything else about them (address, language) is matched.

## What it reads, runs and sends

- **Reads** the server's own SQLite database (`PIPAYA_DB`, or `<PIPAYA_DATA_DIR|~/.pipaya>/pipaya.db`): the `settings` table, and with the boxes above `client_settings` and `custom_providers` (and `credentials` only for the keys of the secrets option). On the primary it also reads `~/.agents/{skills,subagents,AGENTS.md}` and the extension folders when a follower asks for them.
- **Writes** on the primary, only what a follower changed (`push`): settings rows, `~/.agents/{skills,subagents,AGENTS.md}`, extension settings and providers through its own routes.
- **Writes** on the follower, only for checked boxes: settings rows, `~/.agents/{skills,subagents,AGENTS.md}`, and the rest through its own server's routes (install, `/extensions/:id/settings`, `/client-settings/:key`, `/configuration/providers/:id`).
- **Network**: the follower talks to exactly one URL, the `remoteUrl` you configure: `POST /pairing/redeem` once to trade the code for a token, then `POST /server-extensions/server-sync/methods/snapshot` with that token, and `.../methods/push` with its own changes. With the boxes above it also calls its own server (at its bound address, `PIPAYA_HOST`/`PIPAYA_PORT`) to save what it pulled, and reads the marketplace index (`raw.githubusercontent.com/dohwi/pipaya-marketplace`) to find an extension's pinned source. The primary only answers its own `/pairing` when asked for a code. Nothing else is sent anywhere.
- The device token is stored in the extension's own data folder (`extension-data/server-sync/peer.json`, mode 0600), not in its settings: the app's form saves only the fields it shows, so a token kept there was wiped by the next save. It is never logged and never appears in the status below. A token an older version kept in the settings moves there on load.

## Roles

- **primary** — keeps its own settings, serves them to the peer. It never writes anything and never polls.
- **follower** — polls the primary every `intervalSeconds` (minimum 15) and applies what it sees: rows are overwritten, rows the primary lacks are deleted. Its own conflicting edits do not survive. A failed pull is logged and retried with a growing wait (2× per miss, at most 8 intervals), so a primary that is down is not hammered.

Both sides install this same extension; only the role differs. The follower holds a **device token** it redeemed from the primary's pairing code — revocable on the primary, never its admin token. The primary's Devices tab lists it under **기준 서버에 보일 이름**, or `Server Sync · <host> (<address>)` when that is empty.

## Setup

1. Install the extension on both servers (Settings → Extensions → Marketplace, or `dohwi/pipaya-extensions`, folder `server-sync`).
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
