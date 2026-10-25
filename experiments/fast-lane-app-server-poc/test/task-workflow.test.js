"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPermissionedToolRuntime } = require("../permissioned-tool-runtime");
const {
  EVIDENCE_MAX_AGE_MS,
  TaskLifecycle,
  captureWorkspaceDiff,
  evidenceScopeError,
  understandTask,
} = require("../task-workflow");

const PROJECT = path.resolve("/tmp/vesper-workflow-project");
const SESSION = "8baf4d07-6a0e-43a3-9b3c-9e3128fc4eaa";
const PROVIDER = "openai-chat-completions";
const NOW = Date.parse("2026-10-25T00:00:00.000Z");

function evidence({ projectRoot = PROJECT, sessionId = SESSION, providerId = PROVIDER, observedAt = new Date(NOW).toISOString(), conversationId = null } = {}) {
  return {
    context: { projectRoot, sessionId, providerId, conversationId, investigation: { observedAt } },
    investigation: { observedAt },
    evidence: { investigations: [] },
  };
}

function investigation(evidenceValue = evidence()) {
  return { status: "complete", evidence: evidenceValue, providerContext: "Vesper local repository evidence\npackages/pricing/src/price.js", verificationRequirements: ["npm test (not run)"] };
}

function lifecycle(task = "Implement a small pricing change") {
  return new TaskLifecycle({ requestId: crypto.randomUUID(), sessionId: SESSION, providerId: PROVIDER, projectRoot: PROJECT, task });
}

test("shared preflight attaches only fresh evidence scoped to the active project, provider, and session", async () => {
  const model = { async investigate() { return investigation(); } };
  const fresh = await understandTask({ task: "Implement pricing rounding", systemModel: model, projectRoot: PROJECT, sessionId: SESSION, providerId: PROVIDER, now: () => NOW });
  assert.equal(fresh.state, "complete");
  assert.equal(fresh.evidenceIncluded, true);

  for (const mismatched of [
    evidence({ projectRoot: path.join(PROJECT, "other") }),
    evidence({ sessionId: crypto.randomUUID() }),
    evidence({ providerId: "codex-app-server" }),
    evidence({ conversationId: "stale-conversation" }),
  ]) {
    const result = await understandTask({ task: "Implement pricing rounding", systemModel: { async investigate() { return investigation(mismatched); } },
      projectRoot: PROJECT, sessionId: SESSION, providerId: PROVIDER, conversationId: "active-conversation", now: () => NOW });
    assert.equal(result.evidenceIncluded, false);
    assert.equal(result.providerTask, "Implement pricing rounding");
  }

  const oldEvidence = evidence({ observedAt: new Date(NOW - EVIDENCE_MAX_AGE_MS - 1).toISOString() });
  const stale = await understandTask({ task: "Implement pricing rounding", systemModel: { async investigate() { return investigation(oldEvidence); } },
    projectRoot: PROJECT, sessionId: SESSION, providerId: PROVIDER, now: () => NOW });
  assert.equal(stale.evidenceIncluded, false);
  assert.match(stale.note, /stale/u);
  assert.match(evidenceScopeError(oldEvidence, { projectRoot: PROJECT, sessionId: SESSION, providerId: PROVIDER, now: NOW }), /stale/u);
});

test("preflight cancellation prevents provider submission and task state stays cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  let inspections = 0;
  const preparation = await understandTask({ task: "Implement pricing rounding", signal: controller.signal,
    systemModel: { async investigate() { inspections += 1; return investigation(); } }, projectRoot: PROJECT, sessionId: SESSION, providerId: PROVIDER });
  assert.equal(preparation.state, "cancelled");
  assert.equal(inspections, 0);
  const task = lifecycle();
  task.setUnderstanding(preparation);
  task.complete();
  assert.equal(task.snapshot().status, "cancelled");
  assert.equal(task.snapshot().submitted, false);
});

test("a provider completion without a verified implementation is partial, not task success", () => {
  const task = lifecycle();
  task.setUnderstanding({ state: "complete", evidenceIncluded: false });
  task.complete({ result: { status: "completed" } });
  assert.equal(task.snapshot().providerStatus, "completed");
  assert.equal(task.snapshot().status, "partial");
  assert.equal(task.snapshot().verification.state, "not-run");
});

test("verified writes, actual diffs, and passed verification produce a completed task report", () => {
  const task = lifecycle();
  task.setUnderstanding({ state: "complete", evidenceIncluded: true, investigation: { verificationRequirements: ["npm test (not run)"] } });
  task.observe({ type: "task-started", providerId: PROVIDER, sessionId: SESSION, conversationId: "conversation-1", taskId: "task-1" });
  task.observe({ type: "tool-result", providerId: PROVIDER, sessionId: SESSION, conversationId: "conversation-1", taskId: "task-1",
    toolId: "apply_file_change", state: "verified", verified: true, changedFiles: ["packages/pricing/src/price.js"] });
  task.observe({ type: "task-progress", kind: "aggregate-diff", activity: { source: "workspace", evidenceState: "available", closeReason: "workspace-readback",
    paths: ["packages/pricing/src/price.js"], diff: "diff --git a/packages/pricing/src/price.js b/packages/pricing/src/price.js\n+ return Math.round(value * 100) / 100;" } });
  task.recordVerification({ state: "executed", executed: true, result: { exitCode: 0, signal: null } }, ["node", "--test"]);
  task.complete({ result: { status: "completed" } });
  const report = task.snapshot();
  assert.equal(report.status, "completed");
  assert.deepEqual(report.verifiedFiles, ["packages/pricing/src/price.js"]);
  assert.deepEqual(report.diskVerifiedFiles, [], "Vesper-managed writes are not relabeled as native provider changes");
  assert.equal(report.verification.state, "passed");
  assert.match(report.diff.diff, /Math\.round/u);
});

test("native Codex changes complete only after accepted approval, item completion, and working-tree read-back", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-codex-readback-"));
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "price.js"), "module.exports = 2;\n");
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const task = new TaskLifecycle({ requestId: crypto.randomUUID(), sessionId: SESSION, providerId: "codex-app-server", projectRoot,
    task: "Implement a pricing fix" });
  task.observe({ type: "task-started", providerId: "codex-app-server", sessionId: SESSION, conversationId: "codex-thread", taskId: "codex-turn" });
  task.observe({ type: "approval-required", providerId: "codex-app-server", sessionId: SESSION, conversationId: "codex-thread", taskId: "codex-turn",
    request: { type: "file-change", approvalId: "codex-approval", itemId: "codex-file-item" } });
  task.observe({ type: "file-change", providerId: "codex-app-server", sessionId: SESSION,
    activity: { threadId: "codex-thread", turnId: "codex-turn", itemId: "codex-file-item", state: "updated", changes: [{ path: "src/price.js" }] } });
  assert.deepEqual(task.workspaceReadbackPaths(), [], "pending changes are not read back as approved changes");
  task.observe({ type: "approval-decided", providerId: "codex-app-server", sessionId: SESSION, conversationId: "codex-thread", taskId: "codex-turn",
    operation: "file-change", approvalId: "codex-approval", itemId: "codex-file-item", status: "approved" });
  task.observe({ type: "file-change", providerId: "codex-app-server", sessionId: SESSION,
    activity: { threadId: "codex-thread", turnId: "codex-turn", itemId: "codex-file-item", state: "completed", changes: [] } });
  assert.deepEqual(task.workspaceReadbackPaths(), ["src/price.js"]);
  task.observe({ type: "task-state", providerId: "codex-app-server", sessionId: SESSION, conversationId: "codex-thread", taskId: "codex-turn", state: "completed" });

  const runtime = {
    disposed: false,
    sessionId: SESSION,
    async preview(request) {
      assert.equal(request.toolId, "git_diff");
      assert.equal(request.context.projectRoot, projectRoot);
      return { state: "validated", executes: false };
    },
    async invoke(request) {
      assert.equal(request.input.path, "src/price.js");
      return { state: "executed", result: { exitCode: 0, text: "diff --git a/src/price.js b/src/price.js\n+module.exports = 2;\n" } };
    },
  };
  assert.equal(await captureWorkspaceDiff(task, runtime), true);
  task.complete({ result: { status: "completed" } });
  const report = task.snapshot();
  assert.equal(report.status, "completed");
  assert.deepEqual(report.verifiedFiles, [], "Codex paths remain distinct from Vesper-managed writes");
  assert.deepEqual(report.diskVerifiedFiles, ["src/price.js"]);
  assert.equal(report.diff.source, "workspace");
  assert.match(report.diff.diff, /module\.exports = 2/u);
  assert.equal(report.verification.state, "not-run");
});

test("failed verification and rejected approvals stay partial with actual paths preserved", () => {
  const failedVerification = lifecycle();
  failedVerification.observe({ type: "task-started", providerId: PROVIDER, sessionId: SESSION, taskId: "task-2" });
  failedVerification.observe({ type: "tool-result", providerId: PROVIDER, sessionId: SESSION, taskId: "task-2", toolId: "apply_file_change",
    state: "verified", verified: true, changedFiles: ["packages/pricing/src/price.js"] });
  failedVerification.complete({ result: { status: "completed" } });
  failedVerification.recordVerification({ state: "failed", executed: true, result: { exitCode: 1, signal: null } }, ["node", "--test"]);
  assert.equal(failedVerification.snapshot().status, "partial");
  assert.equal(failedVerification.snapshot().verification.exitCode, 1);

  const rejected = lifecycle();
  rejected.observe({ type: "task-started", providerId: PROVIDER, sessionId: SESSION, conversationId: "conversation-2", taskId: "task-3" });
  rejected.observe({ type: "approval-required", providerId: PROVIDER, sessionId: SESSION, conversationId: "conversation-2", taskId: "task-3",
    request: { type: "file-change", approvalId: "approval-1", itemId: "item-1" } });
  rejected.observe({ type: "approval-decided", providerId: PROVIDER, sessionId: SESSION, conversationId: "conversation-2", taskId: "task-3",
    operation: "file-change", approvalId: "approval-1", itemId: "item-1", status: "declined" });
  rejected.complete({ result: { status: "completed" } });
  assert.equal(rejected.snapshot().status, "partial");
  assert.equal(rejected.snapshot().approvals[0].status, "rejected");
});

test("provider failures, uncertain submission, interruption, timeout, and rejected verification remain distinct", () => {
  const providerFailure = lifecycle();
  providerFailure.complete({ error: Object.assign(new Error("provider unavailable"), { code: "TASK_FAILED" }) });
  assert.equal(providerFailure.snapshot().status, "failed");

  const uncertain = lifecycle();
  uncertain.complete({ error: Object.assign(new Error("unknown remote outcome"), { code: "SUBMISSION_OUTCOME_UNCERTAIN" }) });
  assert.equal(uncertain.snapshot().status, "uncertain");
  assert.equal(uncertain.snapshot().errorCode, "SUBMISSION_OUTCOME_UNCERTAIN");

  const interrupted = lifecycle("Explain this code");
  interrupted.observe({ type: "task-started", providerId: PROVIDER, sessionId: SESSION });
  interrupted.complete({ error: Object.assign(new Error("interrupted"), { code: "TASK_INTERRUPTED" }) });
  assert.equal(interrupted.snapshot().status, "interrupted");

  const timeout = lifecycle("Explain this code");
  timeout.complete({ result: { status: "timeout" } });
  assert.equal(timeout.snapshot().status, "uncertain");
  assert.equal(timeout.snapshot().providerStatus, "timed-out");

  const approvalDeclined = lifecycle("Explain this code");
  approvalDeclined.recordVerification({ state: "rejected", error: { code: "APPROVAL_DECLINED" } }, ["node", "--test"]);
  approvalDeclined.complete({ result: { status: "completed" } });
  assert.equal(approvalDeclined.snapshot().verification.state, "rejected");
  assert.equal(approvalDeclined.snapshot().status, "partial");
});

test("event and path storage bounds do not turn incomplete observations into success", () => {
  const task = lifecycle();
  task.observe({ type: "task-started", providerId: PROVIDER, sessionId: SESSION });
  for (let index = 0; index < 70; index += 1) task.observe({ type: "tool-result", providerId: PROVIDER, sessionId: SESSION,
    toolId: "search_files", state: "executed", verified: true });
  task.complete({ result: { status: "completed" } });
  assert.ok(task.snapshot().eventsOmitted > 0);
  assert.ok(task.snapshot().eventsOmitted <= 999);
  assert.equal(task.snapshot().status, "partial");
});

test("permissioned runtime rejection and failed verification preserve partial outcomes without executing declined work", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-task-outcomes-"));
  const target = path.join(projectRoot, "price.js");
  fs.writeFileSync(target, "module.exports = 1;\n");
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const sessionId = crypto.randomUUID();
  let commandRuns = 0;
  const imageId = `sha256:${"c".repeat(64)}`;
  const commandBackend = {
    async inspect() { return { available: true, enabled: true, imageId, backend: "mocked", platform: "linux" }; },
    async prepare(input) { return { binding: "fixture-policy", argv: input.argv, workspaceRoot: input.workspaceRoot,
      workspaceAccess: input.workspaceAccess, imageId, display: { backend: "mocked", network: "disabled", workspaceAccess: input.workspaceAccess } }; },
    async run(input) { commandRuns += 1; assert.equal(input.workspaceAccess, "read-only");
      return { argv: input.argv, exitCode: 1, signal: null, stdout: "fixture failure", stderr: "", truncated: false }; },
    async dispose() {},
  };
  const runtime = createPermissionedToolRuntime({ projectRoot, sessionId, commandExecutionEnabled: true, commandBackend,
    approvalHandler: async (snapshot) => snapshot.toolId === "run_command" ? "approve-once" : "decline" });
  t.after(() => runtime.dispose());
  const request = (toolId, input) => ({ toolId, input, context: { projectRoot, sessionId }, requestId: crypto.randomUUID() });

  const task = new TaskLifecycle({ requestId: crypto.randomUUID(), sessionId, providerId: PROVIDER, projectRoot, task: "Implement a pricing fix" });
  task.observe({ type: "task-started", providerId: PROVIDER, sessionId, taskId: "runtime-task" });
  const proposal = await runtime.invoke(request("propose_file_change", { path: "price.js", content: "module.exports = 2;\n" }));
  assert.equal(proposal.state, "proposed");
  task.observe({ type: "approval-required", providerId: PROVIDER, sessionId, taskId: "runtime-task",
    request: { type: "file-change", approvalId: "declined-approval" } });
  const declined = await runtime.invoke(request("apply_file_change", { proposalId: proposal.proposal.proposalId }));
  assert.equal(declined.state, "rejected");
  assert.equal(declined.error.code, "APPROVAL_DECLINED");
  task.observe({ type: "approval-decided", providerId: PROVIDER, sessionId, taskId: "runtime-task",
    operation: "file-change", approvalId: "declined-approval", status: "declined" });
  task.observe({ type: "tool-result", providerId: PROVIDER, sessionId, taskId: "runtime-task", toolId: "apply_file_change",
    state: declined.state, verified: false, errorCode: declined.error.code, summary: declined.error.message });
  assert.equal(fs.readFileSync(target, "utf8"), "module.exports = 1;\n");

  task.complete({ result: { status: "completed" } });
  assert.equal(task.snapshot().status, "partial");
  const failedVerification = await runtime.invoke(request("run_command", { argv: ["node", "--test"], workspaceAccess: "read-only" }));
  assert.equal(failedVerification.state, "failed");
  assert.equal(failedVerification.result.exitCode, 1);
  task.recordVerification(failedVerification, ["node", "--test"]);
  assert.equal(task.snapshot().verification.state, "failed");
  assert.equal(task.snapshot().status, "partial");
  assert.equal(commandRuns, 1);
  assert.equal(runtime.getAuditEvents().filter((event) => event.toolId === "apply_file_change" && event.state === "rejected").length, 1);
});
