#!/usr/bin/env node
/**
 * Playwright MCP with tabId isolation.
 * Fork of @playwright/mcp — adds an optional `tabId` parameter to every tool,
 * allowing multiple agents to work on separate tabs in the same browser.
 *
 * Approach: require the internal server module via its absolute path in
 * node_modules (bypassing the exports map), then monkey-patch start()
 * to inject tabId into schemas and wrap callTool with tab routing.
 */

const path = require('path');

// Resolve the internal module path directly (bypasses package.json exports)
const pwCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const mcpServer = require(path.join(pwCorePath, 'lib/tools/utils/mcp/server.js'));
const { z: zod } = require(path.join(pwCorePath, 'lib/mcpBundle.js'));

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
      await context.newTab();
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

// --- Monkey-patch mcpServer.start ---
const originalStart = mcpServer.start;
const router = new TabIdRouter();

mcpServer.start = async function patchedStart(factory, options) {
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
    const backend = await originalCreate.call(this, clientInfo);

    const originalCallTool = backend.callTool.bind(backend);
    let firstCallDone = false;
    backend.callTool = async (name, rawArgs, progress) => {
      const { tabId, ...args } = rawArgs || {};

      return router.run(async () => {
        const ctx = backend._context;
        if (ctx && tabId) {
          // On first call, _context was just initialized by the framework.
          // The default tab (index 0) already exists. Register the first
          // tabId to it instead of creating a new tab.
          if (!firstCallDone) {
            firstCallDone = true;
            if (ctx.tabs().length > 0 && !router._tabIdToIndex.has(tabId)) {
              router._tabIdToIndex.set(tabId, 0);
              // Already on tab 0, no need to select
            }
          }
          await router.ensureTab(ctx, tabId);
        }
        return originalCallTool(name, args, progress);
      });
    };

    return backend;
  };

  factory.name = 'Playwright Multiple';
  factory.nameInConfig = 'playwright-multiple';

  return originalStart.call(this, factory, options);
};

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
