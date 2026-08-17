'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionRegistry } = require('../lib/session/registry');
const { startMockService } = require('./helpers/mockService');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-reg-'));
}

function fakeService() {
  const state = { createCount: 0, deleteCount: 0, alive: new Set() };
  return {
    state,
    create: async () => {
      state.createCount += 1;
      const id = `S${state.createCount}`;
      state.alive.add(id);
      return { id, connectUrl: `ws://host/cdp?token=tok-${state.createCount}` };
    },
    isAlive: async (id) => state.alive.has(id),
    del: async (id) => { state.deleteCount += 1; state.alive.delete(id); },
  };
}

test('session is deleted only when the last process exits (refcount)', async () => {
  const dir = tmpDir();
  const alivePids = new Set([1001, 1002]);
  const pidAlive = (pid) => alivePids.has(pid);
  const svc = fakeService();
  const key = 'shared-key';

  const regA = new SessionRegistry({ dir, pid: 1001, pidAlive });
  const regB = new SessionRegistry({ dir, pid: 1002, pidAlive });

  const a = await regA.acquire(key, svc.create, svc.isAlive);
  assert.equal(a.reused, false);
  assert.equal(svc.state.createCount, 1);

  const b = await regB.acquire(key, svc.create, svc.isAlive);
  assert.equal(b.reused, true, 'second process must reuse the same session');
  assert.equal(svc.state.createCount, 1, 'no second session created');
  assert.equal(b.connectUrl, a.connectUrl);

  const rel1 = await regA.release(key, svc.del);
  assert.equal(rel1.deleted, false, 'session must survive while process B holds it');
  assert.equal(svc.state.deleteCount, 0);

  const rel2 = await regB.release(key, svc.del);
  assert.equal(rel2.deleted, true, 'last process release must delete the session');
  assert.equal(svc.state.deleteCount, 1);
});

test('a dead session in the registry is replaced, not reused', async () => {
  const dir = tmpDir();
  const pidAlive = () => true;
  const svc = fakeService();
  const key = 'ctx-1';

  const regA = new SessionRegistry({ dir, pid: 2001, pidAlive });
  const a = await regA.acquire(key, svc.create, svc.isAlive);
  assert.equal(a.reused, false);
  assert.equal(a.sessionId, 'S1');

  svc.state.alive.delete('S1');

  const regB = new SessionRegistry({ dir, pid: 2002, pidAlive });
  const b = await regB.acquire(key, svc.create, svc.isAlive);
  assert.equal(b.reused, false, 'dead session must not be reused');
  assert.equal(b.sessionId, 'S2');
  assert.equal(svc.state.createCount, 2);
  assert.notEqual(b.connectUrl, a.connectUrl);
});

test('a stale lock is stolen so acquisition never deadlocks', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'sessions.json.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, ts: Date.now() - 60000 }));
  const svc = fakeService();

  const reg = new SessionRegistry({ dir, pid: 3001, pidAlive: () => true, staleLockMs: 15000 });
  const result = await reg.acquire('k', svc.create, svc.isAlive);
  assert.equal(result.reused, false);
  assert.equal(svc.state.createCount, 1);
  assert.ok(!fs.existsSync(lockFile), 'lock released after acquire');
});

test('two concurrent processes with the same session key produce exactly one session', async () => {
  const dir = tmpDir();
  const mock = await startMockService();
  const key = 'cron-race';

  const runWorker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'acquireWorker.js')], {
      env: { ...process.env, SVC: mock.baseUrl, REGDIR: dir, KEY: key },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker failed: ${err}`));
      resolve(JSON.parse(out.trim()));
    });
  });

  const [r1, r2] = await Promise.all([runWorker(), runWorker()]);
  assert.equal(mock.state.createCount, 1, 'exactly one session created across both processes');
  assert.equal(r1.connectUrl, r2.connectUrl, 'both processes share the same connectUrl');
  assert.equal(r1.sessionId, r2.sessionId);
  await mock.close();
});
