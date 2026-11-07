import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickMimeType, extensionFor, formatTime, joinDraft, endpoint, originOf, checkBase, withScheme, isLoopbackHost, pathOf, DEFAULT_TRANSCRIBE_PATH, buildForm, usesLanguagesList, micErrorKind, httpErrorKind,
  parseShortcut, conflictsWithApp, holdVerdict, shortcutLabel, shortcutHint, shortcutReason, SHORTCUT_MIN_HOLD_MS,
  TAP_MS, SHORTCUT_MODES, shortcutMode, modeLabel, releaseAction, waveLevels, smoothLevels, shortcutCombo, SHORTCUT_ID,
  transcribe, VoiceError, message, STRINGS
} from '../src/helpers.mjs';

const blob = (type = 'audio/webm;codecs=opus') => new Blob([new Uint8Array(2000)], { type });
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body instanceof Error) throw body; return body; } });
const run = (fetchImpl, extra = {}) => transcribe({ fetchImpl, apiBase: 'https://ai.example/', transcribePath: '', apiKey: 'k-secret', model: 'm', language: 'ko', blob: blob(), ...extra });

test('picks the first supported recorder format, else lets the browser choose', () => {
  assert.equal(pickMimeType((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickMimeType(() => true), 'audio/webm;codecs=opus');
  assert.equal(pickMimeType(() => false), '');
  assert.equal(pickMimeType(() => { throw new Error('x'); }), '');
});

test('file extension follows the recorded container', () => {
  assert.equal(extensionFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionFor('audio/mp4'), 'm4a');
  assert.equal(extensionFor('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(extensionFor(''), 'webm');
});

test('timer text', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65_900), '1:05');
});

test('transcript is appended after the draft and never replaces it', () => {
  assert.equal(joinDraft('', '커밋하고 푸시해줘.'), '커밋하고 푸시해줘.');
  assert.equal(joinDraft('   ', 'hi'), 'hi');
  assert.equal(joinDraft('이거 고쳐줘  \n', '그리고 푸시해줘.'), '이거 고쳐줘 그리고 푸시해줘.');
  assert.equal(joinDraft('draft', '  '), 'draft');
});

test('endpoint is origin + path; the path defaults to the OpenAI route', () => {
  assert.equal(DEFAULT_TRANSCRIBE_PATH, '/v1/audio/transcriptions');
  assert.equal(endpoint('https://ai.example///'), 'https://ai.example/v1/audio/transcriptions');
  assert.equal(endpoint(' https://host:8317 ', ''), 'https://host:8317/v1/audio/transcriptions');
  assert.equal(endpoint('http://host:8317', ''), '', 'plain http to a non-loopback host is refused');
  assert.equal(endpoint('https://ai.example', '/openai/v1/audio/transcriptions'), 'https://ai.example/openai/v1/audio/transcriptions');
  assert.equal(endpoint('https://ai.example', '/custom/route'), 'https://ai.example/custom/route');
  assert.equal(endpoint('', '/v1/x'), '');
});

test('the transcription path accepts only a plain path', () => {
  assert.equal(pathOf(undefined), DEFAULT_TRANSCRIBE_PATH);
  assert.equal(pathOf('   '), DEFAULT_TRANSCRIBE_PATH);
  assert.equal(pathOf(' /a/b '), '/a/b');
  for (const bad of ['v1/audio', 'https://evil.example/x', '//evil.example/x', '/a/../b', '/..', '/a/./b', '/a/%2e%2e/b', '/a?x=1', '/a#f', '/a b', '/a\\b', '/a\nb', 'javascript:x', '/' + 'a'.repeat(250)]) assert.equal(pathOf(bad), '', JSON.stringify(bad));
  assert.equal(endpoint('https://ai.example', '//evil.example/x'), '', 'a protocol-relative path cannot change the host');
  assert.equal(endpoint('https://ai.example', '/@evil.example'), 'https://ai.example/@evil.example', 'stays on the origin');
});

test('an empty or malformed address is rejected, there is no default', () => {
  for (const bad of ['', '   ', undefined, null, 'ftp://ai.example', 'https://ai.example/path', 'https://user:pw@ai.example', 'https://ai.example?x=1', 'https://ai.example#f', 'javascript:alert(1)', 'https://', 'a b']) {
    assert.equal(originOf(bad), '', String(bad));
    assert.equal(checkBase(bad).problem, 'needBase', String(bad));
  }
  assert.equal(originOf('https://ai.example/'), 'https://ai.example');
});

test('on an https page a plain-http address is refused (the browser would block it as mixed content)', () => {
  for (const http of ['http://ai.example', 'http://ai.example:8317', 'http://192.168.7.9:8000', 'http://100.64.0.1', 'http://10.1.1.2', 'http://my-nas.local', 'HTTP://AI.EXAMPLE']) {
    assert.deepEqual(checkBase(http, 'https:'), { origin: '', problem: 'needHttps' }, http);
    assert.deepEqual(checkBase(http), { origin: '', problem: 'needHttps' }, 'no page given = the strict reading');
    assert.equal(originOf(http, 'https:'), '', http);
    assert.equal(endpoint(http, '', 'https:'), '', http);
  }
  assert.equal(checkBase('https://ai.example', 'https:').origin, 'https://ai.example');
  assert.equal(checkBase('https://ai.example:8443/', 'https:').origin, 'https://ai.example:8443');
});

test('on a page that is not https a plain-http address is fine (nothing mixes)', () => {
  for (const page of ['http:', 'file:', 'tauri:', 'app:']) {
    for (const http of ['http://ai.example', 'http://192.168.7.9:8000', 'http://10.1.1.2', 'http://my-nas.local:9000', 'http://localhost:8000']) {
      assert.equal(checkBase(http, page).problem, '', `${page} ${http}`);
      assert.equal(checkBase(http, page).origin, new URL(http).origin);
    }
    assert.equal(endpoint('http://192.168.7.9:8000', '', page), 'http://192.168.7.9:8000/v1/audio/transcriptions');
    assert.equal(checkBase('https://ai.example', page).origin, 'https://ai.example');
  }
  // other problems are still problems on any page
  assert.equal(checkBase('http://ai.example/path', 'http:').problem, 'needBase');
  assert.equal(checkBase('', 'http:').problem, 'needBase');
});

test('an address without a scheme is read as https, the stored text is not changed', () => {
  assert.equal(withScheme('api.example.com'), 'https://api.example.com');
  assert.equal(withScheme('  api.example.com:8443 '), 'https://api.example.com:8443');
  assert.equal(withScheme('localhost:8000'), 'https://localhost:8000', 'a host:port is a host, not a scheme');
  assert.equal(withScheme('http://x.example'), 'http://x.example');
  assert.equal(withScheme(''), '');
  assert.equal(checkBase('api.example.com').origin, 'https://api.example.com');
  assert.equal(checkBase('api.example.com:8443').origin, 'https://api.example.com:8443');
  assert.equal(endpoint('api.example.com', '/v1/audio/transcriptions'), 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(checkBase('api.example.com/v1').problem, 'needBase', 'a path is still refused');
  assert.equal(checkBase('mailto:me@example.com').problem, 'needBase');
});

test('loopback http is allowed even on an https page; other private addresses are not', () => {
  for (const ok of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://127.1.2.3', 'http://[::1]:9000', 'http://app.localhost:80']) assert.ok(checkBase(ok, 'https:').origin, ok);
  assert.equal(checkBase('http://localhost:8000', 'https:').origin, 'http://localhost:8000');
  assert.equal(checkBase('http://[::1]:9000', 'https:').origin, 'http://[::1]:9000');
  for (const no of ['http://127.0.0.1.example.com', 'http://localhost.example.com', 'http://0.0.0.0:8000', 'http://192.168.1.1', 'http://10.1.2.3', 'http://[fe80::1]', 'http://localhostx']) assert.equal(checkBase(no, 'https:').problem, 'needHttps', no);
  assert.ok(isLoopbackHost('LOCALHOST') && !isLoopbackHost('') && !isLoopbackHost(undefined));
});

test('no request is made without a valid address or path', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(200, { text: 'x' }); };
  for (const apiBase of ['', 'ftp://ai.example', 'https://ai.example/x']) await assert.rejects(run(fetchImpl, { apiBase }), { kind: 'needBase' });
  for (const apiBase of ['http://ai.example', 'http://192.168.7.9:8000', 'http://10.1.1.2']) {
    await assert.rejects(run(fetchImpl, { apiBase, pageProtocol: 'https:' }), { kind: 'needHttps' }, apiBase);
    await assert.rejects(run(fetchImpl, { apiBase }), { kind: 'needHttps' }, 'default page protocol is the strict one');
  }
  for (const transcribePath of ['v1/x', 'https://evil.example/x', '/a/../b', '/a?k=1']) await assert.rejects(run(fetchImpl, { transcribePath }), { kind: 'badPath' });
  assert.equal(calls, 0);
});

test('request follows the OpenAI transcription format on the configured route', async () => {
  let seen;
  const text = await run(async (url, init) => { seen = { url, init }; return reply(200, { text: 'hello' }); }, { apiBase: 'https://api.example', transcribePath: '/openai/v1/audio/transcriptions' });
  assert.equal(text, 'hello');
  assert.equal(seen.url, 'https://api.example/openai/v1/audio/transcriptions');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(Object.keys(seen.init.headers), ['Authorization'], 'no Content-Type: the browser sets the multipart boundary');
  assert.deepEqual([...seen.init.body.keys()].sort(), ['file', 'language', 'model']);
  assert.ok(!seen.url.includes('k-secret') && !seen.url.includes('?'));
});

test('form carries only file, model and language', () => {
  const form = buildForm(blob('audio/mp4'), { model: ' whisper-large-v3-turbo ', language: 'ko' });
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('language'), 'ko');
  assert.equal(form.get('file').name, 'voice.m4a');
  assert.equal(form.get('file').type, 'audio/mp4');
  assert.deepEqual([...form.keys()].sort(), ['file', 'language', 'model'], 'no other field is sent');
  const bare = buildForm(blob(), { model: '', language: '' });
  assert.ok(!bare.has('model') && !bare.has('language'), 'empty settings fall back to the server defaults');
});

test('microphone errors map to a clear kind', () => {
  assert.equal(micErrorKind({ name: 'NotAllowedError' }), 'micDenied');
  assert.equal(micErrorKind({ name: 'NotFoundError' }), 'noMic');
  assert.equal(micErrorKind({ name: 'NotReadableError' }), 'micBusy');
  assert.equal(micErrorKind(new Error('x')), 'micFailed');
  assert.equal(httpErrorKind(401), 'badKey');
  assert.equal(httpErrorKind(403), 'badKey');
  assert.equal(httpErrorKind(429), 'rateLimited');
  assert.equal(httpErrorKind(404), 'notFound');
  assert.equal(httpErrorKind(405), 'notFound');
  assert.equal(httpErrorKind(500), 'serverError');
});

test('transcribe sends the key only as a Bearer header and returns trimmed text', async () => {
  let seen;
  const text = await run(async (url, init) => { seen = { url, init }; return reply(200, { text: ' 커밋하고 푸시해줘. ' }); });
  assert.equal(text, '커밋하고 푸시해줘.');
  assert.equal(seen.url, 'https://ai.example/v1/audio/transcriptions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer k-secret');
  assert.equal(seen.init.credentials, 'omit');
  assert.ok(!seen.url.includes('k-secret'));
  assert.ok(!JSON.stringify([...seen.init.body.entries()].map(([k, v]) => (typeof v === 'string' ? v : k))).includes('k-secret'));
});

test('transcribe failures are classified and never leak the key', async () => {
  const kind = async (fn) => run(fn).then(() => 'ok', (e) => { assert.ok(e instanceof VoiceError); assert.ok(!String(e.message).includes('k-secret')); return e.kind + (e.status ? `:${e.status}` : ''); });
  assert.equal(await kind(async () => reply(401, {})), 'badKey:401');
  assert.equal(await kind(async () => reply(429, {})), 'rateLimited:429');
  assert.equal(await kind(async () => reply(413, {})), 'tooBig:413');
  assert.equal(await kind(async () => reply(502, {})), 'serverError:502');
  assert.equal(await kind(async () => { throw new TypeError('Failed to fetch https://ai.example?k-secret'); }), 'network');
  assert.equal(await kind(async () => reply(200, new SyntaxError('bad json'))), 'badResponse');
  assert.equal(await kind(async () => reply(200, { nope: 1 })), 'badResponse');
  assert.equal(await kind(async () => reply(200, { text: '   ' })), 'empty');
});

test('timeout and caller abort are told apart', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(run(hang, { timeoutMs: 20 }), { kind: 'timeout' });
  const caller = new AbortController();
  const pending = run(hang, { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, { kind: 'aborted' });
});

test('every string exists in Korean and English, with the same placeholders', () => {
  assert.deepEqual(Object.keys(STRINGS.ko).sort(), Object.keys(STRINGS.en).sort());
  for (const k of ['modeToggle', 'modeHold']) assert.ok(STRINGS.ko[k] && STRINGS.en[k], k);
  const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const key of Object.keys(STRINGS.ko)) assert.equal(holes(STRINGS.ko[key]), holes(STRINGS.en[key]), key);
  // Every error the button can show has a long text (toast, tooltip) and a short chip text.
  const errors = ['shortcutBad', 'shortcutConflict', 'shortcutUnsupported', 'shortcutRefused', 'needBase', 'needHttps', 'badPath', 'notFound', 'needKey', 'badKey', 'micDenied', 'noMic', 'micBusy', 'micFailed', 'insecure', 'unsupported', 'network', 'timeout', 'rateLimited', 'tooBig', 'serverError', 'tooShort', 'empty', 'badResponse', 'paneChanged'];
  for (const key of errors) assert.ok(STRINGS.ko[key] && STRINGS.ko[`${key}Short`] && STRINGS.en[key] && STRINGS.en[`${key}Short`], key);
  assert.equal(message('ko-KR', 'needKeyShort'), '키 필요');
  assert.equal(message('en', 'needKeyShort'), 'Key needed');
  assert.equal(message('fr', 'serverError', { status: 500 }), 'Transcription server error (500). Also check the model name.');
});

test('on an http page a plain-http provider is called as written', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return reply(200, { text: 'x' }); };
  await run(fetchImpl, { apiBase: 'http://192.168.7.9:8000', pageProtocol: 'http:' });
  await run(fetchImpl, { apiBase: 'http://localhost:8000', pageProtocol: 'http:' });
  await run(fetchImpl, { apiBase: 'http://localhost:8000', pageProtocol: 'https:' });
  assert.deepEqual(urls, ['http://192.168.7.9:8000/v1/audio/transcriptions', 'http://localhost:8000/v1/audio/transcriptions', 'http://localhost:8000/v1/audio/transcriptions']);
});

test('a scheme-less address reaches the network over https, and loopback http as written', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return reply(200, { text: 'x' }); };
  await run(fetchImpl, { apiBase: 'api.example.com' });
  await run(fetchImpl, { apiBase: 'http://127.0.0.1:8000' });
  assert.deepEqual(urls, ['https://api.example.com/v1/audio/transcriptions', 'http://127.0.0.1:8000/v1/audio/transcriptions']);
});

// ── keyboard shortcut ──────────────────────────────────────────────────────────────────────────────────────────────
// Listening, key matching, IME, repeat, blur and release are the app's job now (`shortcuts.register`) and are tested there.
// What is left here: turning the typed text into the combo the app accepts, the clash notice, the hold rule and the texts.

test('an empty shortcut means none: it parses to nothing, shows instructions in tooltip', () => {
  for (const empty of ['', '   ', undefined, null]) {
    assert.deepEqual(parseShortcut(empty), { ok: true, combo: '' });
    assert.equal(conflictsWithApp(parseShortcut(empty), { x: 'Alt+M' }), '');
    assert.equal(shortcutLabel(parseShortcut(empty), 'toggle', 'ko'), '', 'label alone is empty');
    assert.equal(shortcutHint(empty, 'hold', 'en'), 'No shortcut · set in Settings');
    assert.equal(shortcutHint(empty, 'hold', 'ko'), '단축키 없음 · 설정에서 지정');
  }
});

test('shortcut parsing gives the canonical combo the app wants, and refuses what the app would refuse', () => {
  const ok = { 'Alt+M': 'Alt+M', 'alt+m': 'Alt+M', ' Mod + Shift + K ': 'Mod+Shift+K', 'ctrl+shift+k': 'Mod+Shift+K', 'cmd+j': 'Mod+J', 'Option+Space': 'Alt+Space', 'Alt+F9': 'Alt+F9', 'Alt+5': 'Alt+5', 'Alt+period': 'Alt+Period', 'Shift+Alt+Mod+1': 'Mod+Alt+Shift+1', 'Mod+Alt+ArrowUp': 'Mod+Alt+ArrowUp' };
  for (const [text, combo] of Object.entries(ok)) assert.deepEqual(parseShortcut(text), { ok: true, combo }, text);
  const bad = { 'M': 'needMod', 'Shift+M': 'needMod', 'F9': 'needMod', 'Alt+Shift': 'format', 'Alt+M+K': 'oneKey', 'Alt++': 'format', '+': 'format', 'mod+mod+k': 'format', 'Alt+Ö': 'badKey', 'Alt+F25': 'badKey', 'Alt+Escape': 'reserved', 'Mod+Enter': 'reserved', 'Alt+Tab': 'reserved', 'Alt+Backspace': 'reserved' };
  for (const [text, reason] of Object.entries(bad)) assert.deepEqual(parseShortcut(text), { ok: false, reason }, text);
});

test('three modes, `both` by default, each with its own label', () => {
  assert.deepEqual(SHORTCUT_MODES, ['both', 'toggle', 'hold']);
  assert.equal(shortcutMode(undefined), 'both');
  assert.equal(shortcutMode(''), 'both');
  assert.equal(shortcutMode('nonsense'), 'both');
  for (const m of SHORTCUT_MODES) assert.equal(shortcutMode(m), m);
  const labels = SHORTCUT_MODES.map((m) => modeLabel(m, 'ko'));
  assert.equal(new Set(labels).size, 3, 'each mode reads differently');
  assert.match(modeLabel('both', 'ko'), /짧게/);
  assert.match(modeLabel('both', 'en'), /tap/i);
});

test('`both`: a tap keeps recording, a longer press is push to talk, any other reason ends it', () => {
  assert.equal(TAP_MS, 300);
  // a short press, released: keep recording (the next tap stops it)
  assert.equal(releaseAction('both', 1000, 1299), 'keep');
  // exactly at the threshold it is a hold, not a tap
  assert.equal(releaseAction('both', 1000, 1300), 'send');
  assert.equal(releaseAction('both', 1000, 5000), 'send');
  // a blur, a hidden tab, a shortcut recording or the shortcut going away always stops, however short
  for (const reason of ['blur', 'hidden', 'recording', 'removed']) assert.equal(releaseAction('both', 1000, 1001, reason), 'send', reason);
  // toggle ignores the release, hold throws a too-short press away
  assert.equal(releaseAction('toggle', 1000, 1001), 'send');
  assert.equal(releaseAction('hold', 1000, 1299), 'cancel');
  assert.equal(releaseAction('hold', 1000, 1300), 'send');
  for (const reason of ['blur', 'hidden', 'recording', 'removed']) assert.equal(releaseAction('hold', 1000, 1001, reason), 'send', reason);
  // the threshold is a parameter, so the boundary can be pinned
  assert.equal(releaseAction('both', 0, 299, 'release', 300), 'keep');
  assert.equal(releaseAction('both', 0, 300, 'release', 300), 'send');
});

test('hold: a press shorter than the minimum is discarded, a real one is kept', () => {
  assert.equal(SHORTCUT_MIN_HOLD_MS, 300);
  assert.equal(holdVerdict(1000, 1120), 'discard');
  assert.equal(holdVerdict(1000, 1299), 'discard');
  assert.equal(holdVerdict(1000, 1300), 'send');
  assert.equal(holdVerdict(1000, 5000), 'send');
});

test('the waveform turns frequency data into bars, low frequencies first, smoothed', () => {
  const flat = waveLevels(new Uint8Array(128).fill(0), 8);
  assert.deepEqual(flat, new Array(8).fill(0));
  const loud = waveLevels(new Uint8Array(128).fill(255), 8);
  assert.deepEqual(loud, new Array(8).fill(1));
  // only the lower part of the spectrum is used (the top bins are mostly silence)
  const data = new Uint8Array(128).fill(255); for (let i = 71; i < 128; i++) data[i] = 0; // the top bins silent
  assert.deepEqual(waveLevels(data, 4), [1, 1, 1, 1], 'the low half is read');
  const onlyHigh = new Uint8Array(128); onlyHigh[127] = 255;
  assert.deepEqual(waveLevels(onlyHigh, 4), [0, 0, 0, 0], 'the top of the spectrum is ignored');
  assert.equal(waveLevels(null, 3).length, 3, 'no data: zero bars, not a crash');
  assert.equal(waveLevels(new Uint8Array(0), 3).length, 3);
  // smoothing moves towards the new value without jumping
  assert.deepEqual(smoothLevels([0, 1], [1, 0], 0.5), [0.5, 0.5]);
  assert.deepEqual(smoothLevels(undefined, [1, 0], 0.5), [0.5, 0]);
  assert.deepEqual(smoothLevels([1, 1], [1, 1], 0.5), [1, 1]);
});

test('the shortcut combination comes from one place', () => {
  assert.equal(SHORTCUT_ID, 'dictate');
  // reads from a kit with currentShortcut
  const kitWithMethod = { currentShortcut: (id) => (id === 'dictate' ? 'Alt+M' : '') };
  assert.equal(shortcutCombo(kitWithMethod), 'Alt+M');
  // reads from a kit with shortcuts.currentShortcut
  const kitNested = { shortcuts: { currentShortcut: (id) => (id === 'dictate' ? 'Mod+Shift+K' : '') } };
  assert.equal(shortcutCombo(kitNested), 'Mod+Shift+K');
  // reads from a direct getter function
  assert.equal(shortcutCombo((id) => (id === 'dictate' ? 'Alt+Space' : '')), 'Alt+Space');
  // empty or unbound
  assert.equal(shortcutCombo({ currentShortcut: () => '' }), '');
  assert.equal(shortcutCombo({ currentShortcut: () => null }), '');
  // backwards compatible with settings object
  assert.equal(shortcutCombo({ shortcut: '  Alt+M ' }), 'Alt+M');
  assert.equal(shortcutCombo({ shortcut: '' }), '');
  assert.equal(shortcutCombo({}), '');
  assert.equal(shortcutCombo(null), '');
});

test('hold: a press shorter than the minimum is discarded, a real one is kept', () => {
  assert.equal(SHORTCUT_MIN_HOLD_MS, 300);
  assert.equal(holdVerdict(1000, 1120), 'discard');
  assert.equal(holdVerdict(1000, 1299), 'discard');
  assert.equal(holdVerdict(1000, 1300), 'send');
  assert.equal(holdVerdict(1000, 5000), 'send');
});

test('a combination the app already uses is reported (the app wins), a free one is not', () => {
  const app = { newChat: 'Mod+N', modelPicker: 'Mod+M', prevSession: 'Alt+ArrowUp', toggleSidebar: 'Mod+B+B', newTerminal: 'Mod+Alt+N', unbound: '', renameTab: 'F2' };
  assert.equal(conflictsWithApp(parseShortcut('Mod+N'), app), 'newChat');
  assert.equal(conflictsWithApp(parseShortcut('ctrl+m'), app), 'modelPicker');
  assert.equal(conflictsWithApp(parseShortcut('Alt+ArrowUp'), app), 'prevSession');
  assert.equal(conflictsWithApp(parseShortcut('Mod+B'), app), 'toggleSidebar', 'Mod+B starts the app\'s Mod+B+B');
  assert.equal(conflictsWithApp(parseShortcut('Mod+Alt+N'), app), 'newTerminal');
  for (const free of ['Alt+M', 'Mod+Shift+K', 'Alt+Space']) assert.equal(conflictsWithApp(parseShortcut(free), app), '', free);
  assert.equal(conflictsWithApp({ ok: false, reason: 'format' }, app), '');
});

test('the tooltip names the combination and the mode, in both languages', () => {
  const p = parseShortcut('Alt+M');
  assert.match(shortcutLabel(p, 'toggle', 'ko'), /^Alt\+M · /);
  assert.notEqual(shortcutLabel(p, 'toggle', 'ko'), shortcutLabel(p, 'hold', 'ko'));
  assert.notEqual(shortcutLabel(p, 'hold', 'en'), shortcutLabel(p, 'hold', 'ko'));
  assert.match(shortcutHint('mod+k', 'toggle', 'en'), /^(Ctrl|⌘)\+K · /);
  assert.equal(shortcutHint('Alt+Q+W', 'toggle', 'en'), '', 'an invalid combination shows nothing');
  // empty or no shortcut shows instructions to configure in Settings
  assert.equal(shortcutHint('', 'both', 'ko'), '단축키 없음 · 설정에서 지정');
  assert.equal(shortcutHint('', 'both', 'en'), 'No shortcut · set in Settings');
  assert.equal(shortcutHint(null, 'both', 'ko'), '단축키 없음 · 설정에서 지정');
  assert.equal(shortcutHint(undefined, 'both', 'en'), 'No shortcut · set in Settings');
});

test('the app\'s refusal is passed on short and on one line', () => {
  assert.equal(shortcutReason(new Error('Another extension already uses this shortcut: Alt+M')), 'Another extension already uses this shortcut: Alt+M');
  assert.equal(shortcutReason(new Error('a\n  b')), 'a b');
  assert.ok(shortcutReason(new Error('x'.repeat(500))).length <= 120);
  assert.equal(shortcutReason(undefined), '');
});

test('gpt-transcribe gets `languages[]` instead of `language`, every other model keeps `language`', () => {
  const gpt = buildForm(blob('audio/webm'), { model: 'gpt-transcribe', language: 'ko' });
  assert.deepEqual([...gpt.keys()].sort(), ['file', 'languages[]', 'model']);
  assert.deepEqual(gpt.getAll('languages[]'), ['ko']);
  assert.ok(!gpt.has('language'), 'both fields must never be sent together');
  for (const model of [' GPT-Transcribe ', 'gpt-transcribe\n']) {
    const f = buildForm(blob(), { model, language: 'en' });
    assert.deepEqual(f.getAll('languages[]'), ['en'], JSON.stringify(model));
    assert.ok(!f.has('language'));
  }
  for (const model of ['whisper-1', 'whisper-large-v3-turbo', 'voxtral-mini-transcribe-3', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-transcribe-diarize', 'gpt-transcribe-2', 'my-gpt-transcribe', '']) {
    const f = buildForm(blob(), { model, language: 'ko' });
    assert.deepEqual(f.getAll('language'), ['ko'], `${model || '(empty)'} keeps language`);
    assert.ok(!f.has('languages[]'), `${model || '(empty)'} sends no languages[]`);
  }
  for (const language of ['', '   ', undefined]) {
    const f = buildForm(blob(), { model: 'gpt-transcribe', language });
    assert.ok(!f.has('language') && !f.has('languages[]'), 'an empty language sends neither field');
    const g = buildForm(blob(), { model: 'whisper-1', language });
    assert.ok(!g.has('language') && !g.has('languages[]'));
  }
  assert.equal(usesLanguagesList('gpt-transcribe'), true);
  assert.equal(usesLanguagesList('gpt-transcribe-x'), false);
});

test('a gpt-transcribe upload sends languages[] on the wire and keeps the key out of the URL', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { text: 'ok', languages: [{ code: 'ko' }] }); };
  const text = await transcribe({ fetchImpl, apiBase: 'https://ai.example/', transcribePath: '', apiKey: 'k-secret', model: 'gpt-transcribe', language: 'ko', blob: blob('audio/webm') });
  assert.equal(text, 'ok');
  assert.deepEqual([...seen.init.body.keys()].sort(), ['file', 'languages[]', 'model']);
  assert.equal(seen.init.body.get('languages[]'), 'ko');
  assert.ok(!seen.url.includes('k-secret') && !seen.url.includes('?'));
  assert.equal(seen.init.headers.Authorization, 'Bearer k-secret');
});
