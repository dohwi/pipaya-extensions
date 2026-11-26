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
  const value = String(raw || '').toLowerCase().trim();
  return value === 'full' || value === 'lite' || value === '4' || value === '3.8' ? value : '';
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
  const tierLabelOf = (item, restricted) => {
    const tier = String(item?.tier ?? '').toLowerCase().trim();
    const raw = String(item?.label ?? item?.tier ?? '').trim().slice(0, 32);
    // Google Antigravity Docs distinguish Paid Google AI Pro (full frontier models) from
    // Google AI Pro trial (limited model set, alongside Free / Google AI Plus).
    if (restricted && tier === 'pro' && (!raw || raw === 'AI Pro')) return 'AI Pro Trial';
    return raw;
  };
  const tierRows = (entry, remaining, restricted = false) => {
    const entryShort = validPercent(entry?.short_remaining_percent);
    const entryWeekly = validPercent(entry?.weekly_remaining_percent);
    const rawTiers = Array.isArray(entry?.tiers) ? entry.tiers : [];
    const tiers = [];
    for (const item of rawTiers) {
      if (!item || typeof item !== 'object') continue;
      const value = validPercent(item.remaining_percent);
      const label = tierLabelOf(item, restricted);
      if (value === null || !label) continue;
      tiers.push({
        label,
        value,
        short: validPercent(item.short_remaining_percent),
        weekly: validPercent(item.weekly_remaining_percent)
      });
      if (tiers.length >= 8) break;
    }
    const hasWindow = entryShort !== null || entryWeekly !== null;
    if (hasWindow) {
      const hasDual = entryShort !== null && entryWeekly !== null;
      const windowRows = [];
      if (entryShort !== null) windowRows.push({ label: t('shortWindow'), value: entryShort, window: 'short' });
      if (entryWeekly !== null) windowRows.push({ label: t('weeklyWindow'), value: entryWeekly, window: 'weekly' });
      if (tiers.length === 1 && windowRows.length) windowRows[0].tier = tiers[0].label;
      if (tiers.length >= 2) {
        return {
          rows: [
            ...windowRows,
            ...tiers.map(item => (hasDual
              ? { label: item.label, value: item.value, short: item.short, weekly: item.weekly, sub: true }
              : { label: item.label, value: entryShort !== null ? (item.short ?? item.value) : (item.weekly ?? item.value), sub: true }))
          ],
          tiers: tiers.map(item => item.label),
          singleTier: null
        };
      }
      return {
        rows: windowRows,
        tiers: tiers.length === 1 ? [tiers[0].label] : [],
        singleTier: tiers.length === 1 ? tiers[0].label : null
      };
    }
    if (remaining === null || tiers.length === 0) return { rows: [{ label: t('remaining'), value: remaining }], tiers: [], singleTier: null };
    if (tiers.length === 1) return { rows: [{ label: tiers[0].label, value: remaining, tier: tiers[0].label }], tiers: [tiers[0].label], singleTier: null };
    return {
      rows: [{ label: t('overall'), value: remaining, summary: true }, ...tiers.map(item => ({ label: item.label, value: item.value, sub: true }))],
      tiers: tiers.map(item => item.label),
      singleTier: null
    };
  };
  const fleetSummary = (key, group, restricted = false) => {
    const entry = availability.find(item => item?.key === key);
    // The server owns fleet aggregation. Missing values never fall back to account windows.
    const remaining = validPercent(entry?.remaining_percent);
    const short = validPercent(entry?.short_remaining_percent);
    const weekly = validPercent(entry?.weekly_remaining_percent);
    const usable = group.filter(account => account.operational?.disabled !== true && account.status !== 'disabled' && account.operational?.status !== 'disabled');
    const isStale = account => account.stale === true || account.status === 'error' || account.status === 'stale';
    // One broken account is not worth a warning while another one still reports; flag only when every usable account is stale.
    const stale = usable.length > 0 && usable.every(isStale);
    const times = usable.map(observedAt).filter(time => time !== null);
    const updatedAt = times.length ? Math.max(...times) : null;
    const known = short !== null || weekly !== null || remaining !== null;
    const hint = [!known ? t('unknownRemaining') : '', stale ? t('staleObservation') : ''].filter(Boolean).join(' · ');
    const { rows, tiers, singleTier } = tierRows(entry, remaining, restricted);
    return { remaining, short, weekly, stale, updatedAt, hint, rows, tiers, singleTier };
  };
  const gauge = (id, label, brand, group, key = id, restricted = false) => {
    const summary = fleetSummary(key, group, restricted);
    const out = { id, label, brand, remainingPercent: summary.remaining, hint: summary.hint, updatedAt: summary.updatedAt, rows: summary.rows, tiers: summary.tiers, stale: snapshot.stale === true || summary.stale };
    if (summary.short !== null) out.shortPercent = summary.short;
    if (summary.weekly !== null) out.weeklyPercent = summary.weekly;
    if (summary.singleTier) out.singleTier = summary.singleTier;
    return out;
  };
  const ag = byProvider('antigravity');
  const gemini = byProvider('gemini');
  // Fixed order: Claude, (GPT only when a GPT account exists), (native Gemini only when present), Antigravity units.
  const gpt = byProvider('gpt');
  const stripTiers = item => { const { tiers, ...rest } = item; return rest; };
  const gauges = [stripTiers(gauge('claude', 'Claude', 'claude', byProvider('claude')))];
  if (gpt.length) gauges.push(stripTiers(gauge('gpt', 'GPT', 'gpt', gpt, 'codex')));
  if (gemini.length) gauges.push(stripTiers(gauge('gemini', 'Gemini', 'gemini', gemini)));
  const antigravityGauge = (id, label, brand, group, geminiKey, claudeKey, { restricted = false, deriveLabel = false } = {}) => {
    const outer = gauge(id, label, brand, group, geminiKey, restricted);
    delete outer.singleTier;
    const inner = fleetSummary(claudeKey, group, restricted);
    outer.innerRemainingPercent = inner.remaining;
    if (inner.short !== null) outer.innerShortPercent = inner.short;
    if (inner.weekly !== null) outer.innerWeeklyPercent = inner.weekly;
    outer.innerRows = inner.rows;
    outer.stale ||= inner.stale;
    outer.updatedAt = Math.max(outer.updatedAt ?? 0, inner.updatedAt ?? 0) || null;
    outer.hint = [outer.hint ? `Gemini: ${outer.hint}` : '', inner.hint ? `Claude/GPT: ${inner.hint}` : ''].filter(Boolean).join(' · ');
    if (deriveLabel) {
      const uniqueTiers = [...new Set([...outer.tiers, ...inner.tiers])];
      if (uniqueTiers.length === 1) {
        outer.label = `Antigravity · ${uniqueTiers[0]}`;
        // Plan name is now in the title, so avoid repeating "Gemini · <plan>" on every row.
        outer.rows = outer.rows.map(({ tier, ...row }) => row);
        outer.innerRows = outer.innerRows.map(({ tier, ...row }) => row);
      }
    }
    return stripTiers(outer);
  };
  const ag4 = ag.filter(account => normalizeModelTier(account.model_tier) === '4');
  const ag38 = ag.filter(account => normalizeModelTier(account.model_tier) === '3.8');
  const agLite = ag.filter(account => normalizeModelTier(account.model_tier) === 'lite');
  const agFull = ag.filter(account => normalizeModelTier(account.model_tier) !== 'lite');
  const agLegacy = ag.filter(account => normalizeModelTier(account.model_tier) === '');
  const hasKey = key => availability.some(item => item?.key === key);
  // Server v0.8.1+ auto-splits Antigravity into full (antigravity_gemini/claude) and lite (antigravity_lite_gemini/claude)
  // when accounts have different model pools, and unifies into antigravity_gemini/claude when all share one pool.
  // Split gauges strictly follow the server's availability keys, never account.model_tier alone.
  const has4 = hasKey('antigravity_4_gemini') || hasKey('antigravity_4_claude');
  const has38 = hasKey('antigravity_3_8_gemini') || hasKey('antigravity_3_8_claude');
  const hasUnified = hasKey('antigravity_gemini') || hasKey('antigravity_claude');
  const hasLite = hasKey('antigravity_lite_gemini') || hasKey('antigravity_lite_claude');
  if (has4 || has38) {
    if (has4) gauges.push(antigravityGauge('antigravity_4', 'AGY (4)', 'antigravity_4', ag4, 'antigravity_4_gemini', 'antigravity_4_claude'));
    if (has38) gauges.push(antigravityGauge('antigravity_3_8', 'AGY (3.8)', 'antigravity_3_8', ag38, 'antigravity_3_8_gemini', 'antigravity_3_8_claude'));
    if (hasUnified) gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity', agLegacy.length ? agLegacy : ag, 'antigravity_gemini', 'antigravity_claude', { deriveLabel: true }));
    if (hasLite) gauges.push(antigravityGauge('antigravity_lite', 'Antigravity · Trial/Free', 'antigravity_lite', agLite.length ? agLite : ag, 'antigravity_lite_gemini', 'antigravity_lite_claude', { restricted: true, deriveLabel: true }));
  } else if (hasLite) {
    if (hasUnified) gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity_full', agFull.length ? agFull : ag, 'antigravity_gemini', 'antigravity_claude', { deriveLabel: true }));
    gauges.push(antigravityGauge('antigravity_lite', 'Antigravity · Trial/Free', 'antigravity_lite', agLite.length ? agLite : ag, 'antigravity_lite_gemini', 'antigravity_lite_claude', { restricted: true, deriveLabel: true }));
  } else {
    gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity', ag, 'antigravity_gemini', 'antigravity_claude', { deriveLabel: true }));
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
const GAUGE_ORDER = { claude: 0, gpt: 1, gemini: 2, antigravity_4: 3, antigravity_3_8: 4, antigravity: 5, antigravity_lite: 6 };

// Keep the last known reading when a later snapshot returns null, and hold split Antigravity
// tier gauges (AGY 4 / AGY 3.8) across brief transient omissions so they do not flicker.
export function mergeWithPrevious(previousGauges = [], nextGauges = [], missingCounts = {}) {
  const prevById = new Map((Array.isArray(previousGauges) ? previousGauges : []).map(g => [g.id, g]));
  const merged = (Array.isArray(nextGauges) ? nextGauges : []).map(next => {
    delete missingCounts[next.id];
    const prev = prevById.get(next.id);
    if (!prev) return next;
    const out = { ...next };
    const hasOuter = isFiniteNumber(out.remainingPercent) || isFiniteNumber(out.shortPercent) || isFiniteNumber(out.weeklyPercent);
    const prevOuter = isFiniteNumber(prev.remainingPercent) || isFiniteNumber(prev.shortPercent) || isFiniteNumber(prev.weeklyPercent);
    if (!hasOuter && prevOuter) {
      out.remainingPercent = prev.remainingPercent;
      if (isFiniteNumber(prev.shortPercent)) out.shortPercent = prev.shortPercent;
      if (isFiniteNumber(prev.weeklyPercent)) out.weeklyPercent = prev.weeklyPercent;
      out.rows = prev.rows;
      if (!out.updatedAt && prev.updatedAt) out.updatedAt = prev.updatedAt;
    }
    const hasInner = isFiniteNumber(out.innerRemainingPercent) || isFiniteNumber(out.innerShortPercent) || isFiniteNumber(out.innerWeeklyPercent);
    const prevInner = isFiniteNumber(prev.innerRemainingPercent) || isFiniteNumber(prev.innerShortPercent) || isFiniteNumber(prev.innerWeeklyPercent);
    if ('innerRemainingPercent' in out && !hasInner && prevInner) {
      out.innerRemainingPercent = prev.innerRemainingPercent;
      if (isFiniteNumber(prev.innerShortPercent)) out.innerShortPercent = prev.innerShortPercent;
      if (isFiniteNumber(prev.innerWeeklyPercent)) out.innerWeeklyPercent = prev.innerWeeklyPercent;
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
