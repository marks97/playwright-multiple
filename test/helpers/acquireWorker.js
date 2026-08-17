'use strict';

const { SessionLifecycle } = require('../../lib/session/lifecycle');
const { SessionRegistry } = require('../../lib/session/registry');
const { ServiceClient } = require('../../lib/session/serviceClient');

const client = new ServiceClient({ baseUrl: process.env.SVC, apiKey: 'test' });
const registry = new SessionRegistry({ dir: process.env.REGDIR });
const lifecycle = new SessionLifecycle({ client, registry, sessionKey: process.env.KEY, log: () => {} });

lifecycle
  .acquire()
  .then((connectUrl) => {
    process.stdout.write(`${JSON.stringify({ connectUrl, sessionId: lifecycle.sessionId })}\n`);
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
