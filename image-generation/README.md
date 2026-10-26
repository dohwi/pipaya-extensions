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

- pipaya lists image models (an OpenRouter connection lists them itself; for others, turn on **Makes & edits images** in the model's settings) but does not run them. This extension runs them.
- Pick an image model in a chat: each message is a picture request and the reply is the picture. Pictures you attach go along.
- Pictures are saved under `.pipaya/generated/` in the chat's folder and shown in the chat as markdown images.
- A follow-up without a picture ("make it bluer") sends the last generated picture along, so the model edits it.
- It uses the connection's own address and key. There is nothing to set up here.
- Without this extension, image models show **Needs extension** and the chat cannot send to them.

## Requirements

- A pipaya server with `pi.registerModelRunner` (image models are listed by the core and run by an extension).
- A connection whose endpoint does chat completions with image output (OpenRouter and compatible ones).

## Install

In pipaya, press **Install extension** on an image model, or open **Settings → server → Server extensions → Marketplace** and install **image-generation**. The server fetches the pinned release into `~/.pipaya/extensions/image-generation/` and reloads.

## Security

- Server extensions run with the server's full privileges. Read `index.ts` before you install it.
- It sends your message text, the pictures you attach and the last generated picture to the image model's own connection, with that connection's key. Nothing else.
- It writes picture files only under `.pipaya/generated/` in the chat's folder, and reads back only a picture it linked there.

## Development

Requires [Bun](https://bun.sh) (`mise install`). No build step.

```bash
bun test                                # pure parts
PIPAYA_APP=../../app/server bun test    # also loads it into a pipaya server with a fake endpoint
```

## License

[MIT](LICENSE)
