import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../dist/voice-input.json', import.meta.url), 'utf8'));
const source = pkg.components.VoiceButton;
const sendSource = pkg.components.VoiceSend;

test('package is a single ui-components extension with no worker code', () => {
  assert.equal(pkg.manifest.version, pkg.manifest.version.match(/^\d+\.\d+\.\d+$/)?.[0]);
  assert.equal(pkg.manifest.id, 'voice-input');
  assert.equal(pkg.manifest.sdkVersion, 1);
  assert.deepEqual(pkg.manifest.permissions, ['ui-components', 'shortcuts'], 'least privilege: the microphone button and the app\'s shortcut API, no http, storage or composer permission');
  assert.equal(pkg.code, undefined);
  assert.equal(pkg.mounts, undefined, 'no second button: the microphone is drawn only by the replaced send part');
  assert.deepEqual(pkg.replaces, { 'composer.send': 'VoiceSend' });
  assert.deepEqual(Object.keys(pkg.components).sort(), ['VoiceButton', 'VoiceSend']);
  assert.ok(Buffer.byteLength(JSON.stringify(pkg)) < 256 * 1024);
  assert.ok(Buffer.byteLength(source) < 64 * 1024);
});

test('settings: no built-in address, required origin and secret key, standard default path, device-local scope', () => {
  const byKey = Object.fromEntries(pkg.manifest.settings.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey), ['apiBase', 'transcribePath', 'apiKey', 'model', 'language', 'shortcut', 'shortcutMode']);
  assert.ok(!('format' in byKey.apiBase), 'no origin format: a scheme-less address must still be savable (it is read as https at run time)');
  assert.equal(byKey.apiBase.required, true);
  assert.ok(!('default' in byKey.apiBase), 'the user enters their own address');
  assert.match(byKey.apiBase.placeholder, /^https:\/\/.*example\.com/);
  assert.match(byKey.apiBase.description, /https/i);
  assert.ok(!/https만 가능|HTTPS only|https only/i.test(byKey.apiBase.description), 'the rule is about https pages, not about every address');
  assert.equal(byKey.transcribePath.default, '/v1/audio/transcriptions');
  assert.ok(!byKey.transcribePath.required);
  assert.equal(byKey.apiKey.secret, true);
  assert.equal(byKey.apiKey.required, true);
  assert.ok(!('default' in byKey.apiKey));
  assert.ok(!('default' in byKey.model) && !byKey.model.required, 'no service-specific model is assumed');
  assert.equal(byKey.language.default, 'ko');
  assert.equal(pkg.manifest.settingsScope, 'local');
  assert.equal(pkg.manifest.version, '0.4.0');
});

test('component hard-codes no service route', () => {
  assert.ok(!/\/v0\//.test(source));
  const routes = source.replace(/<style[\s\S]*<\/style>/, '').match(/['"`]\/[\w/.-]*transcriptions['"`]/g) ?? [];
  assert.deepEqual(routes, ["'/v1/audio/transcriptions'"], 'the only route in the code is the OpenAI default');
});

test('component imports only what the host allows and inlines the helpers', () => {
  const imports = [...source.matchAll(/^\s*import .* from ["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['pipaya', 'svelte']);
  assert.ok(/import \* as kit from "pipaya"/.test(source), 'the kit is read as a namespace, so an app without `shortcuts` does not break the button');
  assert.ok(!source.includes('/* @helpers */'));
  assert.match(source, /function transcribe\(|async function transcribe\(/);
  assert.ok(!/^\s*export /m.test(source.replace(/<style[\s\S]*<\/style>/, '')), 'no leftover exports');
});

test('component sends no extra form fields, never stores or logs the key', () => {
  const body = source.replace(/<style[\s\S]*<\/style>/, '');
  const own = body.replace(/<script module>[\s\S]*?<\/script>/, '').replace(/\/\/.*$/gm, ''); // the component's own script, without the inlined helpers
  assert.ok(!/\.append\(/.test(own), 'the form is built only in helpers.mjs');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(body));
  assert.ok(!/console\./.test(body));
  assert.ok(!/(toast|say)\([^)]*apiKey/.test(body));
});

test('component closes the microphone and never auto-sends', () => {
  assert.match(source, /track\.stop\(\)/);
  assert.match(source, /onDestroy/);
  assert.ok(!/\.requestSubmit\(|submit\(|dispatchEvent\(new (Keyboard)?Event\(["']keydown/.test(source), 'transcript is only inserted');
  assert.match(source, /app\.prefill = text/, 'falls back to the app prefill when the textarea is missing');
});

test('no personal address or key is baked into the package', () => {
  const text = JSON.stringify(pkg);
  // the loopback names are part of the https-only rule (the one http exception), not a personal address
  const withoutLoopbackRule = text.replace(/localhost|127\.0\.0\.1|127\\\.\\d\{1,3\}|\[::1\]/g, '');
  assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(withoutLoopbackRule.replace(/127\.1\.2\.3/g, '')), 'no IP address is written into the package');
  assert.ok(!/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(pkg.components.VoiceButton.replace(/<style[\s\S]*<\/style>/, '').replace(/example\.com/g, '')), 'component hard-codes no URL');
});

test('component asks for the address before the key and before any request', () => {
  const begin = source.slice(source.indexOf('async function begin'), source.indexOf('async function begin') + 1200);
  assert.ok(begin.indexOf('base.problem') > 0 && begin.indexOf('base.problem') < begin.indexOf('badPath') && begin.indexOf('badPath') < begin.indexOf('needKey'));
});

test('the send part keeps the original control and only adds the microphone before it', () => {
  assert.match(sendSource, /\{@render fallback\(\)\}/, 'the original control is always drawn');
  assert.ok(sendSource.indexOf('<VoiceButton') < sendSource.indexOf('{@render fallback()}'), 'microphone to the left of send');
  const code = sendSource.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/, '');
  const script = sendSource.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\/\/.*$/gm, '');
  assert.equal(script.match(/\$props\(\)/g)?.length, 1);
  assert.match(script, /let \{ fallback \} = \$props\(\)/, 'takes only fallback; the part props stay with the original control');
  assert.ok(!/canSend|hasInput|compacting|running/.test(code + script), 'no send state is read or re-implemented');
  assert.deepEqual([...sendSource.matchAll(/^\s*import .* from ["']([^"']+)["']/gm)].map((m) => m[1]).sort(), ['./VoiceButton.svelte', 'pipaya']);
  assert.ok(!/fetch\(|getUserMedia|localStorage/.test(sendSource), 'no I/O in the wrapper');
});

test('the microphone is blocked offline but never while it can still be stopped', () => {
  assert.match(source, /blocked = \$derived\(busy \|\| \(offline && phase === "idle"\)\)/);
  assert.match(source, /disabled=\{blocked\}/);
});

test('an insecure page never reaches getUserMedia, and the button says why', () => {
  const begin = source.slice(source.indexOf('async function begin'), source.indexOf('const mine = ++token'));
  assert.match(begin, /if \(!window\.isSecureContext\) return say\("insecure"\)/);
  assert.ok(!/getUserMedia\(/.test(begin), 'begin() only checks; the stream is opened after all checks pass');
  assert.ok(source.indexOf('getUserMedia({') > source.indexOf('const mine = ++token'), 'the stream is opened only after every check');
  assert.ok(begin.indexOf('isSecureContext') < begin.indexOf('checkBase'), 'checked before the settings');
  assert.match(source, /aria-disabled=\{insecure \|\| undefined\}/);
  assert.match(source, /class:unavailable=\{insecure\}/);
  assert.match(source, /insecure && phase === "idle" \? tr\("insecure"\)/);
});

test('the component passes the page protocol, so http providers work from an http page', () => {
  assert.match(source, /checkBase\(settings\.apiBase, location\.protocol\)/);
  assert.match(source, /pageProtocol: location\.protocol/);
});

test('shortcut settings: no default combination, toggle is the default mode, both modes offered', () => {
  const byKey = Object.fromEntries(pkg.manifest.settings.map((f) => [f.key, f]));
  assert.equal(byKey.shortcut.type, 'string');
  assert.ok(!('default' in byKey.shortcut) && !byKey.shortcut.required, 'unassigned until the user sets it');
  assert.match(byKey.shortcut.placeholder, /^Alt\+M$/);
  assert.equal(byKey.shortcutMode.type, 'select');
  assert.equal(byKey.shortcutMode.default, 'toggle');
  assert.deepEqual(byKey.shortcutMode.options.map((o) => o.value), ['toggle', 'hold']);
  assert.ok(pkg.manifest.settings.length <= 20);
});

test('shortcut wiring: the app\'s shortcut API only, registered for a set combination, removed on teardown', () => {
  const code = source.replace(/<style[\s\S]*<\/style>/, '').replace(/<script module>[\s\S]*?<\/script>/, '');
  assert.ok(!/addEventListener|removeEventListener|onkeydown|onkeyup|visibilitychange|isComposing|defaultPrevented/.test(code.replace(/\/\/.*$/gm, '')), 'no key listeners of its own: the app does that');
  const effect = code.slice(code.indexOf('$effect(() => {\n\t\tconst parsed'), code.indexOf('onDestroy(() => {'));
  assert.match(effect, /if \(!parsed\.combo && parsed\.ok\) return;/, 'empty = nothing registered');
  assert.match(effect, /typeof kit\.shortcuts\?\.register !== "function"\) return void tell\("shortcutUnsupported"\)/, 'an app without the API: say so, keep the button');
  assert.match(effect, /mode === "hold" \? \{ down: onShortcut, up: onShortcut \} : \{ down: onShortcut \}/, 'toggle registers down only, hold registers down and up');
  assert.match(effect, /return \(\) => untrack\(\(\) => \{ off\?\.\(\); endHold\(\); \}\)/, 'the cleanup removes the shortcut and ends a held recording, untracked');
  assert.match(effect, /off = untrack\(\(\) => kit\.shortcuts\.register\(/, 'register reads and writes the app\'s shortcut list: untracked, or the effect would trigger itself');
  assert.match(effect, /catch \(error\) \{\s*return void tell\("shortcutRefused"/, 'the app\'s refusal is shown');
  assert.match(effect, /conflictsWithApp\(parsed, app\.prefs\?\.bindings\)/);
  assert.ok(!/\bsay\(/.test(effect), 'notices go through `tell` (untracked): `say` writes the app\'s toast list, and inside an effect that would loop forever');
  assert.match(code, /const tell = \(key, params\) => untrack\(\(\) => \{[\s\S]*?toldFor === id\) return;[\s\S]*?say\(key, params\);/, 'each notice is told once per value');
  const handler = code.slice(code.indexOf('function onShortcut'), code.indexOf('$effect(() => {\n\t\tconst parsed'));
  assert.match(handler, /if \(!pane_\.focused\) return;/, 'only the focused pane answers');
  assert.match(handler, /event\?\.phase === "up"\) return endHold\(\)/);
  assert.match(handler, /else onclick\(\); \/\/ exactly what clicking the button does/, 'toggle is the button\'s own handler');
  assert.ok(!/requestSubmit|submit\(/.test(handler), 'a shortcut only records, it never sends');
});

test('hold ends on every kind of `up`: short taps are cancelled and a microphone still opening is closed', () => {
  const code = source.replace(/<style[\s\S]*<\/style>/, '');
  const end = code.slice(code.indexOf('function endHold()'), code.indexOf('function onShortcut'));
  assert.match(end, /holdVerdict\(heldDownAt, performance\.now\(\)\)/);
  assert.match(end, /stop\(verdict === "send" \? "send" : "cancel"\)/);
  assert.match(end, /phase === "starting"\) \{ token\+\+; phase = "idle"; \}/);
  assert.ok(!/reason/.test(end), 'every reason (release, blur, hidden, recording, removed) ends it the same way');
  assert.match(code, /if \(holdingStart && !heldDownAt\) \{ for \(const track of media\.getTracks\(\)\) track\.stop\(\); reset\(\); return; \}/, 'the stream is closed when the key already came up');
});

test('the tooltip shows the shortcut, the accessible name stays the plain action', () => {
  assert.match(source, /title=\{tip\}/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /hint \? `\$\{baseLabel\} \(\$\{hint\}\)` : baseLabel/);
});

// ── design: the same family as the app's send control, only the app's tokens ────────────────────────────────────────
const css = source.match(/<style>([\s\S]*)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, ''); // comments out
const rule = (selector) => css.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

test('design: no hard-coded colours, every colour is one of the app\'s tokens', () => {
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'no hex colours');
  assert.ok(!/\b(rgba?|hsla?)\(/i.test(css), 'no rgb()/hsl() colours');
  const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
  const allowed = new Set(['--bg-active', '--border-strong', '--text', '--text-dim', '--text-faint', '--danger', '--danger-soft', '--motion-fast', '--ease-std', '--ease', '--fs-sm', '--fs-xs', '--bg']);
  for (const token of used) assert.ok(allowed.has(token), `unexpected token ${token}`);
});

test('design: the microphone is a 38px round button like the send control, danger tint while recording', () => {
  const mic = rule('.mic');
  assert.match(mic, /width: 38px; height: 38px/);
  assert.match(mic, /border-radius: 50%/);
  assert.match(mic, /background: var\(--bg-active\); color: var\(--text-faint\)/, 'grey at rest, like the disabled send control');
  assert.match(css, /\.mic\.rec[^{]*\{[^}]*var\(--danger-soft\)[^}]*var\(--danger\)/, 'the app\'s stop button look');
  assert.match(css, /\.mic svg \{[^}]*width: 19px; height: 19px;[^}]*stroke-width: 2\.1/, 'the send icon size and stroke');
  assert.match(css, /\.mic:active:not\(:disabled\) \{ transform: scale\(0\.9\)/);
  const micRules = css.split('\n').filter((l) => /^\s*\.mic/.test(l)).join('\n');
  assert.ok(micRules && !/opacity/.test(micRules), 'unavailable states use pre-mixed colours, not opacity (only the recording dot pulses)');
  assert.ok(!/outline/.test(mic), 'the keyboard focus ring is the app\'s own');
});

test('design: status chips are padded pills no taller than the buttons, and give way before the send control does', () => {
  const chip = rule('.chip');
  assert.match(chip, /padding: 0 12px/);
  assert.match(chip, /border-radius: 999px/);
  assert.match(chip, /height: 28px/);
  assert.match(chip, /min-width: 0/);
  assert.match(css, /\.chip \.txt \{[^}]*text-overflow: ellipsis/, 'a long text is cut inside the chip');
  assert.match(css, /@media \(max-width: 480px\) \{ \.chip \{ max-width: 8em/);
  assert.match(css, /\.vi \{[^}]*gap: 6px/);
  const send = pkg.components.VoiceSend.match(/<style>([\s\S]*)<\/style>/)[1];
  assert.match(send, /\.vs \{[^}]*gap: 4px/, 'the app\'s own gap between its round buttons');
});

test('design: the cancel button sits inside the recording chip, and the timer is not announced every second', () => {
  const markup = source.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*<\/style>/, '');
  assert.match(markup, /<span class="chip live">[\s\S]*<button type="button" class="x"[\s\S]*<\/button>\s*<\/span>/);
  assert.match(markup, /<span class="sr" role="status" aria-live="polite">/);
  assert.ok(!/class="status"[^>]*aria-live/.test(markup), 'the visible chips are not a live region (the timer would be read out every second)');
  assert.match(markup, /class="txt" aria-hidden="true">\{formatTime\(elapsed\)\}/);
});

test('design: reduced motion stops the spinner, the pulse and the press animation', () => {
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.spin, \.dot \{ animation: none; \}/);
  assert.match(reduced, /\.mic, \.x \{ transition: none; \}/);
  assert.match(reduced, /\.mic:active:not\(:disabled\) \{ transform: none; \}/);
});

test('docs: the Services table lists only public services with documentation links, no private setups', async () => {
  for (const file of ['README.md', 'README.ko.md', '../README.md', '../README.ko.md']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!/CLIProxyAPI|mistral-support|management key|관리 키|context_bias|\/v0\/management/i.test(text), `${file}: no private setup`);
    assert.ok(!/Really run|실제로 끝까지|모의 서버|mock server/i.test(text), `${file}: no internal test results`);
  }
  for (const file of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const url of ['https://developers.openai.com/api/docs/guides/speech-to-text', 'https://console.groq.com/docs/speech-to-text', 'https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files']) assert.ok(text.includes(url), `${file}: ${url}`);
    assert.match(text, /2027/, `${file}: the OpenAI shutdown date is mentioned`);
    assert.ok(!/### From 0\.1\.0|### 0\.1\.0에서/.test(text), `${file}: no 0.1.0 migration section`);
  }
});

test('docs: gpt-transcribe language handling and the Mistral format claim are stated honestly', async () => {
  for (const file of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes('languages[]'), `${file}: explains languages[]`);
    assert.ok(!/OpenAI, Groq and Mistral list webm|OpenAI, Groq, Mistral은 webm/.test(text), `${file}: no unverified Mistral format claim`);
    assert.ok(!/(clear the `language`|`language` 설정을 비우세요)/.test(text), `${file}: the old workaround note is gone`);
  }
});
