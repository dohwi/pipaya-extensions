<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>ask-user</h1>
  <p>Let the agent stop and ask you a question in <a href="https://github.com/dohwi/pipaya">pipaya</a> instead of guessing.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## What it does

- Adds the `ask_user` tool. The agent asks one question, or several at once (shown as tabs, you can revise any answer before sending), and waits for your answer.
- It can offer `options`, highlight a `recommended` choice, and allow or forbid free text (`allowFreeText`).
- Waiting costs nothing and has no time limit. Aborting the run releases the question.
- It uses the same tool name as the former built-in tool, so existing chats and the question card in the client work unchanged.

## Requirements

- A pipaya server with `ctx.ask` for server extensions (the version that moved `ask_user` out of the server).

## Install

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install ask-user        # copies to ~/.pipaya/extensions/ask-user
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

Or copy this folder (`extensions/ask-user`) into `~/.pipaya/extensions/ask-user/` and reload. To turn it off, remove the folder and reload: without it the agent never asks and simply assumes.

## Security

- Server extensions run with the server's full privileges. This one is about 40 lines: read `index.ts`.
- It reads no files, runs no commands and makes no network calls. The question and your answer only pass through the server's question channel (`ctx.ask`).
- It stores nothing and sends nothing to other clients beyond the normal question card events.

## Development

Requires [Bun](https://bun.sh) (`mise install` sets it up). There is no build step: the extension is `index.ts`. The server's own test (`server/test/api.test.ts` in pipaya) loads a copy of it.

## License

[MIT](LICENSE)
