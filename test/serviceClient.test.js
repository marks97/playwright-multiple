'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ServiceClient } = require('../lib/session/serviceClient');
const { buildCreateBody, resolveShareKey } = require('../lib/session/lifecycle');

function clientWithSessions(sequence) {
  let call = 0;
  const client = new ServiceClient({ baseUrl: 'http://x', apiKey: 'k', fetch: async () => ({}) });
  client.getSession = async () => {
    const value = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    return value;
  };
  return client;
}

test('waitForRunning polls until the session reports running with a connectUrl', async () => {
  const client = clientWithSessions([
    { id: 's1', status: 'pending', connectUrl: null },
    { id: 's1', status: 'pending', connectUrl: null },
    { id: 's1', status: 'running', connectUrl: 'ws://host/cdp?token=t' },
  ]);
  const ready = await client.waitForRunning('s1', { intervalMs: 1 });
  assert.equal(ready.status, 'running');
  assert.equal(ready.connectUrl, 'ws://host/cdp?token=t');
});

test('waitForRunning throws when the session fails', async () => {
  const client = clientWithSessions([
    { id: 's1', status: 'pending', connectUrl: null },
    { id: 's1', status: 'failed', connectUrl: null, stoppedReason: 'boom' },
  ]);
  await assert.rejects(() => client.waitForRunning('s1', { intervalMs: 1 }), /failed: boom/);
});

test('waitForRunning throws on timeout', async () => {
  const client = clientWithSessions([{ id: 's1', status: 'pending', connectUrl: null }]);
  await assert.rejects(
    () => client.waitForRunning('s1', { timeoutMs: 5, intervalMs: 1 }),
    /did not become ready/,
  );
});

test('shareKey defaults to the session key so existing configs get sharing for free', () => {
  assert.equal(resolveShareKey({ sessionKey: 'play4row' }), 'play4row');
  assert.equal(resolveShareKey({ shareKey: 'explicit', sessionKey: 'play4row' }), 'explicit');
  assert.equal(buildCreateBody({ sessionKey: 'play4row' }).shareKey, 'play4row');
  assert.equal(buildCreateBody({ shareKey: 'grp', sessionKey: 'play4row' }).shareKey, 'grp');
});
