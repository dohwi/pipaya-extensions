// Pure snapshot -> navbar conversion. Also bundled into the sandbox worker.
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
    throw new Error(snapshot?.configured === false ? 'quota-monitor 설정을 확인하세요' : '첫 쿼터 수집을 기다리는 중');
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
    const hint = [remaining === null ? '잔량 미확인' : '', stale ? '이전 관측값' : ''].filter(Boolean).join(' · ');
    return { remaining, stale, updatedAt, hint, rows: [{ label: '잔량', value: remaining }] };
  };
  const gauge = (id, label, brand, group, key = id) => {
    const summary = fleetSummary(key, group);
    return { id, label, brand, remainingPercent: summary.remaining, hint: summary.hint, updatedAt: summary.updatedAt, rows: summary.rows, stale: snapshot.stale === true || summary.stale };
  };
  const ag = byProvider('antigravity');
  const gemini = byProvider('gemini');
  // Fixed order: Claude, GPT, (native Gemini only when present), Antigravity.
  const gauges = [gauge('claude', 'Claude', 'claude', byProvider('claude')), gauge('gpt', 'GPT', 'gpt', byProvider('gpt'), 'codex')];
  if (gemini.length) gauges.push(gauge('gemini', 'Gemini', 'gemini', gemini));
  const outer = gauge('antigravity', 'Antigravity', 'antigravity', ag, 'antigravity_gemini');
  const inner = fleetSummary('antigravity_claude', ag);
  outer.innerRemainingPercent = inner.remaining;
  outer.innerRows = inner.rows;
  outer.stale ||= inner.stale;
  outer.updatedAt = Math.max(outer.updatedAt ?? 0, inner.updatedAt ?? 0) || null;
  outer.hint = [outer.hint ? `Gemini: ${outer.hint}` : '', inner.hint ? `Claude/GPT: ${inner.hint}` : ''].filter(Boolean).join(' · ');
  gauges.push(outer);
  return { label: 'AI 쿼터 잔량', gauges };
}

export function pollDelay(snapshot, settings = {}) {
  if (snapshot?.snapshot_complete === false || snapshot?.collection_in_progress === true) return 2000;
  const seconds = Number(settings.pollSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(900000, Math.max(10000, seconds * 1000));
  const hint = snapshot?.next_poll_hint_ms;
  return typeof hint === 'number' && Number.isFinite(hint) && hint > 0
    ? Math.min(900000, Math.max(10000, hint)) : 60000;
}
