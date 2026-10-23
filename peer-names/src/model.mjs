/** `{ sessionId: { text, title } }` for the sidebar and header labels. */
export function labelsOf(overview) {
  const out = {};
  for (const s of overview?.sessions ?? []) {
    if (!s?.id || !s?.name) continue;
    out[s.id] = { text: `@${s.name}`, title: s.purpose ? `@${s.name} · ${s.purpose}` : `@${s.name}` };
  }
  return out;
}

const WORDS = {
  ko: { group: '그룹', session: '세션', sessions: n => `${n}개 세션` },
  en: { group: 'Groups', session: 'Sessions', sessions: n => `${n} sessions` }
};
const wordsFor = lang => (String(lang ?? '').toLowerCase().startsWith('ko') ? WORDS.ko : WORDS.en);

/** The `@` completions: every addressable session and every group with sessions in it. */
export function mentionsOf(overview, lang) {
  const w = wordsFor(lang);
  const sessions = overview?.sessions ?? [];
  const known = new Set(sessions.map(s => s.id));
  const items = [];
  for (const g of overview?.groups ?? []) {
    const live = (g.sessionIds ?? []).filter(id => known.has(id)).length;
    if (!live || !g.handle) continue;
    items.push({ insert: `@${g.handle}`, desc: w.sessions(live), group: w.group, keywords: g.name });
  }
  for (const s of sessions) {
    if (!s?.id || !s?.name) continue;
    const dir = String(s.cwd ?? '').split('/').slice(-2).join('/');
    items.push({ insert: `@${s.name}`, desc: [s.purpose || s.title, dir].filter(Boolean).join(' · '), group: w.session, keywords: `${s.title ?? ''} ${s.purpose ?? ''}`, except: s.id });
  }
  return items;
}
