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

test("approval callbacks receive normalized review evidence and return Codex one-time decisions", async () => {
  const client = new FakeCodexClient();
  const provider = createExecutionProvider({ client });
  const events = [];
  provider.on("event", (event) => events.push(event));
  provider.setApprovalHandler(async (request) => {
    assert.equal(request.type, "command");
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
  });
  assert.deepEqual(result, { decision: "accept" });
  const event = events.find((item) => item.type === "approval-required");
  assert.equal(event.request.type, "command");
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
