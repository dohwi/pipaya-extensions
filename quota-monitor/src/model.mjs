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
  const validCount = value => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);
  const extractAgPoolTag = label => {
    const s = String(label || '').trim();
    const m = /^AGY\s*\((.+)\)\s*·/.exec(s) || /^AGY\s*\((.+)\)$/.exec(s);
    return m?.[1]?.trim() || '';
  };
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
      tiers.push(label);
      if (tiers.length >= 8) break;
    }
    const singleTier = tiers.length === 1 ? tiers[0] : null;
    if (entryShort !== null || entryWeekly !== null) {
      const windowRows = [];
      if (entryShort !== null) windowRows.push({ label: t('shortWindow'), value: entryShort, window: 'short' });
      if (entryWeekly !== null) windowRows.push({ label: t('weeklyWindow'), value: entryWeekly, window: 'weekly' });
      if (singleTier && windowRows.length) windowRows[0].tier = singleTier;
      return { rows: windowRows, tiers, singleTier };
    }
    if (remaining === null || tiers.length === 0) return { rows: [{ label: t('remaining'), value: remaining }], tiers: [], singleTier: null };
    if (singleTier) return { rows: [{ label: singleTier, value: remaining, tier: singleTier }], tiers, singleTier: null };
    return { rows: [{ label: t('overall'), value: remaining, summary: true }], tiers, singleTier: null };
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
    const accountsCount = validCount(entry?.accounts);
    const entryLabel = typeof entry?.label === 'string' ? entry.label : '';
    return { remaining, short, weekly, stale, updatedAt, hint, rows, tiers, singleTier, accounts: accountsCount, entryLabel };
  };
  const gauge = (id, label, brand, group, key = id, restricted = false) => {
    const summary = fleetSummary(key, group, restricted);
    const out = { id, label, brand, remainingPercent: summary.remaining, hint: summary.hint, updatedAt: summary.updatedAt, rows: summary.rows, tiers: summary.tiers, entryLabel: summary.entryLabel, stale: snapshot.stale === true || summary.stale };
    if (summary.short !== null) out.shortPercent = summary.short;
    if (summary.weekly !== null) out.weeklyPercent = summary.weekly;
    if (summary.singleTier) out.singleTier = summary.singleTier;
    if (summary.accounts !== null) out.accounts = summary.accounts;
    return out;
  };
  const ag = byProvider('antigravity');
  const gemini = byProvider('gemini');
  const claude = byProvider('claude');
  const gpt = byProvider('gpt');
  const stripTiers = item => { const { tiers, entryLabel, ...rest } = item; return rest; };
  const gauges = [];

  // Dynamic model-set pools: when the server splits Claude or Codex because
  // accounts expose different model catalogs (e.g. Pro 200 vs Pro 100), emit
  // one tile per pool in server order; when catalogs align, stay unified.
  const claudePools = availability.filter(item => item?.key === 'claude' || /^claude_pool_[a-z0-9]+$/.test(String(item?.key || '')));
  if (claudePools.length >= 2) {
    claudePools.forEach((entry, index) => {
      gauges.push(stripTiers(gauge(index === 0 ? 'claude' : entry.key, entry.label || 'Claude', 'claude', claude, entry.key)));
    });
  } else {
    gauges.push(stripTiers(gauge('claude', claudePools[0]?.label || 'Claude', 'claude', claude)));
  }

  const codexPools = availability.filter(item => item?.key === 'codex' || /^codex_pool_[a-z0-9]+$/.test(String(item?.key || '')));
  if (gpt.length) {
    if (codexPools.length >= 2) {
      codexPools.forEach((entry, index) => {
        gauges.push(stripTiers(gauge(index === 0 ? 'gpt' : entry.key, entry.label || 'GPT', 'gpt', gpt, entry.key)));
      });
    } else {
      gauges.push(stripTiers(gauge('gpt', codexPools[0]?.label || 'GPT', 'gpt', gpt, 'codex')));
    }
  }

  if (gemini.length) gauges.push(stripTiers(gauge('gemini', 'Gemini', 'gemini', gemini)));
  const antigravityGauge = (id, label, brand, group, geminiKey, claudeKey, { restricted = false, deriveLabel = false } = {}) => {
    const outer = gauge(id, label, brand, group, geminiKey, restricted);
    delete outer.singleTier;
    const inner = fleetSummary(claudeKey, group, restricted);
    const outerAccounts = outer.accounts ?? null;
    const innerAccounts = inner.accounts;
    if (outerAccounts !== null || innerAccounts !== null) {
      outer.accounts = Math.max(outerAccounts ?? 0, innerAccounts ?? 0);
      if (outerAccounts !== null) outer.outerAccounts = outerAccounts;
      if (innerAccounts !== null) outer.innerAccounts = innerAccounts;
    }
    outer.innerRemainingPercent = inner.remaining;
    if (inner.short !== null) outer.innerShortPercent = inner.short;
    if (inner.weekly !== null) outer.innerWeeklyPercent = inner.weekly;
    outer.innerRows = inner.rows;
    outer.stale ||= inner.stale;
    outer.updatedAt = Math.max(outer.updatedAt ?? 0, inner.updatedAt ?? 0) || null;
    outer.hint = [outer.hint ? `Gemini: ${outer.hint}` : '', inner.hint ? `Claude/GPT: ${inner.hint}` : ''].filter(Boolean).join(' · ');
    if (deriveLabel) {
      const explicitTag = extractAgPoolTag(outer.entryLabel) || extractAgPoolTag(inner.entryLabel);
      const uniqueTiers = [...new Set([...outer.tiers, ...inner.tiers])];
      if (explicitTag) {
        const normalizedTag = restricted && explicitTag === 'AI Pro' ? 'AI Pro Trial' : explicitTag;
        outer.label = `Antigravity · ${normalizedTag}`;
        if (uniqueTiers.length === 1) {
          outer.rows = outer.rows.map(({ tier, ...row }) => row);
          outer.innerRows = outer.innerRows.map(({ tier, ...row }) => row);
        }
      } else if (uniqueTiers.length === 1) {
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
  const dynamicAgPools = [];
  const seenAgPools = new Set();
  for (const item of availability) {
    const m = /^(antigravity_pool_[a-z0-9]+)_(gemini|claude)$/.exec(String(item?.key || ''));
    if (m && !seenAgPools.has(m[1])) {
      seenAgPools.add(m[1]);
      const tag = extractAgPoolTag(item?.label);
      const poolLabel = tag ? `Antigravity · ${tag}` : 'Antigravity';
      dynamicAgPools.push({ id: m[1], label: poolLabel });
    }
  }
  // Server v0.8.1+ auto-splits Antigravity into full (antigravity_gemini/claude), optional
  // dynamic extra pools (antigravity_pool_*_gemini/claude), and lite (antigravity_lite_gemini/claude)
  // when accounts have different model pools, and unifies when all share one pool.
  const has4 = hasKey('antigravity_4_gemini') || hasKey('antigravity_4_claude');
  const has38 = hasKey('antigravity_3_8_gemini') || hasKey('antigravity_3_8_claude');
  const hasUnified = hasKey('antigravity_gemini') || hasKey('antigravity_claude');
  const hasLite = hasKey('antigravity_lite_gemini') || hasKey('antigravity_lite_claude');
  if (has4 || has38) {
    if (has4) gauges.push(antigravityGauge('antigravity_4', 'AGY (4)', 'antigravity_4', ag4, 'antigravity_4_gemini', 'antigravity_4_claude'));
    if (has38) gauges.push(antigravityGauge('antigravity_3_8', 'AGY (3.8)', 'antigravity_3_8', ag38, 'antigravity_3_8_gemini', 'antigravity_3_8_claude'));
    if (hasUnified) gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity', agLegacy.length ? agLegacy : ag, 'antigravity_gemini', 'antigravity_claude', { deriveLabel: true }));
    for (const pool of dynamicAgPools) {
      gauges.push(antigravityGauge(pool.id, pool.label, 'antigravity_full', agFull.length ? agFull : ag, `${pool.id}_gemini`, `${pool.id}_claude`, { deriveLabel: true }));
    }
    if (hasLite) gauges.push(antigravityGauge('antigravity_lite', 'Antigravity · Trial/Free', 'antigravity_lite', agLite.length ? agLite : ag, 'antigravity_lite_gemini', 'antigravity_lite_claude', { restricted: true, deriveLabel: true }));
  } else if (hasLite || dynamicAgPools.length > 0) {
    if (hasUnified) gauges.push(antigravityGauge('antigravity', 'Antigravity', 'antigravity_full', agFull.length ? agFull : ag, 'antigravity_gemini', 'antigravity_claude', { deriveLabel: true }));
    for (const pool of dynamicAgPools) {
      gauges.push(antigravityGauge(pool.id, pool.label, 'antigravity_full', agFull.length ? agFull : ag, `${pool.id}_gemini`, `${pool.id}_claude`, { deriveLabel: true }));
    }
    if (hasLite) gauges.push(antigravityGauge('antigravity_lite', 'Antigravity · Trial/Free', 'antigravity_lite', agLite.length ? agLite : ag, 'antigravity_lite_gemini', 'antigravity_lite_claude', { restricted: true, deriveLabel: true }));
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
const isStickySplitAgId = id => STICKY_TIER_IDS.includes(id) || id === 'antigravity_lite' || String(id).startsWith('antigravity_pool_');
const TIER_MISS_LIMIT = 3;
const GAUGE_ORDER = { claude: 0, gpt: 1, gemini: 2, antigravity_4: 3, antigravity_3_8: 4, antigravity: 5, antigravity_lite: 7 };
const gaugeOrder = id => {
  if (id in GAUGE_ORDER) return GAUGE_ORDER[id];
  if (String(id).startsWith('claude_pool_')) return 0;
  if (String(id).startsWith('codex_pool_')) return 1;
  if (String(id).startsWith('antigravity_pool_')) return 6;
  return 99;
};

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
      if (!out.accounts && prev.accounts) out.accounts = prev.accounts;
      if (!out.outerAccounts && prev.outerAccounts) out.outerAccounts = prev.outerAccounts;
      if (!out.updatedAt && prev.updatedAt) out.updatedAt = prev.updatedAt;
    }
    const hasInner = isFiniteNumber(out.innerRemainingPercent) || isFiniteNumber(out.innerShortPercent) || isFiniteNumber(out.innerWeeklyPercent);
    const prevInner = isFiniteNumber(prev.innerRemainingPercent) || isFiniteNumber(prev.innerShortPercent) || isFiniteNumber(prev.innerWeeklyPercent);
    if ('innerRemainingPercent' in out && !hasInner && prevInner) {
      out.innerRemainingPercent = prev.innerRemainingPercent;
      if (isFiniteNumber(prev.innerShortPercent)) out.innerShortPercent = prev.innerShortPercent;
      if (isFiniteNumber(prev.innerWeeklyPercent)) out.innerWeeklyPercent = prev.innerWeeklyPercent;
      out.innerRows = prev.innerRows;
      if (!out.innerAccounts && prev.innerAccounts) out.innerAccounts = prev.innerAccounts;
      if (!out.accounts && prev.accounts) out.accounts = prev.accounts;
      out.updatedAt = Math.max(out.updatedAt ?? 0, prev.updatedAt ?? 0) || null;
    }
    return out;
  });
  const nextIds = new Set(merged.map(g => g.id));
  const hasSplitAgInNext = [...nextIds].some(isStickySplitAgId);
  const unifiedOnly = nextIds.has('antigravity') && !hasSplitAgInNext;
  const stickyIds = new Set([...STICKY_TIER_IDS, ...[...prevById.keys()].filter(isStickySplitAgId)]);
  for (const id of stickyIds) {
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
  merged.sort((a, b) => gaugeOrder(a.id) - gaugeOrder(b.id));
  return merged;
}
