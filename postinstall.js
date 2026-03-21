#!/usr/bin/env node
/**
 * Postinstall: patches playwright-core's MCP server.js so that
 * exports are configurable (needed for monkey-patching start()).
 */
const fs = require('fs');
const path = require('path');

const serverPath = path.join(
  path.dirname(require.resolve('playwright-core/package.json')),
  'lib/tools/utils/mcp/server.js'
);

let code = fs.readFileSync(serverPath, 'utf-8');

if (code.includes('PATCHED_BY_PLAYWRIGHT_MULTIPLE')) {
  console.log('postinstall: already patched');
  process.exit(0);
}

// Patch __copyProps to add configurable: true
code = code.replace(
  '{ get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable }',
  '{ get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable, configurable: true } /* PATCHED_BY_PLAYWRIGHT_MULTIPLE */'
);

fs.writeFileSync(serverPath, code);
console.log('postinstall: patched server.js exports to be configurable');
