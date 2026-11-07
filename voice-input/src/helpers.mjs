// Pure helpers for VoiceButton.svelte. scripts/build.mjs inlines this file into the component's <script module>
// (a trusted component can import only `pipaya`, `svelte*` and sibling .svelte files), and the tests import it directly.
// Keep it free of DOM, network and storage access.

export const MAX_RECORD_MS = 5 * 60 * 1000;
export const MIN_RECORD_MS = 400;
export const MIN_BLOB_BYTES = 800;
export const UPLOAD_TIMEOUT_MS = 60 * 1000;

// Preference order. Chrome/Firefox/Edge make webm or ogg (opus), Safari makes mp4. The services listed in the README
// accept webm and m4a, so the browser's own format is uploaded as is (no conversion).
export const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

export function pickMimeType(isSupported) {
  for (const type of MIME_CANDIDATES) {
    try { if (isSupported(type)) return type; } catch { /* try the next one */ }
  }
  return '';
}

export function baseMime(type) {
  return String(type || '').split(';')[0].trim().toLowerCase();
}

export function extensionFor(type) {
  switch (baseMime(type)) {
    case 'audio/webm': return 'webm';
    case 'audio/mp4': case 'audio/x-m4a': case 'audio/aac': return 'm4a';
    case 'audio/ogg': return 'ogg';
    case 'audio/wav': case 'audio/x-wav': case 'audio/wave': return 'wav';
    case 'audio/mpeg': return 'mp3';
    default: return 'webm';
  }
}

export function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Append to what is already typed, separated by one space; never replace the draft.
export function joinDraft(current, addition) {
  const add = String(addition ?? '').trim();
  const cur = String(current ?? '');
  if (!add) return cur;
  return cur.trim() ? `${cur.replace(/\s+$/, '')} ${add}` : add;
}

// The extension talks only to the transcription server (`apiBase`), never to the pipaya server. HTTPS matters in two
// places, and only there:
//  1. The microphone (`getUserMedia`) needs the page to be a secure context (checked by the component).
//  2. A page opened over https cannot call an `http://` server (mixed content), so on such a page a plain-http address is
//     refused. The exception is a loopback host (localhost, 127.0.0.1, [::1]): browsers treat these as trustworthy and let
//     an https page call them, which is what a Whisper server on the same machine needs. Private-network addresses are not
//     an exception here (see README).
// On a page that is not https (an http page, or localhost) a plain-http address is fine.
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

// An address typed without a scheme (`api.example.com`, `localhost:8000`) is read as https://. The stored value is not
// changed; only the reading is. Anything that already has a scheme is left alone.
export function withScheme(text) {
  const t = String(text ?? '').trim();
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  // `host:port` also looks like `scheme:path`, so only a `scheme://` counts as a scheme here; other `x:y` forms fall through
  // to URL() below and are rejected as malformed.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/i.test(t)) return t;
  return `https://${t}`;
}

// Splits what the user typed into { origin, problem }. `problem` is '' (fine), 'needBase' (empty or not an origin:
// path, query, credentials, other scheme) or 'needHttps' (a well-formed http:// address, on an https page, that is not
// loopback). `pageProtocol` is `location.protocol` of the page ('https:' / 'http:' / ...); when it is left out the
// strict reading is used, as if the page were https. A missing scheme means https (see withScheme).
export function checkBase(apiBase, pageProtocol = 'https:') {
  const text = withScheme(apiBase);
  if (!text) return { origin: '', problem: 'needBase' };
  let url;
  try { url = new URL(text); } catch { return { origin: '', problem: 'needBase' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { origin: '', problem: 'needBase' };
  if (url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) return { origin: '', problem: 'needBase' };
  if (url.protocol === 'http:' && pageProtocol === 'https:' && !isLoopbackHost(url.hostname)) return { origin: '', problem: 'needHttps' };
  return { origin: url.origin, problem: '' };
}

// The bare origin to send to, or '' when the setting must not be used (see checkBase).
export function originOf(apiBase, pageProtocol = 'https:') {
  return checkBase(apiBase, pageProtocol).origin;
}

// The standard OpenAI-style route. It is only the default of the `transcribePath` setting; servers that mount
// the same API elsewhere (a prefix, a gateway route) change the setting instead of the code.
export const DEFAULT_TRANSCRIBE_PATH = '/v1/audio/transcriptions';

// A request path only: starts with one `/`, no scheme, origin, query, fragment, `..`/`.` segments, backslashes,
// spaces or control characters. Empty means the default. Returns '' when the value is not acceptable.
export function pathOf(transcribePath) {
  const text = transcribePath === undefined || transcribePath === null ? '' : String(transcribePath).trim();
  if (!text) return DEFAULT_TRANSCRIBE_PATH;
  if (text.length > 200 || !/^\/(?!\/)[A-Za-z0-9._~\-\/%:@!$&'()*+,;=]*$/.test(text)) return '';
  if (text.split('/').some((part) => part === '.' || part === '..' || /^(%2e)+$/i.test(part))) return '';
  return text;
}

// origin + path, or '' when either part is not acceptable (then nothing is sent).
export function endpoint(apiBase, transcribePath, pageProtocol = 'https:') {
  const origin = originOf(apiBase, pageProtocol);
  const path = pathOf(transcribePath);
  if (!origin || !path) return '';
  try { if (new URL(origin + path).origin !== origin) return ''; } catch { return ''; }
  return origin + path;
}

export function hostOf(apiBase) {
  try { return new URL(String(apiBase)).host; } catch { return String(apiBase ?? ''); }
}

// OpenAI's documentation says the model `gpt-transcribe` takes `languages` (a list) instead of the single `language`, and
// that both must not be sent together. Only that exact model name is treated this way (compared without case or
// surrounding spaces): its reference lists no other `gpt-transcribe-...` model, and every other model or service keeps `language`.
export const usesLanguagesList = (model) => String(model ?? '').trim().toLowerCase() === 'gpt-transcribe';

// Only file, model and the language hint are sent. Optional extras some services support (prompt, context or keyword hints)
// are left to the server. An empty language sends neither field.
export function buildForm(blob, { model, language }) {
  const form = new FormData();
  const type = baseMime(blob.type) || 'audio/webm';
  form.append('file', new File([blob], `voice.${extensionFor(type)}`, { type }));
  const m = String(model ?? '').trim();
  if (m) form.append('model', m);
  const l = String(language ?? '').trim();
  if (l) form.append(usesLanguagesList(m) ? 'languages[]' : 'language', l);
  return form;
}

export class VoiceError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

// One upload. The key goes only into the Authorization header and never into a message or log.
// Throws VoiceError(kind) with kind in needBase | needHttps | badPath | notFound | aborted | timeout | network | badKey | rateLimited | tooBig | serverError | badResponse | empty.
export async function transcribe({ fetchImpl, apiBase, transcribePath, pageProtocol = 'https:', apiKey, model, language, blob, timeoutMs = UPLOAD_TIMEOUT_MS, signal }) {
  const base = checkBase(apiBase, pageProtocol);
  if (base.problem) throw new VoiceError(base.problem);
  if (!pathOf(transcribePath)) throw new VoiceError('badPath');
  const control = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; control.abort(); }, timeoutMs);
  const onAbort = () => control.abort();
  if (signal) { if (signal.aborted) control.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    let response;
    try {
      response = await fetchImpl(endpoint(apiBase, transcribePath, pageProtocol), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildForm(blob, { model, language }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: control.signal
      });
    } catch {
      throw new VoiceError(timedOut ? 'timeout' : control.signal.aborted ? 'aborted' : 'network');
    }
    if (!response.ok) throw new VoiceError(httpErrorKind(response.status), response.status);
    let body;
    try { body = await response.json(); } catch { throw new VoiceError(timedOut ? 'timeout' : control.signal.aborted ? 'aborted' : 'badResponse'); }
    if (typeof body?.text !== 'string') throw new VoiceError('badResponse');
    const text = body.text.trim();
    if (!text) throw new VoiceError('empty');
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function micErrorKind(error) {
  switch (error?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError': return 'micDenied';
    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError': return 'noMic';
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': return 'micBusy';
    default: return 'micFailed';
  }
}

export function httpErrorKind(status) {
  if (status === 401 || status === 403) return 'badKey';
  if (status === 404 || status === 405) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status === 413) return 'tooBig';
  return 'serverError';
}

export const STRINGS = {
  ko: {
    idle: '음성으로 입력',
    recording: '녹음 중 — 눌러서 정지하고 변환',
    transcribing: '변환 중…',
    transcribingShort: '변환 중',
    cancel: '녹음 취소',
    errorShort: '오류',
    needBase: '설정에서 서버 주소를 입력하세요(예: https://서버 주소).',
    needBaseShort: '주소 필요',
    shortcutBad: '단축키 형식이 올바르지 않습니다. Alt+M, Mod+Shift+K처럼 Ctrl(Mod)/Alt와 키 하나로 쓰세요.',
    shortcutBadShort: '단축키 오류',
    shortcutConflict: '이 단축키는 pipaya의 다른 기능이 이미 씁니다. 앱 단축키가 먼저 동작하니 다른 조합을 고르세요.',
    shortcutConflictShort: '단축키 충돌',
    modeToggle: '누르면 시작/다시 누르면 정지',
    modeHold: '누르고 있는 동안 녹음',
    needHttps: 'https 화면에서는 http 주소를 쓸 수 없습니다(브라우저가 차단). https 주소를 쓰세요. 같은 컴퓨터의 localhost는 http도 됩니다.',
    needHttpsShort: 'https 주소 필요',
    badPath: '전사 경로가 올바르지 않습니다. /로 시작하는 경로만 쓸 수 있습니다(예: /v1/audio/transcriptions).',
    badPathShort: '경로 오류',
    needKey: 'API 키가 없습니다. 확장 설정에서 키를 입력하세요.',
    needKeyShort: '키 필요',
    badKey: 'API 키가 거부되었습니다({status}). 설정에서 키를 고치세요. 반복 실패로 인한 차단을 피하려고 키를 바꿀 때까지 요청하지 않습니다.',
    badKeyShort: '키 거부됨',
    micDenied: '마이크 권한이 거부되었습니다. 주소창의 사이트 설정에서 마이크를 허용한 뒤 다시 누르세요.',
    micDeniedShort: '마이크 거부됨',
    noMic: '마이크를 찾을 수 없습니다. 장치 연결을 확인하세요.',
    noMicShort: '마이크 없음',
    micBusy: '마이크를 열 수 없습니다. 다른 앱이 쓰고 있을 수 있습니다.',
    micBusyShort: '마이크 사용 불가',
    micFailed: '마이크를 시작하지 못했습니다.',
    micFailedShort: '마이크 오류',
    insecure: '마이크는 HTTPS 화면에서만 켜집니다. pipaya를 https 주소로 여세요.',
    insecureShort: 'HTTPS 화면 필요',
    unsupported: '이 브라우저는 녹음을 지원하지 않습니다.',
    unsupportedShort: '녹음 미지원',
    network: '{host}에 연결할 수 없습니다. 네트워크와 확장 설정의 서버 주소를 확인하세요.',
    networkShort: '연결 실패',
    timeout: '변환 요청이 {sec}초 안에 끝나지 않았습니다.',
    timeoutShort: '시간 초과',
    notFound: '전사 경로를 찾을 수 없습니다({status}). 설정의 서버 주소와 전사 경로를 확인하세요.',
    notFoundShort: '경로 없음',
    rateLimited: '요청이 너무 많습니다(429). 잠시 후 다시 시도하세요.',
    rateLimitedShort: '요청 과다',
    tooBig: '녹음이 너무 깁니다(413). 더 짧게 나눠 말해 주세요.',
    tooBigShort: '너무 김',
    serverError: '변환 서버 오류({status}). 모델 이름이 맞는지도 확인하세요.',
    serverErrorShort: '서버 오류',
    tooShort: '녹음이 너무 짧습니다.',
    tooShortShort: '너무 짧음',
    empty: '인식된 내용이 없습니다. 다시 말해 보세요.',
    emptyShort: '인식 없음',
    badResponse: '변환 서버의 응답을 읽을 수 없습니다.',
    badResponseShort: '응답 오류',
    paneChanged: '입력창이 바뀌어 넣지 않았습니다. 변환 결과: {text}',
    paneChangedShort: '입력창 변경됨'
  },
  en: {
    idle: 'Dictate',
    recording: 'Recording — click to stop and transcribe',
    transcribing: 'Transcribing…',
    transcribingShort: 'Working',
    cancel: 'Cancel recording',
    errorShort: 'Error',
    needBase: 'Enter the server address in the extension settings (for example https://your-server).',
    needBaseShort: 'Address needed',
    shortcutBad: 'The shortcut is not valid. Use Ctrl (Mod) or Alt plus one key, for example Alt+M or Mod+Shift+K.',
    shortcutBadShort: 'Bad shortcut',
    shortcutConflict: 'pipaya already uses this shortcut for something else, and the app wins. Choose another combination.',
    shortcutConflictShort: 'Shortcut taken',
    modeToggle: 'press to start, press again to stop',
    modeHold: 'hold to record',
    needHttps: 'An http address cannot be used from an https page (the browser blocks it). Use an https address. localhost on this same computer may use http.',
    needHttpsShort: 'Use https',
    badPath: 'The transcription path is not valid. Use a path starting with / (for example /v1/audio/transcriptions).',
    badPathShort: 'Bad path',
    needKey: 'The API key is not set. Enter it in the extension settings.',
    needKeyShort: 'Key needed',
    badKey: 'The API key was rejected ({status}). Fix it in the settings. Requests stop until the key changes, to avoid being blocked after repeated failures.',
    badKeyShort: 'Key rejected',
    micDenied: 'Microphone permission was denied. Allow the microphone in the site settings next to the address bar, then try again.',
    micDeniedShort: 'Mic denied',
    noMic: 'No microphone found. Check that a device is connected.',
    noMicShort: 'No mic',
    micBusy: 'The microphone cannot be opened. Another app may be using it.',
    micBusyShort: 'Mic unavailable',
    micFailed: 'Could not start the microphone.',
    micFailedShort: 'Mic error',
    insecure: 'The microphone works only on an HTTPS page. Open pipaya at an https address.',
    insecureShort: 'HTTPS needed',
    unsupported: 'This browser cannot record audio.',
    unsupportedShort: 'Unsupported',
    network: 'Cannot reach {host}. Check the network and the server address in the extension settings.',
    networkShort: 'Unreachable',
    timeout: 'Transcription did not finish within {sec} seconds.',
    timeoutShort: 'Timed out',
    notFound: 'The transcription route was not found ({status}). Check the server address and transcription path in the settings.',
    notFoundShort: 'Not found',
    rateLimited: 'Too many requests (429). Try again in a moment.',
    rateLimitedShort: 'Rate limited',
    tooBig: 'The recording is too long (413). Speak in shorter parts.',
    tooBigShort: 'Too long',
    serverError: 'Transcription server error ({status}). Also check the model name.',
    serverErrorShort: 'Server error',
    tooShort: 'The recording is too short.',
    tooShortShort: 'Too short',
    empty: 'Nothing was recognised. Try again.',
    emptyShort: 'Nothing heard',
    badResponse: 'The transcription response could not be read.',
    badResponseShort: 'Bad response',
    paneChanged: 'The input box changed, so nothing was inserted. Transcript: {text}',
    paneChangedShort: 'Input changed'
  }
};

export function message(lang, key, params = {}) {
  const table = STRINGS[String(lang || '').toLowerCase().startsWith('ko') ? 'ko' : 'en'];
  return String(table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// ── keyboard shortcut ──────────────────────────────────────────────────────────────────────────────────────────────
// The combo is typed as text, in the same notation as pipaya's own shortcuts: modifiers `Mod` (Ctrl, or ⌘ on macOS),
// `Alt`, `Shift`, then exactly one key: `Alt+M`, `Mod+Shift+K`, `Alt+Space`, `F9`. There is no default: empty = none.
// Keys are matched on KeyboardEvent.code, so they do not depend on the layout, on a Korean IME state, or on what Alt
// turns a letter into on macOS.
export const SHORTCUT_MIN_HOLD_MS = 300;
const NAMED_KEYS = new Set(['Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'Minus', 'Equal', 'Comma', 'Period', 'Slash', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'BracketLeft', 'BracketRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete']);
const MOD_NAMES = ['Mod', 'Alt', 'Shift'];

export function keyNameOf(code) {
  const c = String(code ?? '');
  return c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5) : c;
}

function isKeyName(k) {
  return /^[A-Z]$/.test(k) || /^[0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED_KEYS.has(k);
}

// -> { ok: true, combo, mods: {mod, alt, shift}, key } | { ok: false, reason }.  Empty text is `{ ok: true, combo: '' }`.
// reason: format | needMod | oneKey | badKey | reserved
export function parseShortcut(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, combo: '', mods: null, key: '' };
  const parts = raw.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return { ok: false, reason: 'format' };
  const fixCase = (p) => (/^(mod|ctrl|control|cmd|command|meta)$/i.test(p) ? 'Mod' : /^(alt|option|opt)$/i.test(p) ? 'Alt' : /^shift$/i.test(p) ? 'Shift' : p);
  const fixed = parts.map(fixCase);
  const mods = fixed.filter((p) => MOD_NAMES.includes(p));
  const keys = fixed.filter((p) => !MOD_NAMES.includes(p));
  if (new Set(mods).size !== mods.length) return { ok: false, reason: 'format' };
  if (keys.length !== 1) return { ok: false, reason: keys.length ? 'oneKey' : 'format' };
  let key = keys[0];
  if (/^[a-z]$/.test(key)) key = key.toUpperCase();
  else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase();
  else if (!/^[A-Z0-9]$/.test(key)) key = NAMED_KEYS.has(key) ? key : [...NAMED_KEYS].find((n) => n.toLowerCase() === key.toLowerCase()) ?? key;
  if (!isKeyName(key)) return { ok: false, reason: 'badKey' };
  const flags = { mod: mods.includes('Mod'), alt: mods.includes('Alt'), shift: mods.includes('Shift') };
  // A bare letter (or Shift+letter) would be typed into the input box, so a combo needs Ctrl/⌘ or Alt, like the app's own
  // extension shortcuts. F-keys type nothing and may stand alone.
  const isF = /^F\d{1,2}$/.test(key);
  if (!isF && !flags.mod && !flags.alt) return { ok: false, reason: 'needMod' };
  // Keys the app and the browser keep for themselves.
  if (key === 'Escape' || key === 'Enter' || key === 'Tab' || key === 'Backspace') return { ok: false, reason: 'reserved' };
  const canon = [flags.mod && 'Mod', flags.alt && 'Alt', flags.shift && 'Shift', key].filter(Boolean).join('+');
  return { ok: true, combo: canon, mods: flags, key };
}

// Does this keyboard event press exactly that combo? `e` needs `code`, ctrlKey, metaKey, altKey, shiftKey.
export function matchesShortcut(parsed, e) {
  if (!parsed?.ok || !parsed.combo) return false;
  if (keyNameOf(e.code) !== parsed.key) return false;
  const mod = !!(e.ctrlKey || e.metaKey);
  return mod === parsed.mods.mod && !!e.altKey === parsed.mods.alt && !!e.shiftKey === parsed.mods.shift;
}

// Is it the release of the shortcut's key (modifiers may already be up)?
export function releasesShortcut(parsed, e) {
  return !!parsed?.ok && !!parsed.combo && keyNameOf(e.code) === parsed.key;
}

// A release of a modifier that is part of the combo also ends a held shortcut.
export function releasesModifier(parsed, e) {
  if (!parsed?.ok || !parsed.mods) return false;
  const k = String(e.key ?? '');
  return (parsed.mods.mod && (k === 'Control' || k === 'Meta')) || (parsed.mods.alt && k === 'Alt') || (parsed.mods.shift && k === 'Shift');
}

// `bindings` is the app's own shortcut table ({ actionId: combo }), read from `app.prefs.bindings`. The app's shortcuts win
// over this one, so a combo it already uses is reported: the extension keeps listening but the app acts first only for
// combos it handles itself, so tell the user. Order of keys inside a combo does not matter to the app for held keys.
export function conflictsWithApp(parsed, bindings) {
  if (!parsed?.ok || !parsed.combo) return '';
  const want = parsed.combo;
  for (const [id, combo] of Object.entries(bindings ?? {})) {
    if (typeof combo !== 'string' || !combo) continue;
    const parts = combo.split('+');
    const keys = parts.filter((p) => !MOD_NAMES.includes(p));
    const sameMods = MOD_NAMES.filter((m) => parts.includes(m)).join('+');
    // a combo made of one key + the same modifiers, or one that starts a longer app shortcut (Mod+B starts Mod+B+B)
    if (combo === want || (keys.length > 1 && [sameMods, keys[0]].filter(Boolean).join('+') === want)) return id;
  }
  return '';
}

// Where a key event comes from, to decide what the extension may do with it. IME composition is never touched.
export function shouldHandleKey(e, { recordingKey = false } = {}) {
  if (e.isComposing || e.keyCode === 229) return false;
  if (recordingKey) return false;
  return true;
}

export function shortcutLabel(parsed, mode, lang) {
  if (!parsed?.ok || !parsed.combo) return '';
  const names = { Mod: /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl' };
  const text = parsed.combo.split('+').map((p) => names[p] ?? p).join('+');
  return `${text} · ${message(lang, mode === 'hold' ? 'modeHold' : 'modeToggle')}`;
}

// ── hold-to-talk bookkeeping ───────────────────────────────────────────────────────────────────────────────────────
// Pure: given when the key went down and when it came up, was it a real press?
export function holdVerdict(downAt, upAt, minMs = SHORTCUT_MIN_HOLD_MS) {
  return upAt - downAt >= minMs ? 'send' : 'discard';
}
