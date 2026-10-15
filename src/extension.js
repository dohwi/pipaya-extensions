// Async SDK function body; model.mjs is prepended by scripts/build.mjs.
const initialSettings = await sdk.settings.get();
setLanguage(initialSettings?.language);
const itemId = 'usage';
// Quota data is served only on the authenticated management route (/v0/resource is unauthenticated
// and carries no data). The host adds `Authorization: Bearer <httpToken>` from this extension's own
// settings; the extension never sees the token on the wire and cannot choose another origin/header.
const QUOTA_PATH = '/v0/management/plugins/quota-monitor/data/accounts';
// CLIProxyAPI bans an IP for 30 minutes after five rejected management requests, so a missing or
// rejected key is never retried: requests resume only once the stored key itself changes.
let rejectedKey = null;
const keyOf = value => (typeof value?.httpToken === 'string' ? value.httpToken.trim() : '');
let settings = initialSettings;
let model = {
  label: t('title'),
  gauges: [
    { id: 'claude', label: 'Claude', brand: 'claude', remainingPercent: null },
    { id: 'gpt', label: 'GPT', brand: 'gpt', remainingPercent: null },
    { id: 'antigravity', label: 'Antigravity', brand: 'antigravity', remainingPercent: null }
  ]
};
let pending = null;
let timer;
let lastAttempt = 0;
let failures = 0;
let followUp = false;

function render(error) {
  return sdk.navbar.set(itemId, { label: t('itemLabel'), view: navbarView(model, error) });
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => { void refresh(); }, delay);
}

function refresh() {
  if (pending) return pending;
  // Run-finished events and timers cannot create a request burst.
  if (Date.now() - lastAttempt < 2000) {
    schedule(2000);
    return Promise.resolve();
  }
  lastAttempt = Date.now();
  pending = (async () => {
    let delay = 60000;
    try {
      // Re-read the (local, free) settings so a corrected key or interval applies without a reload.
      settings = await sdk.settings.get();
      setLanguage(settings?.language);
      const key = keyOf(settings);
      if (!key) throw Object.assign(new Error(t('needKey')), { authBlocked: true });
      if (key === rejectedKey) throw Object.assign(new Error(t('badKey')), { authBlocked: true });
      const response = await sdk.http.requestJson({ path: QUOTA_PATH });
      if (response.status === 401 || response.status === 403) {
        rejectedKey = key;
        throw Object.assign(new Error(t('badKey')), { authBlocked: true });
      }
      if (response.status < 200 || response.status >= 300) throw new Error(t('serverError', { status: response.status }));
      const snapshot = response.body;
      delay = pollDelay(snapshot, settings);
      model = { ...navbarFromSnapshot(snapshot), fetchedAt: Date.now() };
      await render();
      failures = 0;
    } catch (error) {
      failures += 1;
      const text = String(error?.message || t('cannotRead')).slice(0, 200);
      model = { ...model, gauges: model.gauges.map(gauge => ({ ...gauge, stale: true })) };
      await render(text);
      // Keep last-good values. Never turn failed, unconfigured or missing data into 0%.
      // Auth problems cost nothing locally, so re-check the settings every 15 s; never hit the server.
      delay = error?.authBlocked ? 15000 : error?.code === 'waiting' ? 2000 : Math.min(300000, 10000 * 2 ** Math.min(failures - 1, 5));
    } finally {
      pending = null;
      schedule(followUp ? Math.min(delay, 2500) : delay);
      followUp = false;
    }
  })().catch(() => { /* Host teardown stops the worker and all timers. */ });
  return pending;
}

await render();
await sdk.events.on(event => {
  if (event.type === 'run_finished') {
    if (pending) followUp = true;
    else schedule(2500);
  }
});
// Do not wait for the network during the host's 5-second extension startup deadline.
void refresh();
