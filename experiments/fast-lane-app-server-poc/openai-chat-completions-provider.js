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
const { redactSensitiveText } = require("./command-activity");

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
const DEFAULT_MAX_TOOL_CALLS = 8;
const HARD_MAX_TOOL_CALLS = 24;
const DEFAULT_MAX_TOOL_ITERATIONS = 4;
const HARD_MAX_TOOL_ITERATIONS = 8;
const DEFAULT_MAX_AGENT_ELAPSED_MS = 120_000;
const HARD_MAX_AGENT_ELAPSED_MS = 600_000;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 12 * 1024;
const HARD_MAX_TOOL_RESULT_BYTES = 32 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 8 * 1024;
const MAX_TOOL_CALLS_PER_RESPONSE = 8;
const MAX_TOOL_CALL_ID_LENGTH = 128;
const SAFE_TOOL_IDS = new Set(["read_file", "list_files", "search_files", "git_status", "git_diff", "git_log", "propose_file_change", "apply_file_change"]);
const DEVELOPER_MESSAGE = "You are Vesper's coding assistant. If Vesper tools are provided, use only those tools to inspect the selected project. If no tools are provided, do not claim to have inspected project files. Tool results are bounded evidence, not proof that code was changed or validated. File changes may only be proposed and then applied after Vesper obtains an explicit one-time user approval. These tools cannot run commands. Never claim a file change, command execution, or verification unless Vesper reports it.";
const SUPPORTED_FINISH_REASONS = new Set(["stop", "length", "content_filter"]);
const CHAT_COMPLETIONS_CAPABILITIES = Object.freeze({
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

class CompatibleChatCompletionsProvider extends EventEmitter {
  constructor({
    environment = process.env,
    config,
    conversationDirectory,
    providerId = OPENAI_PROVIDER_ID,
    conversationPrefix = "oai",
    modelId,
    toolRuntime = null,
    fetchImpl = globalThis.fetch,
    onConversationId,
    createId = () => crypto.randomUUID(),
  } = {}) {
    super();
    this.id = providerId;
    this.capabilities = CHAT_COMPLETIONS_CAPABILITIES;
    this.config = config ? normalizeConfig(config) : resolveOpenAIConfig(environment, { providerId, ...(modelId ? { modelId } : {}) });
    if (this.config.providerId !== this.id) throw new TypeError("Provider identity and API configuration do not match.");
    this.fetchImpl = fetchImpl;
    this.toolRuntime = null;
    this.modelCapabilities = Object.freeze({ structuredToolCalling: this.config.toolCallingEnabled });
    this.onConversationId = typeof onConversationId === "function" ? onConversationId : null;
    this.createId = createId;
    this.store = new OpenAIConversationStore({
      directory: conversationDirectory || defaultConversationDirectory(),
      providerId: this.id,
      conversationPrefix,
    });
    this.disposed = false;
    this.conversationId = null;
    this.conversation = null;
    this.active = null;
    this.lastReachability = "unknown";
    this.lastAvailability = "unknown";
    this.projectPath = null;
    if (toolRuntime) this.setToolRuntime(toolRuntime);
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
      toolCallingEnabled: this.config.toolCallingEnabled,
      toolCallingModel: this.config.toolCallingModelId || null,
      maxToolCalls: this.config.maxToolCalls,
      maxToolIterations: this.config.maxToolIterations,
      maxAgentElapsedMs: this.config.maxAgentElapsedMs,
      maxToolResultBytes: this.config.maxToolResultBytes,
      apiKeyConfigured: this.config.apiKeyConfigured,
      reachability: this.lastReachability,
    });
  }

  setToolRuntime(toolRuntime) {
    if (toolRuntime !== null && (!toolRuntime || typeof toolRuntime !== "object" ||
        typeof toolRuntime.getDefinitions !== "function" || typeof toolRuntime.preview !== "function" ||
        typeof toolRuntime.invoke !== "function" || typeof toolRuntime.interrupt !== "function" ||
        typeof toolRuntime.dispose !== "function" || typeof toolRuntime.sessionId !== "string")) {
      throw new TypeError("The provider tool boundary must be a Vesper permissioned runtime facade.");
    }
    this.toolRuntime = toolRuntime;
    return this.config.toolCallingEnabled && Boolean(toolRuntime);
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
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The compatible API returned an invalid model-list response.", { providerId: this.id, retryable: true });
    }
    this.lastReachability = "yes";
    if (!response.ok) {
      await cancelResponse(response);
      this.lastAvailability = "unavailable";
      throw apiHttpError(response.status, true, this.id);
    }
    let body;
    try {
      body = await readBoundedResponseBody(response, MAX_MODEL_LIST_BODY_BYTES, Math.max(1, this.config.requestTimeoutMs - (Date.now() - startedAt)));
    } catch {
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The compatible API did not complete the bounded model-list response.", { providerId: this.id, retryable: true });
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The compatible API returned malformed model-list data.", { providerId: this.id, retryable: true });
    }
    if (!parsed || !Array.isArray(parsed.data)) {
      this.lastAvailability = "unavailable";
      throw createExecutionError("PROVIDER_UNAVAILABLE", "The compatible API returned an unsupported model-list response.", { providerId: this.id, retryable: true });
    }
    const modelIds = [];
    let modelAvailable = false;
    for (const model of parsed.data) {
      const modelId = model && typeof model.id === "string" && model.id.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(model.id)
        ? model.id
        : null;
      if (!modelId) continue;
      if (modelId === this.config.modelId) modelAvailable = true;
      if (modelIds.length < 100) modelIds.push(modelId);
    }
    this.lastReachability = "yes";
    this.lastAvailability = modelAvailable ? "available" : "unavailable";
    if (typeof projectPath === "string") this.projectPath = projectPath;
    return Object.freeze({ providerId: this.id, configured: true, reachable: true, modelAvailable, modelIds: Object.freeze(modelIds) });
  }

  async startConversation({ projectPath } = {}) {
    this.assertLive();
    this.assertConfigured();
    validateProjectPath(projectPath, this.id);
    if (this.conversationId && this.projectPath !== path.resolve(projectPath)) {
      throw createExecutionError("RESUME_FAILED", "This provider instance is already bound to another project conversation. Start a separate Vesper session.", { providerId: this.id });
    }
    if (this.conversationId && this.projectPath === path.resolve(projectPath) && this.conversation?.status === "ready") {
      return Object.freeze({ providerId: this.id, conversationId: this.conversationId });
    }
    if (this.conversationId && ["pending", "uncertain"].includes(this.conversation?.status)) {
      throw submissionUncertain("This provider conversation has an unconfirmed request and cannot be replaced. Start a separate Vesper session to continue.", this.id);
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
    validateProjectPath(projectPath, this.id);
    if (!this.capabilities.resume) throw unsupportedOperation(this.id, "resume conversation");
    if (typeof conversationId !== "string" || !conversationId) {
      throw createExecutionError("RESUME_FAILED", "This Vesper session has no saved provider conversation to resume.", { providerId: this.id });
    }
    this.emitEvent("conversation-state", { state: "resuming", conversationId });
    let record;
    try {
      record = this.store.load(conversationId, path.resolve(projectPath));
    } catch {
      throw createExecutionError("RESUME_FAILED", "The saved provider conversation could not be loaded for this project.", { providerId: this.id, retryable: true });
    }
    if (record.modelId !== this.config.modelId || record.baseUrlFingerprint !== endpointFingerprint(this.config.baseUrl)) {
      throw createExecutionError("RESUME_FAILED", "The saved provider conversation uses different provider settings. Restore its model and API base URL, or explicitly start a new session.", { providerId: this.id, retryable: true });
    }
    if (record.status === "pending" || record.status === "uncertain") {
      this.setConversation(record);
      throw createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", "The saved provider request has no confirmed completion. Vesper kept its transcript and will not submit it again; start a new session to continue.", { providerId: this.id, retryable: false });
    }
    if (record.status === "unsupported") {
      this.setConversation(record);
      throw createExecutionError("UNSUPPORTED_OPERATION", "The saved provider response requested a tool operation Vesper does not execute. Start a new session to continue with text-only responses.", { providerId: this.id });
    }
    this.setConversation(record);
    this.emitEvent("conversation-state", { state: "resumed", conversationId });
    return Object.freeze({ providerId: this.id, conversationId });
  }

  async readConversationHistory() {
    this.assertLive();
    if (!this.capabilities.conversationHistory) throw unsupportedOperation(this.id, "read conversation history");
    if (!this.conversationId || !this.projectPath) return emptyHistory(this.config.providerName);
    let record;
    try {
      record = this.store.load(this.conversationId, this.projectPath);
    } catch {
      return unavailableHistory("The saved provider conversation history could not be read safely.");
    }
    const source = record.messages.slice(-MAX_HISTORY_MESSAGES);
    let visibleLength = 0;
    const entries = [];
    for (let index = Math.max(0, source.length - MAX_HISTORY_MESSAGES); index < source.length; index += 1) {
      const message = source[index];
      const toolRequest = message.role === "assistant" && Array.isArray(message.tool_calls);
      const label = message.role === "user" ? "User task"
        : message.role === "tool" ? "Vesper permissioned tool result"
          : toolRequest ? "Vesper structured tool request"
            : `${this.config.providerName} text response · not executed`;
      const remaining = MAX_HISTORY_TEXT_LENGTH - visibleLength - label.length;
      if (remaining <= 0) break;
      const messageText = toolRequest
        ? `Requested: ${message.tool_calls.map((call) => call.function.name).join(", ")}`
        : String(message.content || "");
      const text = messageText.slice(0, remaining);
      entries.push({
        id: `${record.conversationId}:${index}`,
        kind: message.role === "user" ? "user" : "assistant",
        label,
        text: text.length < messageText.length ? `${text}\n[history truncated]` : text,
      });
      visibleLength += label.length + text.length;
      if (text.length < messageText.length) break;
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
          : entries.length ? "Conversation history restored from Vesper's private local provider store." : "This provider conversation has no saved messages yet.",
    };
  }

  async submitTask({ task, projectPath } = {}) {
    this.assertLive();
    this.assertConfigured();
    if (typeof task !== "string" || !task.trim() || task.length > 32 * 1024) {
      throw createExecutionError("INVALID_REQUEST", "A non-empty task of at most 32,768 characters is required.", { providerId: this.id });
    }
    validateProjectPath(projectPath, this.id);
    if (this.active) throw createExecutionError("INVALID_REQUEST", "This provider already has an active request.", { providerId: this.id });
    if (!this.conversationId || this.projectPath !== path.resolve(projectPath)) await this.startConversation({ projectPath });
    let current;
    try { current = this.store.load(this.conversationId, this.projectPath); } catch {
      throw createExecutionError("RESUME_FAILED", "The saved provider conversation could not be loaded safely; no API request was sent.", { providerId: this.id });
    }
    if (current.modelId !== this.config.modelId || current.baseUrlFingerprint !== endpointFingerprint(this.config.baseUrl)) {
      throw createExecutionError("RESUME_FAILED", "The saved provider conversation uses different provider settings. Restore them or explicitly start a new session.", { providerId: this.id });
    }
    if (current.status === "pending" || current.status === "uncertain") {
      this.setConversation(current);
      throw createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", "The previous provider request has no confirmed completion. Vesper will not submit it again; start a new session to continue.", { providerId: this.id });
    }
    if (current.status === "unsupported") {
      throw createExecutionError("UNSUPPORTED_OPERATION", "The saved provider conversation is blocked after an unsupported tool request. Start a new session to continue.", { providerId: this.id });
    }

    const toolDefinitions = this.config.toolCallingEnabled ? this.getModelToolDefinitions() : [];
    if (this.config.toolCallingEnabled && (!this.toolRuntime || toolDefinitions.length === 0)) {
      throw createExecutionError("UNSUPPORTED_OPERATION", "Structured tool calling is enabled for this model, but no safe Vesper tool runtime is attached. No API request was sent.", { providerId: this.id });
    }

    const taskId = this.createId();
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
      startedAt: Date.now(),
      totalTextLength: 0,
      toolCallCount: 0,
      toolIterationCount: 0,
      changedFiles: false,
    };
    this.active = active;
    active.timer = setTimeout(() => {
      active.timedOut = true;
      controller.abort("vesper-request-timeout");
      void this.toolRuntime?.interrupt?.();
    }, Math.min(this.config.requestTimeoutMs, this.config.maxAgentElapsedMs));
    active.timer.unref?.();
    this.emitForTask(active, "task-started", { conversationId: active.conversationId, taskId, providerId: this.id, model: this.config.modelId });

    try {
      return await this.runAgentLoop({ active, taskId, pending, toolDefinitions });
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
        throw createExecutionError("CONNECTION_LOST", "The provider request was stopped while Vesper was closing. Its completion is unknown.", { providerId: this.id, retryable: false });
      }
      if (active.timedOut) {
        this.markUncertainQuietly(active, "uncertain");
        throw submissionUncertain("The provider request timed out after dispatch. Vesper did not submit it again.", this.id);
      }
      const normalized = error?.name === "ExecutionError"
        ? error
        : submissionUncertain("The provider connection ended before a complete response was confirmed.", this.id);
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

  getModelToolDefinitions() {
    if (!this.config.toolCallingEnabled || !this.toolRuntime) return [];
    let definitions;
    try { definitions = this.toolRuntime.getDefinitions(); } catch {
      throw createExecutionError("UNSUPPORTED_OPERATION", "Vesper could not read the safe tool definitions; no API request was sent.", { providerId: this.id });
    }
    if (!Array.isArray(definitions)) throw createExecutionError("UNSUPPORTED_OPERATION", "The attached Vesper tool runtime returned malformed definitions.", { providerId: this.id });
    return definitions
      .filter((entry) => entry && SAFE_TOOL_IDS.has(entry.id) && entry.enabled !== false &&
        typeof entry.description === "string" && entry.inputSchema && typeof entry.inputSchema === "object")
      .map((entry) => ({
        type: "function",
        function: {
          name: entry.id,
          description: entry.description.slice(0, 512),
          parameters: providerJsonSchema(entry.inputSchema),
        },
      }))
      .slice(0, SAFE_TOOL_IDS.size);
  }

  async runAgentLoop({ active, taskId, pending, toolDefinitions }) {
    const transcript = pending.messages.map((message) => ({ ...message }));
    let finalText = "";
    let finishReason = null;
    for (let iteration = 0; iteration <= this.config.maxToolIterations; iteration += 1) {
      if (active.interrupted || active.timedOut || active.disposed) throw new Error("Vesper stopped the provider task.");
      const apiMessages = [{ role: "developer", content: DEVELOPER_MESSAGE }, ...transcript];
      const body = {
        model: this.config.modelId,
        messages: apiMessages,
        stream: true,
        store: false,
        n: 1,
        ...(this.config.toolCallingEnabled ? { tools: toolDefinitions, tool_choice: "auto" } : {}),
      };
      const requestBody = JSON.stringify(body);
      if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
        if (!active.responseStarted) {
          this.setConversation(this.store.rejectTask(active.conversationId, this.projectPath, taskId));
        } else {
          this.markUncertainQuietly(active, "uncertain");
        }
        throw createExecutionError("INVALID_REQUEST", "This conversation exceeds Vesper's bounded API request size. Start a new Vesper session to continue.", { providerId: this.id });
      }
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: requestBody,
        signal: active.controller.signal,
      });
      active.responseStarted = true;
      if (!response || typeof response.ok !== "boolean") {
        this.lastReachability = "no";
        this.lastAvailability = "unavailable";
        throw submissionUncertain("The compatible API returned an invalid HTTP response.", this.id);
      }
      this.lastReachability = "yes";
      if (!response.ok) {
        this.lastAvailability = "unavailable";
        await cancelResponse(response);
        if (response.status >= 500 || active.toolCallCount > 0) {
          this.markUncertainQuietly(active, "uncertain");
          throw submissionUncertain(`The compatible API returned HTTP ${response.status}; the task did not complete and will not be resubmitted.`, this.id);
        }
        this.setConversation(this.store.rejectTask(active.conversationId, this.projectPath, taskId));
        throw apiHttpError(response.status, false, this.id);
      }
      const contentType = response.headers?.get?.("content-type") || "";
      let completion;
      const onText = (delta) => {
        if (active.totalTextLength + delta.length > MAX_RESPONSE_TEXT_LENGTH) {
          active.controller.abort("vesper-output-limit");
          throw submissionUncertain("The provider response exceeded Vesper's bounded output size; completion is unconfirmed.", this.id);
        }
        active.totalTextLength += delta.length;
        this.emitText(active, delta);
      };
      if (/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
        if (!response.body || typeof response.body.getReader !== "function") {
          this.markUncertainQuietly(active, "uncertain");
          throw submissionUncertain("The compatible API did not provide a readable streaming response.", this.id);
        }
        completion = await consumeSse(response.body, { providerId: this.id, active, onText });
      } else if (/^application\/json(?:\s*;|$)/iu.test(contentType)) {
        const remainingMs = Math.max(1, Math.min(this.config.requestTimeoutMs, this.config.maxAgentElapsedMs) - (Date.now() - active.startedAt));
        const rawBody = await readBoundedResponseBody(response, MAX_STREAM_BYTES, remainingMs, active.controller.signal);
        completion = parseCompletedChatResponse(rawBody, { providerId: this.id, onText });
      } else {
        await cancelResponse(response);
        this.markUncertainQuietly(active, "uncertain");
        throw submissionUncertain("The compatible API returned neither a supported event stream nor a complete JSON response.", this.id);
      }
      finishReason = completion.finishReason;
      if (completion.legacyFunctionCallSeen) {
        this.store.markUncertain(active.conversationId, this.projectPath, taskId, "unsupported");
        throw createExecutionError("UNSUPPORTED_OPERATION", "The provider returned the legacy function_call format. Vesper supports only the structured tool_calls protocol and executed nothing.", { providerId: this.id });
      }
      if (completion.toolCalls.length) {
        if (!this.config.toolCallingEnabled || !this.toolRuntime) {
          this.store.markUncertain(active.conversationId, this.projectPath, taskId, "unsupported");
          throw createExecutionError("UNSUPPORTED_OPERATION", "The provider returned a structured tool call while tool calling was disabled. Vesper executed nothing; start a new session to continue.", { providerId: this.id });
        }
        if (finishReason !== "tool_calls") {
          transcript.push({ role: "assistant", content: completion.text || null, tool_calls: completion.toolCalls });
          for (const call of completion.toolCalls) {
            transcript.push({ role: "tool", tool_call_id: call.id, content: safeToolErrorResult("INVALID_TOOL_RESPONSE", "The provider returned a tool call without the documented tool_calls finish reason.", this.config.maxToolResultBytes) });
          }
          this.emitForTask(active, "task-progress", { kind: "agent-tool-response", state: "rejected", reasonCode: "INVALID_TOOL_RESPONSE" });
          continue;
        }
        if (iteration >= this.config.maxToolIterations) {
          this.markUncertainQuietly(active, "uncertain");
          throw createExecutionError("TASK_FAILED", `Vesper reached the ${this.config.maxToolIterations}-iteration tool limit. No final answer was received; start a new session to continue.`, { providerId: this.id });
        }
        if (active.toolCallCount + completion.toolCalls.length > this.config.maxToolCalls) {
          this.markUncertainQuietly(active, "uncertain");
          throw createExecutionError("TASK_FAILED", `Vesper reached the ${this.config.maxToolCalls}-call tool limit. No additional tool calls were executed.`, { providerId: this.id });
        }
        active.toolIterationCount += 1;
        transcript.push({ role: "assistant", content: completion.text || null, tool_calls: completion.toolCalls });
        for (const call of completion.toolCalls) {
          if (active.interrupted || active.timedOut || active.disposed) throw new Error("Vesper stopped the provider task.");
          active.toolCallCount += 1;
          const requestId = crypto.randomUUID();
          const toolName = SAFE_TOOL_IDS.has(call.function.name) ? call.function.name : "unsupported_tool";
          this.emitForTask(active, "tool-call", { toolCallId: call.id, toolId: toolName, state: "requested", iteration: active.toolIterationCount });
          const result = await this.invokeModelTool(call, requestId, active);
          transcript.push({ role: "tool", tool_call_id: call.id, content: result.content });
          this.emitForTask(active, "tool-result", {
            toolCallId: call.id,
            toolId: result.toolId || call.function.name,
            state: result.state,
            verified: result.verified === true,
            ...(result.summary ? { summary: result.summary } : {}),
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          });
        }
        continue;
      }
      if (finishReason === "tool_calls") {
        this.markUncertainQuietly(active, "uncertain");
        throw submissionUncertain("The provider indicated tool calls but supplied no complete calls.", this.id);
      }
      if (!SUPPORTED_FINISH_REASONS.has(finishReason)) {
        this.markUncertainQuietly(active, "uncertain");
        throw submissionUncertain("The provider response ended without a supported completion status.", this.id);
      }
      finalText = completion.text;
      const extraMessages = transcript.slice(pending.messages.length);
      const record = this.store.completeTask(active.conversationId, this.projectPath, taskId, finalText, extraMessages);
      this.setConversation(record);
      this.lastAvailability = "available";
      active.completed = true;
      this.emitForTask(active, "task-state", {
        conversationId: active.conversationId,
        taskId,
        state: "completed",
        finishReason,
        toolCallCount: active.toolCallCount,
        toolIterationCount: active.toolIterationCount,
        truncated: finishReason === "length",
      });
      return Object.freeze({
        status: "completed",
        conversationId: active.conversationId,
        model: this.config.modelId,
        finishReason,
        toolCallCount: active.toolCallCount,
        toolIterationCount: active.toolIterationCount,
        truncated: finishReason === "length",
        executedCommands: false,
        changedFiles: active.changedFiles,
      });
    }
    this.markUncertainQuietly(active, "uncertain");
    throw createExecutionError("TASK_FAILED", "Vesper reached its bounded tool-loop limit without a final answer.", { providerId: this.id });
  }

  async invokeModelTool(call, requestId, active) {
    const callId = call && typeof call.id === "string" && call.id.length <= MAX_TOOL_CALL_ID_LENGTH ? call.id : "";
    const name = call?.function?.name;
    const reject = (code, message) => ({ toolId: typeof name === "string" && SAFE_TOOL_IDS.has(name) ? name : "unsupported_tool",
      state: "rejected", verified: false, errorCode: code,
      content: safeToolErrorResult(code, message, this.config.maxToolResultBytes) });
    if (!callId || !/^[A-Za-z0-9_-]+$/u.test(callId) || typeof name !== "string" || !SAFE_TOOL_IDS.has(name)) {
      return reject("UNSUPPORTED_TOOL", "This tool name or call identity is not allowed by Vesper.");
    }
    if (typeof call.function.arguments !== "string" || Buffer.byteLength(call.function.arguments, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
      return reject("INVALID_ARGUMENT", "Tool arguments are missing or exceed Vesper's limit.");
    }
    let input;
    try { input = JSON.parse(call.function.arguments); } catch {
      return reject("INVALID_ARGUMENT", "Tool arguments were not valid JSON. Vesper did not execute the request.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reject("INVALID_ARGUMENT", "Tool arguments must be a JSON object. Vesper did not execute the request.");
    }
    const request = Object.freeze({
      toolId: name,
      input,
      context: Object.freeze({ projectRoot: this.projectPath, sessionId: this.toolRuntime.sessionId }),
      requestId,
    });
    let preview;
    try { preview = await this.toolRuntime.preview(request); } catch {
      return reject("INVALID_ARGUMENT", "Vesper rejected the tool request during schema and scope validation.");
    }
    if (!preview || preview.state !== "validated" || preview.enabled === false || preview.executes !== false) {
      return reject("TOOL_UNAVAILABLE", "Vesper did not validate this tool request for the active project and session.");
    }
    this.emitForTask(active, "tool-call", { toolCallId: callId, toolId: name, state: "validated", iteration: active.toolIterationCount });
    let result;
    try { result = await this.toolRuntime.invoke(request); } catch {
      return reject("TOOL_FAILED", "Vesper's permissioned tool runtime failed without a confirmed result.");
    }
    if (!result || result.requestId !== requestId || result.toolId !== name || typeof result.state !== "string") {
      return reject("TOOL_FAILED", "Vesper did not receive a matching validated tool result.");
    }
    const content = serializeModelToolResult(result, this.config.maxToolResultBytes);
    if (name === "apply_file_change" && result.state === "verified" && result.verified === true && result.proposalState === "applied") {
      active.changedFiles = true;
    }
    const summaryValue = result.error?.message || (result.proposal ? {
      proposalId: result.proposal.proposalId,
      path: result.proposal.path,
      originalExists: result.proposal.originalExists,
      contentHash: result.proposal.contentHash,
      proposedBytes: result.proposal.proposedBytes,
      approvalState: result.proposal.approvalState,
      message: "File proposal created; no file was changed.",
    } : result.result);
    let summary = "";
    try { summary = redactSensitiveText(JSON.stringify(sanitizeModelValue(summaryValue))).slice(0, 500); } catch { /* No UI summary for an unserializable tool result. */ }
    return { toolId: name, state: result.state, verified: result.verified === true, summary,
      ...(result.error?.code ? { errorCode: String(result.error.code).slice(0, 80) } : {}), content };
  }

  async interrupt() {
    this.assertLive();
    const active = this.active;
    if (!active) return false;
    active.interrupted = true;
    this.emitForTask(active, "interrupt-requested", { accepted: true, conversationId: active.conversationId, taskId: active.taskId });
    active.controller.abort("vesper-interrupt");
    void this.toolRuntime?.interrupt?.();
    if (active.reader) {
      try { await active.reader.cancel(); } catch { /* Abort has already closed the reader. */ }
    }
    return true;
  }

  async recover() {
    this.assertLive();
    throw unsupportedOperation(this.id, "recover a provider request outcome");
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
      throw createExecutionError("TASK_FAILED", "Vesper could not save the provider conversation mapping; no task was submitted.", { providerId: this.id });
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
        ? "The compatible API could not be reached during the explicit connectivity check."
        : "The provider connection failed.";
      throw createExecutionError(fallbackCode, message, { providerId: this.id, retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  assertConfigured() {
    this.assertLive();
    if (this.config.errors.length) {
      throw createExecutionError("PROVIDER_UNAVAILABLE", `${this.config.providerName} configuration is incomplete: ${this.config.errors.join("; ")}.`, { providerId: this.id });
    }
    if (typeof this.fetchImpl !== "function") {
      throw createExecutionError("PROVIDER_UNAVAILABLE", "This Node.js runtime does not provide an HTTP fetch implementation.", { providerId: this.id });
    }
  }

  assertLive() {
    if (this.disposed) throw createExecutionError("PROVIDER_UNAVAILABLE", "The provider has been disposed.", { providerId: this.id });
  }
}

function parseCompletedChatResponse(rawBody, { providerId, onText } = {}) {
  let response;
  try { response = JSON.parse(rawBody); } catch { throw submissionUncertain("The provider returned malformed completed-response JSON.", providerId); }
  if (!response || !Array.isArray(response.choices) || response.choices.length !== 1) {
    throw submissionUncertain("The provider returned an unsupported completed-response shape.", providerId);
  }
  const choice = response.choices[0];
  const message = choice?.message;
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      (choice.finish_reason !== null && typeof choice.finish_reason !== "string")) {
    throw submissionUncertain("The provider returned a malformed completed response.", providerId);
  }
  let text = "";
  const content = message.content;
  if (content !== undefined && content !== null) {
    if (typeof content !== "string") throw submissionUncertain("The provider returned non-text message content.", providerId);
    text += content;
    onText(content);
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    if (typeof message.refusal !== "string") throw submissionUncertain("The provider returned malformed refusal text.", providerId);
    text += message.refusal;
    onText(message.refusal);
  }
  const toolCalls = new Map();
  if (message.tool_calls !== undefined) appendToolCallDeltas(toolCalls, message.tool_calls, providerId, { positionFallback: true });
  return {
    finishReason: choice.finish_reason,
    toolCalls: finalizeToolCalls(toolCalls, providerId),
    legacyFunctionCallSeen: message.function_call !== undefined && message.function_call !== null,
    text,
  };
}

function appendToolCallDeltas(calls, deltas, providerId, { positionFallback = false } = {}) {
  if (!Array.isArray(deltas) || deltas.length > MAX_TOOL_CALLS_PER_RESPONSE) {
    throw submissionUncertain("The provider returned a malformed or oversized tool-call list.", providerId);
  }
  for (let position = 0; position < deltas.length; position += 1) {
    const delta = deltas[position];
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw submissionUncertain("The provider returned a malformed tool-call fragment.", providerId);
    const index = Number.isSafeInteger(delta.index) ? delta.index : positionFallback ? position : -1;
    if (index < 0 || index >= MAX_TOOL_CALLS_PER_RESPONSE) throw submissionUncertain("The provider returned an out-of-range tool-call index.", providerId);
    const current = calls.get(index) || { index, id: "", type: "", function: { name: "", arguments: "" } };
    if (delta.id !== undefined) current.id = mergeIdentifierFragment(current.id, delta.id, providerId);
    if (delta.type !== undefined) {
      if (typeof delta.type !== "string" || delta.type.length > 32 || (current.type && current.type !== delta.type)) {
        throw submissionUncertain("The provider returned an invalid tool-call type.", providerId);
      }
      current.type = delta.type;
    }
    if (delta.function !== undefined) {
      if (!delta.function || typeof delta.function !== "object" || Array.isArray(delta.function)) {
        throw submissionUncertain("The provider returned a malformed function-call fragment.", providerId);
      }
      if (delta.function.name !== undefined) current.function.name = appendFragment(current.function.name, delta.function.name, MAX_TOOL_CALL_ID_LENGTH, providerId);
      if (delta.function.arguments !== undefined) current.function.arguments = appendFragment(current.function.arguments, delta.function.arguments, MAX_SSE_RECORD_BYTES, providerId);
    }
    calls.set(index, current);
  }
}

function mergeIdentifierFragment(existing, fragment, providerId) {
  if (typeof fragment !== "string" || fragment.length > MAX_TOOL_CALL_ID_LENGTH || /[^A-Za-z0-9_-]/u.test(fragment)) {
    throw submissionUncertain("The provider returned an invalid tool-call id.", providerId);
  }
  if (!existing || fragment.startsWith(existing)) return fragment;
  if (existing === fragment || existing.endsWith(fragment)) return existing;
  const merged = existing + fragment;
  if (merged.length > MAX_TOOL_CALL_ID_LENGTH) throw submissionUncertain("The provider tool-call id exceeded Vesper's limit.", providerId);
  return merged;
}

function appendFragment(existing, fragment, maximum, providerId) {
  if (typeof fragment !== "string") throw submissionUncertain("The provider returned a non-text tool-call fragment.", providerId);
  if (!fragment) return existing;
  const merged = existing + fragment;
  if (Buffer.byteLength(merged, "utf8") > maximum) throw submissionUncertain("The provider tool-call data exceeded Vesper's limit.", providerId);
  return merged;
}

function finalizeToolCalls(calls, providerId) {
  if (!calls.size) return [];
  const indexes = [...calls.keys()].sort((left, right) => left - right);
  if (indexes.length > MAX_TOOL_CALLS_PER_RESPONSE || indexes.some((index, position) => index !== position)) {
    throw submissionUncertain("The provider returned incomplete tool-call indexes.", providerId);
  }
  const ids = new Set();
  return indexes.map((index) => {
    const call = calls.get(index);
    if (!call.id || !call.type || !call.function.name || !/^[A-Za-z0-9_-]{1,128}$/u.test(call.id) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(call.function.name) || ids.has(call.id)) {
      throw submissionUncertain("The provider returned an incomplete or duplicate structured tool call.", providerId);
    }
    if (call.type !== "function") throw submissionUncertain("The provider returned an unsupported tool-call type.", providerId);
    ids.add(call.id);
    return Object.freeze({ id: call.id, type: "function", function: Object.freeze({ name: call.function.name, arguments: call.function.arguments }) });
  });
}

function providerJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(providerJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-") || key === "format") continue;
    normalized[key] = providerJsonSchema(value);
  }
  return normalized;
}

function serializeModelToolResult(result, maximumBytes) {
  const payload = {
    state: result.state,
    executed: result.executed === true,
    verified: result.verified === true,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.error ? { error: {
      code: /^[A-Z][A-Z0-9_]{0,79}$/u.test(String(result.error.code)) ? result.error.code : "TOOL_FAILED",
      message: typeof result.error.message === "string" ? redactSensitiveText(result.error.message).slice(0, 500) : "The tool failed without a confirmed result.",
    } } : {}),
    ...(result.proposal && typeof result.proposal === "object" ? { proposal: {
      proposalId: typeof result.proposal.proposalId === "string" ? result.proposal.proposalId.slice(0, 80) : null,
      path: typeof result.proposal.path === "string" ? redactSensitiveText(result.proposal.path).slice(0, 1_024) : null,
      originalExists: result.proposal.originalExists === true,
      originalHash: typeof result.proposal.originalHash === "string" ? result.proposal.originalHash.slice(0, 64) : null,
      contentHash: typeof result.proposal.contentHash === "string" ? result.proposal.contentHash.slice(0, 64) : null,
      proposedBytes: Number.isSafeInteger(result.proposal.proposedBytes) ? result.proposal.proposedBytes : null,
      originalBytes: Number.isSafeInteger(result.proposal.originalBytes) ? result.proposal.originalBytes : null,
      approvalState: typeof result.proposal.approvalState === "string" ? result.proposal.approvalState.slice(0, 40) : null,
      message: "Proposal created. No file was changed. A separate Vesper approval is required to apply it.",
    } } : {}),
    ...(typeof result.proposalState === "string" ? { proposalState: result.proposalState.slice(0, 40) } : {}),
    ...(Object.hasOwn(result, "result") ? { result: sanitizeModelValue(result.result) } : {}),
  };
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { serialized = ""; }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    return JSON.stringify({ state: result.state || "failed", truncated: true, message: "Vesper omitted this tool result because it exceeded the configured result-size limit." });
  }
  return serialized;
}

function sanitizeModelValue(value, depth = 0) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= 8) return "[nested result omitted]";
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeModelValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      if (/^(?:__proto__|constructor|prototype)$/u.test(key)) continue;
      result[key.slice(0, 100)] = sanitizeModelValue(entry, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 500);
}

function safeToolErrorResult(code, message, maximumBytes) {
  const boundedCode = /^[A-Z][A-Z0-9_]{0,79}$/u.test(String(code)) ? code : "TOOL_FAILED";
  return JSON.stringify({ state: "rejected", executed: false, verified: false,
    error: { code: boundedCode, message: redactSensitiveText(message).slice(0, 500) } }).slice(0, maximumBytes);
}

function resolveCompatibleChatCompletionsConfig(environment = process.env, overrides = {}) {
  const env = environment && typeof environment === "object" ? environment : {};
  const keyNames = Array.isArray(overrides.apiKeyEnvVars) && overrides.apiKeyEnvVars.length
    ? overrides.apiKeyEnvVars
    : ["VESPER_OPENAI_API_KEY", "OPENAI_API_KEY"];
  const configuredKeyName = keyNames.find((name) => typeof env[name] === "string" && env[name]) || null;
  const apiKey = typeof overrides.apiKey === "string"
    ? overrides.apiKey
    : configuredKeyName ? env[configuredKeyName] : "";
  const apiKeyEnvVar = overrides.apiKeyEnvVar || (typeof overrides.apiKey === "string"
    ? "explicit provider setting"
    : configuredKeyName || keyNames.join(" or "));
  const baseUrlEnvVar = overrides.baseUrlEnvVar || "VESPER_OPENAI_BASE_URL";
  const modelEnvVar = overrides.modelEnvVar || "VESPER_OPENAI_MODEL";
  const timeoutEnvVar = overrides.timeoutEnvVar || "VESPER_OPENAI_TIMEOUT_MS";
  const toolCallingModelEnvVar = overrides.toolCallingModelEnvVar || "VESPER_OPENAI_TOOL_CALLING_MODEL";
  const maxToolCallsEnvVar = overrides.maxToolCallsEnvVar || "VESPER_OPENAI_MAX_TOOL_CALLS";
  const maxToolIterationsEnvVar = overrides.maxToolIterationsEnvVar || "VESPER_OPENAI_MAX_TOOL_ITERATIONS";
  const maxAgentElapsedEnvVar = overrides.maxAgentElapsedEnvVar || "VESPER_OPENAI_MAX_AGENT_ELAPSED_MS";
  const maxToolResultBytesEnvVar = overrides.maxToolResultBytesEnvVar || "VESPER_OPENAI_MAX_TOOL_RESULT_BYTES";
  const defaultBaseUrl = overrides.defaultBaseUrl || DEFAULT_OPENAI_BASE_URL;
  const rawBaseUrl = overrides.baseUrl ?? env[baseUrlEnvVar] ?? defaultBaseUrl;
  const modelId = String(overrides.modelId ?? env[modelEnvVar] ?? "").trim();
  const rawTimeout = overrides.requestTimeoutMs ?? env[timeoutEnvVar] ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const rawToolCallingModelId = overrides.toolCallingModelId ?? env[toolCallingModelEnvVar] ?? "";
  const errors = [];
  let baseUrl;
  try { baseUrl = validateBaseUrl(rawBaseUrl, baseUrlEnvVar); } catch (error) { errors.push(error.message); }
  if (typeof modelId !== "string" || !modelId || modelId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(modelId)) {
    errors.push(`set ${modelEnvVar} to a valid model identifier`);
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8_192 || /\s/u.test(apiKey)) {
    errors.push(`set ${keyNames.join(" or ")} in the environment`);
  }
  const toolCallingModelId = typeof rawToolCallingModelId === "string" ? rawToolCallingModelId.trim() : "";
  if (toolCallingModelId && (toolCallingModelId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(toolCallingModelId))) {
    errors.push(`${toolCallingModelEnvVar} must contain a valid exact model identifier`);
  }
  const requestTimeoutMs = Number(rawTimeout);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    errors.push(`${timeoutEnvVar} must be from ${MIN_REQUEST_TIMEOUT_MS} to ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  const maxToolCalls = boundedIntegerSetting(env, overrides.maxToolCalls, maxToolCallsEnvVar, DEFAULT_MAX_TOOL_CALLS, 1, HARD_MAX_TOOL_CALLS, errors);
  const maxToolIterations = boundedIntegerSetting(env, overrides.maxToolIterations, maxToolIterationsEnvVar, DEFAULT_MAX_TOOL_ITERATIONS, 1, HARD_MAX_TOOL_ITERATIONS, errors);
  const maxAgentElapsedMs = boundedIntegerSetting(env, overrides.maxAgentElapsedMs, maxAgentElapsedEnvVar,
    DEFAULT_MAX_AGENT_ELAPSED_MS, MIN_REQUEST_TIMEOUT_MS, HARD_MAX_AGENT_ELAPSED_MS, errors);
  const maxToolResultBytes = boundedIntegerSetting(env, overrides.maxToolResultBytes, maxToolResultBytesEnvVar,
    DEFAULT_MAX_TOOL_RESULT_BYTES, 1_024, HARD_MAX_TOOL_RESULT_BYTES, errors);
  return Object.freeze({
    providerId: overrides.providerId || OPENAI_PROVIDER_ID,
    providerName: overrides.providerName || "OpenAI Chat Completions",
    apiKey,
    apiKeyEnvVar,
    baseUrlEnvVar,
    modelEnvVar,
    timeoutEnvVar,
    toolCallingModelEnvVar,
    maxToolCallsEnvVar,
    maxToolIterationsEnvVar,
    maxAgentElapsedEnvVar,
    maxToolResultBytesEnvVar,
    toolCallingModelId: toolCallingModelId && toolCallingModelId.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(toolCallingModelId) ? toolCallingModelId : "",
    toolCallingEnabled: Boolean(toolCallingModelId && toolCallingModelId === modelId),
    maxToolCalls,
    maxToolIterations,
    maxAgentElapsedMs,
    maxToolResultBytes,
    apiKeyConfigured: Boolean(apiKey && !/\s/u.test(apiKey)),
    baseUrl: baseUrl || defaultBaseUrl,
    modelId: modelId && !/[\u0000-\u001f\u007f-\u009f]/u.test(modelId) ? modelId : "",
    requestTimeoutMs: Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS && requestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS,
    errors: Object.freeze(errors),
  });
}

function normalizeConfig(config) {
  const normalized = resolveOpenAIConfig({}, {
    providerId: config.providerId || OPENAI_PROVIDER_ID,
    providerName: config.providerName || "OpenAI Chat Completions",
    apiKey: config.apiKey,
    apiKeyEnvVar: config.apiKeyEnvVar,
    apiKeyEnvVars: [config.apiKeyEnvVar || "provider API key"],
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    requestTimeoutMs: config.requestTimeoutMs,
    baseUrlEnvVar: config.baseUrlEnvVar || "provider base URL setting",
    modelEnvVar: config.modelEnvVar || "provider model setting",
    timeoutEnvVar: config.timeoutEnvVar || "provider timeout setting",
    toolCallingModelEnvVar: config.toolCallingModelEnvVar || "provider tool-calling model setting",
    maxToolCallsEnvVar: config.maxToolCallsEnvVar || "provider maximum tool calls setting",
    maxToolIterationsEnvVar: config.maxToolIterationsEnvVar || "provider maximum tool iterations setting",
    maxAgentElapsedEnvVar: config.maxAgentElapsedEnvVar || "provider maximum agent elapsed time setting",
    maxToolResultBytesEnvVar: config.maxToolResultBytesEnvVar || "provider maximum tool result setting",
    toolCallingModelId: config.toolCallingModelId || "",
    maxToolCalls: config.maxToolCalls,
    maxToolIterations: config.maxToolIterations,
    maxAgentElapsedMs: config.maxAgentElapsedMs,
    maxToolResultBytes: config.maxToolResultBytes,
    defaultBaseUrl: config.baseUrl,
  });
  const priorErrors = Array.isArray(config.errors) ? config.errors.filter((error) => typeof error === "string") : [];
  return Object.freeze({ ...normalized, errors: Object.freeze([...new Set([...priorErrors, ...normalized.errors])]) });
}

function boundedIntegerSetting(environment, override, envName, fallback, minimum, maximum, errors) {
  const raw = override ?? environment[envName] ?? fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    errors.push(`${envName} must be from ${minimum} to ${maximum}`);
    return fallback;
  }
  return number;
}

function validateBaseUrl(value, settingName = "VESPER_OPENAI_BASE_URL") {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) throw new Error(`set ${settingName} to a valid HTTPS API base URL`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`set ${settingName} to a valid HTTPS API base URL`); }
  if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password || url.search || url.hash || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${settingName} must use HTTP(S) without credentials, query parameters, or fragments`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(`${settingName} must use HTTPS unless it targets localhost`);
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

function validateProjectPath(value, providerId = OPENAI_PROVIDER_ID) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw createExecutionError("INVALID_REQUEST", "A valid absolute project directory is required.", { providerId });
  }
}

function submissionUncertain(message, providerId = OPENAI_PROVIDER_ID) {
  return createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", message, { providerId, retryable: false });
}

function apiHttpError(status, statusCheck, providerId = OPENAI_PROVIDER_ID) {
  const prefix = statusCheck ? "The API connectivity check" : "The API request";
  if (status === 401 || status === 403) {
    return createExecutionError("PROVIDER_UNAVAILABLE", `${prefix} was rejected with HTTP ${status}; check the configured API key and account access.`, { providerId, retryable: false });
  }
  if (status === 429) {
    return createExecutionError("PROVIDER_UNAVAILABLE", `${prefix} was rate limited with HTTP 429. No automatic retry was attempted.`, { providerId, retryable: true });
  }
  return createExecutionError("TASK_FAILED", `${prefix} was rejected with HTTP ${status}. Raw API error details are withheld.`, { providerId, retryable: false });
}

async function consumeSse(body, { active, onText, providerId = OPENAI_PROVIDER_ID } = {}) {
  const reader = body.getReader();
  active.reader = reader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let dataLines = [];
  let streamBytes = 0;
  let doneMarker = false;
  let finishReason = null;
  const toolCalls = new Map();
  let legacyFunctionCallSeen = false;
  let responseText = "";
  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (Buffer.byteLength(data, "utf8") > MAX_SSE_RECORD_BYTES) throw submissionUncertain("A provider streaming record exceeded Vesper's size limit.", providerId);
    if (data === "[DONE]") {
      doneMarker = true;
      return;
    }
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw submissionUncertain("The provider stream contained malformed JSON; completion is unconfirmed.", providerId); }
    if (!chunk || typeof chunk !== "object" || !Array.isArray(chunk.choices)) throw submissionUncertain("The provider stream contained an unsupported response record.", providerId);
    if (chunk.choices.length > 1) throw submissionUncertain("The provider returned multiple choices when Vesper requested one.", providerId);
    for (const choice of chunk.choices) {
      if (!choice || typeof choice !== "object") throw submissionUncertain("The provider stream contained a malformed choice.", providerId);
      const delta = choice.delta;
      if (delta !== undefined && (!delta || typeof delta !== "object" || Array.isArray(delta))) throw submissionUncertain("The provider stream contained malformed text data.", providerId);
      if (delta?.tool_calls !== undefined) appendToolCallDeltas(toolCalls, delta.tool_calls, providerId);
      if (delta?.function_call !== undefined && delta.function_call !== null) legacyFunctionCallSeen = true;
      if (delta?.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") throw submissionUncertain("The provider stream contained non-text output; completion is unconfirmed.", providerId);
        responseText += delta.content;
        onText(delta.content);
      }
      if (delta?.refusal !== undefined && delta.refusal !== null) {
        if (typeof delta.refusal !== "string") throw submissionUncertain("The provider stream contained malformed refusal text.", providerId);
        responseText += delta.refusal;
        onText(delta.refusal);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== "string") throw submissionUncertain("The provider stream contained an invalid finish status.", providerId);
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
      if (dataLines.join("\n").length > MAX_SSE_RECORD_BYTES) throw submissionUncertain("A provider streaming record exceeded Vesper's size limit.", providerId);
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
        throw new Error("Vesper stopped the provider stream.");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw submissionUncertain("The provider stream returned malformed bytes.", providerId);
      streamBytes += value.byteLength;
      if (streamBytes > MAX_STREAM_BYTES) throw submissionUncertain("The provider stream exceeded Vesper's size limit.", providerId);
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_RECORD_BYTES && !buffer.includes("\n")) {
        throw submissionUncertain("A provider streaming record exceeded Vesper's size limit.", providerId);
      }
      processLines();
      if (doneMarker) break;
    }
    buffer += decoder.decode();
    processLines(true);
    if (!doneMarker || !finishReason) throw submissionUncertain("The provider stream ended before a completion marker and finish status were received.", providerId);
    return { finishReason, toolCalls: finalizeToolCalls(toolCalls, providerId), legacyFunctionCallSeen, text: responseText };
  } catch (error) {
    if (error?.name === "ExecutionError") throw error;
    if (active.interrupted || active.disposed || active.timedOut) throw error;
    throw submissionUncertain("The provider stream ended before Vesper received a complete response.", providerId);
  } finally {
    try { await reader.cancel(); } catch { /* The reader may already be closed. */ }
    try { reader.releaseLock(); } catch { /* Lock may already be released. */ }
    if (active.reader === reader) active.reader = null;
  }
}

async function readBoundedResponseBody(response, limit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal = null) {
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("HTTP response has no readable body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  let abortListener;
  const abortPromise = signal ? new Promise((_, reject) => {
    abortListener = () => {
      void reader.cancel().catch(() => undefined);
      reject(new Error("HTTP response body was interrupted."));
    };
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }) : null;
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
      try { result = await Promise.race(abortPromise ? [reader.read(), timeout, abortPromise] : [reader.read(), timeout]); } finally { clearTimeout(timer); }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("HTTP response body exceeded its size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    try { await reader.cancel(); } catch { /* Already closed. */ }
    try { reader.releaseLock(); } catch { /* Already released. */ }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cancelResponse(response) {
  try { await response.body?.cancel?.(); } catch { /* Error response body is intentionally discarded. */ }
}

function emptyHistory(providerName = "Provider") {
  return { state: "empty", entries: [], truncated: false, text: `This ${providerName} conversation has no saved messages yet.` };
}

function defaultConversationDirectory() {
  const root = process.env.VESPER_HOME ? path.resolve(process.env.VESPER_HOME) : path.join(require("node:os").homedir(), ".vesper");
  return path.join(root, "sessions", "provider-conversations");
}

function createCompatibleChatCompletionsProvider(options = {}) {
  return assertExecutionProvider(new CompatibleChatCompletionsProvider(options));
}

function createOpenAIChatCompletionsProvider(options = {}) {
  return createCompatibleChatCompletionsProvider({ ...options, providerId: OPENAI_PROVIDER_ID });
}

const resolveOpenAIConfig = resolveCompatibleChatCompletionsConfig;
const OPENAI_CAPABILITIES = CHAT_COMPLETIONS_CAPABILITIES;

module.exports = {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  CHAT_COMPLETIONS_CAPABILITIES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_TEXT_LENGTH,
  CompatibleChatCompletionsProvider,
  OPENAI_CAPABILITIES,
  OPENAI_PROVIDER_ID,
  OpenAIChatCompletionsProvider: CompatibleChatCompletionsProvider,
  createCompatibleChatCompletionsProvider,
  createOpenAIChatCompletionsProvider,
  resolveCompatibleChatCompletionsConfig,
  resolveOpenAIConfig,
  validateBaseUrl,
};
