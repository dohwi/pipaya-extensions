<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

# voice-input

A microphone button in the [pipaya](https://github.com/dohwi/pipaya) composer. Press it, speak, press again: the audio is sent to **any OpenAI-compatible transcription API** and the text is appended to the input box. It never sends the message for you.

| Recording | Settings | Done (390 px, dark) |
| :---: | :---: | :---: |
| <img src="docs/preview-recording.png" alt="Recording" width="100%" /> | <img src="docs/preview-settings.png" alt="Settings" width="100%" /> | <img src="docs/preview-mobile.png" alt="Mobile" width="60%" /> |

## Requirements

- A transcription server that answers `POST <origin><path>` with multipart `file`, `model`, `language` and an `Authorization: Bearer` key, and returns JSON with a `text` field (the OpenAI `audio/transcriptions` format), and that **allows requests from the browser (CORS)**.
- pipaya opened over **HTTPS** (or `http://localhost`) so the microphone can start. On an https page the transcription server must be `https://` too. See [HTTPS](#https).
- When pipaya is on HTTPS, its own **server address must be HTTPS too** (mixed content is blocked). See [Server address](#server-address-https).

## Install

1. `npm run build` (or take `dist/voice-input.json`).
2. pipaya **Settings → Client extensions → Add extension**, choose `dist/voice-input.json`, import (starts disabled).
3. Open **Voice Input**, fill in the settings, **Save settings**, then turn it on and approve the notice.

| Setting | Default | Description |
| --- | --- | --- |
| `apiBase` | *(required, none)* | Origin of the server, for example `https://api.openai.com`. On an **https page it must be https** (see [HTTPS](#https)). No path or credentials. Nothing is built in: empty or malformed, the button asks for it and sends no request. A value typed without a scheme (`api.example.com`) is read as `https://`; the stored text is not changed. |
| `transcribePath` | `/v1/audio/transcriptions` | Request path, starting with `/`. Only a plain path is accepted (no scheme, host, query, `..`). The URL is `apiBase` + this path. |
| `apiKey` | *(required, none)* | Sent only as `Authorization: Bearer`. Secret field. |
| `model` | *(empty)* | Model name. Most hosted services require one (see the table). Empty: the field is not sent and the server default is used. There is no default because any value would suit only one service. |
| `language` | `ko` | ISO 639-1 code. Empty lets the server detect it. Sent as `languages[]` when the model is `gpt-transcribe`. |
| `shortcut` | *(empty = none)* | Keyboard shortcut for dictation, for example `Alt+M` or `Mod+Shift+K`. See [Keyboard shortcut](#keyboard-shortcut). |
| `shortcutMode` | `toggle` | `toggle` or `hold` (hold to talk). Only used when `shortcut` is set. |

`settingsScope` is **`local`**: the key is a credential, and `server` scope would store it in plain text on the pipaya server and share it with every connected device. With `local` it stays on this browser/app only (and is never exported). Enter it once per device.

## Services

Set `apiBase`, `transcribePath` and `model` as below. The values come from each service's public documentation (linked); for a self-hosted server use your own address.

| Service | `apiBase` | `transcribePath` | `model` examples | Documentation |
| --- | --- | --- | --- | --- |
| OpenAI | `https://api.openai.com` | `/v1/audio/transcriptions` | `gpt-transcribe` (recommended, see the note below) | [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text) |
| Groq | `https://api.groq.com` | `/openai/v1/audio/transcriptions` | `whisper-large-v3-turbo`, `whisper-large-v3` | [Speech to text](https://console.groq.com/docs/speech-to-text) |
| Mistral | `https://api.mistral.ai` | `/v1/audio/transcriptions` | `voxtral-mini-transcribe-3` (also `voxtral-mini-latest` in the API reference) | [File transcription](https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files) |
| Self-hosted OpenAI-compatible server (for example [speaches](https://github.com/speaches-ai/speaches), formerly faster-whisper-server) | your server | the route its documentation lists, usually `/v1/audio/transcriptions` | what the server lists | the server's own documentation |

Notes:

- **OpenAI models.** OpenAI's documentation lists `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` as deprecated, shutting down on **26 February 2027**, and recommends `gpt-transcribe`. That model takes `languages` instead of `language` and says not to send both, so when the `model` setting is exactly `gpt-transcribe` this extension sends your `language` as `languages[]` (and no `language`); every other model keeps `language`. This follows OpenAI's documentation; it has not been checked with a real call to OpenAI.
- **Self-hosted servers.** Any server that implements the OpenAI transcription request (multipart `file`, `model`, `language`; JSON `{ "text": ... }` back) works; if it serves the route under another path, set `transcribePath`. Not every server speaks this format: for example the `whisper.cpp` example server answers on `/inference` with its own request format, so it needs an OpenAI-compatible front end. The server must also allow browser (CORS) requests.
- **What was tested.** During development the full flow (record, upload, text in the input box) was run end to end against one OpenAI-compatible server. The hosted services above follow their published request format, but the author of this repository has not called them.

## Usage

- The microphone is just left of the send button. Click it: recording starts (red button, elapsed time). Click again (or the stop square) to transcribe. **✕** cancels without uploading.
- The text is appended after the current draft, separated by a space. Review it, then send yourself.
- Recording stops by itself after 5 minutes. The microphone is released as soon as recording ends (and when the button is removed).

| Message | Meaning |
| --- | --- |
| Use https | pipaya is open over https and `apiBase` starts with `http://` (not localhost). The browser would block it, so no request is sent; change it to `https://`. |
| HTTPS page needed | pipaya itself is open over plain `http://` (not localhost), so the browser will not start the microphone. The button is dimmed and explains this when pressed. |
| Address needed | `apiBase` is empty or not a bare http(s) origin (opens the settings). |
| Bad path | `transcribePath` is not a plain path starting with `/`. |
| Key needed | No key in the settings (opens the settings). |
| Key rejected | 401/403. No request is made again until the key changes, to avoid being blocked after repeated failures. |
| Not found | 404/405: wrong address or path. |
| Mic denied / No mic / Mic unavailable | Allow the microphone in the browser's site settings, check the device, close other apps using it. |
| Unreachable / Timed out | Cannot reach `apiBase` (60 s limit), or the server blocks browser requests (CORS). |
| Server error | Other non-2xx answers; also check the model name. |
| Nothing heard / Too short | Empty transcript or recording under 0.4 s. |

## HTTPS

The extension talks only to the transcription server you configure (`apiBase`); it never talks to the pipaya server. HTTPS matters for exactly two reasons:

1. **The microphone.** Browsers start it (`getUserMedia`) only when the page is a secure context: an `https://` page, or `http://localhost` / `http://127.0.0.1`. If pipaya is opened at `http://<host>:<port>` the mic button is dimmed and, when pressed, says so; no recording starts. Open pipaya over HTTPS (for example behind a reverse proxy, or with `tailscale serve`).
2. **Mixed content.** An `https://` page cannot call an `http://` server; the browser blocks it. So **on an https page, `apiBase` must be `https://`**, and a plain `http://` address is refused with "Use https" and no request is made. A value typed without a scheme is read as `https://`.

Everything else is allowed. On a page that is *not* https (for example `http://localhost` with a local Whisper server at `http://localhost:8000`, or an http page with a private-network server), a plain-http `apiBase` is used as written.

**Loopback exception on https pages**: `http://localhost`, `http://127.0.0.1` and `http://[::1]` are accepted even from an https page, for a Whisper server on your own machine. Checked in headless Chromium 158 (an https page `fetch` to each of the three over plain `http` succeeded, while the same call to a public host was blocked as mixed content). Other private addresses (`192.168.x.x`, `10.x.x.x`, `*.local`, a LAN or tailnet IP) were also reachable in that Chromium, but that is not guaranteed in other browsers or versions, so on an https page this extension does not treat them as an exception: give such a server an `https://` address (reverse proxy, `tailscale serve`).

## Keyboard shortcut

**There is no default shortcut.** While `shortcut` is empty the extension listens to no keys at all. Type your own combination in the extension settings; it applies at once, no restart.

- **Format**: the same notation as pipaya's own shortcuts. `Mod` is Ctrl (⌘ on macOS), then optionally `Alt` and `Shift`, then **one** key: `Alt+M`, `Mod+Shift+K`, `Alt+Space`, `F9`. Case does not matter (`ctrl+shift+k` works). A combination needs `Mod` or `Alt` (so it never types a letter into the input box); an F-key may stand alone. `Esc`, `Enter`, `Tab` and `Backspace` are not allowed. Keys are matched by their physical position, so a Korean keyboard layout or the character `Alt` produces on macOS does not matter.
- **`toggle`** (default): press once to start recording, press again to stop, transcribe and append. It does exactly what clicking the microphone does.
- **`hold`**: record while the keys are held; releasing them stops, transcribes and appends. A press shorter than 0.3 s is thrown away silently (nothing is uploaded), so an accidental tap does nothing. Key auto-repeat is ignored. If the window loses focus or the tab is hidden while the key is down, recording stops by itself (the key-up would never arrive), and the microphone is always closed.
- The shortcut works while the input box has focus. During Korean (or other IME) composition it is ignored.
- The microphone tooltip shows the combination and the mode when one is set.
- Like the button, it explains why it cannot start (no address, no key, offline, page not https) instead of failing silently.

**If pipaya already uses the combination** (for example `Mod+M`, the model picker, or `Mod+N`), the app handles the key first and wins; the extension steps aside and tells you once, when you save the setting ("shortcut taken"). Pick another combination. A combination the browser or your OS reserves (for example `Ctrl+W`, `Alt+Tab`) may never reach the page at all.

The SDK's own `shortcuts` permission is not used: it has no key-release signal, so it cannot do `hold`, and it would add a second permission. The component listens to the keyboard itself, and removes every listener when the setting is cleared, the extension is turned off, or the button goes away.

## Recording format

The browser's own `MediaRecorder` format is uploaded as is (Chrome/Firefox: `audio/webm` opus, Safari: `audio/mp4`), named `voice.webm` / `voice.m4a`. The documentation of [OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text) and [Groq](https://console.groq.com/docs/speech-to-text) lists webm and m4a among the accepted formats. For any other service, including Mistral (its pages did not list the accepted file formats when this was written), check that service's documentation. No WAV conversion is done.

## Upgrading

0.3.1 is a visual clean-up only (no behaviour change): the microphone now has the send button's shape, size and feel (38px round, grey at rest, danger tint while recording, no transparency tricks when unavailable), the status chips are padded pills, and the cancel button moved inside the recording chip. The timer is no longer read out by screen readers every second.

0.3.0 adds the optional keyboard shortcut (`shortcut`, `shortcutMode`). Nothing changes until you set one.

0.2.1 moves the button from the toolbar (beside the model picker) to the left of the send button. Re-import `dist/voice-input.json`; settings are kept.

## Server address (HTTPS)

No core change is needed. In pipaya: **Settings → (your server tab) → edit**, set the address to `https://<your-pipaya-server>:<port>` and the same token, save (the app verifies it first). The list is kept in this browser's `localStorage` (`pipaya.servers`). The default address is built from the page host with port 8787 over `http`, so on an HTTPS page it must be changed once per browser.

## Permissions

| Permission | Why |
| --- | --- |
| `ui-components` | The only one. Replaces the app's `composer.send` part so the microphone sits right beside the send button. The original send control is still drawn by the app (`fallback`), untouched. The microphone and upload are done by the component itself (`getUserMedia`, `fetch`), so no `http`, `composer`, `storage` or `context` permission is requested. |

### Replacing `composer.send`

- Only one extension can replace a given part, and **the first installed wins**. This extension therefore cannot be used together with another extension that replaces `composer.send`.
- Symptom if another extension already holds it: the microphone button is simply not there (nothing else breaks). Fix: turn that extension off (or delete it) and reload this one, or install this one first.
- If this extension's component fails, the app falls back to its normal send button, so sending never depends on it.
- Send, queue, steer, stop and the compaction cancel are the app's own controls and behave as before; the microphone is just placed to their left. It is disabled while the app is offline.

> [!WARNING]
> `ui-components` runs this extension's Svelte code **inside the pipaya app, without a sandbox**, so it can reach everything the app holds (chats, server connections, tokens). The key is only sent as an `Authorization` header to your `apiBase` and is never logged, stored elsewhere or put in a URL or message (tests enforce this), but install only builds you trust. Your voice goes to the service you configure; read its privacy terms.

## Development

```sh
npm run check   # build + unit tests
```

`src/helpers.mjs` (pure, tested) is inlined into `src/components/VoiceButton.svelte` by `scripts/build.mjs` because a trusted component may only import `pipaya` and `svelte*`. Output: `dist/voice-input.json`.

## License

MIT
