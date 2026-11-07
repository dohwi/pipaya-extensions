<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

# voice-input

A microphone button in the [pipaya](https://github.com/dohwi/pipaya) composer. Press it, speak, press again: the audio is transcribed by **Mistral Voxtral** through the `mistral-support` CLIProxyAPI plugin and the text is appended to the input box. It never sends the message for you.

| Recording | Done (390 px, dark) |
| :---: | :---: |
| <img src="docs/preview-recording.png" alt="Recording" width="100%" /> | <img src="docs/preview-mobile.png" alt="Mobile" width="60%" /> |

## Requirements

- CLIProxyAPI with the `mistral-support` plugin (route `POST /v0/management/audio/transcriptions`) and its **management key**.
- pipaya opened over **HTTPS** (browsers only allow the microphone in a secure context). a plain `http://<ip>:<port>` page will not work; serve it over HTTPS (for example with a reverse proxy or `tailscale serve`).
- When pipaya is on HTTPS, its **server address must be HTTPS too** (mixed content is blocked). See [Server address](#server-address-https).

## Install

1. `npm run build` (or take `dist/voice-input.json`).
2. pipaya **Settings → Client extensions → Add extension**, choose `dist/voice-input.json`, import (starts disabled).
3. Open **Voice Input**, fill in the settings, **Save settings**, then turn it on and approve the notice.

| Setting | Default | Description |
| --- | --- | --- |
| `apiBase` | *(required, none)* | Origin of your CLIProxyAPI, for example `https://your-cliproxyapi.example.com`. No path or credentials. Nothing is built in: empty or malformed, the button asks for it and sends no request. |
| `apiKey` | *(required, none)* | Management key. Secret field. Empty: the button tells you to set it. |
| `model` | `voxtral-mini-transcribe-3-0` | Empty uses the server default. |
| `language` | `ko` | ISO 639-1 code. Empty lets Voxtral detect it. |

`settingsScope` is **`local`**: the management key is a credential, and `server` scope would store it in plain text on the pipaya server and share it with every connected device. With `local` it stays on this browser/app only (and is never exported). Enter it once per device.

## Usage

- Click the mic: recording starts (red button, elapsed time). Click again (or the stop square) to transcribe. **✕** cancels without uploading.
- The text is appended after the current draft, separated by a space. Review it, then send yourself.
- Recording stops by itself after 5 minutes. The microphone is released as soon as recording ends (and when the button is removed).
- `context_bias` is never sent: the server adds its stored term list (commit, push, git, …).

| Message | Meaning |
| --- | --- |
| Address needed | `apiBase` is empty or not a bare http(s) origin (opens the settings). |
| Key needed | No management key in the settings (opens the settings). |
| Key rejected | 401/403. No request is made again until the key changes, to avoid CLIProxyAPI's IP ban after repeated failures. |
| Mic denied / No mic / Mic unavailable | Allow the microphone in the browser's site settings, check the device, close other apps using it. |
| HTTPS needed | pipaya is not in a secure context. |
| Unreachable / Timed out | Cannot reach `apiBase` (60 s limit). |
| Nothing heard / Too short | Empty transcript or recording under 0.4 s. |

## Recording format

The browser's own `MediaRecorder` format is uploaded as is (Chrome/Firefox: `audio/webm` opus, Safari: `audio/mp4`). Voxtral was checked with real uploads of m4a, webm/opus and wav, all returning the same transcript, so no WAV conversion is done.

## Server address (HTTPS)

No core change is needed. In pipaya: **Settings → (your server tab) → edit**, set the address to `https://<your-pipaya-server>:<port>` and the same token, save (the app verifies it first). The list is kept in this browser's `localStorage` (`pipaya.servers`). The default address is built from the page host with port 8787 over `http`, so on an HTTPS page it must be changed once per browser.

## Permissions

| Permission | Why |
| --- | --- |
| `ui-components` | The only one. Mounts the button in `composer.toolbar`. The microphone and upload are done by the component itself (`getUserMedia`, `fetch`), so no `http`, `composer`, `storage` or `context` permission is requested. |

> [!WARNING]
> `ui-components` runs this extension's Svelte code **inside the pipaya app, without a sandbox**, so it can reach everything the app holds (chats, server connections, tokens). The key is only sent as an `Authorization` header to your `apiBase` and is never logged, stored elsewhere or put in a message (tests enforce this), but install only builds you trust.

## Development

```sh
npm run check   # build + unit tests
```

`src/helpers.mjs` (pure, tested) is inlined into `src/components/VoiceButton.svelte` by `scripts/build.mjs` because a trusted component may only import `pipaya` and `svelte*`. Output: `dist/voice-input.json`.

## License

MIT
