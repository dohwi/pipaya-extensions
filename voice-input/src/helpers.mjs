// Pure helpers for VoiceButton.svelte. scripts/build.mjs inlines this file into the component's <script module>
// (a trusted component can import only `pipaya`, `svelte*` and sibling .svelte files), and the tests import it directly.
// Keep it free of DOM, network and storage access.

export const MAX_RECORD_MS = 5 * 60 * 1000;
export const MIN_RECORD_MS = 400;
export const MIN_BLOB_BYTES = 800;
export const UPLOAD_TIMEOUT_MS = 60 * 1000;

// Preference order. Chrome/Firefox/Edge make webm or ogg (opus), Safari makes mp4. Voxtral accepts them all
// (checked by uploading m4a, webm/opus and wav), so the browser's own format is uploaded as is.
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

// There is no default address: the user enters their own. Returns the bare http(s) origin, or '' when the
// setting is empty or not an origin (no path, query, credentials), so nothing is ever sent to a guessed place.
export function originOf(apiBase) {
  const text = String(apiBase ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) return '';
  return url.origin;
}

export function endpoint(apiBase) {
  return `${originOf(apiBase)}/v0/management/audio/transcriptions`;
}

export function hostOf(apiBase) {
  try { return new URL(String(apiBase)).host; } catch { return String(apiBase ?? ''); }
}

// context_bias is deliberately never sent: the server adds its stored term list.
export function buildForm(blob, { model, language }) {
  const form = new FormData();
  const type = baseMime(blob.type) || 'audio/webm';
  form.append('file', new File([blob], `voice.${extensionFor(type)}`, { type }));
  const m = String(model ?? '').trim();
  if (m) form.append('model', m);
  const l = String(language ?? '').trim();
  if (l) form.append('language', l);
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
// Throws VoiceError(kind) with kind in needBase | aborted | timeout | network | badKey | rateLimited | tooBig | serverError | badResponse | empty.
export async function transcribe({ fetchImpl, apiBase, apiKey, model, language, blob, timeoutMs = UPLOAD_TIMEOUT_MS, signal }) {
  if (!originOf(apiBase)) throw new VoiceError('needBase');
  const control = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; control.abort(); }, timeoutMs);
  const onAbort = () => control.abort();
  if (signal) { if (signal.aborted) control.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    let response;
    try {
      response = await fetchImpl(endpoint(apiBase), {
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
    needBase: '설정에서 CLIProxyAPI 주소를 입력하세요(예: https://서버 주소).',
    needBaseShort: '주소 필요',
    needKey: 'CLIProxyAPI 관리 키가 없습니다. 확장 설정에서 키를 입력하세요.',
    needKeyShort: '키 필요',
    badKey: '관리 키가 거부되었습니다({status}). 설정에서 키를 고치세요. 서버의 IP 차단을 피하려고 키를 바꿀 때까지 요청하지 않습니다.',
    badKeyShort: '키 거부됨',
    micDenied: '마이크 권한이 거부되었습니다. 주소창의 사이트 설정에서 마이크를 허용한 뒤 다시 누르세요.',
    micDeniedShort: '마이크 거부됨',
    noMic: '마이크를 찾을 수 없습니다. 장치 연결을 확인하세요.',
    noMicShort: '마이크 없음',
    micBusy: '마이크를 열 수 없습니다. 다른 앱이 쓰고 있을 수 있습니다.',
    micBusyShort: '마이크 사용 불가',
    micFailed: '마이크를 시작하지 못했습니다.',
    micFailedShort: '마이크 오류',
    insecure: '마이크는 HTTPS 주소에서만 켤 수 있습니다. https:// 로 접속하세요.',
    insecureShort: 'HTTPS 필요',
    unsupported: '이 브라우저는 녹음을 지원하지 않습니다.',
    unsupportedShort: '녹음 미지원',
    network: '{host}에 연결할 수 없습니다. 네트워크와 확장 설정의 서버 주소를 확인하세요.',
    networkShort: '연결 실패',
    timeout: '변환 요청이 {sec}초 안에 끝나지 않았습니다.',
    timeoutShort: '시간 초과',
    rateLimited: '요청이 너무 많습니다(429). 잠시 후 다시 시도하세요.',
    rateLimitedShort: '요청 과다',
    tooBig: '녹음이 너무 깁니다(413). 더 짧게 나눠 말해 주세요.',
    tooBigShort: '너무 김',
    serverError: '변환 서버 오류({status}).',
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
    needBase: 'Enter the CLIProxyAPI address in the extension settings (for example https://your-server).',
    needBaseShort: 'Address needed',
    needKey: 'The CLIProxyAPI management key is not set. Enter it in the extension settings.',
    needKeyShort: 'Key needed',
    badKey: 'The management key was rejected ({status}). Fix it in the settings. Requests stop until the key changes, to avoid a server IP ban.',
    badKeyShort: 'Key rejected',
    micDenied: 'Microphone permission was denied. Allow the microphone in the site settings next to the address bar, then try again.',
    micDeniedShort: 'Mic denied',
    noMic: 'No microphone found. Check that a device is connected.',
    noMicShort: 'No mic',
    micBusy: 'The microphone cannot be opened. Another app may be using it.',
    micBusyShort: 'Mic unavailable',
    micFailed: 'Could not start the microphone.',
    micFailedShort: 'Mic error',
    insecure: 'The microphone works only on an HTTPS address. Open pipaya with https://.',
    insecureShort: 'HTTPS needed',
    unsupported: 'This browser cannot record audio.',
    unsupportedShort: 'Unsupported',
    network: 'Cannot reach {host}. Check the network and the server address in the extension settings.',
    networkShort: 'Unreachable',
    timeout: 'Transcription did not finish within {sec} seconds.',
    timeoutShort: 'Timed out',
    rateLimited: 'Too many requests (429). Try again in a moment.',
    rateLimitedShort: 'Rate limited',
    tooBig: 'The recording is too long (413). Speak in shorter parts.',
    tooBigShort: 'Too long',
    serverError: 'Transcription server error ({status}).',
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
