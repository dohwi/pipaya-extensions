// Optional integration QA (needs Playwright and a running pipaya client that supports `ui-components`).
//   PIPAYA_TEST_URL=http://host:1420/ PIPAYA_TEST_SERVER=http://host:8787 PIPAYA_TEST_TOKEN=<token> node scripts/check-browser.mjs
// Synthetic data and a local stand-in for CLIProxyAPI. The management key must only ever travel as a Bearer header.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const app = process.env.PIPAYA_TEST_URL || 'http://localhost:1420/';
const server = { id: 't1', name: 'test', baseUrl: process.env.PIPAYA_TEST_SERVER || 'http://localhost:8787', token: process.env.PIPAYA_TEST_TOKEN || '' };
const pkgFile = join(mkdtempSync(join(tmpdir(), 'qm-')), 'quota-monitor.json');
writeFileSync(pkgFile, readFileSync(new URL('../dist/quota-monitor.json', import.meta.url)));
const fixture = { configured: true, snapshot_complete: true, next_poll_hint_ms: 900000,
  availability: [{ key: 'claude', remaining_percent: 69 }, { key: 'codex', remaining_percent: 12 }, { key: 'antigravity_gemini', remaining_percent: 49 }, { key: 'antigravity_claude', remaining_percent: 3 }],
  accounts: [{ provider: 'claude', status: 'known', windows: [] }, { provider: 'codex', status: 'known', windows: [] }, { provider: 'antigravity', status: 'known', windows: [] }] };
const seen = [];
const proxy = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization ?? null });
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(req.method === 'OPTIONS' ? '' : JSON.stringify(fixture));
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${proxy.address().port}`;

const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  for (const [width, height, theme] of [[1280, 800, 'dark'], [390, 844, 'light']]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(([s, th]) => {
      if (window !== window.top || localStorage.getItem('seeded')) return;
      localStorage.setItem('seeded', '1'); localStorage.setItem('pipaya.theme', th);
      localStorage.setItem('pipaya.servers', JSON.stringify([s])); localStorage.setItem('pipaya.activeServer', s.id);
    }, [server, theme]);
    await page.goto(app);
    await page.waitForSelector('[data-part=app]');
    const mobile = width < 700;
    const openSettings = async () => { if (mobile) { await page.click('button.tool.menu'); await page.waitForTimeout(400); } await page.click('button.settings'); };
    const closeSettings = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(400); if (mobile) { await page.mouse.click(width - 5, 400); await page.waitForTimeout(400); } };
    await openSettings(); await page.getByText('클라이언트 확장').first().click();
    await page.setInputFiles('input[type=file][accept*=json]', pkgFile);
    await page.waitForSelector('[data-ok]');
    assert.ok(await page.locator('[role=alert]').count(), 'ui-components shows the danger notice');
    await page.click('[data-ok]'); await page.getByText('설치된 확장 보기').click();
    await page.getByLabel(/CLIProxyAPI 주소/).fill(origin);
    await page.getByLabel(/관리 키/).fill('mgmt-key-123');
    await page.locator('button[type=submit]').first().click();
    await page.waitForTimeout(500);
    await page.locator('[role=switch]').first().click();
    await page.locator('[data-part=header] .gauge').nth(2).waitFor({ timeout: 15000 });
    await closeSettings();
    const gauges = await page.evaluate(() => [...document.querySelectorAll('[data-part=header] .gauge')].map(g => [g.getAttribute('aria-label'), [...g.querySelectorAll('[role=progressbar]')].map(p => p.getAttribute('aria-valuetext')).join('/')]));
    assert.deepEqual(gauges, [['Claude', '69%'], ['GPT', '12%'], ['Antigravity', '49%/3%']]);
    await page.locator('[data-part=header] .gauge').last().hover();
    await page.locator('.qm-pop').waitFor();
    const box = await page.locator('.qm-pop').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height, 'popover stays on screen');
    assert.match(await page.locator('.qm-pop').innerText(), /Gemini[\s\S]*49%[\s\S]*Claude\/GPT[\s\S]*3%/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.qm-pop').count(), 0, 'Escape closes the popover');
    await page.locator('[data-part=header] .gauge').first().focus();
    await page.locator('.qm-pop').waitFor();
    assert.ok(seen.every(s => !/mgmt-key/.test(s.url)), 'the key is never in a URL');
    assert.ok(seen.some(s => s.auth === 'Bearer mgmt-key-123'), 'the host sends the key as a Bearer header');
    await openSettings(); await page.getByText('클라이언트 확장').first().click();
    await page.locator('[role=switch]').first().click(); await page.waitForTimeout(500); await closeSettings();
    assert.equal(await page.locator('.gauge, .qm-pop').count(), 0, 'disabling removes every gauge and popover');
    assert.deepEqual(errors, []);
    console.log(`ok ${width}x${height} ${theme}`);
    await page.close();
  }
} catch (error) { failed = true; console.error(error); } finally { proxy.close(); await browser.close(); }
process.exit(failed ? 1 : 0);
