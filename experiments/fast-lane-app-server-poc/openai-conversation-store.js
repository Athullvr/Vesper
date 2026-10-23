"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OPENAI_PROVIDER_ID = "openai-chat-completions";
const CONVERSATION_SCHEMA_VERSION = 1;
const MAX_CONVERSATION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 120;
const MAX_CONVERSATION_MESSAGE_LENGTH = 256 * 1024;
const CONVERSATION_ID_PATTERN = /^oai_[0-9a-f-]{36}$/iu;

class OpenAIConversationStore {
  constructor({ directory, providerId = OPENAI_PROVIDER_ID, conversationPrefix = "oai" } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new TypeError("An absolute OpenAI conversation directory is required.");
    }
    if (typeof providerId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(providerId)) {
      throw new TypeError("A valid provider id is required for conversation storage.");
    }
    if (typeof conversationPrefix !== "string" || !/^[a-z][a-z0-9]{1,11}$/u.test(conversationPrefix)) {
      throw new TypeError("A valid provider conversation prefix is required.");
    }
    this.directory = path.resolve(directory);
    this.providerId = providerId;
    this.conversationPrefix = conversationPrefix;
  }

  create({ projectPath, modelId, baseUrlFingerprint }) {
    validateProjectPath(projectPath);
    const now = new Date().toISOString();
    const record = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      providerId: this.providerId,
      conversationId: `${this.conversationPrefix}_${crypto.randomUUID()}`,
      projectPath: path.resolve(projectPath),
      modelId: validateSafeField(modelId, "model identifier", 200),
      baseUrlFingerprint: validateSafeField(baseUrlFingerprint, "API base URL fingerprint", 64),
      status: "ready",
      pendingTaskId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.write(record);
    return record;
  }

  load(conversationId, projectPath) {
    validateConversationId(conversationId, this.conversationPrefix);
    validateProjectPath(projectPath);
    this.ensureDirectory();
    const filePath = this.filePath(conversationId);
    let descriptor;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (linkStat.isSymbolicLink() || !linkStat.isFile() || (linkStat.mode & 0o077) !== 0 || linkStat.size > MAX_CONVERSATION_FILE_BYTES) {
        throw new Error("OpenAI conversation metadata has an unsafe file type, permissions, or size.");
      }
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_CONVERSATION_FILE_BYTES) {
        throw new Error("OpenAI conversation metadata has an unsafe file type, permissions, or size.");
      }
      const raw = fs.readFileSync(descriptor, "utf8");
      const record = JSON.parse(raw);
      if (!isValidRecord(record, this.providerId, this.conversationPrefix) || record.conversationId !== conversationId) {
        throw new Error("OpenAI conversation metadata is invalid.");
      }
      if (path.resolve(record.projectPath) !== path.resolve(projectPath)) {
        throw new Error("The saved OpenAI conversation belongs to a different project folder.");
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("The saved OpenAI conversation was not found.");
      if (error instanceof SyntaxError) throw new Error("OpenAI conversation metadata is invalid JSON.");
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  beginTask(conversationId, projectPath, taskId, task) {
    const current = this.load(conversationId, projectPath);
    if (current.status === "uncertain" || current.status === "pending") {
      throw new Error("The saved OpenAI conversation has an unfinished request; start a new Vesper session to avoid resubmitting it.");
    }
    if (current.status === "unsupported") {
      throw new Error("The saved OpenAI conversation returned an unsupported tool request; start a new Vesper session.");
    }
    if (current.messages.length + 2 > MAX_CONVERSATION_MESSAGES) {
      throw new Error("The saved OpenAI conversation reached its message limit; start a new Vesper session to continue.");
    }
    const messages = [...current.messages, { role: "user", content: validateMessage(task, "user") }];
    const next = { ...current, status: "pending", pendingTaskId: taskId, messages, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  completeTask(conversationId, projectPath, taskId, assistantText) {
    const current = this.load(conversationId, projectPath);
    assertPendingTask(current, taskId);
    if (current.messages.length >= MAX_CONVERSATION_MESSAGES) {
      throw new Error("The saved OpenAI conversation reached its message limit; start a new Vesper session to continue.");
    }
    const messages = [...current.messages, { role: "assistant", content: validateMessage(assistantText, "assistant") }];
    const next = { ...current, status: "ready", pendingTaskId: null, messages, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  rejectTask(conversationId, projectPath, taskId) {
    const current = this.load(conversationId, projectPath);
    assertPendingTask(current, taskId);
    const messages = current.messages.slice(0, -1);
    const next = { ...current, status: "ready", pendingTaskId: null, messages, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  markUncertain(conversationId, projectPath, taskId, status = "uncertain") {
    const current = this.load(conversationId, projectPath);
    assertPendingTask(current, taskId);
    const next = { ...current, status, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error("OpenAI conversation directory must be private (0700) and cannot be a symbolic link.");
    }
  }

  write(record) {
    if (!isValidRecord(record, this.providerId, this.conversationPrefix)) throw new TypeError("Invalid provider conversation metadata.");
    this.ensureDirectory();
    const filePath = this.filePath(record.conversationId);
    try {
      const existing = fs.lstatSync(filePath);
      if (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o077) !== 0) {
        throw new Error("Refusing to replace unsafe OpenAI conversation metadata.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONVERSATION_FILE_BYTES) {
      throw new Error("The saved OpenAI conversation reached its local size limit; start a new Vesper session to continue.");
    }
    const temporaryPath = path.join(this.directory, `.${record.conversationId}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporaryPath); } catch { /* Temporary file may not exist. */ }
      throw error;
    }
  }

  filePath(conversationId) {
    validateConversationId(conversationId, this.conversationPrefix);
    return path.join(this.directory, `${conversationId}.json`);
  }
}

function assertPendingTask(record, taskId) {
  if (record.status !== "pending" || record.pendingTaskId !== taskId || !record.messages.length || record.messages.at(-1).role !== "user") {
    throw new Error("The saved OpenAI conversation no longer matches the active task.");
  }
}

function isValidRecord(record, providerId = OPENAI_PROVIDER_ID, conversationPrefix = "oai") {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const allowed = new Set([
    "schemaVersion", "providerId", "conversationId", "projectPath", "modelId", "baseUrlFingerprint",
    "status", "pendingTaskId", "messages", "createdAt", "updatedAt",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || Object.keys(record).length !== allowed.size) return false;
  if (record.schemaVersion !== CONVERSATION_SCHEMA_VERSION || record.providerId !== providerId) return false;
  if (!conversationIdPattern(conversationPrefix).test(record.conversationId || "")) return false;
  if (typeof record.projectPath !== "string" || !path.isAbsolute(record.projectPath) || /[\u0000-\u001f\u007f]/u.test(record.projectPath)) return false;
  if (typeof record.modelId !== "string" || !record.modelId || record.modelId.length > 200 || /[\u0000-\u001f\u007f\u009f]/u.test(record.modelId)) return false;
  if (typeof record.baseUrlFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(record.baseUrlFingerprint)) return false;
  if (!new Set(["ready", "pending", "uncertain", "unsupported"]).has(record.status)) return false;
  if (record.pendingTaskId !== null && (typeof record.pendingTaskId !== "string" || record.pendingTaskId.length > 80)) return false;
  if (record.status === "ready" && record.pendingTaskId !== null) return false;
  if (["pending", "uncertain", "unsupported"].includes(record.status) && !record.pendingTaskId) return false;
  if (!Array.isArray(record.messages) || record.messages.length > MAX_CONVERSATION_MESSAGES) return false;
  for (const message of record.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        Object.keys(message).length !== 2 || !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || message.content.length > MAX_CONVERSATION_MESSAGE_LENGTH || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message.content)) return false;
  }
  const createdAt = Date.parse(record.createdAt);
  const updatedAt = Date.parse(record.updatedAt);
  return Number.isFinite(createdAt) && Number.isFinite(updatedAt) && createdAt <= updatedAt;
}

function validateConversationId(value, conversationPrefix = "oai") {
  if (typeof value !== "string" || !conversationIdPattern(conversationPrefix).test(value)) throw new TypeError("Provider conversation id is invalid.");
}

function conversationIdPattern(prefix) {
  return prefix === "oai" ? CONVERSATION_ID_PATTERN : new RegExp(`^${prefix}_[0-9a-f-]{36}$`, "iu");
}

function validateProjectPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError("OpenAI conversation project path must be an absolute path.");
  }
}

function validateSafeField(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`OpenAI conversation ${label} is invalid.`);
  }
  return value;
}

function validateMessage(value, role) {
  if (typeof value !== "string" || value.length > MAX_CONVERSATION_MESSAGE_LENGTH || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`OpenAI ${role} message is malformed or exceeds its local size limit.`);
  }
  return value;
}

module.exports = {
  CONVERSATION_SCHEMA_VERSION,
  MAX_CONVERSATION_FILE_BYTES,
  MAX_CONVERSATION_MESSAGES,
  MAX_CONVERSATION_MESSAGE_LENGTH,
  OPENAI_PROVIDER_ID,
  OpenAIConversationStore,
  isValidRecord,
};
