<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>prompt-templates</h1>
  <p>Save a long prompt as a Markdown file and call it with <code>/prompt:name</code> in <a href="https://github.com/dohwi/pipaya">pipaya</a>.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## What it does

- `/prompt:name rest of the line` is sent to the model as the template's text. `$ARGUMENTS` is replaced by what you typed after the name; without it the arguments are appended.
- Templates are `<name>.md` files in `~/.agents/templates` (global) or `.agents/templates` from the chat's folder up to the repository root (project). Optional frontmatter: `description`, `name`.
- The chat shows the short call you typed as a note under the message, and the chat title becomes the template name.
- Adds the `list` method that the client uses for the slash menu and the footer badge.

> Before this existed as an extension, templates were built into the server. Install it to keep them.

## Requirements

- A pipaya server with the `input` hook results `parts` and `title` (commit 936bab8 or newer; the first release after 0.3.7). Without this extension the client hides the template menu and badge.

## Install

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install prompt-templates        # copies to ~/.pipaya/extensions/prompt-templates
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

Or copy this folder (`extensions/prompt-templates`) into `~/.pipaya/extensions/prompt-templates/` and reload. To turn it off, remove the folder and reload.

## Security

- Server extensions run with the server's full privileges. Read `index.ts` before you install it.
- It reads `.md` files from the two template folders (max 200 files, 128 KB each) and nothing else. It runs no commands and makes no network calls. Nothing is stored.

## Development

Requires [Bun](https://bun.sh) (`mise install`). There is no build step. `bun test` runs the unit tests of the template parser.

## License

[MIT](LICENSE)
