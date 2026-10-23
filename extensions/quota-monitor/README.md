<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>pipaya-extension-quota-monitor</h1>
  <p>See how much Claude, GPT and Antigravity quota you have left, right in the <a href="https://github.com/dohwi/pipaya">pipaya</a> navbar.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/cliproxyapi-plugin-quota-monitor"><img src="https://img.shields.io/badge/Requires-cliproxyapi--plugin--quota--monitor-0EA5E9?style=flat-square" alt="Requires cliproxyapi-plugin-quota-monitor" /></a>
  </p>
</div>

| Navbar gauges | Hover popover |
| :---: | :---: |
| <img src="docs/preview-desktop.png" alt="Navbar gauges" width="100%" /> | <img src="docs/preview-hover.png" alt="Hover popover" width="100%" /> |

<sub>Screenshots show the Korean UI. The extension also supports English (see [Language](#language)).</sub>

## What it does

- Shows one ring gauge per provider in the pipaya navbar: **Claude**, **GPT (Codex)** and **Antigravity**. A directly connected Gemini account gets its own gauge too.
- The ring is the **overall remaining quota (%)** computed by your CLIProxyAPI server. It is not a token or cost estimate.
- **Antigravity** has a dual ring: the outer ring is Gemini, the inner ring is Claude/GPT.
- **Only providers you actually have are shown.** With no GPT account, there is no GPT gauge.
- Ring colour: provider colour above 20%, amber at 20% or less, red at 5% or less.
- Hover or focus a gauge to see the remaining percentage and how long ago it was measured.
- Refreshes on its own every 60 seconds, and again 2.5 seconds after the agent finishes a turn.
- Unknown or failed reads are never shown as 0%. The last good value stays, marked as stale.

## Requirements

- A [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server with the [cliproxyapi-plugin-quota-monitor](https://github.com/dohwi/cliproxyapi-plugin-quota-monitor) plugin installed. Use v0.2.1 or later so Antigravity shows Gemini quota.
- The CLIProxyAPI **management key**.
- A pipaya client that supports extensions (SDK v1).

## Install

1. Get the package. Download `dist/quota-monitor.json` from this repository, or build it yourself (see [Development](#development)).
2. In pipaya, open **Settings → Extensions → Import package** and choose `dist/quota-monitor.json`.
3. Fill in the settings and save:
   - **CLIProxyAPI address**: the origin only, for example `http://your-server:8317`. No path, no credentials.
   - **Management key**: your CLIProxyAPI management key.
4. Review the requested permissions (`navbar`, `http-write`, `events`), approve them and turn on **Quota Monitor**.

The gauges appear in the navbar within a few seconds.

> Settings are stored on the pipaya server and shared by all your devices. Enabling the extension and approving permissions must be done on each device.
>
> To update, import the new `quota-monitor.json` again (same ID) and approve any new permissions.

## Usage

- **Read a gauge**: the fuller the ring, the more quota you have left. A grey or empty ring means the value is unknown.
- **Details**: hover (or focus with the keyboard) a gauge to see the remaining percentage and `Updated N seconds ago`. Antigravity shows two bars, Gemini and Claude/GPT.
- **Stale data**: if the server cannot be reached, the last value stays and the popover says so. It recovers by itself.
- **Force a refresh**: finishing an agent turn triggers one. There is no manual button.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Set the management key" | The key is empty. Enter it in the extension settings. |
| "The management key was rejected" | Wrong key (401/403). Requests stop until you change the key, which protects you from the server's temporary IP ban after repeated failures. |
| "Check the quota-monitor configuration" | The plugin is installed but not configured on the server. |
| "Waiting for the first quota collection" | The server is still doing its first collection. Retries every 2 seconds. |
| A gauge shows unknown | The server has no `availability` value for it. Update the quota-monitor plugin. |
| No GPT gauge | You have no GPT (Codex) account. This is intended. |
| Antigravity has no Gemini ring | Update the quota-monitor plugin to v0.2.1 or later. |

## Configuration

| Setting | Default | Description |
| --- | :---: | --- |
| `httpOrigin` | *(required)* | Origin of your CLIProxyAPI, for example `http://your-server:8317`. |
| `httpToken` | *(required)* | CLIProxyAPI management key. |
| `language` | `auto` | `auto` follows the program language. You can pin `ko` or `en`. |
| `pollSeconds` | empty | Refresh interval in seconds (10–900). Empty follows the server hint (about 60 seconds). |

### Language

`auto` uses the language reported by the program that runs pipaya. Unsupported languages fall back to English. Messages are in `src/i18n.mjs`.

## Security

- The extension runs in pipaya's sandboxed Worker. It cannot touch the page, the app's auth token or anything outside its permissions.
- It only sends `GET <httpOrigin>/v0/management/plugins/quota-monitor/data/accounts`. The host adds the `Authorization: Bearer` header itself, so the key never appears in the URL or in extension code. Cookies are not sent and redirects are rejected.
- `http-write` is requested only because the SDK requires it for authenticated requests. This extension never sends anything but GET.
- **The management key is stored in plain text** in the pipaya server's `extensions/quota-monitor/settings.json`, and every device connected to that server receives it. Anyone with a token for your pipaya server can read it. It is left out of configuration exports. If you lose a device, rotate the management key and the server token.
- Only overall percentages are used. Account names, emails and per-account limits are never displayed.

## How it works

```
Providers → CLIProxyAPI + quota-monitor plugin ──GET (management key)──▶ this extension ──▶ pipaya navbar
```

The plugin measures every account and aggregates the overall remaining quota (`availability`: `claude`, `codex`, `antigravity_gemini`, `antigravity_claude`). The extension maps those values to rings and never recalculates them.

## Development

Requires Node.js 26 (`mise install` sets it up).

```bash
npm run build   # bundles src/ into dist/quota-monitor.json
npm test        # Node built-in test runner
npm run check   # build + test
```

Source layout: `src/extension.js` (lifecycle and polling), `src/model.mjs` (snapshot → gauges), `src/view.mjs` (navbar nodes), `src/i18n.mjs` (messages), `src/logos.mjs` (brand icons). `scripts/check-browser.cjs` is an optional headless-browser QA script that needs Playwright and a running pipaya client (`PIPAYA_TEST_URL`).

## License

[MIT](LICENSE) © 2026 dohwi
