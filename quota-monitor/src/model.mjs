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
  const validPercent = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
  const tierRows = (entry, remaining) => {
    const rawTiers = Array.isArray(entry?.tiers) ? entry.tiers : [];
    const tiers = [];
    for (const item of rawTiers) {
      if (!item || typeof item !== 'object') continue;
      const value = validPercent(item.remaining_percent);
      const label = String(item.label ?? item.tier ?? '').trim().slice(0, 32);
      if (value === null || !label) continue;
      tiers.push({ label, value });
      if (tiers.length >= 8) break;
    }
    if (remaining === null || tiers.length === 0) return [{ label: t('remaining'), value: remaining }];
    if (tiers.length === 1) return [{ label: tiers[0].label, value: remaining }];
    return [{ label: t('overall'), value: remaining }, ...tiers.map(item => ({ label: item.label, value: item.value, sub: true }))];
  };
  const fleetSummary = (key, group) => {
    const entry = availability.find(item => item?.key === key);
    // The server owns fleet aggregation. Missing values never fall back to account windows.
    const remaining = validPercent(entry?.remaining_percent);
    const usable = group.filter(account => account.operational?.disabled !== true && account.status !== 'disabled' && account.operational?.status !== 'disabled');
    const isStale = account => account.stale === true || account.status === 'error' || account.status === 'stale';
    // One broken account is not worth a warning while another one still reports; flag only when every usable account is stale.
    const stale = usable.length > 0 && usable.every(isStale);
    const times = usable.map(observedAt).filter(time => time !== null);
    const updatedAt = times.length ? Math.max(...times) : null;
    const hint = [remaining === null ? t('unknownRemaining') : '', stale ? t('staleObservation') : ''].filter(Boolean).join(' · ');
    return { remaining, stale, updatedAt, hint, rows: tierRows(entry, remaining) };
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
  // Server v0.8.0+ unifies Antigravity into antigravity_gemini / antigravity_claude while still tagging accounts with
  // model_tier: "4", so split AGY (4) / AGY (3.8) gauges only when the server actually reports split availability keys.
  const has4 = hasKey('antigravity_4_gemini') || hasKey('antigravity_4_claude');
  const has38 = hasKey('antigravity_3_8_gemini') || hasKey('antigravity_3_8_claude');
  const hasUnified = hasKey('antigravity_gemini') || hasKey('antigravity_claude');
  if (has4 || has38) {
    if (has4) gauges.push(antigravityGauge('antigravity_4', 'AGY (4)', 'antigravity_4', ag4, 'antigravity_4_gemini', 'antigravity_4_claude'));
    if (has38) gauges.push(antigravityGauge('antigravity_3_8', 'AGY (3.8)', 'antigravity_3_8', ag38, 'antigravity_3_8_gemini', 'antigravity_3_8_claude'));
    if (hasUnified) gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity', agLegacy.length ? agLegacy : ag, 'antigravity_gemini', 'antigravity_claude'));
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

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const STICKY_TIER_IDS = ['antigravity_4', 'antigravity_3_8'];
const TIER_MISS_LIMIT = 3;
const GAUGE_ORDER = { claude: 0, gpt: 1, gemini: 2, antigravity_4: 3, antigravity_3_8: 4, antigravity: 5 };

// Keep the last known reading when a later snapshot returns null, and hold split Antigravity
// tier gauges (AGY 4 / AGY 3.8) across brief transient omissions so they do not flicker.
export function mergeWithPrevious(previousGauges = [], nextGauges = [], missingCounts = {}) {
  const prevById = new Map((Array.isArray(previousGauges) ? previousGauges : []).map(g => [g.id, g]));
  const merged = (Array.isArray(nextGauges) ? nextGauges : []).map(next => {
    delete missingCounts[next.id];
    const prev = prevById.get(next.id);
    if (!prev) return next;
    const out = { ...next };
    if (!isFiniteNumber(out.remainingPercent) && isFiniteNumber(prev.remainingPercent)) {
      out.remainingPercent = prev.remainingPercent;
      out.rows = prev.rows;
      if (!out.updatedAt && prev.updatedAt) out.updatedAt = prev.updatedAt;
    }
    if ('innerRemainingPercent' in out && !isFiniteNumber(out.innerRemainingPercent) && isFiniteNumber(prev.innerRemainingPercent)) {
      out.innerRemainingPercent = prev.innerRemainingPercent;
      out.innerRows = prev.innerRows;
      out.updatedAt = Math.max(out.updatedAt ?? 0, prev.updatedAt ?? 0) || null;
    }
    return out;
  });
  const nextIds = new Set(merged.map(g => g.id));
  const unifiedOnly = nextIds.has('antigravity') && !STICKY_TIER_IDS.some(id => nextIds.has(id));
  for (const id of STICKY_TIER_IDS) {
    if (nextIds.has(id) || unifiedOnly) {
      delete missingCounts[id];
      continue;
    }
    const prev = prevById.get(id);
    if (!prev) {
      delete missingCounts[id];
      continue;
    }
    const misses = (missingCounts[id] || 0) + 1;
    if (misses < TIER_MISS_LIMIT) {
      missingCounts[id] = misses;
      merged.push(prev);
    } else {
      delete missingCounts[id];
    }
  }
  merged.sort((a, b) => (GAUGE_ORDER[a.id] ?? 99) - (GAUGE_ORDER[b.id] ?? 99));
  return merged;
}
