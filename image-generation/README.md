<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>image-generation</h1>
  <p>Make and edit pictures in a <a href="https://github.com/dohwi/pipaya">pipaya</a> chat.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## What it does

- Adds the model provider **Image generation** with the models you list (default `google/gemini-3.1-flash-image`).
- Pick one of its models in a chat: each message is a picture request and the reply is the picture. Pictures you attach go along.
- Pictures are saved under `.pipaya/generated/` in the chat's folder and shown in the chat as markdown images.
- A follow-up without a picture ("make it bluer") sends the last generated picture along, so the model edits it.
- No tools, no reasoning: the model only draws.

## Settings

Settings → server extensions → Image Generation:

| Field | Meaning |
|---|---|
| API key | Key of the endpoint (stored in the extension settings on the server) |
| Endpoint | Chat-completions base URL with image output. Empty: `https://openrouter.ai/api/v1` |
| Models | Model ids, comma separated |

## Requirements

- A pipaya server where image generation is no longer built in (it moved into this extension).

## Install

In pipaya, open **Settings → Extensions → Marketplace** and install **image-generation**. The server fetches the pinned release into `~/.pipaya/extensions/image-generation/` and reloads.

## Security

- Server extensions run with the server's full privileges. Read `index.ts` before you install it.
- It sends your message text, the pictures you attach and the last generated picture to the endpoint you set, with your API key. Nothing else.
- It writes picture files only under `.pipaya/generated/` in the chat's folder, and reads back only a picture it linked there.

## Development

Requires [Bun](https://bun.sh) (`mise install`). No build step.

```bash
bun test                                # pure parts
PIPAYA_APP=../../app/server bun test    # also loads it into a pipaya server with a fake endpoint
```

## License

[MIT](LICENSE)
