"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTaskEvidence,
  hasSuccessfulInspection,
  hasEvidenceBackedPlan,
  recordTaskToolOutcome,
  recordProviderExecutionEvent,
  mergeRepositoryEvidence,
  renderTaskEvidenceReport,
  renderEvidenceInstructions,
} = require("../task-evidence");

test("read-only evidence reports only files and Git operations that actually completed", () => {
  const evidence = createTaskEvidence();
  assert.equal(hasSuccessfulInspection(evidence), false);
  recordTaskToolOutcome(evidence, { toolId: "read_file", input: { path: "src/main.js" }, result: {
    state: "verified", executed: true, verified: true, result: { path: "src/main.js", content: "secret file body omitted" },
  } });
  recordTaskToolOutcome(evidence, { toolId: "git_status", result: {
    state: "verified", executed: true, verified: true, result: { exitCode: 0, text: "M src/main.js" },
  } });
  const report = renderTaskEvidenceReport(evidence);
  assert.equal(hasSuccessfulInspection(evidence), true);
  assert.equal(hasEvidenceBackedPlan("Plan: update src/main.js based on the inspected file.", evidence), true);
  assert.equal(hasEvidenceBackedPlan("Plan: update src/other.js.", evidence), false);
  assert.match(report, /read_file: `src\/main\.js` \(verified\)/u);
  assert.match(report, /git_status \(verified\)/u);
  assert.match(report, /No file change was proposed or applied/u);
  assert.match(report, /Commands: none/u);
  assert.match(report, /Tests\/builds: not run by Vesper/u);
  assert.doesNotMatch(report, /secret file body omitted/u);
});

test("Git ignore checks are retained as bounded, project-relative inspection evidence", () => {
  const evidence = createTaskEvidence({ sessionId: "session-1", projectRoot: "/repo" });
  recordTaskToolOutcome(evidence, { toolId: "git_check_ignore", input: { paths: ["src/main.js", "vendor/lib.js"] }, result: {
    state: "verified", executed: true, verified: true, result: { checked: 2, ignored: ["vendor/lib.js"] },
  } });
  assert.equal(hasSuccessfulInspection(evidence), true);
  assert.deepEqual(evidence.inspections, [
    { kind: "git_check_ignore", path: null, state: "verified" },
  ]);
  const report = renderTaskEvidenceReport(evidence);
  assert.match(report, /git_check_ignore \(verified\)/u);
  assert.doesNotMatch(report, /\/repo/u);
});

test("scoped repository evidence retains model hypotheses, provenance, usage bounds, and unresolved questions", () => {
  const target = createTaskEvidence({ providerId: "openai-chat-completions", sessionId: "session-a", projectRoot: "/repo-a" });
  const source = createTaskEvidence({ providerId: "openai-chat-completions", sessionId: "session-a", projectRoot: "/repo-a" });
  source.findings.push({ type: "symbol-definition", description: "Checkout route declaration.", path: "src/checkout.js", lineStart: 4,
    source: "read_file", confidence: "high", observation: "observed", status: "confirmed", sourceContextRead: true });
  source.investigation = { status: "partial", unresolved: ["The validation branch has not been inspected."], modelPlanning: {
    mode: "model-assisted", enabled: true, reason: "model-selected-sufficient-evidence", calls: 1, followupSteps: 0,
    sourceBytesSent: 0, tokenUsage: { reportedByProvider: true, inputTokens: 30, outputTokens: 12, totalTokens: 42,
      budgetTokensUsed: 42, budgetTokensIncludeEstimates: false },
    unresolvedQuestions: ["Does the route reject invalid tax values before calling the service?"],
    hypotheses: [{ text: "The route may pass unvalidated tax values to the service.", confidence: "low", provenance: "model-generated",
      evidenceRefs: [{ type: "symbol-definition", path: "src/checkout.js", lineStart: 4, lineEnd: 4, confidence: "high", observation: "observed", sourceContextRead: true }] }],
  } };
  assert.equal(mergeRepositoryEvidence(target, source), true);
  assert.equal(target.investigation.modelPlanning.tokenUsage.budgetTokensUsed, 42);
  assert.equal(target.investigation.modelPlanning.hypotheses[0].evidenceRefs[0].path, "src/checkout.js");
  const report = renderTaskEvidenceReport(target);
  assert.match(report, /Model-generated hypothesis \(unverified\): The route may pass unvalidated tax values/u);
  assert.match(report, /src\/checkout\.js/u);
  assert.match(report, /:4 \(high, source read\)/u);
  assert.match(report, /Does the route reject invalid tax values/u);

  const foreign = createTaskEvidence({ providerId: "openai-chat-completions", sessionId: "session-b", projectRoot: "/repo-a" });
  foreign.investigation = source.investigation;
  assert.equal(mergeRepositoryEvidence(target, foreign), false);
  assert.equal(target.investigation.modelPlanning.hypotheses.length, 1);
});

test("proposal and apply evidence distinguish a proposal from an approved verified write", () => {
  const evidence = createTaskEvidence();
  recordTaskToolOutcome(evidence, { toolId: "search_files", input: { query: "route" }, result: {
    state: "verified", executed: true, verified: true, result: { matches: [{ path: "src/router.js" }] },
  } });
  recordTaskToolOutcome(evidence, { toolId: "propose_file_change", input: { path: "src/router.js" }, result: {
    state: "proposed", executed: false, verified: false,
    proposal: { proposalId: "proposal-1", path: "src/router.js", approvalState: "pending" },
  } });
  const proposalReport = renderTaskEvidenceReport(evidence);
  assert.match(proposalReport, /`src\/router\.js`: proposed; not applied/u);
  assert.doesNotMatch(proposalReport, /Plan: a concise plan/u);
  assert.doesNotMatch(proposalReport, /Applied and verified/u);

  recordTaskToolOutcome(evidence, { toolId: "apply_file_change", input: { proposalId: "proposal-1" }, result: {
    state: "verified", executed: true, verified: true, approved: true, proposalState: "applied",
    result: { path: "src/router.js", sha256: "a".repeat(64) },
  } });
  const appliedReport = renderTaskEvidenceReport(evidence);
  assert.match(appliedReport, /`src\/router\.js`: applied/u);
  assert.match(appliedReport, /Applied and verified by Vesper read-back/u);
  assert.doesNotMatch(appliedReport, /sha256/u);
});

test("stale approval or failed verification is reported as unverified and never as applied", () => {
  const evidence = createTaskEvidence();
  recordTaskToolOutcome(evidence, { toolId: "read_file", result: {
    state: "verified", executed: true, verified: true, result: { path: "src/a.js" },
  } });
  recordTaskToolOutcome(evidence, { toolId: "propose_file_change", input: { path: "src/a.js" }, result: {
    state: "proposed", executed: false, proposal: { proposalId: "proposal-2", path: "src/a.js" },
  } });
  recordTaskToolOutcome(evidence, { toolId: "apply_file_change", input: { proposalId: "proposal-2" }, result: {
    state: "uncertain", executed: true, verified: false, proposalState: "uncertain",
    error: { code: "WRITE_VERIFICATION_FAILED" },
  } });
  const report = renderTaskEvidenceReport(evidence);
  assert.match(report, /not applied \(uncertain\)/u);
  assert.match(report, /apply_file_change: uncertain \(WRITE_VERIFICATION_FAILED\)/u);
  assert.doesNotMatch(report, /Applied and verified by Vesper read-back/u);
  assert.match(renderEvidenceInstructions(evidence), /Never claim tests or builds passed/u);
});

test("provider-native evidence is bounded, correlated, deduplicated, and keeps provider-reported status separate from verification", () => {
  const evidence = createTaskEvidence({
    providerId: "codex-app-server",
    sessionId: "session-1",
    conversationId: "thread-1",
    projectRoot: "/repo",
  });
  const taskStart = { type: "task-started", fields: { conversationId: "thread-1", taskId: "turn-1" }, sourceEventType: "turn/started" };
  assert.equal(recordProviderExecutionEvent(evidence, taskStart), true);
  assert.equal(recordProviderExecutionEvent(evidence, taskStart), true);

  const commandStarted = {
    type: "command-activity",
    sourceEventType: "item/started",
    fields: { update: { type: "state", activity: {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-command", cwd: "/repo/src", executionStatus: "inProgress",
    } } },
  };
  recordProviderExecutionEvent(evidence, commandStarted);
  recordProviderExecutionEvent(evidence, commandStarted);
  recordProviderExecutionEvent(evidence, {
    type: "command-activity",
    sourceEventType: "item/completed",
    fields: { update: { type: "state", activity: {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-command", cwd: "/repo/src", executionStatus: "completed",
      exitCodeAvailable: true, exitCode: 0,
    } } },
  });
  recordProviderExecutionEvent(evidence, {
    type: "file-change", sourceEventType: "file_change_activity",
    fields: { activity: { threadId: "thread-1", turnId: "turn-1", itemId: "item-file", state: "pending", changes: [{ path: "src/main.js" }] } },
  });
  recordProviderExecutionEvent(evidence, {
    type: "file-change", sourceEventType: "file_change_activity",
    fields: { activity: { threadId: "thread-1", turnId: "turn-1", itemId: "item-file", state: "completed", changes: [] } },
  });
  recordProviderExecutionEvent(evidence, {
    type: "approval-required", sourceEventType: "item/commandExecution/requestApproval",
    fields: { request: { type: "command", conversationId: "thread-1", taskId: "turn-1", itemId: "item-command", approvalId: "approval-1" } },
  });
  recordProviderExecutionEvent(evidence, {
    type: "approval-decided", sourceEventType: "item/commandExecution/requestApproval",
    fields: { operation: "command", conversationId: "thread-1", taskId: "turn-1", itemId: "item-command", approvalId: "approval-1", status: "approved" },
  });
  recordProviderExecutionEvent(evidence, {
    type: "approval-required", sourceEventType: "item/commandExecution/requestApproval",
    fields: { request: { type: "command", conversationId: "thread-1", taskId: "turn-1", itemId: "item-command", approvalId: "approval-2" } },
  });
  assert.equal(recordProviderExecutionEvent(evidence, {
    type: "command-activity",
    fields: { update: { type: "state", activity: { threadId: "thread-1", turnId: "turn-old", itemId: "stale", executionStatus: "completed" } } },
  }), false);

  assert.equal(evidence.providerEvents.length, 5);
  const command = evidence.providerEvents.find((entry) => entry.category === "command");
  assert.equal(command.state, "completed");
  assert.equal(command.exitCode, 0);
  assert.equal(command.independentlyVerified, false);
  assert.deepEqual(command.paths, ["src"]);
  const fileChange = evidence.providerEvents.find((entry) => entry.category === "file-change");
  assert.equal(fileChange.state, "unverified");
  assert.deepEqual(fileChange.paths, ["src/main.js"]);
  assert.equal(evidence.providerEvents.find((entry) => entry.category === "approval").state, "approved");
  assert.equal(evidence.providerEvents.filter((entry) => entry.category === "approval").length, 2);

  const report = renderTaskEvidenceReport(evidence);
  assert.match(report, /Provider: codex-app-server/u);
  assert.match(report, /Vesper session: session-1/u);
  assert.match(report, /codex-app-server command item item-command in working directory `src`: completed/u);
  assert.match(report, /exit code 0/u);
  assert.match(report, /not independently verify/u);
  assert.match(report, /file-change item item-file for `src\/main\.js`: unverified/u);
  assert.match(report, /command approval item item-command approval approval-1: approved/u);
  assert.doesNotMatch(report, /\/repo/u);
});

test("provider evidence from one task or Vesper session cannot enter another ledger", () => {
  const first = createTaskEvidence({ providerId: "codex-app-server", sessionId: "session-one", conversationId: "thread-one" });
  const second = createTaskEvidence({ providerId: "codex-app-server", sessionId: "session-two", conversationId: "thread-two" });
  const staleEvent = {
    type: "task-state", fields: { conversationId: "thread-one", taskId: "turn-one", state: "completed" },
  };
  assert.equal(recordProviderExecutionEvent(first, staleEvent), true);
  assert.equal(recordProviderExecutionEvent(second, staleEvent), false);
  assert.equal(first.providerEvents.length, 1);
  assert.equal(second.providerEvents.length, 0);
  assert.match(renderTaskEvidenceReport(second), /Vesper session: session-two/u);
  assert.doesNotMatch(renderTaskEvidenceReport(second), /thread-one|turn-one/u);
});
