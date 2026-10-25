<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>session-retention</h1>
  <p>Delete chats in <a href="https://github.com/dohwi/pipaya">pipaya</a> that have not been used for a while. Off until you pick a number of days.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## What it does

- The server never deletes chats by itself; this extension adds that, once an hour and shortly after the server starts.
- Set it in Settings → server extensions → Session Retention (days, only closed chats), with `PIPAYA_FLAG_RETENTION_DAYS=30` (and `PIPAYA_FLAG_RETENTION_ONLY_CLOSED=1` to spare active chats), or call the `setPolicy` method `{enabled, days, onlyClosed}`. A saved policy wins over the flags.
- Methods: `info` (policy, last run, how many would go now), `setPolicy`, `run` (clean up now).
- A chat that is running, or waiting for an answer, is never deleted, whatever its age.

> Older pipaya servers had this built in (Settings → Chats → automatic deletion). Install this extension and set the days again to keep it.

## Requirements

- A pipaya server with `pi.sessions` (commit 936bab8 or newer; the first release after 0.3.7).

## Install

In pipaya, open **Settings → Extensions → Marketplace** and install **session-retention**. The server fetches the pinned release into `~/.pipaya/extensions/session-retention/` and reloads.

By hand: copy this folder to `~/.pipaya/extensions/session-retention/` and reload (`POST /server-extensions/reload` or Settings → Extensions). To turn it off, remove the folder and reload.

## Security

- Server extensions run with the server's full privileges. Read `index.ts` before you install it.
- It **deletes chats permanently**. It reads session metadata only (never messages), runs no commands and makes no network calls. It stores its policy in the extension settings and its last run in its own data folder.

## Development

Requires [Bun](https://bun.sh) (`mise install`). There is no build step. It is checked by loading it into a pipaya server (`/server-extensions` lists it without an `error`).

## License

[MIT](LICENSE)
