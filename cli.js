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

// --- Tab ID Router ---
class TabIdRouter {
  constructor() {
    this._tabIdToIndex = new Map();
    this._mutex = Promise.resolve();
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

  async ensureTab(context, tabId) {
    if (!tabId) return;

    if (!this._tabIdToIndex.has(tabId)) {
      const tab = await context.newTab();
      this._tabIdToIndex.set(tabId, context.tabs().length - 1);
      return;
    }

    const storedIndex = this._tabIdToIndex.get(tabId);
    if (storedIndex < context.tabs().length) {
      await context.selectTab(storedIndex);
    } else {
      await context.newTab();
      this._tabIdToIndex.set(tabId, context.tabs().length - 1);
    }
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
      router._tabIdToIndex.clear();
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

      return router.run(async () => {
        const performCall = async () => {
          if (backend._context && tabId) {
            await router.ensureTab(backend._context, tabId);
          }
          return originalCallTool.call(backend, name, args, progress);
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

void program.parseAsync(process.argv);
