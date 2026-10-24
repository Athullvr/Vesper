"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createExecutionProvider } = require("../execution-provider");
const { assertExecutionProvider } = require("../execution-interface");

class FakeCodexClient extends EventEmitter {
  constructor() {
    super();
    this.threadId = "thread-1";
    this.threadReady = true;
    this.submitCount = 0;
    this.disposed = false;
  }

  async connect() { return true; }
  async ensureThread() { return this.threadId; }
  async resumeThread() { return this.threadId; }
  async readThreadHistory() { return { threadId: this.threadId, turns: [], truncated: false }; }
  async runTurn({ onDelta }) {
    this.submitCount += 1;
    this.emit("progress", { type: "turn_started", threadId: this.threadId, turnId: "turn-1" });
    onDelta("streamed answer");
    return { status: "completed" };
  }
  async interrupt() { return true; }
  dispose() { this.disposed = true; }
}

test("Codex adapter exposes a provider-neutral contract and normalized bounded events", async () => {
  const client = new FakeCodexClient();
  const provider = createExecutionProvider({ client });
  const events = [];
  provider.on("event", (event) => events.push(event));

  assert.equal(assertExecutionProvider(provider), provider);
  assert.equal(provider.id, "codex-app-server");
  assert.equal(provider.capabilities.streaming, true);
  assert.equal(provider.capabilities.persistentSessions, true);
  assert.deepEqual(provider.getState(), {
    providerId: "codex-app-server",
    availability: "available",
    state: "connected",
    conversationId: "thread-1",
    conversationReady: true,
  });

  await provider.submitTask({ task: "Inspect this repository", projectPath: "/workspace/project" });
  assert.equal(client.submitCount, 1);
  assert.equal(events.some((event) => event.type === "task-started" && event.taskId === "turn-1"), true);
  assert.equal(events.some((event) => event.type === "text-delta" && event.text === "streamed answer"), true);
  assert.equal(events.some((event) => event.type === "task-state" && event.state === "completed"), true);

  client.emit("progress", { type: "turn_identity", threadId: "thread-1", turnId: "turn-2", fileChanges: [] });
  client.emit("progress", {
    type: "codex_progress",
    method: "item/started",
    params: {
      threadId: "thread-1", turnId: "turn-2", rawCredential: "Bearer raw-secret",
      item: { type: "commandExecution", id: "command-1", status: "inProgress", command: "echo secret=raw-secret", cwd: "/workspace/project" },
    },
  });
  const activity = events.find((event) => event.type === "command-activity");
  assert.ok(activity);
  assert.equal(JSON.stringify(activity).includes("rawCredential"), false);
  assert.equal(JSON.stringify(activity).includes("raw-secret"), false);
  assert.equal(Object.hasOwn(activity, "params"), false);

  provider.dispose();
  assert.equal(client.disposed, true);
});

test("Codex native command, approval, file-change, and turn events share one bounded provider-provenance report", async () => {
  const client = new FakeCodexClient();
  const provider = createExecutionProvider({
    client,
    sessionId: "vesper-session-3k",
    approvalHandler: async () => ({ choice: "approve-once" }),
  });
  const events = [];
  provider.on("event", (event) => events.push(event));
  const projectPath = "/workspace/project";
  const fileActivity = {
    threadId: "thread-1", turnId: "turn-native-1", itemId: "item-file-1", number: 1,
    state: "pending", changes: [{ path: "src/main.js", kind: "update", addedLines: 1, removedLines: 1 }], incomplete: false,
  };
  client.runTurn = async () => {
    client.submitCount += 1;
    client.emit("progress", { type: "turn_started", threadId: "thread-1", turnId: "turn-native-1" });
    client.emit("progress", { type: "turn_identity", threadId: "thread-1", turnId: "turn-native-1", fileChanges: [fileActivity] });
    const commandStarted = {
      threadId: "thread-1", turnId: "turn-native-1",
      item: { type: "commandExecution", id: "item-command-1", status: "inProgress", command: "npm test", cwd: `${projectPath}/src` },
    };
    client.emit("progress", { type: "codex_progress", method: "item/started", params: commandStarted });
    client.emit("progress", { type: "codex_progress", method: "item/started", params: commandStarted });
    client.emit("progress", { type: "codex_progress", method: "item/completed", params: {
      ...commandStarted, item: { ...commandStarted.item, status: "completed", exitCode: 0, aggregatedOutput: "private output must not enter the evidence report" },
    } });
    const approvalParams = {
      threadId: "thread-1", turnId: "turn-native-1", itemId: "item-command-1", approvalId: "approval-1",
      command: "npm test", cwd: projectPath, availableDecisions: ["accept", "decline"],
    };
    const response = await client.onApproval("item/commandExecution/requestApproval", approvalParams);
    assert.deepEqual(response, { decision: "accept" });
    client.emit("progress", { type: "approval_decided", method: "item/commandExecution/requestApproval", params: approvalParams, status: "approved" });
    client.emit("progress", { type: "file_change_activity", activity: { ...fileActivity, state: "completed", changes: [] } });
    client.emit("progress", { type: "turn_status", threadId: "thread-1", turnId: "turn-native-1", status: "completed" });
    return { status: "completed" };
  };

  const result = await provider.submitTask({ task: "Update and verify the project.", projectPath });
  assert.equal(result.status, "completed");
  assert.match(result.evidenceReport, /Provider: codex-app-server/u);
  assert.match(result.evidenceReport, /Vesper session: vesper-session-3k/u);
  assert.match(result.evidenceReport, /command item item-command-1 in working directory `src`: completed/u);
  assert.match(result.evidenceReport, /exit code 0/u);
  assert.match(result.evidenceReport, /file-change item item-file-1 for `src\/main\.js`: unverified/u);
  assert.match(result.evidenceReport, /approval item item-command-1 approval approval-1: approved/u);
  assert.match(result.evidenceReport, /turn: completed/u);
  assert.doesNotMatch(result.evidenceReport, /npm test|private output|\x1b/u);
  assert.equal(events.filter((event) => event.type === "task-progress" && event.kind === "workflow-report").length, 1);
  assert.equal((result.evidenceReport.match(/codex-app-server command item item-command-1/g) || []).length, 1);
  await provider.recover({ projectPath, conversationId: "thread-1" });
  assert.equal(events.filter((event) => event.type === "task-progress" && event.kind === "workflow-report").length, 1);
  provider.dispose();
});

test("Codex interruption and uncertain acknowledgement leave native command outcomes unverified", async () => {
  const interruptedClient = new FakeCodexClient();
  interruptedClient.runTurn = async () => {
    interruptedClient.submitCount += 1;
    interruptedClient.emit("progress", { type: "turn_started", threadId: "thread-1", turnId: "turn-interrupted" });
    interruptedClient.emit("progress", { type: "turn_identity", threadId: "thread-1", turnId: "turn-interrupted", fileChanges: [] });
    interruptedClient.emit("progress", { type: "codex_progress", method: "item/started", params: {
      threadId: "thread-1", turnId: "turn-interrupted",
      item: { type: "commandExecution", id: "item-running", status: "inProgress", command: "npm test", cwd: "/workspace/project" },
    } });
    interruptedClient.emit("progress", { type: "turn_status", threadId: "thread-1", turnId: "turn-interrupted", status: "interrupted" });
    return { status: "interrupted" };
  };
  const interrupted = createExecutionProvider({ client: interruptedClient, sessionId: "session-interrupted" });
  const interruptedResult = await interrupted.submitTask({ task: "Run a task", projectPath: "/workspace/project" });
  assert.match(interruptedResult.evidenceReport, /turn: interrupted/u);
  assert.match(interruptedResult.evidenceReport, /command item item-running[^\n]*unverified/u);
  assert.doesNotMatch(interruptedResult.evidenceReport, /completed with exit code 0/u);
  interrupted.dispose();

  const uncertainClient = new FakeCodexClient();
  uncertainClient.runTurn = async () => {
    uncertainClient.submitCount += 1;
    uncertainClient.emit("progress", { type: "turn_started", threadId: "thread-1", turnId: "turn-uncertain" });
    const error = new Error("credential-bearing raw provider response");
    error.executionCode = "SUBMISSION_OUTCOME_UNCERTAIN";
    throw error;
  };
  const uncertain = createExecutionProvider({ client: uncertainClient, sessionId: "session-uncertain" });
  const uncertainEvents = [];
  uncertain.on("event", (event) => uncertainEvents.push(event));
  await assert.rejects(uncertain.submitTask({ task: "Do not retry", projectPath: "/workspace/project" }), (error) => error.code === "SUBMISSION_OUTCOME_UNCERTAIN");
  const uncertainReport = uncertainEvents.find((event) => event.type === "task-progress" && event.kind === "workflow-report")?.report;
  assert.match(uncertainReport, /turn: uncertain/u);
  assert.doesNotMatch(uncertainReport, /completed/u);
  assert.doesNotMatch(uncertainReport, /credential-bearing|raw provider response/u);
  assert.equal(uncertainClient.submitCount, 1);
  uncertain.dispose();
});

test("Codex safety-declined file approvals are reported as rejected without implying a write", async () => {
  const client = new FakeCodexClient();
  client.runTurn = async () => {
    client.submitCount += 1;
    client.emit("progress", { type: "turn_started", threadId: "thread-1", turnId: "turn-declined" });
    client.emit("progress", {
      type: "file_approval_declined",
      conversationId: "thread-1",
      taskId: "turn-declined",
      itemId: "item-file-rejected",
      approvalId: "approval-rejected",
    });
    client.emit("progress", { type: "turn_status", threadId: "thread-1", turnId: "turn-declined", status: "completed" });
    return { status: "completed" };
  };
  const provider = createExecutionProvider({ client, sessionId: "session-rejected" });
  const result = await provider.submitTask({ task: "Apply a change", projectPath: "/workspace/project" });
  assert.match(result.evidenceReport, /file-change approval item item-file-rejected approval approval-rejected: rejected/u);
  assert.doesNotMatch(result.evidenceReport, /file change applied|disk write verified/u);
  provider.dispose();
});

test("approval callbacks receive normalized review evidence and return Codex one-time decisions", async () => {
  const client = new FakeCodexClient();
  const provider = createExecutionProvider({ client });
  const events = [];
  provider.on("event", (event) => events.push(event));
  provider.setApprovalHandler(async (request) => {
    assert.equal(request.type, "command");
    assert.equal(request.requestId, "rpc-approval-1");
    assert.equal(request.review.title, "command execution");
    assert.equal(request.command, "npm test");
    assert.equal(Object.hasOwn(request, "method"), false);
    assert.equal(Object.hasOwn(request, "params"), false);
    return { choice: "approve-once" };
  });

  const result = await client.onApproval("item/commandExecution/requestApproval", {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm test", cwd: "/workspace/project",
    availableDecisions: ["accept", "decline"],
    privatePayload: "credential-value",
  }, { requestId: "rpc-approval-1" });
  assert.deepEqual(result, { decision: "accept" });
  const event = events.find((item) => item.type === "approval-required");
  assert.equal(event.request.type, "command");
  assert.equal(event.request.requestId, "rpc-approval-1");
  assert.equal(JSON.stringify(event).includes("privatePayload"), false);
  assert.equal(JSON.stringify(event).includes("credential-value"), false);
  provider.dispose();
});

test("uncertain task acknowledgement is surfaced without a retry or raw provider error", async () => {
  const client = new FakeCodexClient();
  client.runTurn = async () => {
    client.submitCount += 1;
    const error = new Error("raw server payload with credential-value");
    error.executionCode = "SUBMISSION_OUTCOME_UNCERTAIN";
    throw error;
  };
  const provider = createExecutionProvider({ client });

  await assert.rejects(provider.submitTask({ task: "Do not duplicate", projectPath: "/workspace/project" }), (error) => {
    assert.equal(error.code, "SUBMISSION_OUTCOME_UNCERTAIN");
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /credential-value|raw server payload/u);
    return true;
  });
  assert.equal(client.submitCount, 1);
  provider.dispose();
});

test("unsupported providers and resume operations fail explicitly", async () => {
  assert.throws(() => createExecutionProvider({ providerId: "future-agent" }), (error) => error.code === "UNSUPPORTED_OPERATION");
  const client = new EventEmitter();
  client.runTurn = async () => ({ status: "completed" });
  const provider = createExecutionProvider({ client });
  await assert.rejects(provider.resumeConversation({ projectPath: "/workspace/project", conversationId: "thread-1" }),
    (error) => error.code === "UNSUPPORTED_OPERATION");
  provider.dispose();
});
