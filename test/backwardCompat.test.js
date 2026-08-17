'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { startMockService } = require('./helpers/mockService');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('--service-url mode creates a session on startup', async () => {
  const mock = await startMockService();
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-bc-'));
  const res = await runCli(
    ['--service-url', mock.baseUrl, '--service-key', 'secret-key', '--help'],
    { XDG_RUNTIME_DIR: regdir },
  );
  assert.equal(mock.state.createCount, 1, 'service mode must create exactly one session');
  assert.ok(!res.out.includes('secret-key'), 'service key must never be printed');
  assert.ok(!res.err.includes('secret-key'), 'service key must never appear on stderr');
  await mock.close();
});

test('--cdp-endpoint wins over --service-url and creates no session', async () => {
  const mock = await startMockService();
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-bc-'));
  await runCli(
    ['--cdp-endpoint', 'http://127.0.0.1:9222', '--service-url', mock.baseUrl, '--service-key', 'secret-key', '--help'],
    { XDG_RUNTIME_DIR: regdir },
  );
  assert.equal(mock.state.createCount, 0, 'cdp-endpoint mode must not create a session');
  await mock.close();
});

test('legacy invocation with no service flags creates no session', async () => {
  const mock = await startMockService();
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-bc-'));
  await runCli(['--cdp-endpoint', 'http://127.0.0.1:9222', '--caps', 'vision', '--help'], { XDG_RUNTIME_DIR: regdir });
  assert.equal(mock.state.createCount, 0);
  await mock.close();
});
