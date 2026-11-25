// What the worker hands to components/Gauge.svelte (plain data); the component draws it in the app.
// Rings and popovers show only the upstream overall remaining quota.
import { LOGOS, COLORS } from './logos.mjs';
import { t } from './i18n.mjs';

// Low remaining overrides the brand color so a nearly exhausted limit stands out.
function tone(value, color) {
  if (value === null || value === undefined) return color;
  return value <= 5 ? 'danger' : value <= 20 ? 'warn' : color;
}

function rows(list, color, group) {
  return (list || []).map((row, index) => {
    const isGroupHead = Boolean(group && index === 0 && !row.sub);
    const label = isGroupHead
      ? (row.tier ? `${group} · ${row.tier}` : group)
      : row.label;
    const out = { label, value: row.value, color: tone(row.value, color) };
    if (group) out.group = group;
    if (isGroupHead || row.summary) out.summary = true;
    if (row.sub) out.sub = true;
    return out;
  });
}

export function gaugeData(gauge, error, fetchedAt = null) {
  const isAntigravity = gauge.brand === 'antigravity' || gauge.brand === 'antigravity_full' || gauge.brand === 'antigravity_lite' || gauge.brand === 'antigravity_4' || gauge.brand === 'antigravity_3_8';
  const outerColor = gauge.brand === 'antigravity' ? COLORS.gemini : COLORS[gauge.brand];
  const ring = (value, color, label) => ({ value, color: tone(value, color), label });
  const isPrimaryAg = gauge.brand === 'antigravity' || gauge.brand === 'antigravity_full';
  const outerRingLabel = isPrimaryAg
    ? t('remainingOf', { name: 'Gemini' })
    : t('remainingOf', { name: `${gauge.label} · Gemini` });
  const innerRingLabel = isPrimaryAg
    ? t('remainingOf', { name: 'Claude via Antigravity' })
    : t('remainingOf', { name: `${gauge.label} · Claude/GPT` });
  const rings = isAntigravity
    ? [
        ring(gauge.remainingPercent, outerColor, outerRingLabel),
        ring(gauge.innerRemainingPercent ?? null, COLORS.claude, innerRingLabel)
      ]
    : [ring(gauge.remainingPercent, COLORS[gauge.brand], t('remainingOf', { name: gauge.label }))];
  let detailRows = isAntigravity
    ? [...rows(gauge.rows, outerColor, 'Gemini'), ...rows(gauge.innerRows, COLORS.claude, 'Claude/GPT')]
    : rows(gauge.rows, COLORS[gauge.brand]);
  if (!detailRows.length) detailRows = [{ label: t('noQuotaInfo'), value: null }];
  const title = t('remainingOf', { name: gauge.label });
  const node = {
    id: gauge.id, label: gauge.label, rings,
    icon: LOGOS[gauge.brand],
    hint: [gauge.hint, error].filter(Boolean).join(' · ').slice(0, 500),
    details: { title: title.slice(0, 40), rows: detailRows.slice(0, 20) }
  };
  // The monitor's own observation time wins; otherwise the last successful read. A failed read never advances either.
  const updatedAt = Number.isFinite(gauge.updatedAt) && gauge.updatedAt > 0 ? gauge.updatedAt : fetchedAt;
  if (Number.isFinite(updatedAt) && updatedAt > 0) node.details.updatedAt = Math.round(updatedAt);
  // Show the last known value cleanly without a warning badge; flag stale only when no value is known.
  const hasValue = rings.some(r => typeof r.value === 'number' && Number.isFinite(r.value));
  if (!hasValue && (gauge.stale || error || fetchedAt !== null)) node.stale = true;
  return node;
}

export function gaugesData(model, error) {
  return model.gauges.map(gauge => gaugeData(gauge, error, model.fetchedAt));
}

// Text the component needs, already in the extension's language (the component never translates).
export function strings() {
  return Object.fromEntries(['unknown', 'stale', 'updated', 'sec', 'min', 'hour', 'day'].map(key => [key, t(key)]));
}
