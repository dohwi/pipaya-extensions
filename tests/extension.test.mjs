import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const gauges = item => item.view.children;
const ring = (item, index, ringIndex = 0) => item.view.children[index].rings[ringIndex].value;

const pkg = JSON.parse(await readFile(new URL('../dist/quota-monitor.json', import.meta.url), 'utf8'));

async function boot(read, settings = { httpToken: 'test-key' }) {
  const calls = [], scheduled = [], handlers = {}, requests = [];
  const sdk = {
    settings: { get: async () => settings },
    navbar: { set: async (id, item) => calls.push(JSON.parse(JSON.stringify(item))) },
    http: { requestJson: async request => { requests.push(request); return { status: 200, body: await read(request) }; } },
    events: { on: async handler => { handlers.event = handler; } }
  };
  const context = vm.createContext({ sdk, console, Date, setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, clearTimeout() {} });
  await vm.runInContext(`(async () => { ${pkg.code}\n })()`, context);
  // Drain the async SDK-only chain without waiting for a fake clock timer.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { calls, scheduled, handlers, requests };
}

test('built import package requests only the narrowly scoped permissions', () => {
  assert.deepEqual(pkg.manifest.permissions, ['navbar', 'http-write', 'events']);
  assert.equal(pkg.manifest.sdkVersion, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(pkg)) < 256 * 1024);
  assert.ok(!/sdk\.commands|sdk\.notifications/.test(pkg.code), 'no slash command is registered');
  assert.ok(!/fetch\(|localStorage|document\.|importScripts|sdk\.quota/.test(pkg.code));
});

test('startup paints unknown immediately, then renders quota and schedules read-only poll', async () => {
  const run = await boot(async () => ({ configured: true, snapshot_complete: true, next_poll_hint_ms: 120000,
    availability: [{ key: 'codex', remaining_percent: 83, accounts: 1 }],
    accounts: [{ provider: 'codex', windows: [{ name: 'primary', used_percent: 97 }] }] }));
  assert.equal(ring(run.calls[0], 1), null);
  assert.equal(ring(run.calls.at(-1), 1), 83, 'GPT ring uses upstream availability, not raw account quota');
  assert.equal(run.scheduled.at(-1).ms, 120000);
  await run.handlers.event({ type: 'run_finished' });
  assert.equal(run.scheduled.at(-1).ms, 2500);
});

test('failure is visible, remains unmeasured and backs off', async () => {
  const run = await boot(async () => { throw new Error('쿼터 스냅샷 조회 실패'); });
  assert.ok(gauges(run.calls.at(-1)).every(g => g.rings[0].value === null && g.stale && g.hint.includes('쿼터 스냅샷 조회 실패')));
  assert.equal(run.scheduled.at(-1).ms, 10000);
});

test('initial collection retries quickly without rendering partial accounts', async () => {
  const run = await boot(async () => ({ configured: true, snapshot_complete: false, accounts: [{ provider: 'claude', windows: [{ used_percent: 88 }] }] }));
  assert.ok(gauges(run.calls.at(-1)).every(g => g.rings[0].value === null));
  assert.equal(run.scheduled.at(-1).ms, 2000);
});

test('network does not block extension startup; run-finished during I/O queues one short follow-up', async () => {
  let finish, reads = 0;
  const run = await boot(() => { reads++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(run.calls.length, 1);
  assert.equal(reads, 1);
  await run.handlers.event({ type: 'run_finished' });
  finish({ configured: true, snapshot_complete: true, next_poll_hint_ms: 900000, accounts: [] });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(run.calls.length, 2);
  assert.equal(run.scheduled.at(-1).ms, 2500, 'Run-finished during I/O must not be overwritten by long polling delay');
});

test('navbar item is generic data: bounded non-interactive nodes, icons as path data only', async () => {
  const run = await boot(async () => ({ configured: true, snapshot_complete: true,
    availability: [{ key: 'antigravity_gemini', remaining_percent: 49, accounts: 2 }, { key: 'antigravity_claude', remaining_percent: 33, accounts: 1 }],
    accounts: [{ provider: 'antigravity', windows: [{ name: 'Gemini weekly', used_percent: 51 }, { name: 'Claude/GPT weekly', used_percent: 67 }] }] }));
  const item = run.calls.at(-1);
  assert.ok(item.label.length <= 40);
  assert.deepEqual(item.view.children.map(g => g.id), ['claude', 'gpt', 'antigravity']);
  const ag = item.view.children.find(g => g.id === 'antigravity');
  assert.deepEqual(ag.rings.map(r => [r.label, r.value]), [['Gemini 잔량', 49], ['Claude via Antigravity 잔량', 33]]);
  assert.equal(ag.display, undefined, 'no percentage text in the navbar itself');
  assert.deepEqual(ag.details.rows.map(r => [r.group, r.label, r.value]), [['Gemini', '잔량', 49], ['Claude/GPT', '잔량', 33]]);
  assert.ok(ag.details.rows.every(r => r.caption === undefined));
  assert.equal(ag.icon.paths.length, 1, 'Antigravity uses its own mark, not Gemini');
  assert.equal(ag.icon.paths[0].fillRule, 'evenodd');
  assert.ok(!item.view.children.some(g => g.id === 'gemini'));
  for (const g of item.view.children) {
    assert.ok(g.hint.length <= 500 && g.rings.length <= 3);
    for (const p of g.icon.paths) assert.match(p.d, /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., \t\n\r]+$/);
  }
  const types = new Set(); (function walk(n) { types.add(n.type); (n.children || []).forEach(walk); })(item.view);
  assert.deepEqual([...types].sort(), ['gauge', 'stack']);
});

test('hover shows only overall remaining with no plan counts, windows or reset labels', async () => {
  const run = await boot(async () => ({ configured: true, snapshot_complete: true,
    availability: [{ key: 'claude', remaining_percent: 74.6, accounts: 2 }, { key: 'codex', remaining_percent: 3, accounts: 1 }], accounts: [
    { provider: 'claude', plan_type: 'pro', status: 'known', windows: [{ name: 'five-hour', used_percent: 12, reset_at: new Date(Date.now() + 90 * 60000).toISOString() }, { name: 'weekly', used_percent: 83 }, { name: 'sonnet', used_percent: null }] },
    { provider: 'claude', plan_type: 'pro', status: 'known', windows: [{ name: 'five-hour', used_percent: 40, reset_at: new Date(Date.now() + 45 * 60000).toISOString() }] },
    { provider: 'codex', plan_type: 'plus', status: 'known', windows: [{ name: 'primary', used_percent: 97 }] }
  ] }));
  const [claude, gpt] = run.calls.at(-1).view.children;
  assert.deepEqual(claude.details.rows, [{ label: '잔량', value: 74.6, color: '#d97757' }]);
  assert.equal(gpt.details.rows[0].caption, undefined);
  assert.doesNotMatch(JSON.stringify([claude, gpt]), /가용률|이용률|5시간|주간|sonnet|리셋|caption|집계 계정|최저|Pro|Plus|플랜/);
  assert.equal(gpt.details.rows[0].color, 'danger');
  assert.equal(gpt.details.rows[0].value, 3);
  assert.equal(claude.details.title, 'Claude 잔량');
  assert.equal(gpt.details.title, 'GPT 잔량');
  assert.equal(claude.rings[0].value, 74.6);
  assert.equal(claude.rings[0].color, '#d97757', 'ring follows upstream availability, not the lowest remaining window (17%)');
  assert.equal(gpt.rings[0].color, 'danger');
});

test('missing upstream availability renders unknown rings instead of local quota guesses', async () => {
  const run = await boot(async () => ({ configured: true, snapshot_complete: true, accounts: [
    { provider: 'claude', windows: [{ name: 'five-hour', used_percent: 12 }] },
    { provider: 'codex', windows: [{ name: 'primary', used_percent: 0 }] }
  ] }));
  assert.ok(gauges(run.calls.at(-1)).every(g => g.rings.every(r => r.value === null)));
  assert.equal(gauges(run.calls.at(-1))[0].details.rows.length, 1);
  assert.equal(gauges(run.calls.at(-1))[0].details.rows[0].value, null);
});

test('hover shows data age from the monitor observation time, never the local poll time', async () => {
  const seen = Date.now() - 42000;
  const run = await boot(async () => ({ configured: true, snapshot_complete: true, accounts: [
    { provider: 'claude', status: 'known', last_success: new Date(seen - 90000).toISOString(), observed_at: new Date(seen).toISOString(), windows: [{ name: 'five-hour', used_percent: 10 }] },
    { provider: 'codex', status: 'known', windows: [{ name: 'primary', used_percent: 10 }] }
  ] }));
  const [claude, gpt] = run.calls.at(-1).view.children;
  assert.equal(claude.details.updatedAt, seen, 'newest observation wins');
  assert.ok(Math.abs(gpt.details.updatedAt - Date.now()) < 5000, 'without an observation time the last successful read is used');
});

// ---- Authenticated management route (/v0/resource is unauthenticated and carries no data) ----
const goodSnapshot = { configured: true, snapshot_complete: true, availability: [{ key: 'claude', remaining_percent: 70, accounts: 1 }], accounts: [] };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('quota is read from the authenticated management route, never from /v0/resource', async () => {
  const run = await boot(async () => goodSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(run.requests)), [{ path: '/v0/management/plugins/quota-monitor/data/accounts' }]);
  assert.ok(!pkg.code.includes('/v0/resource/'), 'no data path under the unauthenticated prefix');
  // The host adds the Bearer header from httpToken; the worker must never build one or pass headers.
  const code = pkg.code.replace(/\/\/.*$/gm, '');
  assert.ok(!/Authorization|Bearer|headers\s*:/.test(code), 'worker code builds no auth header');
  // Only one request is ever built, from the constant path; the key is read for a presence check only.
  assert.equal((code.match(/requestJson\(/g) || []).length, 1);
  assert.ok(/requestJson\(\{ path: QUOTA_PATH \}\)/.test(code), 'the request is the constant path alone, so the key cannot reach a URL');
  assert.equal(ring(run.calls.at(-1), 0), 70);
});

test('package asks only for the permissions the authenticated read needs, with a local secret key', () => {
  assert.deepEqual([...pkg.manifest.permissions].sort(), ['events', 'http-write', 'navbar']);
  assert.equal(pkg.manifest.settingsScope, 'server', 'settings, including the management key, follow the server to every device');
  const token = pkg.manifest.settings.find(field => field.key === 'httpToken');
  assert.ok(token && token.secret === true && token.required === true && !('default' in token));
});

test('without a key nothing is sent and the navbar says what to do (a keyless call is a failed attempt)', async () => {
  const run = await boot(async () => goodSnapshot, {});
  assert.equal(run.requests.length, 0);
  assert.match(JSON.stringify(run.calls.at(-1)), /관리 키를 설정하세요/);
  assert.ok(gauges(run.calls.at(-1)).every(g => g.rings[0].value === null && g.stale));
  assert.equal(run.scheduled.at(-1).ms, 15000, 'cheap local re-check, no server traffic');
});

test('a rejected key is not retried until the key itself changes (5 rejections = 30-minute IP ban)', async () => {
  let key = 'wrong-key', status = 401;
  const requests = [], scheduled = [], calls = [];
  const sdk = {
    settings: { get: async () => ({ httpToken: key }) },
    navbar: { set: async (id, item) => calls.push(JSON.parse(JSON.stringify(item))) },
    http: { requestJson: async request => { requests.push(request); return { status, body: status === 200 ? goodSnapshot : { error: 'invalid management key' } }; } },
    events: { on: async () => {} }
  };
  let now = 10000;
  class FakeDate extends Date { static now() { return now; } }
  const context = vm.createContext({ sdk, Date: FakeDate, setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, clearTimeout() {} });
  await vm.runInContext(`(async () => { ${pkg.code}\n })()`, context);
  await tick();
  assert.equal(requests.length, 1, 'one rejected attempt');
  assert.match(JSON.stringify(calls.at(-1)), /거부되었습니다/);
  assert.ok(gauges(calls.at(-1)).every(g => g.rings[0].value === null));
  for (let i = 0; i < 4; i++) { now += 20000; scheduled.at(-1).fn(); await tick(); }
  assert.equal(requests.length, 1, 'four more polls, still only the first rejected request');
  // The operator corrects the key: requests resume on the next local re-check.
  key = 'good-key'; status = 200; now += 20000; scheduled.at(-1).fn(); await tick();
  assert.equal(requests.length, 2);
  assert.equal(calls.at(-1).view.children[0].rings[0].value, 70);
});

test('language setting switches the rendered text; auto without a program language stays Korean', async () => {
  const body = { configured: true, snapshot_complete: true, availability: [], accounts: [] };
  const en = await boot(async () => body, { httpToken: 'k', language: 'en' });
  assert.equal(en.calls.at(-1).label, 'AI quota');
  assert.equal(en.calls.at(-1).view.children[0].details.title, 'Claude remaining');
  const auto = await boot(async () => body, { httpToken: 'k', language: 'auto' });
  assert.equal(auto.calls.at(-1).label, 'AI 잔량');
  const noKey = await boot(async () => body, { language: 'en' });
  assert.ok(noKey.calls.at(-1).view.children[0].hint.includes('Set the management key'));
});
