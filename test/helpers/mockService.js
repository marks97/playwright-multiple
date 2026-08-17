'use strict';

const http = require('http');

function startMockService() {
  const state = { createCount: 0, deleteCount: 0, deadIds: new Set() };
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url || '';
    if (req.method === 'POST' && url === '/v1/sessions') {
      state.createCount += 1;
      const id = `sess-${state.createCount}`;
      send(201, {
        id,
        connectUrl: `ws://127.0.0.1:65535/cdp?token=tok-${state.createCount}`,
        status: 'running',
      });
      return;
    }
    const match = url.match(/^\/v1\/sessions\/([^/?]+)/);
    if (req.method === 'GET' && match) {
      const id = match[1];
      send(200, { id, status: state.deadIds.has(id) ? 'stopped' : 'running' });
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
