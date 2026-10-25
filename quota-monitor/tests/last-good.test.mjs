import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const pkg = JSON.parse(await readFile(new URL('../dist/quota-monitor.json', import.meta.url), 'utf8'));

test('later network failure keeps the previous actual reading and marks every ring stale', async () => {
  let now = 10000, reads = 0;
  const calls = [], timers = [], handlers = {};
  class FakeDate extends Date { static now() { return now; } }
  const sdk = {
    settings: { get: async () => ({ httpToken: 'test-key' }) },
    components: { setData: async data => calls.push(JSON.parse(JSON.stringify(data))) },
    http: { requestJson: async () => {
      if (++reads > 1) throw new Error('조회 실패');
      return { status: 200, body: { configured: true, snapshot_complete: true, availability: [{ key: 'claude', remaining_percent: 64.7, accounts: 2 }], accounts: [{ provider: 'claude', windows: [{ name: 'weekly', used_percent: 96 }] }] } };
    } },
    events: { on: async handler => { handlers.event = handler; } }
  };
  const context = vm.createContext({ sdk, Date: FakeDate, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  await vm.runInContext(`(async () => { ${pkg.code}\n })()`, context);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(calls.at(-1).gauges[0].rings[0].value, 64.7);
  now += 3000;
  timers.at(-1).fn();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(calls.at(-1).gauges[0].rings[0].value, 64.7);
  assert.ok(calls.at(-1).gauges.every(g => g.stale && g.hint.includes('조회 실패')));
  assert.equal(reads, 2);
  now += 3000;
  timers.at(-1).fn();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(timers.at(-1).ms, 20000);
});
