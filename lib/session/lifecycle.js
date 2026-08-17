'use strict';

const { ServiceClient } = require('./serviceClient');
const { SessionRegistry } = require('./registry');

function resolveSessionKey(options) {
  return options.sessionKey || options.contextId || 'default';
}

function resolveShareKey(options) {
  return options.shareKey || resolveSessionKey(options);
}

function buildCreateBody(options) {
  const body = {};
  if (options.contextId) body.contextId = options.contextId;
  if (options.ownerId) body.ownerId = options.ownerId;
  if (options.persist) body.persistContext = true;
  if (options.proxy && options.proxy !== 'none') body.proxy = options.proxy;
  if (options.solveCaptchas) body.solveCaptchas = true;
  if (options.locale) body.locale = options.locale;
  if (options.timezone) body.timezone = options.timezone;
  if (options.country) body.country = options.country;
  if (Number.isFinite(options.idleTimeoutMs)) body.idleTimeoutMs = options.idleTimeoutMs;
  const shareKey = resolveShareKey(options);
  if (shareKey) body.shareKey = shareKey;
  return body;
}

class SessionLifecycle {
  constructor(options = {}) {
    this.options = options;
    this.client = options.client || new ServiceClient({ baseUrl: options.serviceUrl, apiKey: options.serviceKey });
    this.registry = options.registry || new SessionRegistry({});
    this.key = resolveSessionKey(options);
    this.log = options.log || ((message) => process.stderr.write(`${message}\n`));
    this.released = false;
    this.sessionId = null;
    this.connectUrl = null;
  }

  async acquire() {
    const body = buildCreateBody(this.options);
    const result = await this.registry.acquire(
      this.key,
      async () => {
        const created = await this.client.createSession(body);
        this.log(`[service] created session ${created.id} for key "${this.key}" (status ${created.status || 'pending'})`);
        const ready = await this.client.waitForRunning(created.id);
        this.log(`[service] session ${ready.id} is ready for key "${this.key}"`);
        return { id: ready.id, connectUrl: ready.connectUrl };
      },
      (sessionId) => this.client.isAlive(sessionId)
    );
    this.sessionId = result.sessionId;
    this.connectUrl = result.connectUrl;
    if (!this.connectUrl) {
      const ready = await this.client.waitForRunning(this.sessionId);
      this.connectUrl = ready.connectUrl;
    }
    if (result.reused) this.log(`[service] reusing session ${result.sessionId} for key "${this.key}"`);
    return this.connectUrl;
  }

  async release() {
    if (this.released) return;
    this.released = true;
    try {
      const result = await this.registry.release(this.key, (sessionId) => this.client.deleteSession(sessionId));
      if (result.deleted) this.log(`[service] ended session ${this.sessionId} for key "${this.key}"`);
      else this.log(`[service] detached from session ${this.sessionId} for key "${this.key}"`);
    } catch (error) {
      this.log(`[service] release failed for key "${this.key}": ${error.message}`);
    }
  }
}

module.exports = { SessionLifecycle, resolveSessionKey, resolveShareKey, buildCreateBody };
