// Pure snapshot -> navbar conversion. Also bundled into the sandbox worker.
import { t } from './i18n.mjs';
export function providerName(provider) {
  const name = String(provider || '').toLowerCase().trim();
  if (['codex', 'openai', 'gpt'].includes(name)) return 'gpt';
  if (['gemini', 'gemini-cli', 'google'].includes(name)) return 'gemini';
  if (['claude', 'anthropic'].includes(name)) return 'claude';
  return name;
}

// Never use the local poll time: a failed refresh must keep the original data age.
export function observedAt(account) {
  const candidates = [account?.last_success, account?.observed_at,
    ...(Array.isArray(account?.windows) ? account.windows.map(window => window?.observed_at) : [])];
  const times = candidates.map(value => (typeof value === 'string' ? Date.parse(value) : NaN))
    .filter(time => Number.isFinite(time) && time > 0);
  return times.length ? Math.max(...times) : null;
}

export function navbarFromSnapshot(snapshot) {
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
    const stale = usable.some(account => account.stale === true || account.status === 'error' || account.status === 'stale');
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
  // Fixed order: Claude, (GPT only when a GPT account exists), (native Gemini only when present), Antigravity.
  const gpt = byProvider('gpt');
  const gauges = [gauge('claude', 'Claude', 'claude', byProvider('claude'))];
  if (gpt.length) gauges.push(gauge('gpt', 'GPT', 'gpt', gpt, 'codex'));
  if (gemini.length) gauges.push(gauge('gemini', 'Gemini', 'gemini', gemini));
  const outer = gauge('antigravity', 'Antigravity', 'antigravity', ag, 'antigravity_gemini');
  const inner = fleetSummary('antigravity_claude', ag);
  outer.innerRemainingPercent = inner.remaining;
  outer.innerRows = inner.rows;
  outer.stale ||= inner.stale;
  outer.updatedAt = Math.max(outer.updatedAt ?? 0, inner.updatedAt ?? 0) || null;
  outer.hint = [outer.hint ? `Gemini: ${outer.hint}` : '', inner.hint ? `Claude/GPT: ${inner.hint}` : ''].filter(Boolean).join(' · ');
  gauges.push(outer);
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
