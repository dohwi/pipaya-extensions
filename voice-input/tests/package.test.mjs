import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../dist/voice-input.json', import.meta.url), 'utf8'));
const source = pkg.components.VoiceButton;

test('package is a single ui-components extension with no worker code', () => {
  assert.equal(pkg.manifest.id, 'voice-input');
  assert.equal(pkg.manifest.sdkVersion, 1);
  assert.deepEqual(pkg.manifest.permissions, ['ui-components'], 'least privilege: no http, storage or composer permission');
  assert.equal(pkg.code, undefined);
  assert.deepEqual(pkg.mounts, [{ slot: 'composer.toolbar', component: 'VoiceButton' }]);
  assert.ok(Buffer.byteLength(JSON.stringify(pkg)) < 256 * 1024);
  assert.ok(Buffer.byteLength(source) < 64 * 1024);
});

test('settings: no built-in address, required origin and secret key, device-local scope', () => {
  const byKey = Object.fromEntries(pkg.manifest.settings.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey), ['apiBase', 'apiKey', 'model', 'language']);
  assert.equal(byKey.apiBase.format, 'origin');
  assert.equal(byKey.apiBase.required, true);
  assert.ok(!('default' in byKey.apiBase), 'the user enters their own address');
  assert.match(byKey.apiBase.placeholder, /example\.com/);
  assert.equal(byKey.apiKey.secret, true);
  assert.equal(byKey.apiKey.required, true);
  assert.ok(!('default' in byKey.apiKey));
  assert.equal(byKey.model.default, 'voxtral-mini-transcribe-3-0');
  assert.equal(byKey.language.default, 'ko');
  assert.equal(pkg.manifest.settingsScope, 'local');
});

test('component imports only what the host allows and inlines the helpers', () => {
  const imports = [...source.matchAll(/^\s*import .* from ["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['pipaya', 'svelte']);
  assert.ok(!source.includes('/* @helpers */'));
  assert.match(source, /function transcribe\(|async function transcribe\(/);
  assert.ok(!/^\s*export /m.test(source.replace(/<style[\s\S]*<\/style>/, '')), 'no leftover exports');
});

test('component never sends context_bias, never stores or logs the key', () => {
  const body = source.replace(/<style[\s\S]*<\/style>/, '');
  assert.ok(!/context_bias['"]\s*,\s*[^)]/.test(body.replace(/\/\/.*$/gm, '')), 'context_bias must not be appended');
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
  assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|localhost/.test(text), 'no IP address or localhost');
  assert.ok(!/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(pkg.components.VoiceButton.replace(/<style[\s\S]*<\/style>/, '').replace(/example\.com/g, '')), 'component hard-codes no URL');
});

test('component asks for the address before the key and before any request', () => {
  const begin = source.slice(source.indexOf('async function begin'), source.indexOf('async function begin') + 900);
  assert.ok(begin.indexOf('needBase') > 0 && begin.indexOf('needBase') < begin.indexOf('needKey'));
});
