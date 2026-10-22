"use strict";

const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const path = require("node:path");
const {
  assertExecutionProvider,
  createExecutionError,
  createExecutionEvent,
  unsupportedOperation,
} = require("./execution-interface");
const { unavailableHistory } = require("./conversation-history");
const { OpenAIConversationStore, OPENAI_PROVIDER_ID } = require("./openai-conversation-store");

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const MAX_REQUEST_BODY_BYTES = 768 * 1024;
const MAX_STREAM_BYTES = 3 * 1024 * 1024;
const MAX_SSE_RECORD_BYTES = 64 * 1024;
const MAX_MODEL_LIST_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_TEXT_LENGTH = 256 * 1024;
const MAX_TEXT_EVENT_LENGTH = 32 * 1024;
const MAX_HISTORY_MESSAGES = 120;
const MAX_HISTORY_TEXT_LENGTH = 128 * 1024;
const DEVELOPER_MESSAGE = "You are Vesper's text-only coding assistant. You cannot inspect the user's project, run commands, apply patches, or verify file changes. Provide guidance or code as text and state when you need the user to apply or validate it.";
const SUPPORTED_FINISH_REASONS = new Set(["stop", "length", "content_filter"]);
const OPENAI_CAPABILITIES = Object.freeze({
  streaming: true,
  interruptions: true,
  resume: true,
  conversationHistory: true,
  approvalEvents: false,
  fileChanges: false,
  commandExecutionEvents: false,
  recovery: false,
  persistentSessions: true,
});

class OpenAIChatCompletionsProvider extends EventEmitter {
  constructor({
    environment = process.env,
    config,
    conversationDirectory,
    fetchImpl = globalThis.fetch,
    onConversationId,
    createId = () => crypto.randomUUID(),
  } = {}) {
    super();
    this.id = OPENAI_PROVIDER_ID;
    this.capabilities = OPENAI_CAPABILITIES;
    this.config = config ? normalizeConfig(config) : resolveOpenAIConfig(environment);
    this.fetchImpl = fetchImpl;
    this.onConversationId = typeof onConversationId === "function" ? onConversationId : null;
    this.createId = createId;
    this.store = new OpenAIConversationStore({ directory: conversationDirectory || defaultConversationDirectory() });
    this.disposed = false;
    this.conversationId = null;
    this.conversation = null;
    this.active = null;
    this.lastReachability = "unknown";
    this.lastAvailability = "unknown";
    this.projectPath = null;
  }

  getState() {
    const configured = this.config.errors.length === 0 && Boolean(this.fetchImpl);
    const conversationReady = Boolean(this.conversationId && this.conversation?.status === "ready");
    return Object.freeze({
      providerId: this.id,
      availability: this.disposed || !configured ? "unavailable" : this.lastAvailability,
      state: this.disposed ? "closed" : this.active ? "running" : this.conversation?.status || (configured ? "configured" : "unconfigured"),
      conversationId: this.conversationId,
      conversationReady,
      model: this.config.modelId || null,
      configured,
      apiKeyConfigured: this.config.apiKeyConfigured,
      reachability: this.lastReachability,
    });
  }

  async initialize({ projectPath, checkConnection = false } = {}) {
    this.assertLive();
    this.assertConfigured();
    if (!checkConnection) return Object.freeze({ providerId: this.id, configured: true, reachable: this.lastReachability });
    const startedAt = Date.now();
    const response = await this.fetchWithTimeout(`${this.config.baseUrl}/models`, { method: "GET" }, "PROVIDER_UNAVAILABLE");
    if (!response || typeof response.ok !== "boolean") {
      this.lastReachability = "no";
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The OpenAI-compatible API returned an invalid model-list response.", { providerId: this.id, retryable: true });
    }
    this.lastReachability = "yes";
    if (!response.ok) {
      await cancelResponse(response);
      this.lastAvailability = "unavailable";
      throw apiHttpError(response.status, true);
    }
    let body;
    try {
      body = await readBoundedResponseBody(response, MAX_MODEL_LIST_BODY_BYTES, Math.max(1, this.config.requestTimeoutMs - (Date.now() - startedAt)));
    } catch {
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The OpenAI-compatible API did not complete the bounded model-list response.", { providerId: this.id, retryable: true });
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The OpenAI-compatible API returned malformed model-list data.", { providerId: this.id, retryable: true });
    }
    if (!parsed || !Array.isArray(parsed.data)) {
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The OpenAI-compatible API returned an unsupported model-list response.", { providerId: this.id, retryable: true });
    }
    const modelAvailable = parsed.data.some((model) => model && model.id === this.config.modelId);
    this.lastReachability = "yes";
    this.lastAvailability = modelAvailable ? "available" : "unavailable";
    if (typeof projectPath === "string") this.projectPath = projectPath;
    return Object.freeze({ providerId: this.id, configured: true, reachable: true, modelAvailable });
  }

  async startConversation({ projectPath } = {}) {
    this.assertLive();
    this.assertConfigured();
    validateProjectPath(projectPath);
    if (this.conversationId && this.projectPath !== path.resolve(projectPath)) {
      throw createExecutionError("RESUME_FAILED", "This OpenAI provider instance is already bound to another project conversation. Start a separate Vesper session.", { providerId: this.id });
    }
    if (this.conversationId && this.projectPath === path.resolve(projectPath) && this.conversation?.status === "ready") {
      return Object.freeze({ providerId: this.id, conversationId: this.conversationId });
    }
    if (this.conversationId && ["pending", "uncertain"].includes(this.conversation?.status)) {
      throw submissionUncertain("This OpenAI conversation has an unconfirmed request and cannot be replaced. Start a separate Vesper session to continue.");
    }
    if (this.conversationId && this.conversation?.status === "unsupported") {
      throw unsupportedOperation(this.id, "continue a conversation after a tool request");
    }
    let record;
    try {
      record = this.store.create({
        projectPath: path.resolve(projectPath),
        modelId: this.config.modelId,
        baseUrlFingerprint: endpointFingerprint(this.config.baseUrl),
      });
    } catch {
      throw createExecutionError("TASK_FAILED", "Vesper could not create private local conversation storage; no API request was sent.", { providerId: this.id });
    }
    this.setConversation(record);
    try {
      await this.persistConversationId(record.conversationId);
    } catch (error) {
      this.conversationId = null;
      this.conversation = null;
      this.projectPath = null;
      throw error;
    }
    this.emitEvent("conversation-state", { state: "created", conversationId: record.conversationId });
    return Object.freeze({ providerId: this.id, conversationId: record.conversationId });
  }

  async resumeConversation({ projectPath, conversationId } = {}) {
    this.assertLive();
    this.assertConfigured();
    validateProjectPath(projectPath);
    if (!this.capabilities.resume) throw unsupportedOperation(this.id, "resume conversation");
    if (typeof conversationId !== "string" || !conversationId) {
      throw createExecutionError("RESUME_FAILED", "This Vesper session has no saved OpenAI conversation to resume.", { providerId: this.id });
    }
    this.emitEvent("conversation-state", { state: "resuming", conversationId });
    let record;
    try {
      record = this.store.load(conversationId, path.resolve(projectPath));
    } catch {
      throw createExecutionError("RESUME_FAILED", "The saved OpenAI conversation could not be loaded for this project.", { providerId: this.id, retryable: true });
    }
    if (record.modelId !== this.config.modelId || record.baseUrlFingerprint !== endpointFingerprint(this.config.baseUrl)) {
      throw createExecutionError("RESUME_FAILED", "The saved OpenAI conversation uses different provider settings. Restore its model and API base URL, or explicitly start a new session.", { providerId: this.id, retryable: true });
    }
    if (record.status === "pending" || record.status === "uncertain") {
      this.setConversation(record);
      throw createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", "The saved OpenAI request has no confirmed completion. Vesper kept its transcript and will not submit it again; start a new session to continue.", { providerId: this.id, retryable: false });
    }
    if (record.status === "unsupported") {
      this.setConversation(record);
      throw createExecutionError("UNSUPPORTED_OPERATION", "The saved OpenAI response requested a tool operation Vesper does not execute. Start a new session to continue with text-only responses.", { providerId: this.id });
    }
    this.setConversation(record);
    this.emitEvent("conversation-state", { state: "resumed", conversationId });
    return Object.freeze({ providerId: this.id, conversationId });
  }

  async readConversationHistory() {
    this.assertLive();
    if (!this.capabilities.conversationHistory) throw unsupportedOperation(this.id, "read conversation history");
    if (!this.conversationId || !this.projectPath) return emptyHistory();
    let record;
    try {
      record = this.store.load(this.conversationId, this.projectPath);
    } catch {
      return unavailableHistory("The saved OpenAI conversation history could not be read safely.");
    }
    const source = record.messages.slice(-MAX_HISTORY_MESSAGES);
    let visibleLength = 0;
    const entries = [];
    for (let index = Math.max(0, source.length - MAX_HISTORY_MESSAGES); index < source.length; index += 1) {
      const message = source[index];
      const label = message.role === "user" ? "User task" : "OpenAI text response · not executed";
      const remaining = MAX_HISTORY_TEXT_LENGTH - visibleLength - label.length;
      if (remaining <= 0) break;
      const text = message.content.slice(0, remaining);
      entries.push({
        id: `${record.conversationId}:${index}`,
        kind: message.role === "user" ? "user" : "assistant",
        label,
        text: text.length < message.content.length ? `${text}\n[history truncated]` : text,
      });
      visibleLength += label.length + text.length;
      if (text.length < message.content.length) break;
    }
    const partial = record.status !== "ready" || entries.length < record.messages.length;
    return {
      state: entries.length === 0 ? "empty" : partial ? "partial" : "available",
      entries,
      truncated: partial,
      text: record.status === "uncertain" || record.status === "pending"
        ? "Showing the locally saved transcript. The last request has no confirmed completion and was not resubmitted."
        : record.status === "unsupported"
          ? "Showing the locally saved transcript. A requested tool operation was not executed."
          : entries.length ? "Conversation history restored from Vesper's private local provider store." : "This OpenAI conversation has no saved messages yet.",
    };
  }

  async submitTask({ task, projectPath } = {}) {
    this.assertLive();
    this.assertConfigured();
    if (typeof task !== "string" || !task.trim() || task.length > 32 * 1024) {
      throw createExecutionError("INVALID_REQUEST", "A non-empty task of at most 32,768 characters is required.", { providerId: this.id });
    }
    validateProjectPath(projectPath);
    if (this.active) throw createExecutionError("INVALID_REQUEST", "This OpenAI provider already has an active request.", { providerId: this.id });
    if (!this.conversationId || this.projectPath !== path.resolve(projectPath)) await this.startConversation({ projectPath });
    let current;
    try { current = this.store.load(this.conversationId, this.projectPath); } catch {
      throw createExecutionError("RESUME_FAILED", "The saved OpenAI conversation could not be loaded safely; no API request was sent.", { providerId: this.id });
    }
    if (current.modelId !== this.config.modelId || current.baseUrlFingerprint !== endpointFingerprint(this.config.baseUrl)) {
      throw createExecutionError("RESUME_FAILED", "The saved OpenAI conversation uses different provider settings. Restore them or explicitly start a new session.", { providerId: this.id });
    }
    if (current.status === "pending" || current.status === "uncertain") {
      this.setConversation(current);
      throw createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", "The previous OpenAI request has no confirmed completion. Vesper will not submit it again; start a new session to continue.", { providerId: this.id });
    }
    if (current.status === "unsupported") {
      throw createExecutionError("UNSUPPORTED_OPERATION", "The saved OpenAI conversation is blocked after an unsupported tool request. Start a new session to continue.", { providerId: this.id });
    }

    const taskId = this.createId();
    const messages = [
      { role: "developer", content: DEVELOPER_MESSAGE },
      ...current.messages,
      { role: "user", content: task },
    ];
    const requestBody = JSON.stringify({
      model: this.config.modelId,
      messages,
      stream: true,
      store: false,
      n: 1,
    });
    if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw createExecutionError("INVALID_REQUEST", "This conversation exceeds Vesper's bounded API request size. Start a new Vesper session to continue.", { providerId: this.id });
    }

    let pending;
    try { pending = this.store.beginTask(this.conversationId, this.projectPath, taskId, task); } catch {
      throw createExecutionError("TASK_FAILED", "Vesper could not save the task to private local conversation storage; no API request was sent.", { providerId: this.id });
    }
    this.setConversation(pending);
    const controller = new AbortController();
    const active = {
      taskId,
      conversationId: this.conversationId,
      controller,
      reader: null,
      interrupted: false,
      timedOut: false,
      disposed: false,
      responseStarted: false,
      timer: null,
      completed: false,
    };
    this.active = active;
    active.timer = setTimeout(() => {
      active.timedOut = true;
      controller.abort("vesper-request-timeout");
    }, this.config.requestTimeoutMs);
    active.timer.unref?.();
    this.emitForTask(active, "task-started", { conversationId: active.conversationId, taskId, providerId: this.id, model: this.config.modelId });

    let response;
    let text = "";
    let completedFinishReason = null;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: requestBody,
        signal: controller.signal,
      });
      active.responseStarted = true;
      if (!response || typeof response.ok !== "boolean") {
        this.lastReachability = "no";
        this.lastAvailability = "unavailable";
        throw submissionUncertain("The OpenAI-compatible API returned an invalid HTTP response.");
      }
      this.lastReachability = "yes";
      if (!response.ok) {
        this.lastAvailability = "unavailable";
        await cancelResponse(response);
        if (response.status >= 500) {
          this.store.markUncertain(active.conversationId, this.projectPath, taskId);
          throw submissionUncertain(`The OpenAI-compatible API returned HTTP ${response.status}; completion is unconfirmed.`);
        }
        this.setConversation(this.store.rejectTask(active.conversationId, this.projectPath, taskId));
        throw apiHttpError(response.status, false);
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        this.lastAvailability = "unavailable";
        this.store.markUncertain(active.conversationId, this.projectPath, taskId);
        throw submissionUncertain("The OpenAI-compatible API did not provide a readable streaming response.");
      }
      const contentType = response.headers?.get?.("content-type") || "";
      if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
        this.lastAvailability = "unavailable";
        this.store.markUncertain(active.conversationId, this.projectPath, taskId);
        throw submissionUncertain("The OpenAI-compatible API did not confirm an event-stream response; completion is unconfirmed.");
      }
      const streamed = await consumeSse(response.body, {
        active,
        onText: (delta) => {
          if (text.length + delta.length > MAX_RESPONSE_TEXT_LENGTH) {
            active.controller.abort("vesper-output-limit");
            throw submissionUncertain("The OpenAI response exceeded Vesper's bounded output size; completion is unconfirmed.");
          }
          text += delta;
          this.emitText(active, delta);
        },
      });
      completedFinishReason = streamed.finishReason;
      if (streamed.finishReason === "tool_calls" || streamed.finishReason === "function_call" || streamed.toolCallSeen) {
        this.store.markUncertain(active.conversationId, this.projectPath, taskId, "unsupported");
        this.setConversation(this.store.load(active.conversationId, this.projectPath));
        throw createExecutionError("UNSUPPORTED_OPERATION", "The model returned a tool call. Vesper treats it as text-only and did not execute it; start a new session to continue.", { providerId: this.id });
      }
      if (!SUPPORTED_FINISH_REASONS.has(streamed.finishReason)) {
        this.store.markUncertain(active.conversationId, this.projectPath, taskId);
        throw submissionUncertain("The OpenAI stream ended without a supported completion status.");
      }
      const record = this.store.completeTask(active.conversationId, this.projectPath, taskId, text);
      this.setConversation(record);
      this.lastAvailability = "available";
      active.completed = true;
      this.emitForTask(active, "task-state", {
        conversationId: active.conversationId,
        taskId,
        state: "completed",
        finishReason: completedFinishReason,
        truncated: completedFinishReason === "length",
      });
      return Object.freeze({
        status: "completed",
        conversationId: active.conversationId,
        model: this.config.modelId,
        finishReason: completedFinishReason,
        truncated: completedFinishReason === "length",
        executedCommands: false,
        changedFiles: false,
      });
    } catch (error) {
      if (!active.responseStarted) {
        this.lastReachability = "no";
        this.lastAvailability = "unavailable";
      }
      if (active.interrupted) {
        this.markUncertainQuietly(active, "uncertain");
        active.completed = true;
        this.emitForTask(active, "task-state", { conversationId: active.conversationId, taskId, state: "interrupted", errorCode: "SUBMISSION_OUTCOME_UNCERTAIN" });
        return Object.freeze({
          status: "interrupted",
          conversationId: active.conversationId,
          model: this.config.modelId,
          recoveryCode: "submission-outcome-uncertain",
          completionKnown: false,
        });
      }
      if (active.disposed) {
        this.markUncertainQuietly(active, "uncertain");
        throw createExecutionError("CONNECTION_LOST", "The OpenAI request was stopped while Vesper was closing. Its completion is unknown.", { providerId: this.id, retryable: false });
      }
      if (active.timedOut) {
        this.markUncertainQuietly(active, "uncertain");
        throw submissionUncertain("The OpenAI request timed out after dispatch. Vesper did not submit it again.");
      }
      const normalized = error?.name === "ExecutionError"
        ? error
        : submissionUncertain("The OpenAI connection ended before a complete response was confirmed.");
      if (normalized.code === "SUBMISSION_OUTCOME_UNCERTAIN") this.markUncertainQuietly(active, "uncertain");
      if (normalized.code === "UNSUPPORTED_OPERATION") this.markUncertainQuietly(active, "unsupported");
      this.emitForTask(active, "task-state", { conversationId: active.conversationId, taskId, state: "failed", errorCode: normalized.code });
      throw normalized;
    } finally {
      clearTimeout(active.timer);
      if (active.reader) {
        try { await active.reader.cancel(); } catch { /* Reader may already be closed. */ }
      }
      if (this.active === active) this.active = null;
      if (this.conversationId === active.conversationId) {
        try { this.setConversation(this.store.load(active.conversationId, this.projectPath)); } catch { /* Keep the last in-memory state. */ }
      }
    }
  }

  async interrupt() {
    this.assertLive();
    const active = this.active;
    if (!active) return false;
    active.interrupted = true;
    this.emitForTask(active, "interrupt-requested", { accepted: true, conversationId: active.conversationId, taskId: active.taskId });
    active.controller.abort("vesper-interrupt");
    if (active.reader) {
      try { await active.reader.cancel(); } catch { /* Abort has already closed the reader. */ }
    }
    return true;
  }

  async recover() {
    this.assertLive();
    throw unsupportedOperation(this.id, "recover an OpenAI request outcome");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    if (active) {
      active.disposed = true;
      active.controller.abort("vesper-dispose");
      if (active.reader) void active.reader.cancel().catch(() => undefined);
    }
    this.emitEvent("connection-state", { state: "closed" });
    this.removeAllListeners();
  }

  emitText(active, value) {
    for (let offset = 0; offset < value.length; offset += MAX_TEXT_EVENT_LENGTH) {
      if (this.active !== active || this.disposed) return;
      this.emitForTask(active, "text-delta", { text: value.slice(offset, offset + MAX_TEXT_EVENT_LENGTH), conversationId: active.conversationId, taskId: active.taskId });
    }
  }

  emitForTask(active, type, fields) {
    if (this.active !== active || this.disposed) return;
    this.emitEvent(type, fields);
  }

  emitEvent(type, fields) {
    if (this.disposed) return;
    try { this.emit("event", createExecutionEvent(type, fields)); } catch { /* Invalid provider metadata is discarded. */ }
  }

  setConversation(record) {
    this.conversation = record;
    this.conversationId = record.conversationId;
    this.projectPath = record.projectPath;
  }

  async persistConversationId(conversationId) {
    if (!this.onConversationId) return;
    try {
      await this.onConversationId(conversationId);
    } catch {
      throw createExecutionError("TASK_FAILED", "Vesper could not save the OpenAI conversation mapping; no task was submitted.", { providerId: this.id });
    }
  }

  markUncertainQuietly(active, status) {
    try {
      const record = this.store.markUncertain(active.conversationId, this.projectPath, active.taskId, status);
      if (this.conversationId === active.conversationId) this.setConversation(record);
    } catch { /* A pending record still blocks unsafe reuse after restart. */ }
  }

  async fetchWithTimeout(url, options, fallbackCode) {
    if (typeof this.fetchImpl !== "function") throw createExecutionError("PROVIDER_UNAVAILABLE", "This Node.js runtime does not provide an HTTP fetch implementation.", { providerId: this.id });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("vesper-status-timeout"), this.config.requestTimeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, {
        ...options,
        redirect: "error",
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        signal: controller.signal,
      });
    } catch {
      this.lastReachability = "no";
      this.lastAvailability = "unavailable";
      const message = fallbackCode === "PROVIDER_UNAVAILABLE"
        ? "The OpenAI-compatible API could not be reached during the explicit connectivity check."
        : "The provider connection failed.";
      throw createExecutionError(fallbackCode, message, { providerId: this.id, retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  assertConfigured() {
    this.assertLive();
    if (this.config.errors.length) {
      throw createExecutionError("PROVIDER_UNAVAILABLE", `OpenAI provider configuration is incomplete: ${this.config.errors.join("; ")}.`, { providerId: this.id });
    }
    if (typeof this.fetchImpl !== "function") {
      throw createExecutionError("PROVIDER_UNAVAILABLE", "This Node.js runtime does not provide an HTTP fetch implementation.", { providerId: this.id });
    }
  }

  assertLive() {
    if (this.disposed) throw createExecutionError("PROVIDER_UNAVAILABLE", "The OpenAI provider has been disposed.", { providerId: this.id });
  }
}

function resolveOpenAIConfig(environment = process.env, overrides = {}) {
  const env = environment && typeof environment === "object" ? environment : {};
  const apiKey = typeof overrides.apiKey === "string"
    ? overrides.apiKey
    : typeof env.VESPER_OPENAI_API_KEY === "string" && env.VESPER_OPENAI_API_KEY
      ? env.VESPER_OPENAI_API_KEY
      : typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY : "";
  const apiKeyEnvVar = typeof overrides.apiKey === "string"
    ? "explicit provider setting"
    : env.VESPER_OPENAI_API_KEY ? "VESPER_OPENAI_API_KEY" : "OPENAI_API_KEY";
  const rawBaseUrl = overrides.baseUrl ?? env.VESPER_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
  const modelId = String(overrides.modelId ?? env.VESPER_OPENAI_MODEL ?? "").trim();
  const rawTimeout = overrides.requestTimeoutMs ?? env.VESPER_OPENAI_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const errors = [];
  let baseUrl;
  try { baseUrl = validateBaseUrl(rawBaseUrl); } catch (error) { errors.push(error.message); }
  if (typeof modelId !== "string" || !modelId || modelId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(modelId)) {
    errors.push("set VESPER_OPENAI_MODEL to a valid model identifier");
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8_192 || /\s/u.test(apiKey)) {
    errors.push("set OPENAI_API_KEY or VESPER_OPENAI_API_KEY in the environment");
  }
  const requestTimeoutMs = Number(rawTimeout);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    errors.push(`VESPER_OPENAI_TIMEOUT_MS must be from ${MIN_REQUEST_TIMEOUT_MS} to ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  return Object.freeze({
    providerId: OPENAI_PROVIDER_ID,
    apiKey,
    apiKeyEnvVar,
    apiKeyConfigured: Boolean(apiKey && !/\s/u.test(apiKey)),
    baseUrl: baseUrl || DEFAULT_OPENAI_BASE_URL,
    modelId: modelId && !/[\u0000-\u001f\u007f-\u009f]/u.test(modelId) ? modelId : "",
    requestTimeoutMs: Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS && requestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS,
    errors: Object.freeze(errors),
  });
}

function normalizeConfig(config) {
  const environment = {
    VESPER_OPENAI_MODEL: config.modelId,
    VESPER_OPENAI_BASE_URL: config.baseUrl,
    VESPER_OPENAI_TIMEOUT_MS: config.requestTimeoutMs,
    VESPER_OPENAI_API_KEY: config.apiKey,
  };
  return resolveOpenAIConfig(environment);
}

function validateBaseUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) throw new Error("set VESPER_OPENAI_BASE_URL to a valid HTTPS API base URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("set VESPER_OPENAI_BASE_URL to a valid HTTPS API base URL"); }
  if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password || url.search || url.hash || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("VESPER_OPENAI_BASE_URL must use HTTP(S) without credentials, query parameters, or fragments");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("VESPER_OPENAI_BASE_URL must use HTTPS unless it targets localhost");
  }
  return url.toString().replace(/\/+$/u, "");
}

function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function endpointFingerprint(baseUrl) {
  return crypto.createHash("sha256").update(baseUrl, "utf8").digest("hex");
}

function validateProjectPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw createExecutionError("INVALID_REQUEST", "A valid absolute project directory is required.", { providerId: OPENAI_PROVIDER_ID });
  }
}

function submissionUncertain(message) {
  return createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", message, { providerId: OPENAI_PROVIDER_ID, retryable: false });
}

function apiHttpError(status, statusCheck) {
  const prefix = statusCheck ? "The OpenAI connectivity check" : "The OpenAI request";
  if (status === 401 || status === 403) {
    return createExecutionError("PROVIDER_UNAVAILABLE", `${prefix} was rejected with HTTP ${status}; check the configured API key and account access.`, { providerId: OPENAI_PROVIDER_ID, retryable: false });
  }
  if (status === 429) {
    return createExecutionError("PROVIDER_UNAVAILABLE", `${prefix} was rate limited with HTTP 429. No automatic retry was attempted.`, { providerId: OPENAI_PROVIDER_ID, retryable: true });
  }
  return createExecutionError("TASK_FAILED", `${prefix} was rejected with HTTP ${status}. Raw API error details are withheld.`, { providerId: OPENAI_PROVIDER_ID, retryable: false });
}

async function consumeSse(body, { active, onText } = {}) {
  const reader = body.getReader();
  active.reader = reader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let dataLines = [];
  let streamBytes = 0;
  let doneMarker = false;
  let finishReason = null;
  let toolCallSeen = false;
  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (Buffer.byteLength(data, "utf8") > MAX_SSE_RECORD_BYTES) throw submissionUncertain("An OpenAI streaming record exceeded Vesper's size limit.");
    if (data === "[DONE]") {
      doneMarker = true;
      return;
    }
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw submissionUncertain("The OpenAI stream contained malformed JSON; completion is unconfirmed."); }
    if (!chunk || typeof chunk !== "object" || !Array.isArray(chunk.choices)) throw submissionUncertain("The OpenAI stream contained an unsupported response record.");
    if (chunk.choices.length > 1) throw submissionUncertain("The OpenAI endpoint returned multiple choices when Vesper requested one.");
    for (const choice of chunk.choices) {
      if (!choice || typeof choice !== "object") throw submissionUncertain("The OpenAI stream contained a malformed choice.");
      const delta = choice.delta;
      if (delta !== undefined && (!delta || typeof delta !== "object" || Array.isArray(delta))) throw submissionUncertain("The OpenAI stream contained malformed text data.");
      if (delta?.tool_calls || delta?.function_call) toolCallSeen = true;
      if (delta?.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") throw submissionUncertain("The OpenAI stream contained non-text output; completion is unconfirmed.");
        onText(delta.content);
      }
      if (delta?.refusal !== undefined && delta.refusal !== null) {
        if (typeof delta.refusal !== "string") throw submissionUncertain("The OpenAI stream contained malformed refusal text.");
        onText(delta.refusal);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== "string") throw submissionUncertain("The OpenAI stream contained an invalid finish status.");
        finishReason = choice.finish_reason;
      }
    }
  };
  const processLines = (final = false) => {
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line) dispatch();
      else if (!line.startsWith(":")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
      }
      if (doneMarker) return;
      if (dataLines.join("\n").length > MAX_SSE_RECORD_BYTES) throw submissionUncertain("An OpenAI streaming record exceeded Vesper's size limit.");
    }
    if (final && buffer) {
      const line = buffer.replace(/\r$/u, "");
      buffer = "";
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
    }
    if (final) dispatch();
  };

  try {
    while (true) {
      if (active.interrupted || active.disposed || active.timedOut) {
        throw new Error("Vesper stopped the OpenAI stream.");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw submissionUncertain("The OpenAI stream returned malformed bytes.");
      streamBytes += value.byteLength;
      if (streamBytes > MAX_STREAM_BYTES) throw submissionUncertain("The OpenAI stream exceeded Vesper's size limit.");
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_RECORD_BYTES && !buffer.includes("\n")) {
        throw submissionUncertain("An OpenAI streaming record exceeded Vesper's size limit.");
      }
      processLines();
      if (doneMarker) break;
    }
    buffer += decoder.decode();
    processLines(true);
    if (!doneMarker || !finishReason) throw submissionUncertain("The OpenAI stream ended before a completion marker and finish status were received.");
    return { finishReason, toolCallSeen };
  } catch (error) {
    if (error?.name === "ExecutionError") throw error;
    if (active.interrupted || active.disposed || active.timedOut) throw error;
    throw submissionUncertain("The OpenAI stream ended before Vesper received a complete response.");
  } finally {
    try { await reader.cancel(); } catch { /* The reader may already be closed. */ }
    try { reader.releaseLock(); } catch { /* Lock may already be released. */ }
    if (active.reader === reader) active.reader = null;
  }
}

async function readBoundedResponseBody(response, limit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("HTTP response has no readable body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("HTTP response body timed out.");
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP response body timed out.")), remaining);
        timer.unref?.();
      });
      let result;
      try { result = await Promise.race([reader.read(), timeout]); } finally { clearTimeout(timer); }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("HTTP response body exceeded its size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* Already closed. */ }
    try { reader.releaseLock(); } catch { /* Already released. */ }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cancelResponse(response) {
  try { await response.body?.cancel?.(); } catch { /* Error response body is intentionally discarded. */ }
}

function emptyHistory() {
  return { state: "empty", entries: [], truncated: false, text: "This OpenAI conversation has no saved messages yet." };
}

function defaultConversationDirectory() {
  const root = process.env.VESPER_HOME ? path.resolve(process.env.VESPER_HOME) : path.join(require("node:os").homedir(), ".vesper");
  return path.join(root, "sessions", "provider-conversations");
}

function safeConversationId(value) {
  return typeof value === "string" && /^oai_[0-9a-f-]{36}$/iu.test(value) ? value : null;
}

function createOpenAIChatCompletionsProvider(options = {}) {
  return assertExecutionProvider(new OpenAIChatCompletionsProvider(options));
}

module.exports = {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_TEXT_LENGTH,
  OPENAI_CAPABILITIES,
  OPENAI_PROVIDER_ID,
  OpenAIChatCompletionsProvider,
  createOpenAIChatCompletionsProvider,
  resolveOpenAIConfig,
  validateBaseUrl,
};
