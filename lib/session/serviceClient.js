'use strict';

function redact(url) {
  return String(url).replace(/token=[^&\s]+/gi, 'token=***');
}

class ServiceClient {
  constructor(options = {}) {
    if (!options.baseUrl) throw new Error('serviceClient requires baseUrl');
    if (!options.apiKey) throw new Error('serviceClient requires apiKey');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 60000;
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (!response.ok) {
        const message = (parsed && (parsed.message || parsed.error)) || `status ${response.status}`;
        const error = new Error(`browser-infra ${method} ${path} failed: ${message}`);
        error.status = response.status;
        throw error;
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  async createSession(body) {
    return this.request('POST', '/v1/sessions', body || {});
  }

  async getSession(sessionId) {
    return this.request('GET', `/v1/sessions/${sessionId}`);
  }

  async deleteSession(sessionId) {
    return this.request('DELETE', `/v1/sessions/${sessionId}`);
  }

  async isAlive(sessionId) {
    try {
      const session = await this.getSession(sessionId);
      return !!session && session.status === 'running';
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
}

module.exports = { ServiceClient, redact };
