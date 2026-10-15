import test from 'node:test';
import assert from 'node:assert/strict';
import { observedAt, providerName, navbarFromSnapshot, pollDelay } from '../src/model.mjs';
const snapshot = (accounts, availability = []) => ({ configured: true, snapshot_complete: true, accounts, availability });
const fleet = (key, remaining_percent) => ({ key, remaining_percent });
const account = (provider, windows, extra = {}) => ({ provider, windows, status: 'known', ...extra });
const win = (name, used_percent) => ({ name, used_percent });
const rem = view => view.gauges.map(g => [g.brand, g.remainingPercent]);

test('provider aliases normalize to their displayed brands', () => {
  for (const name of ['codex', 'openai', 'gpt']) assert.equal(providerName(name), 'gpt');
  for (const name of ['gemini', 'gemini-cli', 'google']) assert.equal(providerName(name), 'gemini');
  for (const name of ['claude', 'anthropic']) assert.equal(providerName(name), 'claude');
  assert.equal(providerName(' Antigravity '), 'antigravity');
});

test('fixed order is Claude, GPT, Antigravity; missing availability stays unknown', () => {
  const view = navbarFromSnapshot(snapshot([account('codex', [win('primary', 0), win('secondary', 40)])], [fleet('codex', 60)]));
  assert.deepEqual(rem(view), [['claude', null], ['gpt', 60], ['antigravity', null]]);
});

test('Antigravity families and native Claude never merge', () => {
  const view = navbarFromSnapshot(snapshot([
    account('claude', [win('five-hour', 12), win('weekly', 24)]),
    account('antigravity', [win('Gemini five hour', 35), win('Gemini weekly', 42), win('Claude/GPT five hour', 61), win('Claude/GPT weekly', 73)]),
    account('codex', [win('primary', 8)])
  ], [fleet('claude', 76), fleet('codex', 92), fleet('antigravity_gemini', 58), fleet('antigravity_claude', 27)]));
  assert.deepEqual(rem(view), [['claude', 76], ['gpt', 92], ['antigravity', 58]]);
  assert.equal(view.gauges[2].innerRemainingPercent, 27);
  assert.deepEqual(view.gauges[2].rows, [{ label: '잔량', value: 58 }]);
  assert.deepEqual(view.gauges[2].innerRows, [{ label: '잔량', value: 27 }]);
});

test('native Gemini is shown only when present, between GPT and Antigravity', () => {
  const view = navbarFromSnapshot(snapshot([account('gemini-cli', [win('daily', 17)])], [fleet('gemini', 83)]));
  assert.deepEqual(rem(view), [['claude', null], ['gpt', null], ['gemini', 83], ['antigravity', null]]);
});

test('stale snapshots and accounts retain upstream readings', () => {
  const accounts = [account('claude', [win('weekly', 44)], { status: 'stale' })];
  const view = navbarFromSnapshot(snapshot(accounts, [fleet('claude', 71)]));
  assert.equal(view.gauges[0].remainingPercent, 71);
  assert.equal(view.gauges[0].stale, true);
  assert.match(view.gauges[0].hint, /이전 관측값/);
  assert.ok(navbarFromSnapshot({ ...snapshot([], [fleet('claude', 56)]), stale: true }).gauges.every(g => g.stale));
  assert.throws(() => navbarFromSnapshot({ configured: false, accounts: [] }), /설정/);
  assert.throws(() => navbarFromSnapshot({ configured: true, snapshot_complete: false, accounts: [] }), /첫 쿼터/);
});

test('only overall remaining is exposed, never account windows or aggregation labels', () => {
  const accounts = [
    account('claude', [win('five-hour', 20), win('weekly', 95), win('sonnet', null)]),
    account('claude', [win('five-hour', 0), win('weekly', 100)], { current_account: true, current_kind: 'recent', current_reason: 'recent_usage' }),
    account('codex', [win('primary', 99)])
  ];
  const view = navbarFromSnapshot(snapshot(accounts, [{ ...fleet('claude', 40.1), accounts: 2 }, fleet('codex', 67.5)]));
  assert.equal(view.gauges[0].remainingPercent, 40.1);
  assert.equal(view.gauges[1].remainingPercent, 67.5);
  assert.deepEqual(view.gauges[0].rows, [{ label: '잔량', value: 40.1 }]);
  assert.doesNotMatch(JSON.stringify(view), /가용률|이용률|5시간|주간|sonnet|최근 사용|집계 계정|일부 한도/);
});

test('missing and malformed fleet values remain unknown with no account detail fallback', () => {
  const accounts = [account('claude', [win('five-hour', 12)])];
  for (const availability of [undefined, null, {}, [], [fleet('claude', null)], [fleet('claude', '88')],
    [fleet('claude', NaN)], [fleet('claude', Infinity)], [fleet('claude', -1)], [fleet('claude', 101)]]) {
    const view = navbarFromSnapshot({ ...snapshot(accounts), availability });
    assert.equal(view.gauges[0].remainingPercent, null);
    assert.deepEqual(view.gauges[0].rows, [{ label: '잔량', value: null }]);
    assert.match(view.gauges[0].hint, /잔량 미확인/);
  }
});

test('fleet values work without raw accounts and zero remains authoritative', () => {
  const view = navbarFromSnapshot(snapshot([], [fleet('claude', 0), fleet('codex', 100),
    fleet('antigravity_gemini', 70.2), fleet('antigravity_claude', 0)]));
  assert.deepEqual(rem(view), [['claude', 0], ['gpt', 100], ['antigravity', 70.2]]);
  assert.equal(view.gauges[2].innerRemainingPercent, 0);
  assert.deepEqual(view.gauges[2].innerRows, [{ label: '잔량', value: 0 }]);
});

test('a missing Antigravity family never borrows the other family availability', () => {
  for (const key of ['antigravity_gemini', 'antigravity_claude']) {
    const view = navbarFromSnapshot(snapshot([account('antigravity', [win('Gemini five hour', 0), win('Claude five hour', 0)])], [fleet(key, 61.3)]));
    assert.equal(view.gauges[2].remainingPercent, key === 'antigravity_gemini' ? 61.3 : null);
    assert.equal(view.gauges[2].innerRemainingPercent, key === 'antigravity_claude' ? 61.3 : null);
  }
});

test('disabled accounts do not mark fleet data stale or advance its observation time', () => {
  const view = navbarFromSnapshot(snapshot([
    account('claude', [], { status: 'error', operational: { disabled: true }, observed_at: '2026-01-01T00:00:30Z' }),
    account('claude', [], { observed_at: '2026-01-01T00:00:20Z' })
  ], [fleet('claude', 76)]));
  assert.equal(view.gauges[0].stale, false);
  assert.equal(view.gauges[0].updatedAt, Date.parse('2026-01-01T00:00:20Z'));
});

test('polling respects progressive snapshots and bounded user/server hints', () => {
  assert.equal(pollDelay({ collection_in_progress: true }, { pollSeconds: 60 }), 2000);
  assert.equal(pollDelay({ snapshot_complete: false }), 2000);
  assert.equal(pollDelay({ next_poll_hint_ms: 120000 }), 120000);
  assert.equal(pollDelay({}, { pollSeconds: 0.5 }), 10000);
  assert.equal(pollDelay({}, { pollSeconds: 99999 }), 900000);
  assert.equal(pollDelay({ next_poll_hint_ms: '2000' }), 60000);
});

test('observedAt takes the newest valid timestamp and ignores garbage', () => {
  assert.equal(observedAt({}), null);
  assert.equal(observedAt({ last_success: 'nope', observed_at: 5 }), null);
  assert.equal(observedAt({ last_success: '2026-01-01T00:00:10Z', observed_at: '2026-01-01T00:00:20Z' }), Date.parse('2026-01-01T00:00:20Z'));
  assert.equal(observedAt({ windows: [{ observed_at: '2026-01-01T00:00:20Z' }] }), Date.parse('2026-01-01T00:00:20Z'));
  const view = navbarFromSnapshot(snapshot([account('antigravity', [], { observed_at: '2026-01-01T00:00:20Z' })]));
  assert.equal(view.gauges[2].updatedAt, Date.parse('2026-01-01T00:00:20Z'));
});
