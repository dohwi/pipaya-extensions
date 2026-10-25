// Tiny message catalog. Bundled into the sandbox worker, so it must not touch anything but plain JS.
// Korean is the source language; a missing key in another language falls back to Korean.
const MESSAGES = {
  ko: {
    itemLabel: 'AI 잔량',
    title: 'AI 쿼터 잔량',
    remainingOf: '{name} 잔량',
    remaining: '잔량',
    unknownRemaining: '잔량 미확인',
    staleObservation: '이전 관측값',
    noQuotaInfo: '쿼터 정보 없음',
    checkConfig: 'quota-monitor 설정을 확인하세요',
    waiting: '첫 쿼터 수집을 기다리는 중',
    needKey: '관리 키를 설정하세요',
    badKey: '관리 키가 거부되었습니다 — 설정에서 다시 입력하세요',
    serverError: '서버가 오류를 반환했습니다 ({status})',
    cannotRead: '쿼터를 읽을 수 없습니다',
    unknown: '확인 불가',
    stale: '오래된 데이터',
    updated: '{ago} 업데이트됨',
    sec: '{n}초 전',
    min: '{n}분 전',
    hour: '{n}시간 전',
    day: '{n}일 전'
  },
  en: {
    itemLabel: 'AI quota',
    title: 'AI quota remaining',
    remainingOf: '{name} remaining',
    remaining: 'Remaining',
    unknownRemaining: 'Remaining unknown',
    staleObservation: 'Previous observation',
    noQuotaInfo: 'No quota information',
    checkConfig: 'Check the quota-monitor configuration',
    waiting: 'Waiting for the first quota collection',
    needKey: 'Set the management key',
    badKey: 'The management key was rejected — enter it again in settings',
    serverError: 'The server returned an error ({status})',
    cannotRead: 'Unable to read quota',
    unknown: 'Unknown',
    stale: 'Stale data',
    updated: 'Updated {ago}',
    sec: '{n}s ago',
    min: '{n}m ago',
    hour: '{n}h ago',
    day: '{n}d ago'
  }
};

let currentLanguage = 'ko';

// 'auto' (the default, i.e. first run) follows the program language as the browser reports it, the same
// rule the pipaya client uses: first supported preference wins, unsupported languages fall back to English,
// and an unknown environment falls back to Korean (the source language).
export function resolveLanguage(setting, languages) {
  if (setting === 'ko' || setting === 'en') return setting;
  const list = Array.isArray(languages) ? languages : [];
  for (const raw of list) {
    const base = String(raw).toLowerCase().replace(/_/g, '-').split('-')[0];
    if (MESSAGES[base]) return base;
  }
  return list.length ? 'en' : 'ko';
}

export function systemLanguages() {
  if (typeof navigator === 'undefined' || !navigator) return [];
  if (navigator.languages && navigator.languages.length) return Array.from(navigator.languages);
  return navigator.language ? [navigator.language] : [];
}

export function setLanguage(setting, languages) {
  if (!languages) languages = systemLanguages();
  currentLanguage = resolveLanguage(setting, languages);
  return currentLanguage;
}

export function t(key, params) {
  const text = (MESSAGES[currentLanguage] && MESSAGES[currentLanguage][key]) ?? MESSAGES.ko[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
}
