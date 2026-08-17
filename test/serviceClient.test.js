'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ServiceClient, isPrivateHost } = require('../lib/session/serviceClient');
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

test('isPrivateHost treats container and tailnet addresses as reachable directly', () => {
  for (const host of [
    'browser-infra-service',
    'marcserver',
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.9',
    '192.168.1.10',
    '100.109.202.122',
    'box.local',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }
});

test('isPrivateHost treats real public hostnames as public', () => {
  for (const host of ['browser.marcamoros.dev', 'example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
    assert.equal(isPrivateHost(host), false, `${host} should be public`);
  }
});

test('a docker-network service url picks the direct connectUrl, not the tunnel', () => {
  const onNetwork = new ServiceClient({ baseUrl: 'http://browser-infra-service:8090', apiKey: 'k' });
  const remote = new ServiceClient({ baseUrl: 'https://browser.marcamoros.dev', apiKey: 'k' });
  const session = {
    connectUrl: 'ws://172.20.0.9:8080/cdp?token=t',
    publicConnectUrl: 'wss://browser.marcamoros.dev/v1/sessions/s1/cdp?token=t',
  };
  assert.equal(onNetwork.resolveConnectUrl(session), session.connectUrl);
  assert.equal(remote.resolveConnectUrl(session), session.publicConnectUrl);
});

test('resolveConnectUrl falls back when only one url is present', () => {
  const onNetwork = new ServiceClient({ baseUrl: 'http://browser-infra-service:8090', apiKey: 'k' });
  const remote = new ServiceClient({ baseUrl: 'https://browser.marcamoros.dev', apiKey: 'k' });
  assert.equal(onNetwork.resolveConnectUrl({ publicConnectUrl: 'wss://x/cdp' }), 'wss://x/cdp');
  assert.equal(remote.resolveConnectUrl({ connectUrl: 'ws://y/cdp' }), 'ws://y/cdp');
  assert.equal(remote.resolveConnectUrl(null), null);
});
