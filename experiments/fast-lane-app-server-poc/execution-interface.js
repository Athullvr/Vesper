"use strict";

const EXECUTION_CONTRACT_VERSION = 1;
const MAX_NORMALIZED_EVENT_LENGTH = 64 * 1024;

const EXECUTION_EVENT_TYPES = Object.freeze(new Set([
  "connection-state",
  "conversation-state",
  "task-started",
  "task-identity",
  "text-delta",
  "command-activity",
  "approval-required",
  "approval-decided",
  "file-change",
  "task-progress",
  "tool-call",
  "tool-result",
  "task-state",
  "interrupt-requested",
  "connection-lost",
  "recovery-state",
]));

const EXECUTION_ERROR_CODES = Object.freeze(new Set([
  "PROVIDER_UNAVAILABLE",
  "UNSUPPORTED_OPERATION",
  "CONNECTION_LOST",
  "RESUME_FAILED",
  "SUBMISSION_OUTCOME_UNCERTAIN",
  "TASK_INTERRUPTED",
  "TASK_FAILED",
  "INVALID_REQUEST",
]));

const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "initialize",
  "startConversation",
  "resumeConversation",
  "readConversationHistory",
  "submitTask",
  "interrupt",
  "recover",
  "getState",
  "dispose",
]);

const PROVIDER_CAPABILITIES = Object.freeze([
  "streaming",
  "interruptions",
  "resume",
  "conversationHistory",
  "approvalEvents",
  "fileChanges",
  "commandExecutionEvents",
  "recovery",
  "persistentSessions",
]);

function createExecutionEvent(type, fields = {}) {
  if (!EXECUTION_EVENT_TYPES.has(type)) throw new TypeError(`Unsupported execution event type: ${String(type)}.`);
  const event = { contractVersion: EXECUTION_CONTRACT_VERSION, type };
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === "raw" || key === "params" || key === "payload" || key === "credentials" || key === "environment") continue;
    if (value === undefined) continue;
    event[key] = value;
  }
  let serialized;
  try { serialized = JSON.stringify(event); } catch { throw new TypeError("Execution event is not serializable."); }
  if (serialized.length > MAX_NORMALIZED_EVENT_LENGTH) throw new RangeError("Execution event exceeds the normalized event size limit.");
  return Object.freeze(event);
}

function createExecutionError(code, message, { providerId = null, retryable = false } = {}) {
  const safeCode = EXECUTION_ERROR_CODES.has(code) ? code : "TASK_FAILED";
  const error = new Error(boundText(message || "Execution failed."));
  error.name = "ExecutionError";
  error.code = safeCode;
  error.providerId = typeof providerId === "string" ? boundText(providerId).slice(0, 80) : null;
  error.retryable = Boolean(retryable);
  return error;
}

function unsupportedOperation(providerId, operation) {
  const name = typeof operation === "string" ? operation.slice(0, 80) : "operation";
  return createExecutionError("UNSUPPORTED_OPERATION", `Provider ${providerId} does not support ${name}.`, { providerId });
}

function assertExecutionProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("An execution provider is required.");
  if (typeof provider.id !== "string" || !provider.id.trim() || provider.id.length > 80) {
    throw new TypeError("Execution providers must declare a stable id.");
  }
  if (!provider.capabilities || typeof provider.capabilities !== "object") {
    throw new TypeError("Execution providers must declare their supported capabilities.");
  }
  for (const capability of PROVIDER_CAPABILITIES) {
    if (typeof provider.capabilities[capability] !== "boolean") {
      throw new TypeError(`Execution provider capability ${capability} must be explicitly true or false.`);
    }
  }
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") throw new TypeError(`Execution provider is missing ${method}().`);
  }
  if (typeof provider.on !== "function" || typeof provider.off !== "function") {
    throw new TypeError("Execution providers must emit normalized execution events.");
  }
  return provider;
}

function boundText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 800);
}

module.exports = {
  EXECUTION_CONTRACT_VERSION,
  EXECUTION_EVENT_TYPES,
  EXECUTION_ERROR_CODES,
  MAX_NORMALIZED_EVENT_LENGTH,
  PROVIDER_CAPABILITIES,
  REQUIRED_PROVIDER_METHODS,
  assertExecutionProvider,
  createExecutionError,
  createExecutionEvent,
  unsupportedOperation,
};
