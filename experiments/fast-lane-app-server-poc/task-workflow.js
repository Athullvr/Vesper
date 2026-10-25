"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { redactSensitiveText } = require("./command-activity");
const { shouldInvestigateTask } = require("./system-model");

const MAX_CONTEXT_LENGTH = 7_000;
const MAX_TASK_LIFECYCLE_EVENTS = 64;
const MAX_TASK_FILES = 32;
const MAX_TASK_APPROVALS = 32;
const MAX_TASK_CHANGE_ITEMS = 32;
const MAX_TASK_DIFF_LENGTH = 32 * 1024;
const MAX_DIFF_PATHS = 8;
const EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;
const VALID_STAGES = new Set(["understanding", "inspection", "planning", "proposal", "approval", "implementation", "review", "verification", "report"]);
const TRACKED_EVENT_TYPES = new Set(["task-started", "task-identity", "task-progress", "approval-required", "approval-decided", "file-change", "tool-call", "tool-result", "command-activity", "task-state", "connection-lost", "interrupt-requested"]);

/**
 * Shared repository preflight for the terminal and VS Code frontends. Inspection
 * failures fall back to the original request once; cancellation never submits.
 */
async function understandTask({
  task,
  routeDecision,
  systemModel,
  projectRoot,
  sessionId,
  providerId,
  conversationId = null,
  signal,
  maximumTaskLength = 32 * 1024,
  maximumContextLength = MAX_CONTEXT_LENGTH,
  now = () => Date.now(),
} = {}) {
  const originalTask = typeof task === "string" ? task : "";
  if (!shouldInvestigateTask(originalTask)) {
    return Object.freeze({ state: "not-needed", evidenceIncluded: false, providerTask: originalTask, repositoryEvidence: null, investigation: null,
      note: "This task did not require repository preflight." });
  }
  if (signal?.aborted) return cancelledUnderstanding(originalTask);
  if (!systemModel || typeof systemModel.investigate !== "function") {
    return fallbackUnderstanding(originalTask, null, "Repository inspection is unavailable. The original task without repository evidence will be submitted.");
  }

  let investigation;
  try {
    investigation = await systemModel.investigate({ task: originalTask, routeDecision, signal });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || error?.code === "PREFLIGHT_CANCELLED") return cancelledUnderstanding(originalTask, null);
    return fallbackUnderstanding(originalTask, null, "Repository inspection could not complete; the original task will be submitted without repository evidence.", safeErrorCode(error));
  }
  if (signal?.aborted || investigation?.status === "cancelled") return cancelledUnderstanding(originalTask, investigation);

  const state = ["complete", "partial"].includes(investigation?.status) ? investigation.status : "fallback";
  if (state === "fallback") {
    return fallbackUnderstanding(originalTask, investigation, "Repository inspection was unavailable; the original task will be submitted without repository evidence.");
  }
  const scopeError = evidenceScopeError(investigation?.evidence, {
    projectRoot, sessionId, providerId, conversationId, now: now(),
  });
  if (scopeError) {
    return fallbackUnderstanding(originalTask, investigation,
      `Repository evidence was ${scopeError}; the original task will be submitted without it.`);
  }
  const context = typeof investigation.providerContext === "string" ? investigation.providerContext : "";
  if (!context || context.length > maximumContextLength || originalTask.length + context.length + 2 > maximumTaskLength) {
    return fallbackUnderstanding(originalTask, investigation,
      "The bounded repository summary did not fit the provider task limit; the original task will be submitted without repository evidence.");
  }
  return Object.freeze({
    state,
    evidenceIncluded: true,
    providerTask: `${originalTask}\n\n${context}`,
    repositoryEvidence: investigation.evidence,
    investigation,
    note: state === "partial" ? "Partial, freshly scoped repository evidence is attached to this task only." : "Fresh, scoped repository evidence is attached to this task only.",
  });
}

function evidenceScopeError(evidence, { projectRoot, sessionId, providerId, conversationId, now }) {
  const context = evidence?.context;
  if (!context || typeof projectRoot !== "string" || typeof context.projectRoot !== "string") return "missing required scope metadata";
  if (context.sessionId !== sessionId || context.providerId !== providerId) return "scoped to a different session or provider";
  if (path.resolve(context.projectRoot) !== path.resolve(projectRoot)) return "scoped to a different project";
  if ((conversationId || context.conversationId) && context.conversationId !== conversationId) return "scoped to a different provider conversation";
  const observedAt = Date.parse(context.investigation?.observedAt || evidence.investigation?.observedAt || "");
  if (!Number.isFinite(observedAt) || observedAt > now + 60_000 || now - observedAt > EVIDENCE_MAX_AGE_MS) return "stale or missing a fresh observation time";
  return null;
}

function fallbackUnderstanding(task, investigation, note, errorCode) {
  return Object.freeze({ state: "fallback", evidenceIncluded: false, providerTask: task, repositoryEvidence: null,
    investigation: investigation || null, note, ...(errorCode ? { errorCode } : {}) });
}

function cancelledUnderstanding(task, investigation = null) {
  return Object.freeze({ state: "cancelled", evidenceIncluded: false, providerTask: task, repositoryEvidence: null,
    investigation: investigation || null, note: "Repository inspection was cancelled; the provider task was not submitted." });
}

function renderPreflightSummary(result) {
  if (!result) return "Repository preflight unavailable; no evidence was attached.";
  if (!result.evidenceIncluded) return cleanText(result.note || "No repository evidence was attached.", 500);
  const investigation = result.investigation || {};
  const lines = [
    `Repository preflight · ${result.state} · ${Number.isSafeInteger(investigation.project?.fileCount) ? investigation.project.fileCount : 0} files discovered · ${Array.isArray(investigation.findings) ? investigation.findings.length : 0} findings.`,
    "Bounded findings are attached to this provider task only.",
  ];
  for (const item of (investigation.plan || []).slice(0, 4)) lines.push(`Plan: ${cleanText(item, 240)}`);
  for (const item of (investigation.unresolved || investigation.assumptions || []).slice(0, 4)) lines.push(`Unresolved assumption: ${cleanText(item, 240)}`);
  const verification = investigation.verificationRequirements || [];
  for (const item of verification.slice(0, 4)) lines.push(`Suggested verification, not run: ${cleanText(item, 240)}`);
  const output = lines.join("\n");
  return output.length <= 4_000 ? output : `${output.slice(0, 3_970)}\n[preflight summary truncated]`;
}

class TaskLifecycle {
  constructor({ requestId, sessionId, providerId, projectRoot, task = "" } = {}) {
    this.context = {
      requestId: safeIdentity(requestId),
      sessionId: safeIdentity(sessionId),
      providerId: safeIdentity(providerId),
      projectRoot: typeof projectRoot === "string" ? path.resolve(projectRoot) : null,
      conversationId: null,
      taskId: null,
    };
    this.stage = "understanding";
    this.status = "running";
    this.providerStatus = "not-submitted";
    this.submitted = false;
    this.approvals = new Map();
    this.proposedFiles = new Map();
    this.fileChangeItems = new Map();
    this.approvedFileItems = new Set();
    this.completedFileItems = new Set();
    this.approvedProviderFiles = new Set();
    this.verifiedFiles = new Set();
    this.diskVerifiedFiles = new Set();
    this.operations = [];
    this.eventsObserved = 0;
    this.eventsOmitted = 0;
    this.diff = null;
    this.verification = { state: "not-run", command: null, exitCode: null, summary: "No verification command has run." };
    this.verificationSuggestions = [];
    this.finished = false;
    this.expectsImplementation = isImplementationTask(task);
  }

  setUnderstanding(preflight) {
    this.preflightState = preflight?.state || "unavailable";
    const investigation = preflight?.investigation;
    const suggestions = preflight?.evidenceIncluded && Array.isArray(investigation?.verificationRequirements)
      ? investigation.verificationRequirements : [];
    this.verificationSuggestions = suggestions.slice(0, 8).map((item) => cleanText(item, 240)).filter(Boolean);
    if (preflight?.state === "cancelled") this.cancelBeforeSubmission(preflight.note);
    else this.setStage("planning");
    return this.snapshot();
  }

  setStage(stage) {
    if (VALID_STAGES.has(stage)) this.stage = stage;
    return this.snapshot();
  }

  observe(event) {
    if (!event || typeof event !== "object" || !TRACKED_EVENT_TYPES.has(event.type)) return false;
    if (event.providerId && this.context.providerId && event.providerId !== this.context.providerId) return false;
    if (event.sessionId && this.context.sessionId && event.sessionId !== this.context.sessionId) return false;
    const conversationId = safeIdentity(event.conversationId);
    const taskId = safeIdentity(event.taskId);
    if (conversationId && this.context.conversationId && conversationId !== this.context.conversationId) return false;
    if (taskId && this.context.taskId && taskId !== this.context.taskId) return false;
    if (conversationId && !this.context.conversationId) this.context.conversationId = conversationId;
    if (taskId && !this.context.taskId) this.context.taskId = taskId;
    this.eventsObserved += 1;
    if (this.eventsObserved > MAX_TASK_LIFECYCLE_EVENTS) this.eventsOmitted = Math.min(999, this.eventsOmitted + 1);

    if (event.type === "task-started") {
      this.submitted = true;
      this.providerStatus = "running";
      this.stage = "implementation";
    } else if (event.type === "task-identity") {
      this.submitted = true;
      this.stage = "implementation";
      for (const activity of boundedArray(event.fileChanges, 32)) this.recordFileChange(activity);
    } else if (event.type === "task-progress") {
      if (event.kind === "workflow-stage" && VALID_STAGES.has(event.stage)) this.stage = event.stage;
      if (event.kind === "aggregate-diff") this.recordDiff(event.activity);
    } else if (event.type === "approval-required") {
      const request = event.request || {};
      const key = approvalKey(request);
      this.storeApproval(key, { operation: safeToken(request.type, 40) || "operation", status: "pending", itemId: safeIdentity(request.itemId) });
      this.stage = "approval";
    } else if (event.type === "approval-decided") {
      const key = approvalKey(event);
      const status = normalizeApprovalState(event.status);
      this.storeApproval(key, { operation: safeToken(event.operation, 40) || "operation", status, itemId: safeIdentity(event.itemId) });
      if (event.operation === "file-change" && event.itemId) {
        const itemKey = fileChangeKey(event, this.context);
        if (status === "approved") this.approvedFileItems.add(itemKey);
        else this.approvedFileItems.delete(itemKey);
        this.refreshApprovedProviderFiles();
      }
    } else if (event.type === "file-change") {
      this.recordFileChange(event.activity);
      this.stage = "review";
    } else if (event.type === "tool-call") {
      if (["propose_file_change", "apply_file_change"].includes(event.toolId)) this.stage = event.toolId === "apply_file_change" ? "approval" : "proposal";
    } else if (event.type === "tool-result") {
      this.recordOperation(event);
      if (event.toolId === "apply_file_change" && event.state === "verified" && event.verified === true) {
        for (const filePath of normalizeFilePaths(event.changedFiles, this.context.projectRoot)) this.addVerifiedFile(filePath);
        this.stage = "verification";
      }
    } else if (event.type === "command-activity") {
      const activity = event.update?.activity;
      if (activity) this.recordOperation({ toolId: "codex-command", state: commandOutcomeState(activity), verified: false,
        summary: activity.exitCodeAvailable ? `Codex reported command exit code ${activity.exitCode}.` : "Codex command outcome is provider-reported." });
    } else if (event.type === "task-state") {
      this.providerStatus = normalizeProviderState(event.state, event.errorCode);
      this.submitted ||= this.providerStatus !== "not-submitted";
      if (this.providerStatus === "completed") this.stage = "review";
      else if (["failed", "interrupted", "timed-out", "uncertain"].includes(this.providerStatus)) this.stage = "report";
    } else if (event.type === "connection-lost") {
      this.providerStatus = "uncertain";
    } else if (event.type === "interrupt-requested") {
      if (event.accepted === true) this.interruptRequested = true;
    }
    this.recomputeStatus();
    return true;
  }

  recordFileChange(activity) {
    if (!activity || typeof activity !== "object") return;
    const itemKey = fileChangeKey(activity, this.context);
    const previous = this.fileChangeItems.get(itemKey) || [];
    if (activity.state === "invalidated") {
      for (const filePath of previous) this.proposedFiles.delete(filePath);
      this.fileChangeItems.delete(itemKey);
      this.completedFileItems.delete(itemKey);
      this.approvedFileItems.delete(itemKey);
      for (const remaining of this.fileChangeItems.values()) {
        for (const filePath of remaining) this.proposedFiles.set(filePath, "proposed");
      }
      this.refreshApprovedProviderFiles();
      return;
    }
    if (activity.state === "completed" && (!Array.isArray(activity.changes) || activity.changes.length === 0)) {
      for (const filePath of previous) this.proposedFiles.set(filePath, "completed; disk state unverified");
      this.completedFileItems.add(itemKey);
      this.refreshApprovedProviderFiles();
      return;
    }
    const paths = new Set();
    for (const change of boundedArray(activity.changes, MAX_TASK_FILES)) {
      const filePath = normalizeProjectPath(change?.path, this.context.projectRoot);
      if (!filePath) continue;
      if (!this.proposedFiles.has(filePath) && this.proposedFiles.size >= MAX_TASK_FILES) {
        this.eventsOmitted += 1;
        continue;
      }
      this.proposedFiles.set(filePath, safeToken(activity.state, 40) || "proposed");
      paths.add(filePath);
      if (change?.movePath) {
        const moved = normalizeProjectPath(change.movePath, this.context.projectRoot);
        if (moved) {
          if (!this.proposedFiles.has(moved) && this.proposedFiles.size >= MAX_TASK_FILES) {
            this.eventsOmitted += 1;
            continue;
          }
          this.proposedFiles.set(moved, safeToken(activity.state, 40) || "proposed");
          paths.add(moved);
        }
      }
    }
    for (const filePath of previous) if (!paths.has(filePath)) this.proposedFiles.delete(filePath);
    if (paths.size) {
      if (!this.fileChangeItems.has(itemKey) && this.fileChangeItems.size >= MAX_TASK_CHANGE_ITEMS) {
        this.eventsOmitted += 1;
        return;
      }
      this.fileChangeItems.set(itemKey, [...paths]);
      if (activity.state === "completed") this.completedFileItems.add(itemKey);
      else this.completedFileItems.delete(itemKey);
      this.refreshApprovedProviderFiles();
    }
  }

  refreshApprovedProviderFiles() {
    this.approvedProviderFiles.clear();
    for (const itemKey of this.completedFileItems) {
      if (!this.approvedFileItems.has(itemKey)) continue;
      for (const filePath of this.fileChangeItems.get(itemKey) || []) this.approvedProviderFiles.add(filePath);
    }
  }

  workspaceReadbackPaths() {
    return [...new Set([...this.verifiedFiles, ...this.approvedProviderFiles])].slice(0, MAX_DIFF_PATHS);
  }

  storeApproval(key, value) {
    if (!this.approvals.has(key) && this.approvals.size >= MAX_TASK_APPROVALS) {
      const oldest = this.approvals.keys().next().value;
      if (oldest !== undefined) this.approvals.delete(oldest);
      this.eventsOmitted += 1;
    }
    this.approvals.set(key, value);
  }

  recordDiff(activity) {
    if (!activity || typeof activity !== "object") return;
    const evidenceState = ["available", "empty", "unavailable"].includes(activity.evidenceState) ? activity.evidenceState : "unavailable";
    const rawDiff = typeof activity.diff === "string" ? activity.diff : "";
    const safeDiff = redactSensitiveText(rawDiff).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
    this.diff = Object.freeze({
      source: activity.source === "workspace" ? "workspace" : "provider",
      evidenceState,
      closeReason: safeToken(activity.closeReason, 40) || "inProgress",
      diff: safeDiff.slice(0, MAX_TASK_DIFF_LENGTH),
      truncated: safeDiff.length > MAX_TASK_DIFF_LENGTH || activity.truncated === true,
      paths: Object.freeze(normalizeFilePaths(activity.paths, this.context.projectRoot).slice(0, MAX_DIFF_PATHS)),
      incomplete: activity.incomplete === true,
    });
  }

  addVerifiedFile(filePath) {
    if (this.verifiedFiles.has(filePath)) return;
    if (this.verifiedFiles.size >= MAX_TASK_FILES) {
      this.eventsOmitted += 1;
      return;
    }
    this.verifiedFiles.add(filePath);
  }

  addDiskVerifiedFile(filePath) {
    if (this.diskVerifiedFiles.has(filePath)) return;
    if (this.diskVerifiedFiles.size >= MAX_TASK_FILES) {
      this.eventsOmitted += 1;
      return;
    }
    this.diskVerifiedFiles.add(filePath);
  }

  recordOperation(event) {
    if (this.operations.length >= MAX_TASK_FILES) {
      this.eventsOmitted += 1;
      return;
    }
    const operation = {
      toolId: safeToken(event.toolId, 80) || "unknown",
      state: safeToken(event.state, 40) || "unknown",
      verified: event.verified === true,
      ...(safeToken(event.errorCode, 80) ? { errorCode: safeToken(event.errorCode, 80) } : {}),
      ...(cleanText(event.summary, 240) ? { summary: cleanText(event.summary, 240) } : {}),
    };
    const duplicate = this.operations.find((item) => item.toolId === operation.toolId && item.state === operation.state && item.errorCode === operation.errorCode);
    if (!duplicate) this.operations.push(operation);
    if (event.toolId === "apply_file_change" && event.state === "verified" && event.verified === true) {
      for (const filePath of normalizeFilePaths(event.changedFiles, this.context.projectRoot)) this.addVerifiedFile(filePath);
    }
  }

  complete({ result, error } = {}) {
    this.finished = true;
    if (error) {
      const code = safeToken(error.code, 80);
      this.providerStatus = error.code === "TASK_INTERRUPTED" ? "interrupted"
        : error.code === "SUBMISSION_OUTCOME_UNCERTAIN" || error.code === "CONNECTION_LOST" ? "uncertain"
          : "failed";
      this.errorCode = code || "TASK_FAILED";
    } else if (result && typeof result.status === "string") {
      const resultStatus = normalizeProviderState(result.status, result.recoveryCode === "submission-outcome-uncertain" ? "SUBMISSION_OUTCOME_UNCERTAIN" : result.errorCode);
      if (resultStatus !== "not-submitted" && this.providerStatus !== "uncertain") this.providerStatus = resultStatus;
      this.submitted ||= ["completed", "failed", "interrupted", "timed-out", "uncertain"].includes(resultStatus);
    }
    if (!this.submitted && this.status !== "cancelled" && !error) this.providerStatus = "not-submitted";
    this.stage = "report";
    this.recomputeStatus();
    return this.snapshot();
  }

  cancelBeforeSubmission(note) {
    this.submitted = false;
    this.providerStatus = "not-submitted";
    this.status = "cancelled";
    this.stage = "report";
    this.cancelNote = cleanText(note, 240) || "Task cancelled before provider submission.";
  }

  recordVerification(result, command) {
    const argv = Array.isArray(command) ? command.slice(0, 64).map((item) => cleanText(item, 240)) : [];
    const display = argv.length ? argv.join(" ") : "verification command";
    const exitCode = Number.isInteger(result?.result?.exitCode) ? result.result.exitCode : null;
    const errorCode = safeToken(result?.error?.code || result?.errorCode, 80);
    let state = "unavailable";
    let summary = "The verification command outcome is unavailable.";
    if (errorCode === "APPROVAL_DECLINED") {
      state = "rejected";
      summary = "The verification command was declined; it did not run.";
    } else if (["APPROVAL_CANCELLED", "TOOL_INTERRUPTED", "COMMAND_INTERRUPTED"].includes(errorCode) || result?.state === "interrupted") {
      state = "cancelled";
      summary = "The verification command was cancelled; its execution was not confirmed.";
    } else if (result?.state === "executed" && exitCode === 0 && result.result?.signal === null) {
      state = "passed";
      summary = "The isolated verification command returned exit code 0.";
    } else if (result?.executed === true || exitCode !== null) {
      state = "failed";
      summary = exitCode === null ? "The verification command ran without a confirmed exit code." : `The verification command returned exit code ${exitCode}.`;
    } else if (result?.state === "rejected") {
      state = "rejected";
      summary = "The verification command was rejected and did not run.";
    }
    this.verification = Object.freeze({ state, command: display, exitCode, summary, errorCode: errorCode || null });
    this.stage = "report";
    this.recomputeStatus();
    return this.snapshot();
  }

  recomputeStatus() {
    const approvalStates = [...this.approvals.values()].map((item) => item.status);
    const pending = approvalStates.includes("pending");
    const rejected = approvalStates.some((state) => ["rejected", "cancelled"].includes(state));
    const failedOperation = this.operations.some((item) => ["failed", "rejected", "timed-out", "interrupted", "uncertain"].includes(item.state) || item.errorCode);
    if (this.status === "cancelled" && !this.submitted) return;
    if (this.providerStatus === "failed") this.status = "failed";
    else if (this.providerStatus === "interrupted") this.status = "interrupted";
    else if (this.providerStatus === "timed-out" || this.providerStatus === "uncertain") this.status = "uncertain";
    else if (this.providerStatus === "completed") {
      const hasReadBackFiles = this.verifiedFiles.size > 0 || this.diskVerifiedFiles.size > 0;
      const unresolvedFiles = [...this.proposedFiles.keys()].some((filePath) => !this.verifiedFiles.has(filePath) && !this.diskVerifiedFiles.has(filePath));
      const unresolvedDiff = this.diff?.evidenceState === "available" && Boolean(this.diff.diff) && !hasReadBackFiles;
      const implementationUnverified = this.expectsImplementation && !hasReadBackFiles;
      this.status = pending || rejected || failedOperation || unresolvedFiles || unresolvedDiff || implementationUnverified || this.eventsOmitted > 0 || ["failed", "rejected", "cancelled"].includes(this.verification.state)
        ? "partial" : "completed";
    } else this.status = "running";
  }

  snapshot() {
    const approvals = [...this.approvals.values()].slice(-16).map((item) => Object.freeze({ ...item }));
    const proposedFiles = [...this.proposedFiles.entries()].slice(0, MAX_TASK_FILES).map(([path, state]) => Object.freeze({ path, state }));
    return Object.freeze({
      requestId: this.context.requestId,
      sessionId: this.context.sessionId,
      providerId: this.context.providerId,
      projectRoot: this.context.projectRoot,
      conversationId: this.context.conversationId,
      taskId: this.context.taskId,
      stage: this.stage,
      status: this.status,
      providerStatus: this.providerStatus,
      submitted: this.submitted,
      preflightState: this.preflightState || "not-run",
      pendingApprovals: approvals.filter((item) => item.status === "pending").length,
      approvals: Object.freeze(approvals),
      proposedFiles: Object.freeze(proposedFiles),
      verifiedFiles: Object.freeze([...this.verifiedFiles].slice(0, MAX_TASK_FILES)),
      diskVerifiedFiles: Object.freeze([...this.diskVerifiedFiles].slice(0, MAX_TASK_FILES)),
      diff: this.diff,
      verification: this.verification,
      verificationSuggestions: Object.freeze(this.verificationSuggestions.slice(0, 8)),
      expectsImplementation: this.expectsImplementation,
      operations: Object.freeze(this.operations.slice(0, MAX_TASK_FILES).map((item) => Object.freeze({ ...item }))),
      eventsOmitted: this.eventsOmitted,
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.cancelNote ? { note: this.cancelNote } : {}),
    });
  }
}

function renderTaskLifecycle(snapshot) {
  const state = snapshot || {};
  const lines = [
    `Task workflow: ${safeToken(state.status, 40) || "unknown"} · provider ${safeToken(state.providerStatus, 40) || "unknown"} · stage ${safeToken(state.stage, 40) || "unknown"}.`,
    `Repository evidence: ${safeToken(state.preflightState, 40) || "unknown"}.`,
  ];
  if (state.pendingApprovals) lines.push(`Approvals still pending: ${state.pendingApprovals}.`);
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  const settled = approvals.filter((item) => item.status !== "pending");
  for (const item of settled.slice(0, 4)) lines.push(`Approval ${item.operation}: ${item.status}.`);
  if (state.proposedFiles?.length) lines.push(`Provider-reported proposed or changed paths (disk state may be unverified): ${state.proposedFiles.map((item) => `\`${item.path}\``).join(", ")}.`);
  if (state.verifiedFiles?.length) lines.push(`Vesper-managed file writes verified by read-back: ${state.verifiedFiles.map((item) => `\`${item}\``).join(", ")}.`);
  if (state.diskVerifiedFiles?.length) lines.push(`Approved provider file changes confirmed in the working-tree diff: ${state.diskVerifiedFiles.map((item) => `\`${item}\``).join(", ")}.`);
  if (state.diff) {
    lines.push(state.diff.source === "workspace"
      ? `Workspace diff reread: ${state.diff.evidenceState} · ${state.diff.closeReason}${state.diff.incomplete ? " · some paths unavailable" : ""}${state.diff.truncated ? " · display omitted" : ""}; it can include edits made before this task.`
      : `Provider-reported diff: ${state.diff.evidenceState} · ${state.diff.closeReason}${state.diff.truncated ? " · display omitted" : ""}; disk state is not verified by this diff.`);
    if (state.diff.evidenceState === "available" && state.diff.diff) lines.push(`Observed diff:\n${state.diff.diff}`);
  }
  if (state.verification) lines.push(`Verification: ${state.verification.state}${state.verification.command ? ` · ${state.verification.command}` : ""} · ${state.verification.summary}`);
  for (const item of (state.verificationSuggestions || []).slice(0, 4)) lines.push(`Suggested verification, not run: ${item}`);
  if (state.errorCode) lines.push(`Provider failure: ${state.errorCode}. Vesper did not retry the task.`);
  if (state.eventsOmitted) lines.push(`Workflow event bound reached; ${state.eventsOmitted} additional events omitted.`);
  return lines.join("\n");
}

function normalizeProviderState(value, errorCode) {
  if (errorCode === "SUBMISSION_OUTCOME_UNCERTAIN" || errorCode === "CONNECTION_LOST" || value === "uncertain") return "uncertain";
  if (["completed", "failed", "interrupted", "timed-out"].includes(value)) return value;
  if (value === "timeout" || value === "timed_out") return "timed-out";
  return "not-submitted";
}

function isImplementationTask(task) {
  return typeof task === "string" && /\b(?:implement|add|create|refactor|build|fix|modify|update|remove|delete|replace|write)\b/iu.test(task);
}

/** Re-read the bounded working-tree diff for Vesper-verified paths after a provider turn. */
async function captureWorkspaceDiff(lifecycle, runtime, { isCurrent = () => true } = {}) {
  const state = lifecycle?.snapshot?.();
  if (!state || !runtime || runtime.disposed || runtime.sessionId !== state.sessionId || !isCurrent()) return false;
  let expectedRoot;
  try { expectedRoot = fs.realpathSync(state.projectRoot); } catch { return false; }
  const paths = lifecycle.workspaceReadbackPaths().slice(0, MAX_DIFF_PATHS);
  if (!paths.length) return false;
  const diffs = [];
  let unavailable = false;
  for (const relativePath of paths) {
    if (!isCurrent()) return false;
    let result;
    try {
      const request = {
        toolId: "git_diff",
        input: { path: relativePath },
        context: { projectRoot: expectedRoot, sessionId: state.sessionId },
        requestId: crypto.randomUUID(),
      };
      const preview = await runtime.preview(request);
      if (preview?.state !== "validated" || preview?.executes !== false) {
        unavailable = true;
        continue;
      }
      result = await runtime.invoke({
        toolId: "git_diff",
        input: { path: relativePath },
        context: { projectRoot: expectedRoot, sessionId: state.sessionId },
        requestId: crypto.randomUUID(),
      });
    } catch {
      unavailable = true;
      continue;
    }
    const text = result?.result?.text;
    if (!["executed", "verified"].includes(result?.state) || result?.result?.exitCode !== 0 || typeof text !== "string") {
      unavailable = true;
      continue;
    }
    if (text) {
      diffs.push(text);
      if (!state.verifiedFiles.includes(relativePath)) lifecycle.addDiskVerifiedFile(relativePath);
    }
  }
  if (!isCurrent()) return false;
  lifecycle.observe({
    type: "task-progress",
    kind: "aggregate-diff",
    activity: {
      source: "workspace",
      evidenceState: diffs.length ? "available" : unavailable ? "unavailable" : "empty",
      closeReason: "workspace-readback",
      diff: diffs.join("\n").slice(0, MAX_TASK_DIFF_LENGTH + 1),
      paths,
      incomplete: unavailable,
    },
  });
  return true;
}

function normalizeApprovalState(value) {
  if (["pending", "requested", "approval-required"].includes(value)) return "pending";
  if (["approved", "approve", "approve-once"].includes(value)) return "approved";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  return "rejected";
}

function commandOutcomeState(activity) {
  if (activity?.executionStatus === "declined") return "rejected";
  if (activity?.executionStatus === "failed") return "failed";
  if (activity?.executionStatus === "inProgress") return "running";
  if (activity?.executionStatus === "completed" && activity.exitCodeAvailable === true && Number.isInteger(activity.exitCode)) {
    return activity.exitCode === 0 ? "completed" : "failed";
  }
  return "unverified";
}

function approvalKey(value = {}) {
  const type = ["file-change", "command", "permissions", "unsupported"].includes(value.type) ? value.type : value.operation;
  return [safeToken(type, 40) || "operation", safeIdentity(value.approvalId) || "",
    safeIdentity(value.itemId) || "", safeIdentity(value.requestId) || ""].join(":");
}

function fileChangeKey(value = {}, context = {}) {
  const conversationId = safeIdentity(value.conversationId || value.threadId) || safeIdentity(context.conversationId) || "conversation";
  const taskId = safeIdentity(value.taskId || value.turnId) || safeIdentity(context.taskId) || "task";
  const itemId = safeIdentity(value.itemId) || "turn";
  return [conversationId, taskId, itemId].join(":");
}

function normalizeProjectPath(value, projectRoot) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || !projectRoot) return null;
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative === ".") return ".";
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join("/").slice(0, 1_024);
}

function normalizeFilePaths(values, projectRoot) {
  return boundedArray(values, MAX_TASK_FILES).map((item) => normalizeProjectPath(item, projectRoot)).filter(Boolean);
}

function boundedArray(value, maximum) { return Array.isArray(value) ? value.slice(0, maximum) : []; }
function safeIdentity(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value) ? value : null; }
function safeToken(value, maximum) { return typeof value === "string" && /^[A-Za-z0-9_.:/_-]{1,160}$/u.test(value) ? value.slice(0, maximum) : null; }
function cleanText(value, maximum) {
  if (typeof value !== "string" || !value.trim()) return "";
  return redactSensitiveText(value).replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}
function safeErrorCode(error) { return safeToken(error?.code, 80); }

module.exports = {
  EVIDENCE_MAX_AGE_MS,
  MAX_CONTEXT_LENGTH,
  TaskLifecycle,
  evidenceScopeError,
  understandTask,
  renderPreflightSummary,
  renderTaskLifecycle,
  isImplementationTask,
  captureWorkspaceDiff,
};
