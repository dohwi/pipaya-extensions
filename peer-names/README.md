<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

# peer-names

Client extension for [pipaya](https://github.com/dohwi/pipaya). It draws everything about addressing other chats by `@name`:

- the `@name` label in front of a chat's title in the sidebar and the chat header,
- `@name` / `@group` completion and highlighting in the composer,
- the bubble of a message another chat sent with `peer_send`.

The pipaya core knows nothing about these names. Without this extension none of it is shown.

## Requirements

Install the server extension [peer-tools](../peer-tools) too: it provides `peer_send`, `peer_read`, the mention hints for the agent and the `overview` method this extension reads.

## Permissions

`server` (reads `peer-tools` overview), `events`, `session-labels`, `composer-mentions`, `messages`.

## Build

```bash
npm run check   # builds dist/peer-names.json and runs the tests
```
