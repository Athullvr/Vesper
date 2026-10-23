"use strict";

const path = require("node:path");
const { redactSensitiveText } = require("./command-activity");

const MAX_EVIDENCE_ENTRIES = 32;
const MAX_EVIDENCE_PATHS = 16;
const MAX_REPOSITORY_FINDINGS = 48;
const MAX_REPORT_LENGTH = 8_192;
const MAX_PROVIDER_EVENTS = 64;
const NORMALIZED_EVENT_SOURCES = new Set([
  "command-activity", "file-change", "approval-required", "approval-decided",
  "task-started", "task-identity", "task-state", "connection-lost",
  "turn/start", "turn/start.fileChanges",
]);
const INSPECTION_TOOLS = new Set(["read_file", "list_files", "search_files", "git_status", "git_diff", "git_log", "git_check_ignore"]);
const SUCCESS_STATES = new Set(["executed", "verified"]);

function createTaskEvidence({ providerId = null, sessionId = null, conversationId = null, taskId = null, projectRoot = null } = {}) {
  return {
    context: {
      providerId: safeIdentity(providerId),
      sessionId: safeIdentity(sessionId),
      conversationId: safeIdentity(conversationId),
      taskId: safeIdentity(taskId),
      projectRoot: typeof projectRoot === "string" ? projectRoot.slice(0, 4_096) : null,
    },
    toolCalls: 0,
    inspections: [],
    findings: [],
    proposals: [],
    appliedChanges: [],
    failures: [],
    providerEvents: [],
    providerEventIndex: new Map(),
    providerEventsOmitted: 0,
    investigation: null,
    planPresented: false,
  };
}

function recordRepositoryFinding(evidence, finding = {}) {
  if (!evidence || !Array.isArray(evidence.findings) || evidence.findings.length >= MAX_REPOSITORY_FINDINGS) return false;
  const type = safeToken(finding.type, 40);
  const description = safeDescription(finding.description, 320);
  const source = safeToken(finding.source, 80);
  if (!type || !description || !source) return false;
  const normalizedPath = safeRelativePath(finding.path);
  const entry = {
    type,
    description,
    ...(normalizedPath ? { path: normalizedPath } : {}),
    ...(safeRelativePath(finding.relatedPath) ? { relatedPath: safeRelativePath(finding.relatedPath) } : {}),
    ...(Number.isInteger(finding.lineStart) && finding.lineStart > 0 ? { lineStart: finding.lineStart } : {}),
    ...(Number.isInteger(finding.lineEnd) && finding.lineEnd >= (finding.lineStart || 1) ? { lineEnd: finding.lineEnd } : {}),
    ...(Number.isInteger(finding.relatedLine) && finding.relatedLine > 0 ? { relatedLine: finding.relatedLine } : {}),
    ...(safeDescription(finding.symbol, 120) ? { symbol: safeDescription(finding.symbol, 120) } : {}),
    ...(safeDescription(finding.moduleSpecifier, 200) ? { moduleSpecifier: safeDescription(finding.moduleSpecifier, 200) } : {}),
    ...(safeDescription(finding.importedName, 120) ? { importedName: safeDescription(finding.importedName, 120) } : {}),
    ...(safeDescription(finding.route, 200) ? { route: safeDescription(finding.route, 200) } : {}),
    ...(safeToken(finding.definitionKind, 20) ? { definitionKind: safeToken(finding.definitionKind, 20) } : {}),
    ...(safeToken(finding.discoveryMethod, 80) ? { discoveryMethod: safeToken(finding.discoveryMethod, 80) } : {}),
    ...(finding.sourceContextRead === true ? { sourceContextRead: true } : {}),
    source,
    confidence: ["high", "medium", "low", "unknown"].includes(finding.confidence) ? finding.confidence : "unknown",
    observation: finding.observation === "inferred" ? "inferred" : "observed",
    status: ["confirmed", "incomplete", "stale", "contradictory", "unknown"].includes(finding.status) ? finding.status : "confirmed",
    ...(safeToken(finding.commit, 40) ? { commit: safeToken(finding.commit, 40) } : {}),
    ...(Number.isInteger(finding.depth) && finding.depth >= 1 && finding.depth <= 8 ? { depth: finding.depth } : {}),
    observedAt: safeTimestamp(finding.observedAt) || new Date().toISOString(),
  };
  const key = findingKey(entry);
  if (evidence.findings.some((existing) => findingKey(existing) === key)) return true;
  evidence.findings.push(entry);
  return true;
}

function mergeRepositoryEvidence(target, source) {
  if (!target || !target.context || !source || !source.context) return false;
  if (target.context.sessionId && source.context.sessionId && target.context.sessionId !== source.context.sessionId) return false;
  if (target.context.conversationId && source.context.conversationId && target.context.conversationId !== source.context.conversationId) return false;
  if (target.context.projectRoot && source.context.projectRoot && path.resolve(target.context.projectRoot) !== path.resolve(source.context.projectRoot)) return false;
  for (const entry of Array.isArray(source.inspections) ? source.inspections.slice(0, MAX_EVIDENCE_PATHS) : []) {
    addBoundedUnique(target.inspections, entry, (item) => `${item.kind}:${item.path || ""}`);
  }
  if (target.inspections.length > MAX_EVIDENCE_PATHS) target.inspections.length = MAX_EVIDENCE_PATHS;
  for (const finding of Array.isArray(source.findings) ? source.findings.slice(0, MAX_REPOSITORY_FINDINGS) : []) recordRepositoryFinding(target, finding);
  if (source.investigation && typeof source.investigation === "object") {
    const status = ["complete", "partial", "unavailable", "cancelled"].includes(source.investigation.status)
      ? source.investigation.status : "partial";
    target.investigation = {
      status,
      ...(safeToken(source.investigation.intent, 40) ? { intent: safeToken(source.investigation.intent, 40) } : {}),
      ...(safeDescription(source.investigation.note, 240) ? { note: safeDescription(source.investigation.note, 240) } : {}),
      ...(safeTimestamp(source.investigation.observedAt) ? { observedAt: safeTimestamp(source.investigation.observedAt) } : {}),
      ...(source.investigation.referenceIndex && typeof source.investigation.referenceIndex === "object" ? {
        referenceIndex: normalizeReferenceIndex(source.investigation.referenceIndex),
      } : {}),
      ...(source.investigation.candidateDiscovery && typeof source.investigation.candidateDiscovery === "object" ? {
        candidateDiscovery: normalizeCandidateDiscovery(source.investigation.candidateDiscovery),
      } : {}),
      ...(source.investigation.impactReport && typeof source.investigation.impactReport === "object" ? {
        impactReport: normalizeImpactReport(source.investigation.impactReport),
      } : {}),
      ...(Array.isArray(source.investigation.steps) ? { steps: normalizeInvestigationSteps(source.investigation.steps) } : {}),
      ...(Array.isArray(source.investigation.unresolved) ? { unresolved: source.investigation.unresolved.slice(0, 12).map((item) => safeDescription(item, 240)).filter(Boolean) } : {}),
      ...(source.investigation.remainingBudget && typeof source.investigation.remainingBudget === "object" ? {
        remainingBudget: {
          operations: boundedInteger(source.investigation.remainingBudget.operations, 0, MAX_EVIDENCE_ENTRIES),
          targetedReads: boundedInteger(source.investigation.remainingBudget.targetedReads, 0, 5),
          milliseconds: boundedInteger(source.investigation.remainingBudget.milliseconds, 0, 10_000),
          sourceBytes: boundedInteger(source.investigation.remainingBudget.sourceBytes, 0, 512 * 1024),
        },
      } : {}),
      ...(safeToken(source.investigation.stopReason, 60) ? { stopReason: safeToken(source.investigation.stopReason, 60) } : {}),
    };
  }
  return true;
}

function recordProviderExecutionEvent(evidence, { type, fields = {}, sourceEventType, observedAt } = {}) {
  if (!evidence || !evidence.context || !Array.isArray(evidence.providerEvents)) return false;
  const event = fields && typeof fields === "object" ? fields : {};
  const source = safeSourceEventType(sourceEventType || type);
  const timestamp = safeTimestamp(observedAt) || new Date().toISOString();
  let record = null;

  if (type === "task-started" || type === "task-identity") {
    if (!bindProviderIdentity(evidence, event.conversationId, event.taskId)) return false;
    record = {
      category: "task",
      operation: "provider-turn",
      state: "observed",
      outcome: "The provider reported that the task turn started.",
    };
  } else if (type === "task-state") {
    if (!bindProviderIdentity(evidence, event.conversationId, event.taskId)) return false;
    const state = normalizeProviderTaskState(event.state, event.errorCode);
    record = {
      category: "task",
      operation: "provider-turn",
      state,
      outcome: providerTaskOutcome(state, event.state, event.errorCode),
      ...(safeToken(event.errorCode, 80) ? { errorCode: safeToken(event.errorCode, 80) } : {}),
    };
  } else if (type === "connection-lost") {
    if (!bindProviderIdentity(evidence, event.conversationId, event.taskId)) return false;
    record = {
      category: "connection",
      operation: "provider-connection",
      state: "uncertain",
      outcome: "The provider connection was lost; any active operation may have an unknown outcome.",
    };
  } else if (type === "command-activity") {
    const update = event.update;
    const activity = update?.activity;
    if (update?.type !== "state" || !activity || !bindProviderIdentity(evidence, activity.threadId, activity.turnId)) return false;
    record = normalizeCommandActivity(evidence, activity);
    if (!record) return false;
  } else if (type === "file-change") {
    const activity = event.activity;
    if (!activity || !bindProviderIdentity(evidence, activity.threadId, activity.turnId)) return false;
    record = normalizeFileChangeActivity(activity, evidence.context.projectRoot);
    if (!record) return false;
  } else if (type === "approval-required") {
    const request = event.request;
    if (!request || !bindProviderIdentity(evidence, request.conversationId, request.taskId)) return false;
    record = normalizeApprovalActivity({
      ...request,
      operation: request.type,
      status: "requested",
    });
  } else if (type === "approval-decided") {
    if (!bindProviderIdentity(evidence, event.conversationId, event.taskId)) return false;
    record = normalizeApprovalActivity({
      ...event,
      operation: event.operation || event.type,
    });
  } else {
    return false;
  }

  if (!record) return false;
  const providerId = evidence.context.providerId;
  const identity = [
    providerId || "provider-unknown",
    evidence.context.sessionId || "session-unknown",
    evidence.context.conversationId || "conversation-unknown",
    evidence.context.taskId || "task-unknown",
    record.category,
    record.operation,
    record.category === "approval"
      ? record.approvalId || record.itemId || "task"
      : record.itemId || record.approvalId || "task",
  ];
  const key = JSON.stringify(identity);
  const prior = evidence.providerEventIndex.get(key);
  if (prior && sameProviderEvidence(prior, record)) return true;
  const entrySource = source && (!prior || !NORMALIZED_EVENT_SOURCES.has(source))
    ? source
    : prior?.sourceEventType || source;
  const entry = {
    sessionId: evidence.context.sessionId,
    providerId,
    conversationId: evidence.context.conversationId,
    taskId: evidence.context.taskId,
    ...record,
    ...(entrySource ? { sourceEventType: entrySource } : {}),
    observedAt: prior?.observedAt || timestamp,
    updatedAt: timestamp,
    provenance: "provider-reported",
    independentlyVerified: false,
  };
  if (prior) {
    if (!entry.paths?.length && prior.paths?.length) entry.paths = prior.paths;
    if (entry.itemId === undefined && prior.itemId) entry.itemId = prior.itemId;
    Object.assign(prior, entry);
  } else {
    if (evidence.providerEvents.length >= MAX_PROVIDER_EVENTS) {
      evidence.providerEventsOmitted = Math.min(MAX_EVIDENCE_ENTRIES, (evidence.providerEventsOmitted || 0) + 1);
      return false;
    }
    evidence.providerEvents.push(entry);
    evidence.providerEventIndex.set(key, entry);
  }
  return true;
}

function normalizeCommandActivity(evidence, activity) {
  const executionStatus = ["inProgress", "completed", "failed", "declined"].includes(activity.executionStatus)
    ? activity.executionStatus
    : null;
  const exitCodeAvailable = activity.exitCodeAvailable === true && Number.isInteger(activity.exitCode);
  let state = "unverified";
  let outcome = "Codex reported a command item, but its execution outcome is unavailable.";
  if (executionStatus === "inProgress" && ["interrupted", "failed", "completed"].includes(activity.turnStatus)) {
    state = "unverified";
    outcome = `The Codex turn ${activity.turnStatus} before this command's completion was reported.`;
  } else if (executionStatus === "inProgress") {
    state = "observed";
    outcome = "Codex reported that a command execution item started; completion is not established.";
  } else if (executionStatus === "completed" && exitCodeAvailable && activity.exitCode === 0) {
    state = "completed";
    outcome = "Codex reported command completion with exit code 0; Vesper did not independently verify its effects.";
  } else if (executionStatus === "completed") {
    state = exitCodeAvailable ? "failed" : "unverified";
    outcome = exitCodeAvailable
      ? `Codex reported command completion with nonzero exit code ${activity.exitCode}.`
      : "Codex reported a completed command item without an exit code; success is unverified.";
  } else if (executionStatus === "failed") {
    state = "failed";
    outcome = exitCodeAvailable
      ? `Codex reported command failure with exit code ${activity.exitCode}.`
      : "Codex reported that the command execution item failed; no exit code was available.";
  } else if (executionStatus === "declined") {
    state = "rejected";
    outcome = "Codex reported that command execution was declined.";
  } else if (activity.turnStatus === "interrupted" || activity.turnStatus === "failed" || activity.turnStatus === "completed") {
    outcome = `The Codex turn ${activity.turnStatus} before this command's outcome was established.`;
  }
  const paths = [];
  const cwdPath = safeProjectRelativePath(evidence.context.projectRoot, activity.cwd);
  if (cwdPath) paths.push(cwdPath);
  return {
    category: "command",
    operation: "commandExecution",
    itemId: safeIdentity(activity.itemId),
    ...(paths.length ? { paths } : {}),
    state,
    outcome,
    ...(exitCodeAvailable ? { exitCode: activity.exitCode } : {}),
  };
}

function normalizeFileChangeActivity(activity, projectRoot) {
  const lifecycle = ["pending", "updated", "completed", "invalidated"].includes(activity.state) ? activity.state : "invalidated";
  const paths = uniquePaths((Array.isArray(activity.changes) ? activity.changes : [])
    .flatMap((change) => [change?.path, change?.movePath])
    .map((value) => safeProjectRelativePath(projectRoot, value)));
  const state = lifecycle === "pending" || lifecycle === "updated" ? "proposed" : "unverified";
  const outcome = lifecycle === "pending"
    ? "Codex reported proposed file-change evidence; this does not establish a disk write."
    : lifecycle === "updated"
      ? "Codex reported updated proposed file-change evidence; this does not establish a disk write."
    : lifecycle === "completed"
      ? "The Codex file-change item lifecycle completed; resulting disk state is unverified."
      : "Codex file-change evidence was invalidated; no applied result can be established.";
  return {
    category: "file-change",
    operation: "fileChange",
    itemId: safeIdentity(activity.itemId),
    ...(paths.length ? { paths } : {}),
    state,
    outcome,
  };
}

function sameProviderEvidence(left, right) {
  return left.category === right.category && left.operation === right.operation &&
    left.state === right.state && left.outcome === right.outcome &&
    left.itemId === right.itemId && left.approvalId === right.approvalId &&
    left.exitCode === right.exitCode && JSON.stringify(left.paths || []) === JSON.stringify(right.paths || []);
}

function normalizeApprovalActivity(event) {
  const operation = safeToken(event.operation, 80) || "unsupported";
  const status = event.status === "requested" || event.status === "approval-required"
    ? "approval-required"
    : event.status === "approved" ? "approved"
      : event.status === "cancelled" ? "cancelled"
        : "rejected";
  const operationLabel = operation === "command" ? "command" : operation === "file-change" ? "file change" : "permission";
  return {
    category: "approval",
    operation,
    itemId: safeIdentity(event.itemId),
    approvalId: safeIdentity(event.approvalId),
    state: status,
    outcome: status === "approval-required"
      ? `Codex requested approval for a ${operationLabel}; no operation outcome is implied.`
      : `Vesper wrote an approval response (${status}) to the Codex app-server transport for the ${operationLabel} request; Codex acceptance and operation completion are not implied.`,
  };
}

function bindProviderIdentity(evidence, conversationId, taskId) {
  const conversation = safeIdentity(conversationId);
  const task = safeIdentity(taskId);
  if (conversation && evidence.context.conversationId && conversation !== evidence.context.conversationId) return false;
  if (task && evidence.context.taskId && task !== evidence.context.taskId) return false;
  if (conversation && !evidence.context.conversationId) evidence.context.conversationId = conversation;
  if (task && !evidence.context.taskId) evidence.context.taskId = task;
  return true;
}

function normalizeProviderTaskState(state, errorCode) {
  if (errorCode === "SUBMISSION_OUTCOME_UNCERTAIN" || errorCode === "CONNECTION_LOST") return "uncertain";
  if (state === "completed") return "completed";
  if (state === "interrupted") return "interrupted";
  if (state === "timed-out") return "timed-out";
  if (state === "failed") return "failed";
  return "unverified";
}

function providerTaskOutcome(state, originalState, errorCode) {
  if (state === "completed") return "Codex reported that the turn completed; project changes and tests are not independently verified.";
  if (state === "interrupted") return `Codex reported the turn ${originalState}; unfinished operation outcomes may be unknown.`;
  if (state === "timed-out") return "Vesper observed a Codex turn timeout; command and file-change outcomes may be incomplete.";
  if (state === "uncertain") return "Vesper could not confirm the Codex task outcome; it was not resubmitted.";
  if (state === "failed") return "Codex reported that the task failed.";
  return `Codex task state is unverified${errorCode ? ` (${safeToken(errorCode, 80) || "provider error"})` : ""}.`;
}

function safeProjectRelativePath(projectRoot, value) {
  if (typeof value !== "string" || !value) return null;
  if (!path.isAbsolute(value)) return safeRelativePath(value);
  if (typeof projectRoot !== "string" || !projectRoot || !path.isAbsolute(projectRoot)) return null;
  const relative = path.relative(projectRoot, value);
  if (!relative || relative === ".") return ".";
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return safeRelativePath(relative);
}

function safeIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9_.:-]+$/u.test(value) ? value : null;
}

function safeDescription(value, maximum) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function findingKey(entry) {
  return `${entry.type}:${entry.path || ""}:${entry.relatedPath || ""}:${entry.lineStart || ""}:${entry.symbol || ""}:${entry.description}`;
}

function safeSourceEventType(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    /^[A-Za-z0-9_.:/-]+$/u.test(value) ? value : null;
}

function safeTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : 0;
}

function normalizeReferenceIndex(value) {
  const changes = value.changes && typeof value.changes === "object" ? value.changes : {};
  return {
    status: ["complete", "partial", "unavailable"].includes(value.status) ? value.status : "partial",
    language: safeDescription(value.language, 100) || "JavaScript/TypeScript",
    freshness: safeDescription(value.freshness, 220) || "Freshness is unknown.",
    indexedFiles: boundedInteger(value.indexedFiles, 0, 12),
    eligibleFiles: boundedInteger(value.eligibleFiles, 0, 600),
    indexedBytes: boundedInteger(value.indexedBytes, 0, 512 * 1024),
    parseTimeMs: boundedInteger(value.parseTimeMs, 0, 750),
    relationships: boundedInteger(value.relationships, 0, 2_400),
    unsupportedFiles: boundedInteger(value.unsupportedFiles, 0, 600),
    unsupportedExtensions: Array.isArray(value.unsupportedExtensions) ? value.unsupportedExtensions.slice(0, 8).map((item) => safeDescription(item, 20)).filter(Boolean) : [],
    malformedFiles: boundedInteger(value.malformedFiles, 0, 12),
    excludedFiles: boundedInteger(value.excludedFiles, 0, 600),
    truncated: value.truncated === true,
    changes: {
      added: uniquePaths(changes.added).slice(0, 8),
      changed: uniquePaths(changes.changed).slice(0, 8),
      removed: uniquePaths(changes.removed).slice(0, 8),
      renamed: Array.isArray(changes.renamed) ? changes.renamed.slice(0, 8).flatMap((item) => {
        const from = safeRelativePath(item?.from);
        const to = safeRelativePath(item?.to);
        return from && to ? [{ from, to }] : [];
      }) : [],
      notRefreshed: boundedInteger(changes.notRefreshed, 0, 600),
      inventoryComplete: changes.inventoryComplete === true,
    },
  };
}

function normalizeCandidateDiscovery(value) {
  return {
    status: ["complete", "partial", "unavailable", "skipped"].includes(value.status) ? value.status : "unknown",
    candidateFiles: boundedInteger(value.candidateFiles, 0, 600),
    searchedFiles: boundedInteger(value.searchedFiles, 0, 128),
    scannedFiles: boundedInteger(value.scannedFiles, 0, 2_000),
    scannedBytes: boundedInteger(value.scannedBytes, 0, 16 * 1024 * 1024),
    matches: boundedInteger(value.matches, 0, 100),
    queryCount: boundedInteger(value.queryCount, 0, 4),
    ...(safeToken(value.partialReason, 60) ? { partialReason: safeToken(value.partialReason, 60) } : {}),
  };
}

function normalizeImpactItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 24).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const type = safeToken(item.type, 40);
    if (!type) return [];
    const pathValue = safeRelativePath(item.path);
    const relatedPath = safeRelativePath(item.relatedPath);
    return [{ type, ...(pathValue ? { path: pathValue } : {}),
      ...(Number.isInteger(item.line) && item.line > 0 ? { line: item.line } : {}),
      ...(relatedPath ? { relatedPath } : {}),
      ...(Number.isInteger(item.relatedLine) && item.relatedLine > 0 ? { relatedLine: item.relatedLine } : {}),
      ...(safeDescription(item.symbol, 120) ? { symbol: safeDescription(item.symbol, 120) } : {}),
      confidence: ["high", "medium", "low", "unknown"].includes(item.confidence) ? item.confidence : "unknown",
      observation: item.observation === "inferred" ? "inferred" : "observed",
      sourceContextRead: item.sourceContextRead === true,
      ...(safeToken(item.discoveryMethod, 80) ? { discoveryMethod: safeToken(item.discoveryMethod, 80) } : {}),
    }];
  });
}

function normalizeImpactReport(value) {
  return {
    status: value.status === "bounded" ? "bounded" : "partial",
    targetTerms: Array.isArray(value.targetTerms) ? value.targetTerms.slice(0, 8).map((item) => safeDescription(item, 80)).filter(Boolean) : [],
    definitions: normalizeImpactItems(value.definitions),
    callSites: normalizeImpactItems(value.callSites),
    dependencies: normalizeImpactItems(value.dependencies),
    textualReferences: normalizeImpactItems(value.textualReferences),
    routes: normalizeImpactItems(value.routes),
    tests: normalizeImpactItems(value.tests),
    changedFiles: uniquePaths(value.changedFiles).slice(0, 12),
    ...(value.candidateDiscovery && typeof value.candidateDiscovery === "object" ? { candidateDiscovery: normalizeCandidateDiscovery(value.candidateDiscovery) } : {}),
    gaps: Array.isArray(value.gaps) ? value.gaps.slice(0, 12).map((item) => safeDescription(item, 240)).filter(Boolean) : [],
    suggestedVerification: Array.isArray(value.suggestedVerification) ? value.suggestedVerification.slice(0, 8).map((item) => safeDescription(item, 240)).filter(Boolean) : [],
  };
}

function normalizeInvestigationSteps(steps) {
  return steps.slice(0, MAX_EVIDENCE_ENTRIES).flatMap((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const toolId = safeToken(step.operation?.toolId, 80);
    if (!toolId) return [];
    const rawInput = step.operation?.input && typeof step.operation.input === "object" ? step.operation.input : {};
    const input = {};
    if (safeRelativePath(rawInput.path)) input.path = safeRelativePath(rawInput.path);
    if (Number.isInteger(rawInput.pathCount)) input.pathCount = boundedInteger(rawInput.pathCount, 0, 100);
    if (Number.isInteger(rawInput.candidatePathCount)) input.candidatePathCount = boundedInteger(rawInput.candidatePathCount, 0, 128);
    if (Number.isInteger(rawInput.queryCount)) input.queryCount = boundedInteger(rawInput.queryCount, 0, 4);
    if (Array.isArray(rawInput.samplePaths)) input.samplePaths = uniquePaths(rawInput.samplePaths).slice(0, 4);
    if (Number.isInteger(rawInput.limit)) input.limit = boundedInteger(rawInput.limit, 0, 20);
    if (Number.isInteger(rawInput.maxBytes)) input.maxBytes = boundedInteger(rawInput.maxBytes, 1, 128 * 1024);
    if (Number.isInteger(rawInput.queryLength)) input.queryLength = boundedInteger(rawInput.queryLength, 0, 512);
    if (Number.isInteger(rawInput.maxFileBytes)) input.maxFileBytes = boundedInteger(rawInput.maxFileBytes, 1, 1024 * 1024);
    const result = step.result && typeof step.result === "object" ? step.result : {};
    const refs = Array.isArray(result.evidenceRefs) ? result.evidenceRefs.slice(0, 8).flatMap((item) => {
      const relative = safeRelativePath(item?.path);
      const type = safeToken(item?.type, 40);
      if (!relative || !type) return [];
      return [{ type, path: relative,
        ...(Number.isInteger(item.lineStart) && item.lineStart > 0 ? { lineStart: item.lineStart } : {}),
        ...(Number.isInteger(item.lineEnd) && item.lineEnd >= (item.lineStart || 1) ? { lineEnd: item.lineEnd } : {}) }];
    }) : [];
    return [{
      index: boundedInteger(step.index, 1, MAX_EVIDENCE_ENTRIES) || index + 1,
      operation: { toolId, input },
      purpose: safeDescription(step.purpose, 180) || "Read-only investigation operation.",
      requiredInputs: Array.isArray(step.requiredInputs) ? step.requiredInputs.map((item) => safeToken(item, 40)).filter(Boolean).slice(0, 8) : [],
      expectedEvidence: safeDescription(step.expectedEvidence, 120) || "Bounded project evidence.",
      state: safeToken(step.state, 40) || "unknown",
      result: {
        state: safeToken(result.state, 40) || "unknown",
        verified: result.verified === true,
        summary: safeDescription(result.summary, 180) || "Operation result unavailable.",
        evidenceRefs: refs,
      },
    }];
  });
}

function hasSuccessfulInspection(evidence) {
  return Boolean(evidence && evidence.inspections && evidence.inspections.length);
}

function hasEvidenceBackedPlan(text, evidence) {
  if (typeof text !== "string" || text.length > 8_000 || !/\bplan\s*:/iu.test(text) || !hasSuccessfulInspection(evidence)) return false;
  const normalizedText = text.toLocaleLowerCase("en-US");
  return evidence.inspections.some((entry) => {
    const reference = entry.path && entry.path !== "." ? entry.path : entry.kind.replaceAll("_", " ");
    return typeof reference === "string" && reference.length > 0 && normalizedText.includes(reference.toLocaleLowerCase("en-US"));
  });
}

function recordTaskToolOutcome(evidence, { toolId, input = {}, result = {} } = {}) {
  if (!evidence || !Array.isArray(evidence.inspections) || evidence.toolCalls >= MAX_EVIDENCE_ENTRIES) return;
  evidence.toolCalls += 1;
  const state = safeToken(result.state, 40) || "unknown";
  const verified = result.verified === true;
  const succeeded = SUCCESS_STATES.has(state) && result.executed === true;
  const errorCode = safeToken(result.error?.code || result.errorCode, 80);

  if (INSPECTION_TOOLS.has(toolId)) {
    if (succeeded) recordInspection(evidence, toolId, result, input);
  } else if (toolId === "propose_file_change") {
    const proposal = result.proposal && typeof result.proposal === "object" ? result.proposal : null;
    const entry = {
      path: safeRelativePath(proposal?.path || input.path),
      proposalId: safeToken(proposal?.proposalId, 80),
      state: state === "proposed" ? "proposed" : state,
      approvalState: safeToken(proposal?.approvalState, 40),
    };
    addBoundedUnique(evidence.proposals, entry, (item) => item.proposalId || `${item.path}:${item.state}`);
  } else if (toolId === "apply_file_change") {
    const proposalId = safeToken(input.proposalId, 80);
    const proposal = evidence.proposals.find((entry) => entry.proposalId === proposalId);
    const resultPath = safeRelativePath(result.result?.path);
    const filePath = resultPath || proposal?.path || null;
    if (result.state === "verified" && verified && result.proposalState === "applied" && filePath) {
      addBoundedUnique(evidence.appliedChanges, { path: filePath, state: "verified" }, (item) => item.path);
      if (proposal) proposal.state = "applied";
    } else if (proposal) {
      proposal.state = safeToken(result.proposalState, 40) || state;
      if (result.approved === true) proposal.approvalState = "approved; result not verified";
    }
  } else if (toolId === "run_command") {
    // This branch is defensive. run_command is intentionally excluded from model definitions.
    evidence.failures.push({ toolId, state: "unsupported", errorCode: "UNSUPPORTED_TOOL" });
  }

  if ((!succeeded && state !== "proposed") || (state === "executed" && !verified) || errorCode) {
    const entry = { toolId: safeToken(toolId, 80) || "unknown", state,
      ...(errorCode ? { errorCode } : {}), ...(result.truncated ? { truncated: true } : {}) };
    addBoundedUnique(evidence.failures, entry, (item) => `${item.toolId}:${item.state}:${item.errorCode || ""}`);
  }
}

function recordRejectedTaskTool(evidence, { toolId, state = "rejected", errorCode } = {}) {
  if (!evidence || evidence.toolCalls >= MAX_EVIDENCE_ENTRIES) return;
  evidence.toolCalls += 1;
  const entry = { toolId: safeToken(toolId, 80) || "unsupported_tool", state: safeToken(state, 40) || "rejected",
    ...(safeToken(errorCode, 80) ? { errorCode: safeToken(errorCode, 80) } : {}) };
  addBoundedUnique(evidence.failures, entry, (item) => `${item.toolId}:${item.state}:${item.errorCode || ""}`);
}

function recordInspection(evidence, toolId, result, input) {
  const value = result.result && typeof result.result === "object" ? result.result : {};
  if (toolId === "read_file") {
    addInspection(evidence, { kind: "read_file", path: safeRelativePath(value.path || input.path), state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  } else if (toolId === "git_check_ignore") {
    addInspection(evidence, { kind: "git_check_ignore", path: null, state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  } else if (toolId === "list_files") {
    addInspection(evidence, { kind: "list_files", path: safeRelativePath(value.path || input.path || "."), state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  } else if (toolId === "search_files") {
    const matches = Array.isArray(value.matches) ? value.matches : [];
    const paths = uniquePaths(matches.map((match) => match?.path));
    if (paths.length) {
      for (const filePath of paths) addInspection(evidence, { kind: "search_files match", path: filePath, state: result.truncated ? "partial" : "verified" });
    } else {
      addInspection(evidence, { kind: "search_files", path: null, state: result.truncated ? "partial; no returned match" : "verified; no match returned" });
    }
  } else {
    const scopedPath = toolId === "git_diff" || toolId === "git_log" ? safeRelativePath(input.path) : null;
    addInspection(evidence, { kind: toolId, path: scopedPath, state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  }
}

function addInspection(evidence, entry) {
  addBoundedUnique(evidence.inspections, entry, (item) => `${item.kind}:${item.path || ""}`);
  if (evidence.inspections.length > MAX_EVIDENCE_PATHS) evidence.inspections.length = MAX_EVIDENCE_PATHS;
}

function renderTaskEvidenceReport(evidence) {
  const lines = ["Vesper execution evidence"];
  const context = evidence?.context || {};
  if (safeIdentity(context.providerId)) lines.push(`Provider: ${context.providerId}.`);
  if (safeIdentity(context.sessionId)) lines.push(`Vesper session: ${context.sessionId}.`);
  if (safeIdentity(context.conversationId)) lines.push(`Provider conversation: ${context.conversationId}.`);
  if (safeIdentity(context.taskId)) lines.push(`Provider task: ${context.taskId}.`);
  const inspections = Array.isArray(evidence?.inspections) ? evidence.inspections.slice(0, MAX_EVIDENCE_PATHS) : [];
  lines.push("Inspected:");
  if (!inspections.length) lines.push("- No project files or Git state were verified by Vesper tools.");
  else for (const entry of inspections) lines.push(`- ${entry.kind}${entry.path ? `: ${formatPath(entry.path)}` : ""} (${entry.state}).`);
  if (evidence?.investigation && typeof evidence.investigation === "object") {
    lines.push(`Repository investigation: ${safeToken(evidence.investigation.status, 40) || "partial"}${evidence.investigation.observedAt ? ` · observed ${safeTimestamp(evidence.investigation.observedAt) || "time unavailable"}` : ""}${evidence.investigation.note ? ` · ${safeDescription(evidence.investigation.note, 240)}` : ""}.`);
  }
  const investigation = evidence?.investigation && typeof evidence.investigation === "object" ? evidence.investigation : null;
  if (investigation?.stopReason) lines.push("Investigation stopped: " + (safeToken(investigation.stopReason, 60) || "unknown") + ".");
  if (investigation?.referenceIndex) {
    const index = investigation.referenceIndex;
    lines.push(`Symbol/reference index: ${index.status} · ${index.indexedFiles}/${index.eligibleFiles} eligible JS/TS files · ${index.relationships} bounded relationships · ${index.parseTimeMs} ms parsing · current-file reads only.`);
    if (index.changes?.changed?.length || index.changes?.removed?.length || index.changes?.renamed?.length) {
      lines.push(`Index refresh: ${index.changes.changed.length} changed, ${index.changes.removed.length} removed, ${index.changes.renamed.length} same-content rename(s) observed.`);
    }
  }
  if (investigation?.candidateDiscovery) {
    const discovery = investigation.candidateDiscovery;
    lines.push(`Cross-file search: ${discovery.status} · ${discovery.scannedFiles}/${discovery.searchedFiles} selected files visited · ${discovery.matches} candidates${discovery.partialReason ? ` · ${discovery.partialReason}` : ""}.`);
  }
  if (investigation?.impactReport) {
    const impact = investigation.impactReport;
    lines.push(`Change impact: ${impact.status} · ${impact.definitions.length} definitions · ${impact.callSites.length} syntactic call candidates · ${impact.dependencies.length} dependency candidates · ${impact.routes.length} route matches · ${impact.tests.length} test references.`);
    for (const gap of impact.gaps.slice(0, 4)) lines.push("- Impact limitation: " + safeDescription(gap, 220));
  }
  for (const step of (investigation?.steps || []).slice(0, 8)) {
    const target = step.operation?.input?.path ? " " + formatPath(step.operation.input.path) : "";
    lines.push("- Step " + step.index + ": " + (safeToken(step.operation?.toolId, 80) || "read-only operation") + target +
      " (" + (safeToken(step.state, 40) || "unknown") + "): " + (safeDescription(step.result?.summary, 180) || "result unavailable"));
  }
  for (const note of (investigation?.unresolved || []).slice(0, 5)) lines.push("- Unresolved: " + safeDescription(note, 240));
  const findings = Array.isArray(evidence?.findings) ? evidence.findings.slice(0, 20) : [];
  if (findings.length) {
    lines.push("Repository findings:");
    for (const finding of findings) {
      const location = finding.path ? `${formatPath(finding.path)}${finding.lineStart ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}` : ""}` : "[project]";
      const target = finding.relatedPath ? ` → ${formatPath(finding.relatedPath)}${finding.relatedLine ? `:${finding.relatedLine}` : ""}` : "";
      lines.push(`- ${finding.observation === "inferred" ? "Inferred" : "Observed"} · ${safeToken(finding.type, 40) || "finding"} · ${location}${target}: ${safeDescription(finding.description, 320)} (${safeToken(finding.confidence, 10) || "unknown"} confidence; ${safeToken(finding.status, 20) || "unknown"}; source ${safeToken(finding.source, 80) || "unknown"}${finding.discoveryMethod ? `; method ${safeToken(finding.discoveryMethod, 80) || "unknown"}` : ""}${finding.sourceContextRead ? "; inspected source" : ""}).`);
    }
  }
  if (Array.isArray(evidence?.findings) && evidence.findings.length > findings.length) {
    lines.push(`- ${evidence.findings.length - findings.length} additional repository findings are omitted by Vesper's report bound.`);
  }
  const providerEvents = Array.isArray(evidence?.providerEvents) ? evidence.providerEvents.slice(0, 16) : [];
  if (providerEvents.length) {
    lines.push("Provider-reported native activity (not independently verified):");
    for (const entry of providerEvents) lines.push(`- ${renderProviderEvidence(entry)}${entry.sourceEventType ? ` Source: ${entry.sourceEventType}.` : ""}${entry.updatedAt ? ` Vesper observed: ${entry.updatedAt}.` : ""}`);
  } else if (context.providerId === "codex-app-server") {
    lines.push("- Codex native execution details were unavailable or not exposed by the observed app-server events.");
  }
  const omittedProviderEvents = (Array.isArray(evidence?.providerEvents) ? Math.max(0, evidence.providerEvents.length - providerEvents.length) : 0) +
    (Number.isInteger(evidence?.providerEventsOmitted) ? evidence.providerEventsOmitted : 0);
  if (omittedProviderEvents) lines.push(`- At least ${omittedProviderEvents} additional provider-native records are omitted by Vesper's bounds; this report is partial.`);
  if (evidence?.planPresented === true) lines.push("Plan: a concise plan referencing inspected project evidence was shown before proposing the file change.");
  else if (Array.isArray(evidence?.proposals) && evidence.proposals.length) lines.push("Plan: Vesper did not record an evidence-backed plan before the proposal; the proposal was not eligible to apply.");

  const proposals = Array.isArray(evidence?.proposals) ? evidence.proposals.slice(0, MAX_EVIDENCE_PATHS) : [];
  lines.push("Vesper-managed file changes:");
  if (!proposals.length && !evidence?.appliedChanges?.length) {
    const providerHasFileEvidence = providerEvents.some((entry) => entry.category === "file-change");
    lines.push(providerHasFileEvidence ? "- No file change was proposed or applied through Vesper's managed tool runtime." : "- No file change was proposed or applied.");
  }
  for (const proposal of proposals) {
    const label = proposal.state === "applied" ? "applied" : proposal.state === "proposed" ? "proposed; not applied" : `not applied (${proposal.state})`;
    lines.push(`- ${formatPath(proposal.path)}: ${label}${proposal.state === "applied" ? "; see verified writes below" : "."}`);
  }
  const applied = Array.isArray(evidence?.appliedChanges) ? evidence.appliedChanges.slice(0, MAX_EVIDENCE_PATHS) : [];
  if (applied.length) {
    lines.push("Applied and verified by Vesper read-back:");
    for (const entry of applied) lines.push(`- ${formatPath(entry.path)}.`);
  }

  lines.push("Commands: none through Vesper-managed tools; command execution is unavailable to the structured model tool runtime.");
  lines.push("Tests/builds: not run by Vesper-managed tools; see provider-reported activity above. Vesper did not independently verify test results.");
  const failures = Array.isArray(evidence?.failures) ? evidence.failures.slice(0, MAX_EVIDENCE_PATHS) : [];
  if (failures.length) {
    lines.push("Failed, rejected, partial, or unverified operations:");
    for (const entry of failures) {
      lines.push(`- ${entry.toolId}: ${entry.state}${entry.errorCode ? ` (${entry.errorCode})` : ""}${entry.truncated ? " (truncated)" : ""}.`);
    }
  }
  const report = lines.join("\n");
  return report.length <= MAX_REPORT_LENGTH ? report : `${report.slice(0, MAX_REPORT_LENGTH - 24)}\n[report truncated]`;
}

function renderProviderEvidence(entry) {
  const provider = safeIdentity(entry.providerId) || "provider";
  const itemId = safeIdentity(entry.itemId);
  const approvalId = safeIdentity(entry.approvalId);
  const paths = Array.isArray(entry.paths) ? uniquePaths(entry.paths).slice(0, MAX_EVIDENCE_PATHS) : [];
  const pathSuffix = paths.length ? ` for ${paths.map(formatPath).join(", ")}` : "";
  const identity = `${itemId ? ` item ${itemId}` : ""}${approvalId ? ` approval ${approvalId}` : ""}`;
  const state = safeToken(entry.state, 40) || "unverified";
  const outcome = typeof entry.outcome === "string" ? entry.outcome.slice(0, 320) : "Provider outcome is unavailable.";
  if (entry.category === "command") return `${provider} command${identity}${paths.length ? ` in working directory ${paths.map(formatPath).join(", ")}` : ""}: ${state}. ${outcome}`;
  if (entry.category === "file-change") return `${provider} file-change${identity}${pathSuffix}: ${state}. ${outcome}`;
  if (entry.category === "approval") return `${provider} ${safeToken(entry.operation, 80) || "operation"} approval${identity}: ${state}. ${outcome}`;
  if (entry.category === "connection") return `${provider} connection: ${state}. ${outcome}`;
  return `${provider} turn: ${state}. ${outcome}`;
}

function renderEvidenceInstructions(evidence) {
  const report = renderTaskEvidenceReport(evidence);
  return `Vesper's observed workflow evidence so far (do not add unsupported claims):\n${report}\n\nFor coding changes, inspect relevant files and Git state first. After inspection, show a concise line beginning "Plan:" that references at least one inspected path or inspection type before proposing a change. Vesper will reject proposals without that evidence-backed plan. A proposal is not a write. Apply only after Vesper's fresh one-time approval; then verify using tool evidence. Never claim tests or builds passed: this workflow exposes no command or test execution tool. In the final response separate inspected facts, assumptions, applied changes, failures, and unverified steps.`;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || path.isAbsolute(value)) return null;
  if (redactSensitiveText(value) !== value) return null;
  const normalized = value.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (components.some((component) => component === ".." || component === "")) return null;
  return normalized === "." ? "." : normalized;
}

function uniquePaths(values) {
  return [...new Set(values.map(safeRelativePath).filter(Boolean))].slice(0, MAX_EVIDENCE_PATHS);
}

function addBoundedUnique(entries, value, keyFor) {
  if (!Array.isArray(entries) || entries.length >= MAX_EVIDENCE_ENTRIES) return;
  const key = keyFor(value);
  if (!entries.some((entry) => keyFor(entry) === key)) entries.push(value);
}

function formatPath(value) { return `\`${String(value || "[path unavailable]").replaceAll("`", "'")}\``; }
function safeToken(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/u.test(value) ? value : null;
}

module.exports = {
  createTaskEvidence,
  hasSuccessfulInspection,
  hasEvidenceBackedPlan,
  recordTaskToolOutcome,
  recordRejectedTaskTool,
  renderTaskEvidenceReport,
  renderEvidenceInstructions,
  recordProviderExecutionEvent,
  recordRepositoryFinding,
  mergeRepositoryEvidence,
  MAX_EVIDENCE_ENTRIES,
  MAX_REPOSITORY_FINDINGS,
  MAX_PROVIDER_EVENTS,
  MAX_REPORT_LENGTH,
};
