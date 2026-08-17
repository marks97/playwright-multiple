#!/usr/bin/env node
/**
 * Playwright MCP with tabId isolation.
 * Fork of @playwright/mcp — adds an optional `tabId` parameter to every tool,
 * allowing multiple agents to work on separate tabs in the same browser.
 *
 * --shared mode: multiple MCP servers share one Chrome via CDP.
 *   First server launches Chrome with --remote-debugging-port.
 *   Subsequent servers connect to the existing Chrome via CDP.
 */

const path = require('path');

const { HumanInput } = require('./lib/human/humanInput');
const { wrapHumanizedTools } = require('./lib/human/tools');
const { SessionLifecycle } = require('./lib/session/lifecycle');

// Resolve internal modules via absolute path (bypasses package.json exports)
const pwCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const mcpServer = require(path.join(pwCorePath, 'lib/tools/utils/mcp/server.js'));
const { z: zod } = require(path.join(pwCorePath, 'lib/mcpBundle.js'));
const { BrowserBackend } = require(path.join(pwCorePath, 'lib/tools/backend/browserBackend.js'));
const { filteredTools } = require(path.join(pwCorePath, 'lib/tools/backend/tools.js'));

// Parse and remove custom flags early (before decorateMCPCommand/Commander consumes args)
const isShared = !process.argv.includes('--no-shared');
let cdpPort = 9222;
const cdpPortIdx = process.argv.indexOf('--cdp-port');
if (cdpPortIdx !== -1 && process.argv[cdpPortIdx + 1]) {
  cdpPort = parseInt(process.argv[cdpPortIdx + 1], 10);
  process.argv.splice(cdpPortIdx, 2); // remove --cdp-port and its value
}
// Remove --no-shared too
const noSharedIdx = process.argv.indexOf('--no-shared');
if (noSharedIdx !== -1) process.argv.splice(noSharedIdx, 1);

// --idle-tab-timeout-min N : auto-close any tab whose tabId hasn't been used
// as the target of a tool call for N minutes. 0 = disabled (default).
// Useful when multiple agents share a Chrome — without this, stale tabs
// accumulate forever because nothing reliably closes them.
let idleTabTimeoutMs = 0;
const idleIdx = process.argv.indexOf('--idle-tab-timeout-min');
if (idleIdx !== -1 && process.argv[idleIdx + 1]) {
  const mins = parseFloat(process.argv[idleIdx + 1]);
  if (!isNaN(mins) && mins > 0) idleTabTimeoutMs = Math.round(mins * 60 * 1000);
  process.argv.splice(idleIdx, 2);
}

// --service-* / --humanize flags are custom; strip them before Commander parses,
// and keep --service-key out of argv so it can never reach a log line.
function takeFlagValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1] !== undefined && !process.argv[idx + 1].startsWith('--')) {
    const value = process.argv[idx + 1];
    process.argv.splice(idx, 2);
    return value;
  }
  return undefined;
}
function takeBoolFlag(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1) {
    process.argv.splice(idx, 1);
    return true;
  }
  return false;
}

const hasCdpEndpoint = process.argv.includes('--cdp-endpoint');
const serviceUrl = takeFlagValue('--service-url');
const serviceKey = takeFlagValue('--service-key');
const sessionKeyFlag = takeFlagValue('--session-key');
const contextIdFlag = takeFlagValue('--context-id');
const ownerIdFlag = takeFlagValue('--owner-id');
const persistFlag = takeBoolFlag('--persist');
const proxyFlag = takeFlagValue('--proxy');
const solveCaptchasFlag = takeBoolFlag('--solve-captchas');
const humanizeFlag = takeFlagValue('--humanize');
const humanizeSeedFlag = takeFlagValue('--humanize-seed');

const serviceMode = !!serviceUrl && !hasCdpEndpoint;
const humanizeEnabled = humanizeFlag !== undefined ? humanizeFlag !== 'off' : serviceMode;
const humanSeed = humanizeSeedFlag !== undefined ? parseInt(humanizeSeedFlag, 10) : undefined;
const human = humanizeEnabled ? new HumanInput({ seed: humanSeed }) : null;

let serviceConnectUrl = null;
let sessionLifecycle = null;

// --- Tab ID Router ---
class TabIdRouter {
  constructor() {
    // tabId -> tab object, never an index. Positions shift whenever any tab
    // closes, so an index map silently re-points every id past the closed one
    // at its neighbour's tab — one agent's next call then lands on another
    // agent's page, the exact interference this router exists to prevent.
    this._tabIdToTab = new Map();
    this._tabIdToLastActivity = new Map();
    this._mutex = Promise.resolve();
    this._sweeperStarted = false;
    this._lastContext = null;
  }

  markActivity(tabId) {
    if (!tabId) return;
    this._tabIdToLastActivity.set(tabId, Date.now());
  }

  /// Idle sweeper: every 30s, walk known tabIds and close ones that have been
  /// inactive longer than the configured threshold. No-op if threshold is 0.
  startIdleSweeper(thresholdMs) {
    if (this._sweeperStarted || !thresholdMs) return;
    this._sweeperStarted = true;
    setInterval(async () => {
      const context = this._lastContext;
      if (!context) return;
      const now = Date.now();
      for (const [tabId, lastActivity] of [...this._tabIdToLastActivity.entries()]) {
        if (now - lastActivity < thresholdMs) continue;
        const tab = this._tabIdToTab.get(tabId);
        if (!tab) {
          this._tabIdToLastActivity.delete(tabId);
          continue;
        }
        try {
          const page = tab?.page || tab; // tab object varies; playwright page has close()
          if (page && typeof page.close === 'function' && !page.isClosed?.()) {
            await page.close();
            process.stderr.write(`[idle-sweeper] closed tab "${tabId}" (idle ${Math.round((now - lastActivity) / 1000)}s)\n`);
          }
        } catch (err) {
          process.stderr.write(`[idle-sweeper] failed to close "${tabId}": ${err?.message || err}\n`);
        } finally {
          // Only this id's registration goes; the others still hold valid tab
          // objects. Under the old index map they could not — a sweep shifted
          // every surviving id above the closed one, and dropping just the
          // swept entry left the rest quietly pointing at the wrong tabs.
          this._tabIdToTab.delete(tabId);
          this._tabIdToLastActivity.delete(tabId);
        }
      }
    }, Math.min(30_000, thresholdMs)).unref?.();
  }

  async run(fn) {
    const prev = this._mutex;
    let resolve;
    this._mutex = new Promise(r => resolve = r);
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
    }
  }

  // `create` is false for close operations: creating a tab in order to close
  // one is how an unknown or already-swept id ends up spawning a fresh tab and
  // then closing something else.
  async ensureTab(context, tabId, { create = true } = {}) {
    if (!tabId) return;
    this._lastContext = context;

    const known = this._tabIdToTab.get(tabId);
    if (known) {
      const index = context.tabs().indexOf(known);
      if (index !== -1 && !known.page?.isClosed?.()) {
        await context.selectTab(index);
        return;
      }
      // Gone — swept, or closed by the page itself. Drop it rather than
      // letting a stale entry resolve to whatever now sits in its place.
      this._tabIdToTab.delete(tabId);
      this._tabIdToLastActivity.delete(tabId);
    }

    if (!create) return;

    await context.newTab();
    const tab = context.currentTab?.() ?? context.tabs()[context.tabs().length - 1];
    if (tab) this._tabIdToTab.set(tabId, tab);
  }

  forget(tabId) {
    if (!tabId) return;
    this._tabIdToTab.delete(tabId);
    this._tabIdToLastActivity.delete(tabId);
  }
}

// --- Shared Chrome via CDP ---

// Resolve a Chrome executable for the current platform.
// Honors $PLAYWRIGHT_MCP_CHROME_PATH first, then platform defaults, then PATH.
function resolveChromePath() {
  const fs = require('fs');
  const { execSync } = require('child_process');

  if (process.env.PLAYWRIGHT_MCP_CHROME_PATH && fs.existsSync(process.env.PLAYWRIGHT_MCP_CHROME_PATH))
    return process.env.PLAYWRIGHT_MCP_CHROME_PATH;

  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // Fall back to whatever's on PATH.
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
      try {
        const out = execSync(`${which} ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
        if (out) return out;
      } catch {}
    }
  } catch {}
  throw new Error('Chrome executable not found. Set PLAYWRIGHT_MCP_CHROME_PATH or install Google Chrome / Chromium.');
}

async function waitForCdpReady(cdpEndpoint, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const http = require('http');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${cdpEndpoint}/json/version`, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 400) resolve(); else reject(new Error(`status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(intervalMs * 2, () => { req.destroy(new Error('timeout')); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`CDP endpoint ${cdpEndpoint} did not become ready within ${timeoutMs}ms`);
}

async function getSharedBrowserContext(config) {
  const { chromium } = require('playwright-core');

  if (serviceConnectUrl) {
    const browser = await chromium.connectOverCDP(serviceConnectUrl);
    process.stderr.write('[service] connected to remote browser session over CDP\n');
    const contexts = browser.contexts();
    return contexts.length > 0 ? contexts[0] : await browser.newContext();
  }

  const cdpEndpoint = `http://localhost:${cdpPort}`;

  let browser;
  try {
    // Try connecting to existing Chrome
    browser = await chromium.connectOverCDP(cdpEndpoint);
    process.stderr.write(`[shared] connected to existing Chrome on port ${cdpPort}\n`);
  } catch {
    // No Chrome listening on this CDP port — spawn one ourselves.
    const userDataDir = config.browser?.userDataDir || '';
    const headless = config.browser?.launchOptions?.headless ?? false;
    const { spawn } = require('child_process');

    const chromePath = resolveChromePath();
    const chromeArgs = [
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    if (userDataDir) chromeArgs.push(`--user-data-dir=${path.resolve(userDataDir)}`);
    if (headless) chromeArgs.push('--headless=new');

    process.stderr.write(`[shared] launching ${chromePath} with CDP on port ${cdpPort}\n`);
    const chromeProc = spawn(chromePath, chromeArgs, {
      detached: true,
      stdio: 'ignore',
    });
    chromeProc.unref();

    await waitForCdpReady(cdpEndpoint);

    browser = await chromium.connectOverCDP(cdpEndpoint);
    process.stderr.write(`[shared] launched Chrome and connected via CDP on port ${cdpPort}\n`);
  }

  // Get or create a context
  const contexts = browser.contexts();
  return contexts.length > 0 ? contexts[0] : await browser.newContext();
}

function buildSharedConfig() {
  return {
    browser: {
      userDataDir: process.argv.includes('--user-data-dir')
        ? process.argv[process.argv.indexOf('--user-data-dir') + 1]
        : '',
      launchOptions: {
        headless: process.argv.includes('--headless'),
      },
    },
  };
}

function isContextDeadError(err) {
  const msg = String(err && (err.message || err));
  return /Target page, context or browser has been closed|Target closed|Browser has been closed|browser has disconnected|Connection closed|Browser closed|WebSocket is not open/i.test(msg);
}

function isBrowserContextAlive(browserContext) {
  if (!browserContext) return false;
  try {
    const browser = browserContext.browser?.();
    if (!browser) return false;
    return browser.isConnected?.() !== false;
  } catch {
    return false;
  }
}

// --- Monkey-patch mcpServer.start ---
const originalStart = mcpServer.start;
const router = new TabIdRouter();
router.startIdleSweeper(idleTabTimeoutMs);

Object.defineProperty(mcpServer, 'start', {
  value: async function patchedStart(factory, options) {
  // 1. Add tabId to every tool schema
  factory.toolSchemas = factory.toolSchemas.map(schema => {
    if (!schema.inputSchema || !schema.inputSchema.shape) return schema;

    const newShape = { ...schema.inputSchema.shape };
    newShape.tabId = zod.string().describe(
      'REQUIRED. Unique tab identifier for browser tab isolation. Generate by combining your task or target site with a short random suffix (e.g. "eldiario-a3f", "search-google-9kx"). Reuse the SAME tabId across all your calls to stay on your tab. Different agents MUST use different tabIds to avoid conflicts.'
    );

    return { ...schema, inputSchema: zod.object(newShape) };
  });

  // 2. Wrap factory.create to intercept callTool on the backend
  const originalCreate = factory.create;
  factory.create = async function(clientInfo) {
    let backend;

    // Helper that (re)builds the shared backend's underlying browser context
    // and re-initializes it. Used both on first create and on dead-browser
    // recovery. We mutate `backend` in place so the gateway's reference stays
    // valid.
    const reinitSharedBackend = async () => {
      const browserContext = await getSharedBrowserContext(buildSharedConfig());
      const caps = ['core', 'core-navigation', 'core-tabs', 'core-input'];
      const tools = filteredTools({ capabilities: caps });
      if (human) wrapHumanizedTools(tools, human);
      if (backend) {
        // Drop the stale Context wrapper if any.
        await backend._context?.dispose().catch(() => {});
        backend._context = undefined;
        backend.browserContext = browserContext;
        backend._tools = tools;
        backend._config = { capabilities: caps };
        await backend.initialize(clientInfo);
      } else {
        backend = new BrowserBackend({ capabilities: caps }, browserContext, tools);
        await backend.initialize(clientInfo);
      }
      // Tab indices belong to the dead context — clear them.
      router._tabIdToTab.clear();
      router._tabIdToLastActivity.clear();
    };

    if (isShared) {
      await reinitSharedBackend();
    } else {
      // Normal mode: use the original factory
      backend = await originalCreate.call(this, clientInfo);
    }

    // Wrap callTool for tab routing + (in shared mode) auto-recovery from a
    // dead browser. If the user kills Chrome between calls, transparently
    // relaunch it and replay the call once.
    const originalCallTool = backend.callTool.bind(backend);
    backend.callTool = async (name, rawArgs, progress) => {
      const { tabId, ...args } = rawArgs || {};

      // Record activity for the idle sweeper. Done outside router.run so
      // even concurrent tool calls update the timestamp.
      router.markActivity(tabId);

      return router.run(async () => {
        // Two tools can close a tab, and they address tabs differently:
        //   browser_close  closes the current page
        //   browser_tabs   takes a raw `index`, which the model guesses
        //
        // That raw index is the hole in tab isolation: it names a position in
        // a list the model cannot see reliably, so a close aimed at its own
        // tab lands on whichever tab currently occupies that slot — typically
        // another agent's. Below, an explicit index is dropped and the call is
        // re-aimed at the tab the caller's own tabId owns. Selecting by index
        // is rewritten the same way, for the same reason.
        const isTabsTool = name === 'browser_tabs';
        const tabsAction = isTabsTool ? args?.action : undefined;
        const isClose = name === 'browser_close'
          || (isTabsTool && tabsAction === 'close');
        const needsOwnTab = isClose || (isTabsTool && tabsAction === 'select');

        const performCall = async () => {
          let callArgs = args;
          if (backend._context && tabId) {
            await router.ensureTab(backend._context, tabId, { create: !isClose });
            if (needsOwnTab && callArgs && callArgs.index !== undefined) {
              // ensureTab already selected the caller's tab; letting the
              // model's index through would override that choice.
              const { index, ...rest } = callArgs;
              callArgs = rest;
            }
          }
          const result = await originalCallTool.call(backend, name, callArgs, progress);
          if (isClose) router.forget(tabId);
          return result;
        };

        // Pre-check liveness in shared mode — cheaper than reacting to errors
        // and avoids partial side effects.
        if (isShared && !isBrowserContextAlive(backend.browserContext)) {
          process.stderr.write('[shared] cached browser context is dead; re-launching Chrome\n');
          await reinitSharedBackend();
        }

        try {
          return await performCall();
        } catch (err) {
          if (!isShared || !isContextDeadError(err)) throw err;
          process.stderr.write('[shared] tool call hit a closed browser; re-launching and retrying once\n');
          await reinitSharedBackend();
          return await performCall();
        }
      });
    };

    return backend;
  };

  // In shared mode, don't kill Chrome on dispose
  if (isShared) {
    const originalDisposed = factory.disposed;
    factory.disposed = async (backend) => {
      // Just dispose the backend, don't close the browser
      await backend.dispose?.();
      process.stderr.write(`[shared] disconnected from Chrome (Chrome stays running)\n`);
    };
  }

  factory.name = 'Playwright Multiple';
  factory.nameInConfig = 'playwright-multiple';

  return originalStart.call(this, factory, options);
  },
  writable: true,
  configurable: true,
});

// --- Run the original CLI (calls our patched start) ---
const { program } = require('playwright-core/lib/utilsBundle');
const { decorateMCPCommand } = require('playwright-core/lib/tools/mcp/program');

if (process.argv.includes('install-browser')) {
  const argv = process.argv.map(arg => arg === 'install-browser' ? 'install' : arg);
  const { program: mainProgram } = require('playwright-core/lib/cli/program');
  mainProgram.parse(argv);
  return;
}

const packageJSON = require('./package.json');
const p = program.version('Version ' + packageJSON.version).name('Playwright Multiple');
decorateMCPCommand(p, packageJSON.version);

async function shutdown(code) {
  if (sessionLifecycle) {
    try {
      await sessionLifecycle.release();
    } catch {
      // best effort; the service idle timeout is the backstop
    }
  }
  process.exit(code);
}

process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(130); });

async function main() {
  if (serviceMode) {
    sessionLifecycle = new SessionLifecycle({
      serviceUrl,
      serviceKey,
      sessionKey: sessionKeyFlag,
      contextId: contextIdFlag,
      ownerId: ownerIdFlag,
      persist: persistFlag,
      proxy: proxyFlag,
      solveCaptchas: solveCaptchasFlag,
    });
    serviceConnectUrl = await sessionLifecycle.acquire();
  }
  await program.parseAsync(process.argv);
}

void main();
