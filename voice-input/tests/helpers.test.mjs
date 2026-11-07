import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickMimeType, extensionFor, formatTime, joinDraft, endpoint, originOf, pathOf, DEFAULT_TRANSCRIBE_PATH, buildForm, micErrorKind, httpErrorKind,
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
  assert.equal(endpoint(' http://host:8317 ', ''), 'http://host:8317/v1/audio/transcriptions');
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
  for (const bad of ['', '   ', undefined, null, 'ai.example', 'ftp://ai.example', 'https://ai.example/path', 'https://user:pw@ai.example', 'https://ai.example?x=1', 'javascript:alert(1)']) assert.equal(originOf(bad), '', String(bad));
  assert.equal(originOf('https://ai.example/'), 'https://ai.example');
});

test('no request is made without a valid address or path', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(200, { text: 'x' }); };
  for (const apiBase of ['', 'nonsense', 'https://ai.example/x']) await assert.rejects(run(fetchImpl, { apiBase }), { kind: 'needBase' });
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

test('form carries file, model and language but never context_bias', () => {
  const form = buildForm(blob('audio/mp4'), { model: ' voxtral-mini-transcribe-3-0 ', language: 'ko' });
  assert.equal(form.get('model'), 'voxtral-mini-transcribe-3-0');
  assert.equal(form.get('language'), 'ko');
  assert.equal(form.get('file').name, 'voice.m4a');
  assert.equal(form.get('file').type, 'audio/mp4');
  assert.ok(!form.has('context_bias'));
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
  const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const key of Object.keys(STRINGS.ko)) assert.equal(holes(STRINGS.ko[key]), holes(STRINGS.en[key]), key);
  // Every error the button can show has a long text (toast, tooltip) and a short chip text.
  const errors = ['needBase', 'badPath', 'notFound', 'needKey', 'badKey', 'micDenied', 'noMic', 'micBusy', 'micFailed', 'insecure', 'unsupported', 'network', 'timeout', 'rateLimited', 'tooBig', 'serverError', 'tooShort', 'empty', 'badResponse', 'paneChanged'];
  for (const key of errors) assert.ok(STRINGS.ko[key] && STRINGS.ko[`${key}Short`] && STRINGS.en[key] && STRINGS.en[`${key}Short`], key);
  assert.equal(message('ko-KR', 'needKeyShort'), '키 필요');
  assert.equal(message('en', 'needKeyShort'), 'Key needed');
  assert.equal(message('fr', 'serverError', { status: 500 }), 'Transcription server error (500). Also check the model name.');
});
