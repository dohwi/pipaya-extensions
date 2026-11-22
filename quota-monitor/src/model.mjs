// Pure snapshot -> gauges conversion. Also bundled into the sandbox worker.
import { t } from './i18n.mjs';
export function providerName(provider) {
  const name = String(provider || '').toLowerCase().trim();
  if (['codex', 'openai', 'gpt'].includes(name)) return 'gpt';
  if (['gemini', 'gemini-cli', 'google'].includes(name)) return 'gemini';
  if (['claude', 'anthropic'].includes(name)) return 'claude';
  return name;
}

export function normalizeModelTier(raw) {
  const value = String(raw || '').trim();
  return value === '4' || value === '3.8' ? value : '';
}

// Never use the local poll time: a failed refresh must keep the original data age.
export function observedAt(account) {
  const candidates = [account?.last_success, account?.observed_at,
    ...(Array.isArray(account?.windows) ? account.windows.map(window => window?.observed_at) : [])];
  const times = candidates.map(value => (typeof value === 'string' ? Date.parse(value) : NaN))
    .filter(time => Number.isFinite(time) && time > 0);
  return times.length ? Math.max(...times) : null;
}

export function gaugesFromSnapshot(snapshot) {
  if (!snapshot || snapshot.configured !== true || snapshot.snapshot_complete !== true) {
    const code = snapshot?.configured === false ? 'checkConfig' : 'waiting';
    throw Object.assign(new Error(t(code)), { code });
  }
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const byProvider = name => accounts.filter(account => providerName(account.provider) === name);
  const availability = Array.isArray(snapshot.availability) ? snapshot.availability : [];
  const fleetSummary = (key, group) => {
    const entry = availability.find(item => item?.key === key);
    const value = entry?.remaining_percent;
    // The server owns fleet aggregation. Missing values never fall back to account windows.
    const remaining = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    const usable = group.filter(account => account.operational?.disabled !== true && account.status !== 'disabled' && account.operational?.status !== 'disabled');
    const isStale = account => account.stale === true || account.status === 'error' || account.status === 'stale';
    // One broken account is not worth a warning while another one still reports; flag only when every usable account is stale.
    const stale = usable.length > 0 && usable.every(isStale);
    const times = usable.map(observedAt).filter(time => time !== null);
    const updatedAt = times.length ? Math.max(...times) : null;
    const hint = [remaining === null ? t('unknownRemaining') : '', stale ? t('staleObservation') : ''].filter(Boolean).join(' · ');
    return { remaining, stale, updatedAt, hint, rows: [{ label: t('remaining'), value: remaining }] };
  };
  const gauge = (id, label, brand, group, key = id) => {
    const summary = fleetSummary(key, group);
    return { id, label, brand, remainingPercent: summary.remaining, hint: summary.hint, updatedAt: summary.updatedAt, rows: summary.rows, stale: snapshot.stale === true || summary.stale };
  };
  const ag = byProvider('antigravity');
  const gemini = byProvider('gemini');
  // Fixed order: Claude, (GPT only when a GPT account exists), (native Gemini only when present), Antigravity units.
  const gpt = byProvider('gpt');
  const gauges = [gauge('claude', 'Claude', 'claude', byProvider('claude'))];
  if (gpt.length) gauges.push(gauge('gpt', 'GPT', 'gpt', gpt, 'codex'));
  if (gemini.length) gauges.push(gauge('gemini', 'Gemini', 'gemini', gemini));
  const antigravityGauge = (id, label, brand, group, geminiKey, claudeKey) => {
    const outer = gauge(id, label, brand, group, geminiKey);
    const inner = fleetSummary(claudeKey, group);
    outer.innerRemainingPercent = inner.remaining;
    outer.innerRows = inner.rows;
    outer.stale ||= inner.stale;
    outer.updatedAt = Math.max(outer.updatedAt ?? 0, inner.updatedAt ?? 0) || null;
    outer.hint = [outer.hint ? `Gemini: ${outer.hint}` : '', inner.hint ? `Claude/GPT: ${inner.hint}` : ''].filter(Boolean).join(' · ');
    return outer;
  };
  const ag4 = ag.filter(account => normalizeModelTier(account.model_tier) === '4');
  const ag38 = ag.filter(account => normalizeModelTier(account.model_tier) === '3.8');
  const agLegacy = ag.filter(account => normalizeModelTier(account.model_tier) === '');
  const hasKey = key => availability.some(item => item?.key === key);
  const has4 = ag4.length > 0 || hasKey('antigravity_4_gemini') || hasKey('antigravity_4_claude');
  const has38 = ag38.length > 0 || hasKey('antigravity_3_8_gemini') || hasKey('antigravity_3_8_claude');
  const hasLegacy = agLegacy.length > 0 || hasKey('antigravity_gemini') || hasKey('antigravity_claude');
  if (has4 || has38) {
    if (has4) gauges.push(antigravityGauge('antigravity_4', 'AGY (4)', 'antigravity_4', ag4, 'antigravity_4_gemini', 'antigravity_4_claude'));
    if (has38) gauges.push(antigravityGauge('antigravity_3_8', 'AGY (3.8)', 'antigravity_3_8', ag38, 'antigravity_3_8_gemini', 'antigravity_3_8_claude'));
    if (hasLegacy) gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity', agLegacy, 'antigravity_gemini', 'antigravity_claude'));
  } else {
    gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity', ag, 'antigravity_gemini', 'antigravity_claude'));
  }
  return { label: t('title'), gauges };
}

export function pollDelay(snapshot, settings = {}) {
  if (snapshot?.snapshot_complete === false || snapshot?.collection_in_progress === true) return 2000;
  const seconds = Number(settings.pollSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(900000, Math.max(10000, seconds * 1000));
  const hint = snapshot?.next_poll_hint_ms;
  return typeof hint === 'number' && Number.isFinite(hint) && hint > 0
    ? Math.min(900000, Math.max(10000, hint)) : 60000;
}
