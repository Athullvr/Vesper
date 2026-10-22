"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SESSION_SCHEMA_VERSION = 2;
const LEGACY_SESSION_SCHEMA_VERSION = 1;
const DEFAULT_PROVIDER_ID = "codex-app-server";
const MAX_SESSION_FILE_BYTES = 16_384;
const MAX_PROJECT_SESSION_SCAN = 10_000;
const MAX_SESSION_LIST_ENTRIES = 50;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEGACY_SESSION_KEYS = new Set(["schemaVersion", "sessionId", "cwd", "threadId", "createdAt", "updatedAt"]);
const SESSION_KEYS = new Set([
  "schemaVersion", "sessionId", "cwd", "providerId", "providerConversationId",
  "status", "recovery", "createdAt", "updatedAt",
]);

class SessionStore {
  constructor({ directory = defaultSessionDirectory(), now = () => new Date() } = {}) {
    this.directory = path.resolve(directory);
    this.now = now;
  }

  create(cwd, { providerId = DEFAULT_PROVIDER_ID } = {}) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("Session project directory must be absolute.");
    if (typeof providerId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(providerId)) throw new TypeError("Session provider id is invalid.");
    const now = this.now().toISOString();
    const session = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: crypto.randomUUID(),
      cwd,
      providerId,
      providerConversationId: null,
      status: "new",
      recovery: null,
      createdAt: now,
      updatedAt: now,
    };
    this.write(session);
    return withLegacyCodexAlias(session);
  }

  load(sessionId) {
    validateSessionId(sessionId);
    this.ensureDirectory();
    const filePath = this.sessionPath(sessionId);
    let descriptor;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (linkStat.isSymbolicLink() || !linkStat.isFile() || (linkStat.mode & 0o077) !== 0 || linkStat.size > MAX_SESSION_FILE_BYTES) {
        throw new Error("Vesper session metadata has unsafe file type, permissions, or size.");
      }
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_SESSION_FILE_BYTES) {
        throw new Error("Vesper session metadata has unsafe file type, permissions, or size.");
      }
      const raw = fs.readFileSync(descriptor, "utf8");
      const session = JSON.parse(raw);
      if (!isValidSession(session) || session.sessionId !== sessionId) throw new Error("Vesper session metadata is invalid.");
      return withLegacyCodexAlias(normalizeSession(session));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Vesper session ${sessionId} was not found.`);
      if (error instanceof SyntaxError) throw new Error("Vesper session metadata is invalid JSON.");
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  findLatestByCwd(cwd) {
    return this.listByCwd(cwd, 1)[0] || null;
  }

  listByCwd(cwd, limit = MAX_SESSION_LIST_ENTRIES) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) {
      throw new TypeError("Session project directory must be an absolute path.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_LIST_ENTRIES) {
      throw new TypeError(`Session list limit must be an integer from 1 to ${MAX_SESSION_LIST_ENTRIES}.`);
    }
    this.ensureDirectory();
    const files = fs.readdirSync(this.directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/iu.test(name));
    if (files.length > MAX_PROJECT_SESSION_SCAN) {
      throw new Error("Too many Vesper sessions to safely find this project conversation.");
    }

    const sessions = [];
    for (const name of files) {
      const sessionId = name.slice(0, -5);
      const session = this.load(sessionId);
      if (path.resolve(session.cwd) !== path.resolve(cwd)) continue;
      sessions.push(session);
    }
    sessions.sort((left, right) => {
      const updatedOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (updatedOrder) return updatedOrder;
      if (right.sessionId === left.sessionId) return 0;
      return right.sessionId > left.sessionId ? 1 : -1;
    });
    return sessions.slice(0, limit);
  }

  update(sessionId, changes) {
    const allowed = new Set(["cwd", "providerConversationId", "threadId", "status", "recovery"]);
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).some((key) => !allowed.has(key))) {
      throw new TypeError("Only the project directory, provider conversation mapping, session status, and recovery state can be updated in session metadata.");
    }
    if (Object.hasOwn(changes, "threadId")) {
      if (Object.hasOwn(changes, "providerConversationId")) throw new TypeError("Specify only one provider conversation identifier.");
      changes = { ...changes, providerConversationId: changes.threadId };
      delete changes.threadId;
    }
    const current = this.load(sessionId);
    if (current.providerConversationId && changes.providerConversationId !== undefined &&
        changes.providerConversationId !== current.providerConversationId) {
      throw new Error("A Vesper session cannot be rebound to a different provider conversation.");
    }
    if (changes.recovery !== undefined) changes = { ...changes, recovery: normalizeRecovery(changes.recovery, this.now()) };
    const next = { ...current, ...changes, updatedAt: this.now().toISOString() };
    this.write(next);
    return withLegacyCodexAlias(next);
  }

  touch(sessionId) {
    const current = this.load(sessionId);
    const next = { ...current, updatedAt: this.now().toISOString() };
    this.write(next);
    return withLegacyCodexAlias(next);
  }

  write(session) {
    if (!isValidV2Session(session)) throw new TypeError("Invalid Vesper session metadata.");
    this.ensureDirectory();
    const filePath = this.sessionPath(session.sessionId);
    try {
      const existing = fs.lstatSync(filePath);
      if (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o077) !== 0) {
        throw new Error("Refusing to replace unsafe Vesper session metadata.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = path.join(this.directory, `.${session.sessionId}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(session, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be renamed.
      }
      throw error;
    }
  }

  ensureDirectory() {
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error("Vesper session directory must be a private, non-symlink directory (permissions 0700).");
    }
  }

  sessionPath(sessionId) {
    validateSessionId(sessionId);
    return path.join(this.directory, `${sessionId}.json`);
  }
}

function defaultSessionDirectory() {
  const root = process.env.VESPER_HOME
    ? path.resolve(process.env.VESPER_HOME)
    : path.join(os.homedir(), ".vesper");
  return path.join(root, "sessions");
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError("Vesper session id must be a UUID.");
  }
}

function isValidSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  if (session.schemaVersion === LEGACY_SESSION_SCHEMA_VERSION) return isValidLegacySession(session);
  return isValidV2Session(session);
}

function isValidLegacySession(session) {
  if (Object.keys(session).some((key) => !LEGACY_SESSION_KEYS.has(key)) || Object.keys(session).length !== LEGACY_SESSION_KEYS.size) return false;
  if (!SESSION_ID_PATTERN.test(session.sessionId || "")) return false;
  if (typeof session.cwd !== "string" || !path.isAbsolute(session.cwd) || /[\u0000-\u001f\u007f]/u.test(session.cwd)) return false;
  if (session.threadId !== null && !isValidConversationId(session.threadId)) return false;
  return validTimestamps(session);
}

function isValidV2Session(session) {
  if (!session || typeof session !== "object" || Array.isArray(session) ||
      Object.keys(session).some((key) => !SESSION_KEYS.has(key)) || Object.keys(session).length !== SESSION_KEYS.size) return false;
  if (session.schemaVersion !== SESSION_SCHEMA_VERSION || !SESSION_ID_PATTERN.test(session.sessionId || "")) return false;
  if (typeof session.cwd !== "string" || !path.isAbsolute(session.cwd) || /[\u0000-\u001f\u007f]/u.test(session.cwd)) return false;
  if (typeof session.providerId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(session.providerId)) return false;
  if (session.providerConversationId !== null && !isValidConversationId(session.providerConversationId)) return false;
  if (!new Set(["new", "active", "recovery-required"]).has(session.status)) return false;
  if (session.recovery !== null && !isValidRecovery(session.recovery)) return false;
  if (session.status === "recovery-required" && session.recovery === null) return false;
  return validTimestamps(session);
}

function isValidConversationId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTimestamps(session) {
  const createdAt = Date.parse(session.createdAt);
  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(createdAt) && Number.isFinite(updatedAt) && createdAt <= updatedAt;
}

function normalizeSession(session) {
  if (session.schemaVersion === SESSION_SCHEMA_VERSION) return session;
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: session.sessionId,
    cwd: session.cwd,
    providerId: DEFAULT_PROVIDER_ID,
    providerConversationId: session.threadId,
    status: session.threadId ? "active" : "new",
    recovery: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function withLegacyCodexAlias(session) {
  if (!session || session.providerId !== DEFAULT_PROVIDER_ID || Object.hasOwn(session, "threadId")) return session;
  Object.defineProperty(session, "threadId", {
    configurable: false,
    enumerable: false,
    get() { return this.providerConversationId; },
  });
  return session;
}

function normalizeRecovery(value, now) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Vesper provider recovery metadata.");
  const codes = new Set(["connection-lost", "resume-failed", "submission-outcome-uncertain"]);
  if (!codes.has(value.code)) throw new TypeError("Invalid Vesper provider recovery code.");
  return { code: value.code, observedAt: now.toISOString() };
}

function isValidRecovery(recovery) {
  return Boolean(recovery && typeof recovery === "object" && !Array.isArray(recovery) &&
    Object.keys(recovery).length === 2 &&
    ["connection-lost", "resume-failed", "submission-outcome-uncertain"].includes(recovery.code) &&
    Number.isFinite(Date.parse(recovery.observedAt)));
}

module.exports = {
  MAX_SESSION_LIST_ENTRIES,
  DEFAULT_PROVIDER_ID,
  SESSION_SCHEMA_VERSION,
  SessionStore,
  defaultSessionDirectory,
  isValidSession,
};
