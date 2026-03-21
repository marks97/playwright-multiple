#!/usr/bin/env node
/**
 * Postinstall: patches playwright-core internals for playwright-multiple.
 *
 * 1. server.js: make exports configurable (needed for monkey-patching start())
 * 2. context.js: remove bringToFront() from selectTab to prevent focus stealing
 */
const fs = require('fs');
const path = require('path');

const pwCorePath = path.dirname(require.resolve('playwright-core/package.json'));

// --- Patch 1: server.js exports ---
const serverPath = path.join(pwCorePath, 'lib/tools/utils/mcp/server.js');
let serverCode = fs.readFileSync(serverPath, 'utf-8');

if (!serverCode.includes('PATCHED_BY_PLAYWRIGHT_MULTIPLE')) {
  serverCode = serverCode.replace(
    '{ get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable }',
    '{ get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable, configurable: true } /* PATCHED_BY_PLAYWRIGHT_MULTIPLE */'
  );
  fs.writeFileSync(serverPath, serverCode);
  console.log('postinstall: patched server.js exports to be configurable');
} else {
  console.log('postinstall: server.js already patched');
}

// --- Patch 2: context.js — remove bringToFront from selectTab ---
const contextPath = path.join(pwCorePath, 'lib/tools/backend/context.js');
let contextCode = fs.readFileSync(contextPath, 'utf-8');

if (!contextCode.includes('PATCHED_NO_BRING_TO_FRONT')) {
  contextCode = contextCode.replace(
    'await tab.page.bringToFront();',
    '/* await tab.page.bringToFront(); */ /* PATCHED_NO_BRING_TO_FRONT */'
  );
  fs.writeFileSync(contextPath, contextCode);
  console.log('postinstall: patched context.js to remove bringToFront()');
} else {
  console.log('postinstall: context.js already patched');
}
