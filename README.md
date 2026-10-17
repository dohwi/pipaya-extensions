<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<div align="center">
  <h1>pipaya-extension-quota-monitor</h1>
  <p>A real-time AI provider quota monitor extension for the dohwi/pipaya client, backed by CLIProxyAPI and the quota-monitor plugin.</p>

  <p>
    <a href="https://github.com/dohwi/pipaya" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/pipaya-Client-000000?style=flat-square&logo=github&logoColor=white" alt="pipaya Client" /></a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" alt="Svelte 5" /></a>
    <a href="https://tauri.app" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" /></a>
    <a href="https://nodejs.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Node.js-26-5FA04E?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 26" /></a>
    <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript ESM" /></a>
    <a href="https://github.com/dohwi/cliproxyapi-plugin-quota-monitor" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Quota_Monitor-Management_API-0EA5E9?style=flat-square" alt="Quota Monitor" /></a>
  </p>

  <p><a href="#preview">Preview</a> · <a href="#overview">Overview</a> · <a href="#features">Features</a> · <a href="#data-source">Data Source</a> · <a href="#getting-started">Getting Started</a> · <a href="#configuration">Configuration</a></p>
</div>

---

## Preview

| Navbar gauges | Remaining-quota popover (hover) |
| :---: | :---: |
| <img src="docs/preview-desktop.png" alt="Desktop navbar view" width="100%" /> | <img src="docs/preview-hover.png" alt="Hover details view" width="100%" /> |

<details>
<summary>Mobile / narrow (320px) view</summary>
<br />
<p align="center">
  <img src="docs/preview-mobile.png" width="340" alt="Mobile 320px view" />
</p>
</details>

> The screenshots show the Korean UI. The extension also supports English; see [Language](#language).

---

## Overview

`pipaya-extension-quota-monitor` is a client extension (`quota-monitor`) for the [dohwi/pipaya](https://github.com/dohwi/pipaya) LLM coding agent. It shows the **overall remaining quota (%) that the upstream reports for each AI provider (Claude · GPT · Antigravity)** in the pipaya top navigation bar.

### How the pieces fit together

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Upstream Providers                           │
│        (Anthropic Claude, OpenAI Codex/GPT, Google Gemini, etc.)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Rate-limit & Quota Headers/API
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   CLIProxyAPI (Proxy & Gateway)                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ cliproxyapi-plugin-quota-monitor (Native Server Plugin)          │  │
│  │ - Periodically observes remaining quota and reset times of       │  │
│  │   every AI account from the upstream                             │  │
│  │ - Exposes a read-only endpoint:                                  │  │
│  │   GET /v0/management/plugins/quota-monitor/data/accounts         │  │
│  └────────────────────────────────┬─────────────────────────────────┘  │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │ HTTP GET JSON (Sandboxed Worker)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     dohwi/pipaya Client                                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ pipaya-extension-quota-monitor (Sandboxed Web Worker)            │  │
│  │ 1. Event trigger: run_finished (follow-up poll after 2.5 s)      │  │
│  │    and periodic polling                                          │  │
│  │ 2. Data model: maps upstream overall remaining quota             │  │
│  │ 3. UI emission: sdk.navbar.set('usage', { rings, details })      │  │
│  └────────────────────────────────┬─────────────────────────────────┘  │
│                                   │ Declarative UI nodes               │
│                                   ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Navbar & UI (Svelte 5 / Tauri 2)                                 │  │
│  │ - Claude · GPT · Antigravity (Gemini/Claude dual ring) gauges    │  │
│  │ - Hover popover: overall remaining quota and update time         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **dohwi/pipaya**: a coding agent with a Bun + Fastify backend and a Svelte 5 + Tauri 2 frontend. It ships a sandboxed extension system (SDK v1) built on opaque-origin Web Workers.
2. **CLIProxyAPI (`cliproxy`)**: a gateway that routes and proxies multiple accounts and keys of providers such as Claude, Codex and Gemini in one place.
3. **`cliproxyapi-plugin-quota-monitor` plugin**: a native plugin loaded directly by the CLIProxyAPI server ([dohwi/cliproxyapi-plugin-quota-monitor](https://github.com/dohwi/cliproxyapi-plugin-quota-monitor)). It periodically observes the real limits of each provider account (5-hour window, weekly limit, reset time and so on) from the upstream and exposes them through a management endpoint.
4. **`pipaya-extension-quota-monitor` (this extension)**: installed in the pipaya client. It reads the quota-monitor data and renders live ring gauges and a detail popover in the navbar above the chat.

---

## Features

You can check how much quota is left while talking to the agent, without opening a separate dashboard or CLI.

### 1. Ring gauges based on overall remaining quota
- Rings are filled with the **upstream `availability[].remaining_percent`** value itself, not with token usage or cost estimates.
- Fixed brand order: **Claude** (orange) → **GPT / Codex** (green) → **Antigravity** (dual ring). If a directly connected Gemini account exists, it is placed before Antigravity automatically.
- **Only providers you have accounts for are shown**: if there is no GPT (Codex) account, the GPT gauge is not shown at all, even if the server sends a value for it.
- **Antigravity dual ring**: the outer ring is the Gemini remaining quota and the inner ring is the Claude/GPT-via-Antigravity remaining quota, so they are never confused with the official accounts.

### 2. Colour escalation by remaining quota
- **Normal (above 20%)**: the provider's brand colour
- **Warning (20% or less)**: amber (`warn`)
- **Critical (5% or less)**: red (`danger`), close to exhaustion

### 3. A compact overall-remaining popover
- Hovering or focusing a gauge shows only the overall remaining quota.
- Claude, GPT and directly connected Gemini show one remaining bar. Antigravity shows two bars: Gemini and Claude/GPT.
- Aggregate labels such as availability or usage rate, 5-hour / weekly / per-bucket limits and reset times are not shown.
- The footer shows `Updated N seconds ago`, refreshed every second, based on the time quota-monitor actually measured the data.

### 4. Matches the upstream overall remaining quota
- **Server aggregates are used as is**: the keys `claude`, `codex`, `antigravity_gemini` and `antigravity_claude` map to the rings. The extension never substitutes the most recently used account or the lowest per-account remaining quota.
- **Aggregation rules belong to the upstream**: 5-hour remaining quota, blocking on weekly exhaustion, which accounts are included and the fleet average are all computed by the server. The extension does not recompute them.
- **Unknown stays unknown**: if `availability` or the matching entry is missing, or the ratio is invalid, the ring is shown as unknown. You need a quota-monitor version that provides this field.
- **Consistent display**: the ring and the popover use the same server aggregate. Per-account limits are neither shown nor recomputed.

### 5. Agent lifecycle integration
- When the coding agent finishes a turn (`run_finished` event), a follow-up refresh is scheduled after 2.5 seconds, so quota consumed by the agent shows up immediately.

### 6. Strict zero-trust sandbox
- It runs isolated in a browser opaque-origin Worker sandbox and cannot touch the DOM directly, Tauri internal permissions or the app auth token.
- Since quota-monitor v0.2.0 the data is served only on the authenticated management route. The extension reads read-only snapshots. The management key (`httpToken`) is **stored in plain text** in the server's `extensions/quota-monitor/settings.json` (`settingsScope: server`). Every device connected to the server receives the same value and caches it in its local storage. Anyone holding a server token can read this management key. `secret` fields are shown as password inputs and are excluded from configuration exports. If you lose a device, rotate the management key together with the server token.

---

## Data Source

- **Data endpoint**:
  ```text
  GET <httpOrigin>/v0/management/plugins/quota-monitor/data/accounts
  ```
- **Provided by**: the `quota-monitor` plugin on the CLIProxyAPI server
- **How it is collected**:
  - The snapshot is read with `sdk.http.requestJson({ path })`. The host attaches the extension's own `httpToken` as an `Authorization: Bearer` header. The key is never put in the URL and the extension never builds the header itself.
  - Cookies and the app server auth token are not sent, and HTTP redirects are rejected. The SDK requires the `http-write` permission, but this extension only sends GET requests.
  - If the key is missing or rejected with 401/403, network requests stop and only the local settings are re-checked. Requests resume once the key changes. This avoids the host's ban of an IP for 30 minutes after five failed authentications.
  - When the agent run-finished event (`run_finished`) fires, a fetch is triggered after 2.5 seconds.
  - Periodic background polling (server hint or user-defined interval, 60 seconds by default).
  - Calls within 2 seconds of each other are debounced, and network failures back off exponentially (up to 5 minutes).

---

## Getting Started

Set up the development and build environment with [mise](https://mise.jdx.dev):

```bash
# Activate the runtime
mise trust
mise install

# Build the bundle and run all tests
npm run check
```

### Install the extension in the pipaya client

1. Locate the built single JSON package:
   ```text
   dist/quota-monitor.json
   ```
2. Start the `dohwi/pipaya` client and go to **Settings → Extensions**.
3. Click **Import package** and choose `dist/quota-monitor.json`.
4. In the extension settings, enter the CLIProxyAPI origin and the management key, then click **Save settings**:
   ```json
   {
     "httpOrigin": "https://your-cliproxy.example",
     "httpToken": "<CLIProxyAPI management key>",
     "pollSeconds": 60
   }
   ```
   > **Note**: `httpOrigin` must be a plain `http(s)://host:port` origin with no path (`/v0/...`) and no API key. If you leave `pollSeconds` empty, the server hint (usually 60 seconds) is followed.
5. Review the requested permissions (`navbar`, `http-write`, `events`), approve them and turn on the **Use Quota Monitor** switch. When updating from v0.1.0/v0.2.0, import the JSON with the same ID again and approve the new permissions. Settings use `settingsScope: server`, so saving `httpOrigin` and `httpToken` on one device syncs them to all devices through the server. The enable switch and the permission approval, however, are per device. If you stored a key locally on a device with v0.2.0, the server value takes precedence.
6. Live ring quota gauges appear in the top navigation bar.

---

## Configuration

Extension settings defined in `manifest.json`:

| Field | Type | Default | Description |
|---|---|:---:|---|
| `httpOrigin` | `string (origin)` | *(required)* | Origin of the CLIProxyAPI that has the quota-monitor plugin installed (e.g. `http://100.85.51.107:8317`) |
| `httpToken` | `string (secret)` | *(required)* | CLIProxyAPI management key. Stored in plain text on the server and synced to all devices, excluded from configuration exports, never sent in a URL |
| `language` | `select` | `auto` | Display language. `auto` follows the language of the program running pipaya; you can pin it to `ko` or `en` |
| `pollSeconds` | `number` | `null` | Background refresh interval in seconds (10–900). If empty, the server hint interval is used |

### Language

With `auto` (the default), the extension follows the language the program reports, the same rule the pipaya client uses: the first supported preference wins, unsupported languages fall back to English, and an unknown environment falls back to Korean. Messages live in `src/i18n.mjs`; a key missing in one language falls back to Korean.

---

## Development & Verification

The pure model layer and the SDK mock layer are fully separated, so each module is verified in isolation with Node's built-in test runner.

```bash
# Bundle the worker code into a single async body and generate dist/quota-monitor.json
npm run build

# Run the Node.js built-in test suite
npm test

# Build and test together
npm run check
```

### Source layout

```
pipaya-extension-quota-monitor/
├── dist/
│   └── quota-monitor.json        # Final package to import into the pipaya client
├── docs/                         # Desktop/mobile UI preview assets
├── scripts/
│   ├── build.mjs                 # Bundles the source modules and validates integrity
│   └── check-browser.cjs         # Headless-browser integration QA script
├── src/
│   ├── extension.js              # SDK lifecycle, timers and event handlers
│   ├── i18n.mjs                  # Korean/English message catalog and language selection
│   ├── model.mjs                 # Overall-remaining mapping, observation time and polling policy
│   ├── view.mjs                  # Declarative navbar UI node builder
│   └── logos.mjs                 # Inline SVG path data per brand
├── tests/                        # Node unit tests and SDK mock tests
├── manifest.json                 # Extension permission spec and settings schema
├── package.json
├── mise.toml
├── README.md                     # English
└── README.ko.md                  # 한국어
```
