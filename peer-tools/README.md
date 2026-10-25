<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>peer-tools</h1>
  <p>Let agents in <a href="https://github.com/dohwi/pipaya">pipaya</a> message and read each other's chats.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## What it does

- Adds `peer_send`: send a message to another active chat by its `@name`, or to every other chat in a group by its `@group` handle. The receiver works on its own and answers only if asked.
- Adds `peer_read`: read the latest messages (text only) of another chat.
- At most 10 `peer_send` calls per run, so two chats cannot answer each other forever. `peer_read` output is capped.
- Both tools can be switched off in Settings → Tools.
- Gives every active chat a short `@name` (a Korean first name, or its romanized twin when the UI is not Korean) and keeps it in the chat itself. A closed chat gives its name up. With [peer-names](../peer-names) installed, names follow the UI language (the language tag is kept in this extension's settings).
- Carries the [peer-names](../peer-names) client package (`client/peer-names.json`, `pipaya.client`): pipaya offers to install it from the server itself, same version, no marketplace needed.

> Before this existed as an extension, the same two tools were built into the server. Install it to keep them.

## Requirements

- A pipaya server with `pi.sessions.data`, `pi.groups`, `pi.settings` and the tool options `alwaysActive` / `switchable` (the release after 0.3.11). Chats named by older servers keep their names.

## Install

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install peer-tools        # copies to ~/.pipaya/extensions/peer-tools
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

Or copy this folder (`peer-tools`) into `~/.pipaya/extensions/peer-tools/` and reload. To turn it off, remove the folder and reload.

## Security

- Server extensions run with the server's full privileges. Read `index.ts` before you install it.
- It reads other chats' messages and can send messages into them (which makes their agents work). It reads no files, runs no commands and makes no network calls. Nothing is stored.

## Development

Requires [Bun](https://bun.sh) (`mise install`). There is no build step. It is checked by loading it into a pipaya server (`/server-extensions` lists it without an `error`).

## License

[MIT](LICENSE)
