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
  return (list || []).map(row => {
    const out = { label: row.label, value: row.value, color: tone(row.value, color) };
    if (group) out.group = group;
    return out;
  });
}

export function gaugeData(gauge, error, fetchedAt = null) {
  const antigravity = gauge.brand === 'antigravity';
  const ring = (value, color, label) => ({ value, color: tone(value, color), label });
  const rings = antigravity
    ? [
        ring(gauge.remainingPercent, COLORS.gemini, t('remainingOf', { name: 'Gemini' })),
        ring(gauge.innerRemainingPercent ?? null, COLORS.claude, t('remainingOf', { name: 'Claude via Antigravity' }))
      ]
    : [ring(gauge.remainingPercent, COLORS[gauge.brand], t('remainingOf', { name: gauge.label }))];
  let detailRows = antigravity
    ? [...rows(gauge.rows, COLORS.gemini, 'Gemini'), ...rows(gauge.innerRows, COLORS.claude, 'Claude/GPT')]
    : rows(gauge.rows, COLORS[gauge.brand]);
  if (!detailRows.length) detailRows = [{ label: t('noQuotaInfo'), value: null }];
  const title = t('remainingOf', { name: gauge.label });
  const node = {
    id: gauge.id, label: gauge.label, rings,
    icon: LOGOS[gauge.brand],
    hint: [gauge.hint, error].filter(Boolean).join(' · ').slice(0, 500),
    details: { title: title.slice(0, 40), rows: detailRows.slice(0, 12) }
  };
  // The monitor's own observation time wins; otherwise the last successful read. A failed read never advances either.
  const updatedAt = Number.isFinite(gauge.updatedAt) && gauge.updatedAt > 0 ? gauge.updatedAt : fetchedAt;
  if (Number.isFinite(updatedAt) && updatedAt > 0) node.details.updatedAt = Math.round(updatedAt);
  if (gauge.stale || error) node.stale = true;
  return node;
}

export function gaugesData(model, error) {
  return model.gauges.map(gauge => gaugeData(gauge, error, model.fetchedAt));
}

// Text the component needs, already in the extension's language (the component never translates).
export function strings() {
  return Object.fromEntries(['unknown', 'stale', 'updated', 'sec', 'min', 'hour', 'day'].map(key => [key, t(key)]));
}
