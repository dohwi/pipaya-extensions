// Optional integration QA: real opaque-origin Worker + trusted Svelte navbar, synthetic data only.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const baseUrl = process.env.PIPAYA_TEST_URL || 'http://localhost:1420';
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/quota-monitor.json'), 'utf8'));
const id = pkg.manifest.id;
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let fail = false, requests = 0;
    const fixture = {
      configured: true, snapshot_complete: true, next_poll_hint_ms: 900000,
      availability: [
        { key: 'claude', remaining_percent: 69, accounts: 2 },
        { key: 'codex', remaining_percent: 72, accounts: 3 },
        { key: 'antigravity_gemini', remaining_percent: 49, accounts: 2 },
        { key: 'antigravity_claude', remaining_percent: 33, accounts: 1 }
      ],
      accounts: [
        { provider: 'claude', status: 'known', account: 'secret@example.invalid', auth_index: 'secret', windows: [{ name: 'five-hour', used_percent: 23 }, { name: 'weekly', used_percent: 31 }] },
        { provider: 'antigravity', status: 'known', windows: [{ name: 'Gemini five hour', used_percent: 44 }, { name: 'Gemini weekly', used_percent: 51 }, { name: 'Claude/GPT weekly', used_percent: 67 }] },
        { provider: 'codex', status: 'known', windows: [{ name: 'primary', remaining_percent: 81 }, { name: 'secondary', used_percent: 28 }] }
      ]
    };
    // The unauthenticated /v0/resource prefix must never be asked for data.
    await page.route('**/v0/resource/plugins/quota-monitor/**', async route => { assert.fail(`data requested from the unauthenticated prefix: ${route.request().url()}`); });
    const KEY = 'qa-management-key', seen = [];
    await page.route('**/v0/management/plugins/quota-monitor/data/accounts', async route => {
      requests++;
      const auth = route.request().headers().authorization;
      seen.push(auth);
      assert.equal(route.request().method(), 'GET');
      if (auth !== `Bearer ${KEY}`) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid management key"}' });
      await route.fulfill({ status: fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    });
    await page.goto(baseUrl);
    await page.waitForLoadState('networkidle');
    const source = await (await page.request.get(`${baseUrl}/src/App.svelte`)).text();
    const storeUrl = source.match(/from "([^"]*store\.svelte\.ts[^"]*)"/)[1];
    const hostUrl = source.match(/from "([^"]*extensions\/host\.svelte\.ts[^"]*)"/)[1];
    // Run against a stable dev build: module edits/HMR mid-test create new singleton instances.
    await page.getByRole('button', { name: '설정 · 확장', exact: true }).click();
    await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({ name: 'quota-monitor.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pkg)) });
    await page.getByRole('button', { name: '비활성 상태로 가져오기', exact: true }).click();
    const importResult = page.locator('[aria-labelledby="import-result-title"]');
    await importResult.getByRole('button', { name: '설치된 확장 보기', exact: true }).click();
    await importResult.waitFor({ state: 'hidden' });
    await page.evaluate(async ({ hostUrl, storeUrl, id, origin, key }) => {
      const { extensions } = await import(hostUrl);
      extensions.setSettings(id, { httpOrigin: origin, httpToken: key });
      const { app } = await import(storeUrl);
      app.servers = [{ id: 'qa', name: 'Synthetic QA', baseUrl: origin, token: '' }];
      app.net = 'online';
    }, { hostUrl, storeUrl, id, origin: new URL(baseUrl).origin, key: KEY });
    const card = page.getByRole('article', { name: pkg.manifest.name });
    // pipaya exposes activation as a switch ("<name> 사용"); it stays disabled until settings are saved.
    const enable = card.getByRole('switch', { name: `${pkg.manifest.name} 사용` });
    await page.waitForFunction(el => !el.disabled, await enable.elementHandle());
    await enable.click();
    await page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', await enable.elementHandle());
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('dialog', { name: '설정', exact: true }).waitFor({ state: 'hidden' });
    const navbar = page.locator('main > header');
    try {
      await navbar.locator('[role="progressbar"][aria-label="Claude 잔량"][aria-valuenow="69"]').waitFor({ state: 'attached', timeout: 15000 });
    } catch (error) {
      console.error(await page.evaluate(async ({ hostUrl, id }) => {
        const { extensions } = await import(hostUrl);
        const entry = extensions.installed.find(entry => entry.package.manifest.id === id);
        return { state: entry?.state, error: entry?.error, logs: extensions.logs.filter(log => log.owner === id), navbar: document.querySelector('header')?.textContent };
      }, { hostUrl, id }));
      throw error;
    }
    await navbar.locator('[role="progressbar"][aria-label="Gemini 잔량"][aria-valuenow="49"]').waitFor({ state: 'attached' });
    await navbar.locator('[role="progressbar"][aria-label="GPT 잔량"][aria-valuenow="72"]').waitFor({ state: 'attached', timeout: 15000 });
    assert.ok(!/\d+\s*%/.test(await navbar.innerText()), 'navbar must not print percentages');
    assert.equal(await navbar.locator('[role="progressbar"][aria-label="Claude via Antigravity 잔량"][aria-valuenow="33"]').count(), 1);
    assert.ok(await navbar.locator('svg circle').count() >= 8, 'Tracks + fills for three circles and AG inner ring');
    assert.ok(!(await navbar.textContent()).includes('secret@example.invalid'));
    await navbar.locator('[tabindex="0"], button').first().focus();
    // Ring colors are extension-provided hex values and must win over host theme CSS.
    const strokes = await navbar.locator('circle.arc').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).stroke));
    assert.deepEqual(strokes, ['rgb(217, 119, 87)', 'rgb(16, 163, 127)', 'rgb(107, 141, 233)', 'rgb(217, 119, 87)'], `ring colors: ${strokes}`);
    if (process.env.DUMP_NAVBAR) { const box = await navbar.locator('.slot').boundingBox(); await page.screenshot({ path: '/tmp/quota-monitor-zoom.png', clip: box, scale: 'css', animations: 'disabled' }); console.log('arc fills', await navbar.locator('circle.arc').evaluateAll(n => n.map(c => getComputedStyle(c).stroke + ' / ' + c.getAttribute('stroke-dasharray')))); }
    // Hover popover: only overall remaining per family; closes on Escape, stays inside the viewport.
    const ag = navbar.locator('.gauge[aria-label="Antigravity"]');
    assert.equal(await ag.count(), 1, 'Antigravity gauge present');
    await ag.hover();
    const pop = page.locator('[role="tooltip"]');
    await pop.waitFor({ state: 'visible' });
    assert.equal(await pop.count(), 1, 'only one popover at a time');
    const text = await pop.innerText();
    for (const expected of ['Antigravity 잔량', 'Gemini', 'Claude/GPT', '49%', '33%']) assert.ok(text.includes(expected), `popover missing ${expected}: ${text}`);
    assert.doesNotMatch(text, /가용률|이용률|5시간|주간|리셋|최저|집계 계정|플랜|\d+x/);
    assert.equal(await pop.locator('.pop-fill').count(), 2, 'only overall remaining for the two families');
    assert.equal(await ag.getAttribute('title'), null, 'no native tooltip when popover exists');
    const box = await pop.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 1440 && box.y >= 0, 'popover inside viewport');
    await page.screenshot({ path: '/tmp/quota-monitor-hover.png', clip: box, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'hidden' });
    await page.mouse.move(5, 500);
    await ag.focus();
    await pop.waitFor({ state: 'visible' });
    await page.mouse.move(5, 500); await page.keyboard.press('Escape'); await pop.waitFor({ state: 'hidden' });
    // Synthetic snapshot only; do not use screenshots as real usage evidence.
    if (process.env.DUMP_NAVBAR) console.log('NAVBAR_TEXT:', JSON.stringify(await navbar.innerText()), '\nNAVBAR_HTML:', (await navbar.innerHTML()).replace(/<path[^>]*>/g,'<path/>').slice(0, 2500));
    await page.screenshot({ path: '/tmp/quota-monitor-desktop.png', animations: 'disabled' });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px overflow`);
      const box = await navbar.boundingBox();
      assert.ok(box && box.width <= width);
      if (width === 320) {
        await page.screenshot({ path: '/tmp/quota-monitor-mobile.png', animations: 'disabled' });
        await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        await ag.focus();
        await pop.waitFor({ state: 'visible', timeout: 5000 });
        const small = await pop.boundingBox();
        assert.ok(small.x >= 0 && small.x + small.width <= 320, `320px popover bounds ${JSON.stringify(small)}`);
        await page.screenshot({ path: '/tmp/quota-monitor-mobile-hover.png', animations: 'disabled' });
        await page.keyboard.press('Escape'); await pop.waitFor({ state: 'hidden' });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async ({ storeUrl }) => { const { app } = await import(storeUrl); app.setTheme('dark'); }, { storeUrl });
    await navbar.locator('[role="progressbar"][aria-label="Claude 잔량"][aria-valuenow="69"]').waitFor({ state: 'attached', timeout: 15000 });
    await page.screenshot({ path: '/tmp/quota-monitor-dark.png', animations: 'disabled' });
    // Native Gemini alongside AG becomes a fourth ring. Zero and unknown remain distinct.
    fixture.accounts.push({ provider: 'gemini', status: 'known', windows: [{ name: 'daily', used_percent: 0 }] });
    fixture.accounts[0].windows = [{ name: 'weekly', used_percent: null }];
    fixture.availability = fixture.availability.filter(entry => entry.key !== 'claude');
    fixture.availability.push({ key: 'gemini', remaining_percent: 100, accounts: 1 });
    await page.evaluate(async ({ hostUrl }) => {
      const { extensions } = await import(hostUrl);
      extensions.emit({ type: 'run_finished', at: Date.now(), status: 'completed' });
    }, { hostUrl });
    await navbar.locator('[role="progressbar"][aria-label="Gemini 잔량"][aria-valuenow="100"]').waitFor({ state: 'attached' });
    assert.equal(await navbar.locator('[role="progressbar"][aria-label="Claude 잔량"]:not([aria-valuenow])').count(), 1);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'four-ring 320px overflow');
    await page.setViewportSize({ width: 1440, height: 900 });
    // Worker timers have their own clock. A run-finished event schedules the real 2.5s read.
    fail = true;
    await page.evaluate(async ({ hostUrl }) => {
      const { extensions } = await import(hostUrl);
      extensions.emit({ type: 'run_finished', at: Date.now(), status: 'completed' });
    }, { hostUrl });
    await navbar.locator('.gauge.stale .badge').first().waitFor();
    await navbar.locator('[role="progressbar"][aria-label="GPT 잔량"][aria-valuenow="72"]').waitFor({ state: 'attached', timeout: 15000 });
    assert.equal(await navbar.locator('[role="progressbar"][aria-label="Gemini 잔량"][aria-valuenow="100"]').count(), 1);
    // Stale + failure reason are exposed in the popover and the accessible description (native title is off).
    const staleGauge = navbar.locator('.gauge.stale').first();
    assert.doesNotMatch(await staleGauge.getAttribute('aria-description'), /오래된 데이터/);
    await staleGauge.focus();
    await pop.waitFor({ state: 'visible' });
    const popText = await pop.innerText();
    assert.ok(!popText.includes('오래된 데이터'), 'no generic stale wording');
    assert.match(popText, /\d+(초|분) 전 업데이트됨/, 'popover shows data age');
    const first = await pop.locator('.pop-updated').innerText();
    await page.waitForTimeout(2200);
    assert.notEqual(await pop.locator('.pop-updated').innerText(), first, 'age ticks while open');
    await page.screenshot({ path: '/tmp/quota-monitor-updated.png', clip: { x: 1000, y: 0, width: 440, height: 330 } });
    await page.keyboard.press('Escape'); await pop.waitFor({ state: 'hidden' });
    assert.ok(requests >= 2);
    const denied = await page.evaluate(async ({ hostUrl }) => {
      const { extensions } = await import(hostUrl);
      const probe = extensions.install({ manifest: { id: 'qa.generic-denial', name: 'Permission probe', version: '1.0.0', sdkVersion: 1, permissions: [] }, code: `let blocked = 0; try { await sdk.http.getJson('/x'); } catch { blocked++; } try { await sdk.navbar.set('probe', {label:'Denied',view:{type:'text',id:'t',text:'x'}}); } catch { blocked++; } await sdk.log('blocked=' + blocked);` });
      await extensions.enable(probe);
      return extensions.logs.some(log => log.owner === probe && log.text === 'blocked=2');
    }, { hostUrl });
    assert.equal(denied, true, 'Host must reject both generic capabilities without permission');
    await page.evaluate(async ({ hostUrl }) => { const { extensions } = await import(hostUrl); extensions.setSafeMode(true); }, { hostUrl });
    assert.equal(await page.locator('iframe').count(), 0);
    assert.equal(await navbar.locator('svg circle').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: JSON import + actual Worker, generic gauge/icon nodes, AG dual ring, no account identifier rendered, 3/4-ring mobile 320px, unknown vs zero, stale retention, permission denial, safe-mode teardown');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
