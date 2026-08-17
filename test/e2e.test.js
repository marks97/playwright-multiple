'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HumanInput } = require('../lib/human/humanInput');
const { ServiceClient } = require('../lib/session/serviceClient');

const SERVICE_URL = process.env.BROWSER_INFRA_URL;
const SERVICE_KEY = process.env.BROWSER_INFRA_KEY;

test('humanized typing fires real keydown events in a real browser', async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    console.log(`skipping browser E2E: ${error.message}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.setContent(
      '<style>body{height:2000px}</style>' +
      '<input id="name" style="position:absolute;top:900px;left:120px">' +
      '<script>window.__keys=0;document.addEventListener("keydown",()=>{window.__keys++});</script>'
    );
    const human = new HumanInput({ seed: 2026, startCursor: { x: 4, y: 4 } });
    const locator = page.locator('#name');
    await human.typeIntoLocator(page, locator, 'Marc', { replace: true });

    const keydowns = await page.evaluate(() => window.__keys);
    const value = await locator.inputValue();
    const active = await page.evaluate(() => (navigator.userActivation ? navigator.userActivation.hasBeenActive : true));
    const hovered = await page.evaluate(() => document.querySelectorAll(':hover').length);

    assert.ok(keydowns >= 4, `expected >=4 keydown events, got ${keydowns}`);
    assert.equal(value, 'Marc');
    assert.ok(active, 'navigator.userActivation.hasBeenActive should be true after input');
    console.log(`[e2e] keydowns=${keydowns} value=${value} hasBeenActive=${active} hoverCount=${hovered} (headless does not populate :hover via synthetic moves)`);
  } finally {
    await browser.close();
  }
});

test('live browser-infra session create/get/delete contract', async (t) => {
  if (!SERVICE_URL || !SERVICE_KEY) {
    t.skip('set BROWSER_INFRA_URL and BROWSER_INFRA_KEY to run the live-service E2E');
    return;
  }
  const health = await fetch(`${SERVICE_URL.replace(/\/+$/, '')}/health`).catch(() => null);
  if (!health || !health.ok) {
    t.skip('browser-infra service not reachable');
    return;
  }
  const client = new ServiceClient({ baseUrl: SERVICE_URL, apiKey: SERVICE_KEY });
  const created = await client.createSession({ recordSession: false });
  assert.ok(created.id, 'session must have an id');
  assert.equal(created.status, 'pending', 'create is async and returns pending');
  assert.equal(created.connectUrl, null, 'pending session has no connectUrl yet');
  const ready = await client.waitForRunning(created.id);
  assert.match(ready.connectUrl, /^ws:\/\/.+\/cdp\?token=.+/, 'connectUrl must be a CDP ws endpoint');
  try {
    assert.ok(await client.isAlive(created.id), 'ready session should be running');
  } finally {
    const deleted = await client.deleteSession(created.id);
    assert.ok(deleted.ok, 'delete should return ok');
  }
  assert.equal(await client.isAlive(created.id), false, 'session should be stopped after delete');
});
