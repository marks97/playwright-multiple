'use strict';

const fs = require('fs');
const path = require('path');

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SessionRegistry {
  constructor(options = {}) {
    this.dir = options.dir || path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'playwright-multiple');
    this.file = path.join(this.dir, 'sessions.json');
    this.lockFile = `${this.file}.lock`;
    this.pid = options.pid || process.pid;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || sleep;
    this.pidAlive = options.pidAlive || defaultPidAlive;
    this.lockTimeoutMs = options.lockTimeoutMs || 10000;
    this.staleLockMs = options.staleLockMs || 15000;
    this.lockRetryMs = options.lockRetryMs || 25;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  tryTakeLock() {
    try {
      const fd = fs.openSync(this.lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: this.pid, ts: this.now() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  }

  lockIsStale() {
    try {
      const raw = fs.readFileSync(this.lockFile, 'utf8');
      const parsed = JSON.parse(raw);
      return this.now() - (parsed.ts || 0) > this.staleLockMs;
    } catch {
      try {
        const stat = fs.statSync(this.lockFile);
        return this.now() - stat.mtimeMs > this.staleLockMs;
      } catch {
        return true;
      }
    }
  }

  async acquireLock() {
    this.ensureDir();
    const deadline = this.now() + this.lockTimeoutMs;
    for (;;) {
      if (this.tryTakeLock()) return;
      if (this.lockIsStale()) {
        try {
          fs.unlinkSync(this.lockFile);
        } catch {
          // another process may have taken it; fall through and retry
        }
        if (this.tryTakeLock()) return;
      }
      if (this.now() >= deadline) throw new Error('failed to acquire session registry lock');
      await this.sleep(this.lockRetryMs);
    }
  }

  releaseLock() {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // already gone
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  write(registry) {
    this.ensureDir();
    const tmp = `${this.file}.tmp-${this.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, this.file);
  }

  pruneDeadEntries(registry, exceptKey) {
    for (const key of Object.keys(registry)) {
      if (key === exceptKey) continue;
      const entry = registry[key];
      if (!entry || !Array.isArray(entry.pid)) {
        delete registry[key];
        continue;
      }
      entry.pid = entry.pid.filter((pid) => this.pidAlive(pid));
      entry.refcount = entry.pid.length;
      if (entry.pid.length === 0) delete registry[key];
    }
    return registry;
  }

  async acquire(key, createSession, isAlive) {
    await this.acquireLock();
    try {
      const registry = this.read();
      const entry = registry[key];
      if (entry && entry.sessionId && (await isAlive(entry.sessionId))) {
        const pids = (entry.pid || []).filter((pid) => this.pidAlive(pid));
        if (!pids.includes(this.pid)) pids.push(this.pid);
        entry.pid = pids;
        entry.refcount = pids.length;
        registry[key] = entry;
        this.pruneDeadEntries(registry, key);
        this.write(registry);
        return { sessionId: entry.sessionId, connectUrl: entry.connectUrl, reused: true };
      }
      const created = await createSession();
      registry[key] = {
        sessionId: created.id,
        connectUrl: created.connectUrl,
        refcount: 1,
        pid: [this.pid],
        createdAt: this.now(),
      };
      this.pruneDeadEntries(registry, key);
      this.write(registry);
      return { sessionId: created.id, connectUrl: created.connectUrl, reused: false };
    } finally {
      this.releaseLock();
    }
  }

  async release(key, deleteSession) {
    await this.acquireLock();
    try {
      const registry = this.read();
      const entry = registry[key];
      if (!entry) {
        this.pruneDeadEntries(registry, key);
        this.write(registry);
        return { deleted: false };
      }
      entry.pid = (entry.pid || []).filter((pid) => pid !== this.pid && this.pidAlive(pid));
      entry.refcount = entry.pid.length;
      let deleted = false;
      const sessionId = entry.sessionId;
      if (entry.pid.length === 0) {
        delete registry[key];
        deleted = true;
        try {
          await deleteSession(sessionId);
        } catch {
          // service may already have reaped it; local state is cleaned regardless
        }
      } else {
        registry[key] = entry;
      }
      this.pruneDeadEntries(registry, key);
      this.write(registry);
      return { deleted, sessionId };
    } finally {
      this.releaseLock();
    }
  }
}

module.exports = { SessionRegistry, defaultPidAlive };
