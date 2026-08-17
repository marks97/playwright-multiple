'use strict';

const http = require('http');

function startMockService() {
  const state = { createCount: 0, deleteCount: 0, deadIds: new Set(), byShareKey: new Map() };

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url || '';
    if (req.method === 'POST' && url === '/v1/sessions') {
      const body = await readBody(req);
      if (body.shareKey && state.byShareKey.has(body.shareKey)) {
        const existingId = state.byShareKey.get(body.shareKey);
        if (!state.deadIds.has(existingId)) {
          send(202, { id: existingId, connectUrl: null, liveViewUrl: null, status: 'running' });
          return;
        }
      }
      state.createCount += 1;
      const id = `sess-${state.createCount}`;
      if (body.shareKey) state.byShareKey.set(body.shareKey, id);
      send(202, { id, connectUrl: null, liveViewUrl: null, status: 'pending' });
      return;
    }
    const match = url.match(/^\/v1\/sessions\/([^/?]+)/);
    if (req.method === 'GET' && match) {
      const id = match[1];
      if (state.deadIds.has(id)) {
        send(200, { id, status: 'stopped', connectUrl: null });
        return;
      }
      const seq = id.replace('sess-', '');
      send(200, {
        id,
        status: 'running',
        connectUrl: `ws://127.0.0.1:65535/cdp?token=tok-${seq}`,
      });
      return;
    }
    if (req.method === 'DELETE' && match) {
      state.deleteCount += 1;
      state.deadIds.add(match[1]);
      send(200, { ok: true });
      return;
    }
    send(404, { message: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startMockService };
