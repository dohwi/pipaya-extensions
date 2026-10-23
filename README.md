<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>pipaya-extensions</h1>
  <p>Extensions for <a href="https://github.com/dohwi/pipaya">pipaya</a>, one folder each, installed from the <a href="https://github.com/dohwi/pipaya-marketplace">marketplace</a>.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
    <a href="https://bun.sh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
  </p>
</div>

> [!WARNING]
> Server extensions run **with the server's full privileges**. Read the code (and the folder's README) before you install one.

## Extensions

| Folder | Kind | What it does |
|---|---|---|
| [ask-user](ask-user) | server | Lets the agent ask you a question (options, recommended choice) and wait for the answer |
| [guard](guard) | server | Blocks destructive shell commands (`rm -rf /`, `mkfs`, fork bombs) before they run |
| [peer-tools](peer-tools) | server | Lets agents message (`peer_send`) and read (`peer_read`) each other's chats |
| [prompt-templates](prompt-templates) | server | Save a long prompt as a Markdown file and call it with `/prompt:name` |
| [session-retention](session-retention) | server | Deletes chats that have not been used for a while (off by default) |
| [quota-monitor](quota-monitor) | client | Claude, GPT and Antigravity quota gauges in the navbar |

## Install

Each folder is listed in the marketplace on its own, so you install only what you need:

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install peer-tools     # copies the peer-tools folder to ~/.pipaya/extensions/
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

Client extensions (`quota-monitor`) install from the pipaya app: **Settings → Extensions → Marketplace**.

## Layout

```
pipaya-extensions/
└── <id>/                  # one extension: index.ts + package.json (server), or manifest.json + dist/<id>.json (client)
    ├── package.json       # name, version, description, license, author, pipaya.title
    ├── README.md          # what it reads, runs and sends
    └── tests/             # optional
```

## Adding or updating an extension

1. Add or change `<id>/`. A server extension needs `index.ts` and `package.json`; the README must state what it reads, runs and sends.
2. Bump `version` in its `package.json`.
3. Tag the release `<id>-v<version>` (for example `peer-tools-v0.2.0`). One tag per extension, so each folder versions on its own.
4. In [pipaya-marketplace](https://github.com/dohwi/pipaya-marketplace) run `bun scripts/pin.ts <id> <tag>` and commit the result.

## Development

Requires [Bun](https://bun.sh) (`mise install`). Server extensions have no build step. Tests that need a running pipaya server read `PIPAYA_APP=<pipaya>/server`:

```bash
bun scripts/check.ts                          # every extension: package.json is valid, entry exists, tests that need no server pass
PIPAYA_APP=~/pipaya/app/server bun scripts/check.ts peer-tools   # one extension, with its server tests
```

## License

[MIT](LICENSE)
