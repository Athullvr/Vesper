"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SESSION_SCHEMA_VERSION = 1;
const MAX_SESSION_FILE_BYTES = 16_384;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_KEYS = new Set(["schemaVersion", "sessionId", "cwd", "threadId", "createdAt", "updatedAt"]);

class SessionStore {
  constructor({ directory = defaultSessionDirectory(), now = () => new Date() } = {}) {
    this.directory = path.resolve(directory);
    this.now = now;
  }

  create(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("Session project directory must be absolute.");
    const now = this.now().toISOString();
    const session = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: crypto.randomUUID(),
      cwd,
      threadId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.write(session);
    return session;
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
      return session;
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Vesper session ${sessionId} was not found.`);
      if (error instanceof SyntaxError) throw new Error("Vesper session metadata is invalid JSON.");
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  update(sessionId, changes) {
    const allowed = new Set(["cwd", "threadId"]);
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).some((key) => !allowed.has(key))) {
      throw new TypeError("Only the project directory and Codex thread id can be updated in session metadata.");
    }
    const current = this.load(sessionId);
    const next = { ...current, ...changes, updatedAt: this.now().toISOString() };
    this.write(next);
    return next;
  }

  write(session) {
    if (!isValidSession(session)) throw new TypeError("Invalid Vesper session metadata.");
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
  if (Object.keys(session).some((key) => !SESSION_KEYS.has(key)) || Object.keys(session).length !== SESSION_KEYS.size) return false;
  if (session.schemaVersion !== SESSION_SCHEMA_VERSION || !SESSION_ID_PATTERN.test(session.sessionId || "")) return false;
  if (typeof session.cwd !== "string" || !path.isAbsolute(session.cwd) || /[\u0000-\u001f\u007f]/u.test(session.cwd)) return false;
  if (session.threadId !== null && (typeof session.threadId !== "string" || !session.threadId || session.threadId.length > 256 || /[\u0000-\u001f\u007f]/u.test(session.threadId))) return false;
  const createdAt = Date.parse(session.createdAt);
  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(createdAt) && Number.isFinite(updatedAt) && createdAt <= updatedAt;
}

module.exports = {
  SESSION_SCHEMA_VERSION,
  SessionStore,
  defaultSessionDirectory,
  isValidSession,
};
