"use strict";

const { EventEmitter } = require("node:events");
const { approvalReview } = require("./approval-review");
const { CommandActivityStore, MAX_COMMAND_LENGTH, MAX_CWD_LENGTH, redactSensitiveText } = require("./command-activity");
const { projectConversationHistory } = require("./conversation-history");
const {
  assertExecutionProvider,
  createExecutionError,
  createExecutionEvent,
  unsupportedOperation,
} = require("./execution-interface");
const { createTaskEvidence, mergeRepositoryEvidence, recordProviderExecutionEvent, renderTaskEvidenceReport } = require("./task-evidence");

const CODEX_PROVIDER_ID = "codex-app-server";
const MAX_TEXT_EVENT_LENGTH = 32 * 1024;
const CODEX_CAPABILITIES = Object.freeze({
  streaming: true,
  interruptions: true,
  resume: true,
  conversationHistory: true,
  approvalEvents: true,
  fileChanges: true,
  commandExecutionEvents: true,
  recovery: true,
  persistentSessions: true,
});

class CodexExecutionProvider extends EventEmitter {
  constructor({ client, clientOptions, clientFactory = createDefaultAppServerClient, approvalHandler = null, sessionId = null } = {}) {
    super();
    this.id = CODEX_PROVIDER_ID;
    this.capabilities = CODEX_CAPABILITIES;
    this.approvalHandler = approvalHandler;
    this.sessionId = safeIdentity(sessionId);
    this.activeEvidence = null;
    this.disposed = false;
    this.connectionInitialized = false;
    this.commandActivity = new CommandActivityStore();
    this.initialConversationId = safeIdentity(clientOptions?.initialThreadId) || null;
    this.handleClientProgress = this.handleClientProgress.bind(this);
    this.handleApprovalRequest = this.handleApprovalRequest.bind(this);
    this.client = client || clientFactory({ ...(clientOptions || {}), onApproval: this.handleApprovalRequest });
    if (!this.client || typeof this.client.runTurn !== "function") throw new TypeError("A Codex app-server client is required.");
    this.client.on?.("progress", this.handleClientProgress);
    this.client.onApproval = this.handleApprovalRequest;
  }

  get conversationId() {
    return safeIdentity(this.client.threadId) || this.initialConversationId;
  }

  get conversationReady() {
    return Boolean(this.client.threadReady);
  }

  getState() {
    const availability = this.disposed ? "unavailable" : this.connectionInitialized || this.conversationReady ? "available" : "unknown";
    const state = this.disposed ? "closed" : this.conversationReady ? "connected" : this.connectionInitialized ? "initialized" : this.conversationId ? "disconnected" : "uninitialized";
    return Object.freeze({
      providerId: this.id,
      availability,
      state,
      conversationId: this.conversationId,
      conversationReady: this.conversationReady,
    });
  }

  setApprovalHandler(handler) {
    if (handler !== null && typeof handler !== "function") throw new TypeError("Approval handler must be a function.");
    this.approvalHandler = handler;
    // The app-server callback is kept inside this adapter. Frontends receive
    // a normalized review object and return a provider-neutral choice.
    this.client.onApproval = this.handleApprovalRequest;
  }

  async initialize({ projectPath } = {}) {
    this.assertLive();
    if (typeof this.client.connect !== "function") {
      throw unsupportedOperation(this.id, "initialize");
    }
    try {
      await this.client.connect(projectPath);
      this.connectionInitialized = true;
      return { providerId: this.id, available: true };
    } catch (error) {
      throw mapProviderError(error, "PROVIDER_UNAVAILABLE");
    }
  }

  async startConversation({ projectPath } = {}) {
    this.assertLive();
    if (typeof this.client.ensureThread !== "function") throw unsupportedOperation(this.id, "start conversation");
    try {
      await this.client.connect(projectPath);
      this.connectionInitialized = true;
      await this.client.ensureThread(projectPath);
      return { providerId: this.id, conversationId: this.conversationId };
    } catch (error) {
      throw mapProviderError(error, this.conversationId ? "RESUME_FAILED" : "PROVIDER_UNAVAILABLE");
    }
  }

  async resumeConversation({ projectPath, conversationId = this.conversationId } = {}) {
    this.assertLive();
    if (!this.capabilities.resume || typeof this.client.resumeThread !== "function") throw unsupportedOperation(this.id, "resume conversation");
    if (!conversationId) {
      throw createExecutionError("RESUME_FAILED", "This Vesper session has no saved provider conversation to resume.", { providerId: this.id });
    }
    if (this.conversationId && this.conversationId !== conversationId) {
      throw createExecutionError("RESUME_FAILED", "The provider conversation does not match this Vesper session.", { providerId: this.id });
    }
    try {
      const resumed = await this.client.resumeThread(projectPath);
      if (resumed !== conversationId) {
        throw createExecutionError("RESUME_FAILED", "The provider resumed a different conversation than the saved Vesper session.", { providerId: this.id });
      }
      this.emitEvent("conversation-state", { state: "ready", conversationId });
      return { providerId: this.id, conversationId };
    } catch (error) {
      throw mapProviderError(error, "RESUME_FAILED");
    }
  }

  async readConversationHistory() {
    this.assertLive();
    if (!this.capabilities.conversationHistory || typeof this.client.readThreadHistory !== "function") {
      throw unsupportedOperation(this.id, "read conversation history");
    }
    try {
      const history = await this.client.readThreadHistory();
      if (!history || history.threadId !== this.conversationId) {
        throw createExecutionError("RESUME_FAILED", "Provider history did not match the active Vesper conversation.", { providerId: this.id });
      }
      return projectConversationHistory(history);
    } catch (error) {
      throw mapProviderError(error, "CONNECTION_LOST");
    }
  }

  async submitTask({ task, projectPath, repositoryEvidence = null } = {}) {
    this.assertLive();
    if (typeof task !== "string" || !task.trim()) {
      throw createExecutionError("INVALID_REQUEST", "A non-empty task is required.", { providerId: this.id });
    }
    if (typeof projectPath !== "string" || !projectPath) {
      throw createExecutionError("INVALID_REQUEST", "A project directory is required.", { providerId: this.id });
    }
    if (typeof this.client.runTurn !== "function") throw unsupportedOperation(this.id, "submit task");
    if (this.activeEvidence) throw createExecutionError("TASK_FAILED", "Codex already has an active task; wait for it to finish before submitting another.", { providerId: this.id });

    this.commandActivity = new CommandActivityStore();
    this.activeEvidence = createTaskEvidence({
      providerId: this.id,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      projectRoot: projectPath,
    });
    if (repositoryEvidence) mergeRepositoryEvidence(this.activeEvidence, repositoryEvidence);
    let submissionResult = null;
    try {
      const result = await this.client.runTurn({
        prompt: task,
        cwd: projectPath,
        onDelta: (text) => this.emitText(text),
      });
      const status = result?.status;
      if (status === "completed") this.emitEvent("task-state", { state: "completed", conversationId: this.conversationId });
      else if (status === "interrupted") this.emitEvent("task-state", { state: "interrupted", conversationId: this.conversationId });
      else if (status === "timeout") this.emitEvent("task-state", { state: "timed-out", conversationId: this.conversationId });
      else {
        throw createExecutionError("TASK_FAILED", "The provider did not confirm a successful task completion.", { providerId: this.id });
      }
      submissionResult = { status };
      return submissionResult;
    } catch (error) {
      const normalized = mapProviderError(error, "TASK_FAILED");
      const state = normalized.code === "TASK_INTERRUPTED" ? "interrupted" : "failed";
      this.emitEvent("task-state", {
        state,
        errorCode: normalized.code,
        conversationId: this.conversationId,
        taskId: this.activeEvidence?.context.taskId,
        sourceEventType: "codex.submitTask.result",
      });
      throw normalized;
    } finally {
      const evidence = this.activeEvidence;
      if (evidence) {
        const report = renderTaskEvidenceReport(evidence);
        this.emitEvent("task-progress", {
          kind: "workflow-stage",
          stage: "report",
          sessionId: evidence.context.sessionId,
          conversationId: evidence.context.conversationId,
          taskId: evidence.context.taskId,
        });
        this.emitEvent("task-progress", {
          kind: "workflow-report",
          report,
          sessionId: evidence.context.sessionId,
          conversationId: evidence.context.conversationId,
          taskId: evidence.context.taskId,
        });
        if (submissionResult) {
          submissionResult.evidenceReport = report;
          Object.freeze(submissionResult);
        }
        this.activeEvidence = null;
      }
    }
  }

  async interrupt() {
    this.assertLive();
    if (!this.capabilities.interruptions || typeof this.client.interrupt !== "function") throw unsupportedOperation(this.id, "interrupt");
    try {
      const accepted = await this.client.interrupt();
      if (accepted) this.emitEvent("interrupt-requested", { accepted: true, conversationId: this.conversationId });
      return Boolean(accepted);
    } catch (error) {
      throw mapProviderError(error, "CONNECTION_LOST");
    }
  }

  async recover({ projectPath, conversationId = this.conversationId } = {}) {
    if (!this.capabilities.recovery) throw unsupportedOperation(this.id, "recover connection");
    this.emitEvent("recovery-state", { state: "attempting", conversationId: safeIdentity(conversationId) || null });
    try {
      const result = await this.resumeConversation({ projectPath, conversationId });
      this.emitEvent("recovery-state", { state: "recovered", conversationId: result.conversationId });
      return result;
    } catch (error) {
      this.emitEvent("recovery-state", { state: "failed", errorCode: error.code || "RESUME_FAILED", conversationId: safeIdentity(conversationId) || null });
      throw error;
    }
  }

  getRuntimeObservations() {
    if (typeof this.client.getMcpStartupStatusSnapshot !== "function") return { supported: false, items: [] };
    const snapshot = this.client.getMcpStartupStatusSnapshot();
    return snapshot && typeof snapshot === "object" ? snapshot : { supported: false, items: [] };
  }

  getMcpStartupStatusSnapshot() {
    return this.getRuntimeObservations();
  }

  async handleApprovalRequest(method, params = {}, context) {
    const request = normalizeApprovalRequest(method, params, context);
    if (request.type === "command") {
      this.emitCommandUpdates(this.commandActivity.applyApproval(approvalActivityParams(request), "requested"));
    }
    this.emitEvent("approval-required", { request: publicApprovalRequest(request), sourceEventType: method });
    if (typeof this.approvalHandler !== "function") return codexApprovalResponse(method, "decline", params);
    let choice = "decline";
    try {
      const result = await this.approvalHandler(request);
      choice = result?.choice === "approve-once" ? "approve-once" : result?.choice === "cancel" ? "cancel" : "decline";
    } catch {
      choice = "decline";
    }
    const response = codexApprovalResponse(method, choice, params);
    // Retain the existing app-server schema validation and one-time grant cap.
    return require("./app-server-client").validateApprovalResult(method, response);
  }

  handleClientProgress(event) {
    if (!event || typeof event !== "object") return;
    const conversationId = safeIdentity(event.threadId) || this.conversationId;
    const taskId = safeIdentity(event.turnId) || null;
    switch (event.type) {
      case "initialized":
        this.connectionInitialized = true;
        this.emitEvent("connection-state", { state: "ready" });
        break;
      case "thread_starting":
        this.emitEvent("conversation-state", { state: "starting" });
        break;
      case "thread_resuming":
        this.emitEvent("conversation-state", { state: "resuming", conversationId });
        break;
      case "thread_started":
        this.emitEvent("conversation-state", { state: "created", conversationId });
        break;
      case "thread_resumed":
        this.emitEvent("conversation-state", { state: "resumed", conversationId });
        break;
      case "turn_started":
        this.emitEvent("task-started", { conversationId, taskId, sourceEventType: "turn/start" });
        break;
      case "turn_identity": {
        const activityUpdates = this.commandActivity.bindTurn(conversationId, taskId);
        this.emitEvent("task-identity", {
          conversationId,
          taskId,
          sourceEventType: "turn/start",
        });
        for (const activity of boundedArray(event.fileChanges, 64)) {
          this.emitEvent("file-change", {
            activity: boundedObject(activity),
            sourceEventType: activity?.sourceEventType || "turn/start.fileChanges",
          });
        }
        if (activityUpdates.length) this.emitCommandUpdates(activityUpdates, "turn/start");
        break;
      }
      case "turn_status":
        this.emitCommandUpdates(this.commandActivity.setTurnStatus(conversationId, taskId, event.status), "turn/completed");
        this.emitEvent("task-state", { state: mapTurnState(event.status), conversationId, taskId, sourceEventType: "turn/completed" });
        break;
      case "approval_requested":
        // The separately normalized approval-required event is emitted by the
        // approval callback. The protocol payload is deliberately discarded.
        break;
      case "approval_decided":
        this.emitCommandUpdates(this.commandActivity.applyApproval(event.params, event.status), event.method || "approval.response");
        this.emitEvent("approval-decided", {
          ...normalizeApprovalActivity(event.params, event.status, event.method),
          operation: approvalType(event.method),
          sourceEventType: event.method || "approval.response",
        });
        break;
      case "codex_progress":
        this.handleCodexProgress(event.method, event.params);
        break;
      case "file_change_activity":
        this.emitEvent("file-change", {
          activity: boundedObject(event.activity),
          sourceEventType: event.activity?.sourceEventType || "file_change_activity",
        });
        break;
      case "turn_diff_activity":
      case "turn_diff_updated":
        this.emitEvent("task-progress", {
          kind: "aggregate-diff",
          stage: event.type === "turn_diff_updated" ? "update" : "final",
          activity: boundedObject(event.activity),
        });
        break;
      case "turn_timed_out":
        this.emitEvent("task-state", { state: "timed-out", conversationId, taskId: this.activeEvidence?.context.taskId, sourceEventType: "turn.timeout" });
        break;
      case "disconnected":
        this.connectionInitialized = false;
        this.emitEvent("connection-lost", { message: "Codex app-server connection was lost.", conversationId, taskId: this.activeEvidence?.context.taskId, sourceEventType: "app-server.disconnected" });
        break;
      case "interrupt_requested":
        this.emitEvent("interrupt-requested", { accepted: true, conversationId });
        break;
      case "file_approval_declined":
        this.emitEvent("approval-decided", {
          operation: "file-change",
          conversationId: safeIdentity(event.conversationId),
          taskId: safeIdentity(event.taskId),
          itemId: safeIdentity(event.itemId),
          approvalId: safeIdentity(event.approvalId),
          status: "declined",
          sourceEventType: "app-server.file_approval_declined",
        });
        this.emitEvent("task-progress", { kind: "approval-declined", message: "A file-change request could not be safely approved." });
        break;
      default:
        break;
    }
  }

  handleCodexProgress(method, params) {
    if (method === "item/started" || method === "item/completed" || method === "item/commandExecution/outputDelta") {
      this.emitCommandUpdates(this.commandActivity.applyProtocolNotification(method, params), method);
      return;
    }
    if (method === "turn/plan/updated" || method === "item/mcpToolCall/progress") {
      this.emitEvent("task-progress", { kind: method === "turn/plan/updated" ? "plan-update" : "tool-progress" });
    }
  }

  emitCommandUpdates(updates, sourceEventType = "command-activity") {
    for (const update of boundedArray(updates, 100)) {
      this.emitEvent("command-activity", { update: boundedObject(update), sourceEventType });
    }
  }

  emitText(value) {
    const text = String(value ?? "");
    if (!text) return;
    for (let offset = 0; offset < text.length; offset += MAX_TEXT_EVENT_LENGTH) {
      this.emitEvent("text-delta", { text: text.slice(offset, offset + MAX_TEXT_EVENT_LENGTH) });
    }
  }

  emitEvent(type, fields = {}) {
    if (this.disposed) return;
    if (this.activeEvidence) {
      recordProviderExecutionEvent(this.activeEvidence, {
        type,
        fields,
        sourceEventType: fields.sourceEventType,
      });
    }
    const event = createExecutionEvent(type, { providerId: this.id, ...fields });
    this.emit("event", event);
  }

  assertLive() {
    if (this.disposed) throw createExecutionError("PROVIDER_UNAVAILABLE", "The execution provider is closed.", { providerId: this.id });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.client.off?.("progress", this.handleClientProgress);
    this.client.dispose?.();
    this.removeAllListeners();
  }
}

function createDefaultAppServerClient(options) {
  const { AppServerClient } = require("./app-server-client");
  return new AppServerClient(options);
}

function createCodexExecutionProvider(options = {}) {
  return assertExecutionProvider(new CodexExecutionProvider(options));
}

function normalizeApprovalRequest(method, params, context) {
  const type = approvalType(method);
  const fileChange = method === "item/fileChange/requestApproval" ? context?.fileChange : null;
  const review = approvalReview(method, params, fileChange);
  return Object.freeze({
    type,
    conversationId: safeIdentity(params.threadId || params.conversationId),
    taskId: safeIdentity(params.turnId),
    itemId: safeIdentity(params.itemId),
    approvalId: safeIdentity(params.approvalId),
    command: safeField(params.command, MAX_COMMAND_LENGTH, true),
    cwd: safeField(params.cwd, MAX_CWD_LENGTH, false),
    review,
    canApprove: !Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept"),
    evidence: fileChange && context ? Object.freeze({ ...context, fileChange }) : undefined,
    isCurrent: typeof context?.isCurrent === "function" ? context.isCurrent : undefined,
  });
}

function publicApprovalRequest(request) {
  return Object.freeze({
    type: request.type,
    conversationId: request.conversationId,
    taskId: request.taskId,
    itemId: request.itemId,
    approvalId: request.approvalId,
    reviewTitle: request.review.title,
    reviewTruncated: request.review.truncated,
    canApprove: request.canApprove,
  });
}

function approvalActivityParams(request) {
  return {
    threadId: request.conversationId,
    turnId: request.taskId,
    itemId: request.itemId,
    approvalId: request.approvalId,
    command: request.command,
    cwd: request.cwd,
  };
}

function normalizeApprovalActivity(params = {}, status, method) {
  return {
    conversationId: safeIdentity(params.threadId),
    taskId: safeIdentity(params.turnId),
    itemId: safeIdentity(params.itemId),
    approvalId: safeIdentity(params.approvalId),
    operation: approvalType(method),
    command: safeField(params.command, MAX_COMMAND_LENGTH, true),
    cwd: safeField(params.cwd, MAX_CWD_LENGTH, false),
    status: ["approved", "declined", "cancelled"].includes(status) ? status : "declined",
  };
}

function codexApprovalResponse(method, choice, params = {}) {
  const approved = choice === "approve-once";
  const cancelled = choice === "cancel";
  if (method === "item/permissions/requestApproval") {
    return { permissions: approved ? cloneJsonValue(params.permissions || {}) : {}, scope: "turn" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: approved ? "approved" : cancelled ? "abort" : { denied: { rejection: "User declined the request." } } };
  }
  return { decision: approved ? "accept" : cancelled ? "cancel" : "decline" };
}

function approvalType(method) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") return "command";
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "file-change";
  if (method === "item/permissions/requestApproval") return "permissions";
  return "unsupported";
}

function mapProviderError(error, fallbackCode) {
  if (error?.name === "ExecutionError") return error;
  const executionCode = error?.executionCode || error?.code;
  if (error?.code === "ENOENT") {
    return createExecutionError("PROVIDER_UNAVAILABLE", "Codex CLI is unavailable. Install it or correct PATH, then retry.", { providerId: CODEX_PROVIDER_ID });
  }
  if (executionCode === "SUBMISSION_OUTCOME_UNCERTAIN") {
    return createExecutionError("SUBMISSION_OUTCOME_UNCERTAIN", "The provider did not confirm whether it accepted this task. Reconnect before submitting it again.", { providerId: CODEX_PROVIDER_ID });
  }
  if (executionCode === "TASK_INTERRUPTED" || error?.turnStatus === "interrupted") {
    return createExecutionError("TASK_INTERRUPTED", "The task was interrupted.", { providerId: CODEX_PROVIDER_ID });
  }
  if (executionCode === "CONNECTION_LOST") {
    return createExecutionError("CONNECTION_LOST", "The provider connection was lost. Reconnect before submitting another task.", { providerId: CODEX_PROVIDER_ID });
  }
  const code = ["PROVIDER_UNAVAILABLE", "CONNECTION_LOST", "RESUME_FAILED", "SUBMISSION_OUTCOME_UNCERTAIN", "TASK_FAILED", "TASK_INTERRUPTED", "INVALID_REQUEST"].includes(executionCode)
    ? executionCode
    : fallbackCode;
  const message = code === "RESUME_FAILED"
    ? "The saved provider conversation could not be resumed. The Vesper session mapping was kept."
    : code === "CONNECTION_LOST"
      ? "The provider connection was lost. Reconnect before submitting another task."
      : code === "PROVIDER_UNAVAILABLE"
        ? "Codex app-server is unavailable. Check the local Codex CLI installation and retry."
        : code === "SUBMISSION_OUTCOME_UNCERTAIN"
          ? "The provider did not confirm whether it accepted this task. Reconnect before submitting it again."
          : code === "TASK_FAILED"
            ? "The provider reported that the task failed."
            : "The provider operation failed.";
  const retryable = ["PROVIDER_UNAVAILABLE", "CONNECTION_LOST", "RESUME_FAILED"].includes(code);
  return createExecutionError(code, message, { providerId: CODEX_PROVIDER_ID, retryable });
}

function mapTurnState(status) {
  return status === "completed" || status === "interrupted" || status === "failed" ? status : "unknown";
}

function safeIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value) ? value : null;
}

function safeField(value, limit, redact) {
  if (typeof value !== "string" || !value) return null;
  const text = redact ? redactSensitiveText(value) : value.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ");
  return text.slice(0, limit);
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function boundedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length > 48_000) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function cloneJsonValue(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

module.exports = {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER_ID,
  CodexExecutionProvider,
  codexApprovalResponse,
  createCodexExecutionProvider,
  mapProviderError,
  normalizeApprovalRequest,
};
