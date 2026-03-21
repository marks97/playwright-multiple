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

// Parse --shared and --cdp-port early (before decorateMCPCommand consumes args)
const isShared = !process.argv.includes('--no-shared');
let cdpPort = 9222;
const cdpPortIdx = process.argv.indexOf('--cdp-port');
if (cdpPortIdx !== -1 && process.argv[cdpPortIdx + 1]) {
  cdpPort = parseInt(process.argv[cdpPortIdx + 1], 10);
}

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
async function getSharedBrowserContext(config) {
  const { chromium } = require('playwright-core');
  const cdpEndpoint = `http://localhost:${cdpPort}`;

  let browser;
  try {
    // Try connecting to existing Chrome
    browser = await chromium.connectOverCDP(cdpEndpoint);
    process.stderr.write(`[shared] connected to existing Chrome on port ${cdpPort}\n`);
  } catch {
    // No Chrome running — launch one with CDP
    const userDataDir = config.browser?.userDataDir || '';
    const headless = config.browser?.launchOptions?.headless ?? false;

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];

    process.stderr.write(`[shared] launching Chrome with CDP on port ${cdpPort}\n`);
    const launchedBrowser = await chromium.launch({
      channel: 'chrome',
      headless,
      args,
      ...config.browser?.launchOptions,
      // Override args to include our CDP port
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // Now connect via CDP to get a persistent connection
    // The launched browser exposes a CDP endpoint
    const wsEndpoint = launchedBrowser.contexts()[0]?.pages()[0]?.context()?.browser()?.wsEndpoint?.();

    // Actually, simpler: just use the launched browser directly
    // But for shared mode, we need CDP so other processes can connect.
    // Launch Chrome manually with user-data-dir and CDP.
    await launchedBrowser.close();

    // Launch Chrome the raw way with user-data-dir + CDP
    const { execSync, spawn } = require('child_process');

    // Find Chrome
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromeArgs = [
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ];
    if (userDataDir) chromeArgs.push(`--user-data-dir=${path.resolve(userDataDir)}`);
    if (headless) chromeArgs.push('--headless=new');

    const chromeProc = spawn(chromePath, chromeArgs, {
      detached: true,
      stdio: 'ignore',
    });
    chromeProc.unref();

    // Wait for CDP to be ready
    for (let i = 0; i < 30; i++) {
      try {
        const http = require('http');
        await new Promise((resolve, reject) => {
          http.get(`${cdpEndpoint}/json/version`, (res) => {
            res.resume();
            resolve();
          }).on('error', reject);
        });
        break;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    browser = await chromium.connectOverCDP(cdpEndpoint);
    process.stderr.write(`[shared] launched Chrome and connected via CDP on port ${cdpPort}\n`);
  }

  // Get or create a context
  const contexts = browser.contexts();
  return contexts.length > 0 ? contexts[0] : await browser.newContext();
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
    newShape.tabId = zod.string().optional().describe(
      'Tab identifier for isolation. Each unique tabId gets its own browser tab. Omit for default tab.'
    );

    return { ...schema, inputSchema: zod.object(newShape) };
  });

  // 2. Wrap factory.create to intercept callTool on the backend
  const originalCreate = factory.create;
  factory.create = async function(clientInfo) {
    let backend;

    if (isShared) {
      // Shared mode: connect to Chrome via CDP instead of launching a new browser
      const { resolveCLIConfig } = require(path.join(pwCorePath, 'lib/tools/mcp/config.js'));
      // We need the config to know headless, userDataDir etc.
      // But config is already resolved inside decorateMCPCommand's action.
      // We can access it via the tools that were already filtered.
      // Actually, we just need the browserContext.
      const browserContext = await getSharedBrowserContext({
        browser: {
          userDataDir: process.argv.includes('--user-data-dir')
            ? process.argv[process.argv.indexOf('--user-data-dir') + 1]
            : '',
          launchOptions: {
            headless: process.argv.includes('--headless'),
          },
        },
      });

      const tools = filteredTools({ capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'] });
      backend = new BrowserBackend(
        { capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'] },
        browserContext,
        tools
      );
      await backend.initialize(clientInfo);
    } else {
      // Normal mode: use the original factory
      backend = await originalCreate.call(this, clientInfo);
    }

    // Wrap callTool for tab routing (both modes)
    const originalCallTool = backend.callTool.bind(backend);
    let firstCallDone = false;
    backend.callTool = async (name, rawArgs, progress) => {
      const { tabId, ...args } = rawArgs || {};

      return router.run(async () => {
        const ctx = backend._context;
        if (ctx && tabId) {
          if (!firstCallDone) {
            firstCallDone = true;
            if (ctx.tabs().length > 0 && !router._tabIdToIndex.has(tabId)) {
              router._tabIdToIndex.set(tabId, 0);
            }
          }
          await router.ensureTab(ctx, tabId);
        }
        return originalCallTool(name, args, progress);
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
