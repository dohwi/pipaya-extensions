import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { gaugesFromSnapshot } from '../src/model.mjs';
import { gaugeData, strings } from '../src/view.mjs';
import { setLanguage } from '../src/i18n.mjs';

const ringSource = await readFile(new URL('../src/components/Ring.svelte', import.meta.url), 'utf8');
const moduleScript = /<script\s+module>([\s\S]*?)<\/script>/.exec(ringSource)?.[1] ?? '';
const instanceScript = /<script>([\s\S]*?)<\/script>/.exec(ringSource)?.[1] ?? '';

function evaluateRing(props) {
  const ctx = vm.createContext({
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    $props: () => props,
    $state: v => v,
    $derived: v => v,
    $effect: () => {}
  });
  ctx.$derived.by = fn => fn();
  const code = `${moduleScript}\n${instanceScript}\n({ columns, multiCol, titleAccounts, rows, summary, detailsHeading, description });`;
  return vm.runInContext(code, ctx);
}

test('Ring.svelte evaluates without ReferenceError across unknown, dual-window, and split Antigravity gauges', () => {
  setLanguage('ko');
  const s = strings();

  // 1) Initial unknown state (dual === false)
  const initial = gaugeData({ id: 'claude', label: 'Claude', brand: 'claude', remainingPercent: null });
  const r0 = evaluateRing({ gauge: initial, strings: s });
  assert.equal(r0.columns.length, 1);
  assert.equal(r0.columns[0].dual, false);
  assert.equal(r0.columns[0].text, '확인 불가');

  // 2) Dual-window Claude + split Antigravity with distinct family counts (dual === true)
  const snap = gaugesFromSnapshot({
    configured: true,
    snapshot_complete: true,
    accounts: [
      { provider: 'claude', status: 'known', windows: [] },
      { provider: 'antigravity', status: 'known', windows: [] }
    ],
    availability: [
      {
        key: 'claude',
        remaining_percent: 16.7,
        short_remaining_percent: 16.7,
        weekly_remaining_percent: 75.8,
        accounts: 3
      },
      {
        key: 'antigravity_gemini',
        label: 'AGY (AI Ultra/AI Pro (15)) · Gemini',
        remaining_percent: 74,
        short_remaining_percent: 97,
        weekly_remaining_percent: 74,
        accounts: 4
      },
      {
        key: 'antigravity_claude',
        label: 'AGY (AI Ultra/AI Pro (15)) · Claude/GPT',
        remaining_percent: 100,
        short_remaining_percent: 100,
        weekly_remaining_percent: 100,
        accounts: 2
      },
      {
        key: 'antigravity_pool_deadbeef_gemini',
        label: 'AGY (AI Ultra/AI Pro (12)) · Gemini',
        remaining_percent: 60,
        short_remaining_percent: 70,
        weekly_remaining_percent: 60,
        accounts: 2
      },
      {
        key: 'antigravity_pool_deadbeef_claude',
        label: 'AGY (AI Ultra/AI Pro (12)) · Claude/GPT',
        remaining_percent: 80,
        short_remaining_percent: 85,
        weekly_remaining_percent: 80,
        accounts: 2
      }
    ]
  });

  const claudeView = gaugeData(snap.gauges[0]);
  const rClaude = evaluateRing({ gauge: claudeView, strings: s });
  assert.equal(rClaude.columns[0].dual, true);
  assert.equal(rClaude.columns[0].text, '5시간 17% / 주간 76%');
  assert.equal(rClaude.titleAccounts, '3계정');

  const agView = gaugeData(snap.gauges[1]);
  const rAg = evaluateRing({ gauge: agView, strings: s });
  assert.equal(rAg.multiCol, true);
  assert.equal(rAg.columns[0].text, '5시간 97% / 주간 74%');
  assert.equal(rAg.columns[1].text, '5시간 100% / 주간 100%');
  assert.equal(rAg.titleAccounts, '4계정');
  assert.equal(rAg.rows[0].groupAccountsText, '4계정');
  assert.equal(rAg.rows[2].groupAccountsText, '2계정');

  // 3) English locale
  setLanguage('en');
  const rEn = evaluateRing({ gauge: claudeView, strings: strings() });
  assert.equal(rEn.columns[0].text, '5h 17% / 7d 76%');
  assert.equal(rEn.titleAccounts, '3 accts');
  setLanguage('ko');
});
