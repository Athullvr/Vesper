"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CommandActivityStore,
  MAX_COMMAND_LENGTH,
  MAX_CWD_LENGTH,
  MAX_OUTPUT_LENGTH,
  MAX_RETAINED_ITEMS,
  renderActivityUpdates,
} = require("../command-activity");

const identity = { threadId: "thread-1", turnId: "turn-1", itemId: "command-1" };

function commandItem(overrides = {}) {
  return {
    type: "commandExecution",
    id: identity.itemId,
    command: "npm run lint",
    cwd: "/workspace/project",
    status: "inProgress",
    exitCode: null,
    aggregatedOutput: null,
    ...overrides,
  };
}

function render(updates) {
  let text = "";
  renderActivityUpdates(updates, (chunk) => { text += chunk; });
  return text;
}

test("command start, streamed output and completion remain bound to thread, turn and item", () => {
  const store = new CommandActivityStore();
  assert.deepEqual(store.bindTurn(identity.threadId, identity.turnId), []);
  const started = store.applyProtocolNotification("item/started", {
    ...identity,
    item: commandItem(),
  });
  assert.equal(started[0].type, "state");
  assert.deepEqual({
    threadId: started[0].activity.threadId,
    turnId: started[0].activity.turnId,
    itemId: started[0].activity.itemId,
    executionStatus: started[0].activity.executionStatus,
  }, { ...identity, executionStatus: "inProgress" });

  assert.deepEqual(store.applyProtocolNotification("item/commandExecution/outputDelta", {
    ...identity, delta: "lint passed\n",
  }), []);
  const completed = store.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({ status: "completed", exitCode: 0, aggregatedOutput: "lint passed\n" }),
  });
  assert.equal(completed.filter((update) => update.type === "state").at(-1).activity.executionStatus, "completed");
  assert.deepEqual(completed.find((update) => update.type === "output"), {
    type: "output",
    activity: completed.find((update) => update.type === "output").activity,
    output: "lint passed\n",
    truncated: false,
    partial: false,
  });
});

test("failure, interrupted turn and missing exit code remain distinct", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  const failed = store.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({ status: "failed", exitCode: null, aggregatedOutput: "compiler error" }),
  });
  const failedText = render(failed);
  assert.match(failedText, /execution failed/u);
  assert.match(failedText, /exit code unavailable/u);
  assert.doesNotMatch(failedText, /success/u);

  const interruptedStore = new CommandActivityStore();
  interruptedStore.bindTurn(identity.threadId, identity.turnId);
  interruptedStore.applyProtocolNotification("item/started", { ...identity, item: commandItem() });
  const interrupted = interruptedStore.setTurnStatus(identity.threadId, identity.turnId, "interrupted");
  assert.equal(interrupted.find((update) => update.type === "state").activity.executionStatus, "inProgress");
  const interruptedText = render(interrupted);
  assert.match(interruptedText, /turn interrupted/u);
  assert.match(interruptedText, /outcome was not reported/u);
  assert.doesNotMatch(interruptedText, /execution interrupted/u);

  const missingStatus = new CommandActivityStore();
  missingStatus.bindTurn(identity.threadId, identity.turnId);
  const unknown = missingStatus.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({ status: undefined, exitCode: undefined }),
  });
  assert.equal(unknown[0].activity.executionStatus, null);
  assert.match(render(unknown), /execution status unavailable/u);
  assert.doesNotMatch(render(unknown), /execution completed|execution failed/u);
});

test("out-of-order and duplicate item lifecycle notifications do not regress or duplicate activity", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  store.applyProtocolNotification("item/commandExecution/outputDelta", { ...identity, delta: "partial" });
  const completed = store.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({ status: "completed", exitCode: 0, aggregatedOutput: "authoritative output" }),
  });
  const duplicateCompleted = store.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({ status: "completed", exitCode: 0, aggregatedOutput: "authoritative output" }),
  });
  const lateStarted = store.applyProtocolNotification("item/started", {
    ...identity,
    item: commandItem(),
  });
  assert.equal(completed.filter((update) => update.type === "state").length, 1);
  assert.equal(completed.filter((update) => update.type === "output").length, 1);
  assert.deepEqual(duplicateCompleted, []);
  assert.deepEqual(lateStarted, []);
  assert.equal(store.items.size, 1);
  assert.equal(render(completed).match(/authoritative output/gu).length, 1);
});

test("cross-thread, cross-turn, malformed and missing-identity events are ignored", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  for (const params of [
    { ...identity, threadId: "other-thread", item: commandItem() },
    { ...identity, turnId: "other-turn", item: commandItem() },
    { turnId: identity.turnId, item: commandItem() },
    { ...identity, item: { ...commandItem(), id: "" } },
    null,
    [],
  ]) {
    assert.doesNotThrow(() => store.applyProtocolNotification("item/started", params));
    assert.deepEqual(store.applyProtocolNotification("item/started", params), []);
  }
  assert.deepEqual(store.applyProtocolNotification("item/commandExecution/outputDelta", {
    threadId: identity.threadId, turnId: identity.turnId, itemId: identity.itemId, delta: 123,
  }), []);
  assert.equal(store.items.size, 0);
});

test("oversized command, directory and output are bounded with visible truncation markers", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  const longCwd = `/${"d".repeat(MAX_CWD_LENGTH + 100)}`;
  const longCommand = `run ${"x".repeat(MAX_COMMAND_LENGTH + 100)}`;
  store.applyProtocolNotification("item/started", {
    ...identity,
    item: commandItem({ command: longCommand, cwd: longCwd }),
  });
  store.applyProtocolNotification("item/commandExecution/outputDelta", {
    ...identity, delta: "o".repeat(MAX_OUTPUT_LENGTH + 100),
  });
  const completed = store.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({ command: longCommand, cwd: longCwd, status: "completed", exitCode: null }),
  });
  const activity = completed.find((update) => update.type === "output").activity;
  assert.ok(activity.command.length <= MAX_COMMAND_LENGTH);
  assert.ok(activity.cwd.length <= MAX_CWD_LENGTH);
  assert.ok(completed.find((update) => update.type === "output").output.length <= MAX_OUTPUT_LENGTH);
  const text = render(completed);
  assert.match(text, /\[command truncated\]/u);
  assert.match(text, /\[working directory truncated\]/u);
  assert.match(text, /output truncated at the display limit/u);
});

test("terminal controls and common secret patterns are escaped or redacted before command display", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  store.applyProtocolNotification("item/started", {
    ...identity,
    item: commandItem({
      command: "printf '\u001b[2J' API_KEY=supersecret\u202e",
      cwd: "/workspace/project",
    }),
  });
  const output = store.applyProtocolNotification("item/completed", {
    ...identity,
    item: commandItem({
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "Authorization: Bearer abcdef-secret\n\u001b]0;title\u0007safe\u202e",
    }),
  });
  const text = render(output);
  assert.equal(text.includes("\u001b"), false);
  assert.match(text, /\\x1b/u);
  assert.match(text, /\\u202e/u);
  assert.match(text, /API_KEY=\[redacted\]/u);
  assert.match(text, /Bearer \[redacted\]/u);
  assert.doesNotMatch(text, /supersecret|abcdef-secret/u);
  assert.match(text, /safe\\u202e/u);
});

test("approval state stays separate from execution state", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  const approvalIdentity = { ...identity, requestId: "rpc-approval-1" };
  assert.deepEqual(store.applyApproval({ ...identity, command: "npm test", cwd: "/workspace/project" }, "requested"), [],
    "an approval with no request or approval identity is ignored");
  assert.deepEqual(store.applyApproval({ ...approvalIdentity, requestId: "stale-request" }, "approved"), [],
    "a decision without its matching request is ignored");
  const requested = store.applyApproval({ ...approvalIdentity, command: "npm test", cwd: "/workspace/project" }, "requested");
  const accepted = store.applyApproval({ ...approvalIdentity, command: "npm test", cwd: "/workspace/project" }, "approved");
  assert.equal(requested[0].activity.approvalStatus, "requested");
  assert.equal(requested[0].activity.executionStatus, null);
  assert.equal(accepted[0].activity.approvalStatus, "approved");
  assert.equal(accepted[0].activity.executionStatus, null);
  const started = store.applyProtocolNotification("item/started", {
    ...identity, item: commandItem({ command: "npm test", status: "inProgress" }),
  });
  assert.equal(started[0].activity.approvalStatus, "approved");
  assert.equal(started[0].activity.executionStatus, "inProgress");
  const text = render([...requested, ...accepted, ...started]);
  assert.match(text, /approval requested/u);
  assert.match(text, /approval approved/u);
  assert.match(text, /execution started/u);
  assert.doesNotMatch(render(accepted), /execution completed/u);
});

test("separate approval request IDs stay distinct even when the server reuses an approval ID", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  const first = { ...identity, requestId: "rpc-approval-1", approvalId: "shared-approval" };
  const second = { ...identity, requestId: "rpc-approval-2", approvalId: "shared-approval" };
  store.applyApproval(first, "requested");
  store.applyApproval(second, "requested");
  const firstDecision = store.applyApproval(first, "approved");
  assert.deepEqual(firstDecision, [], "the other pending request remains the latest visible state");
  const secondDecision = store.applyApproval(second, "declined");
  assert.equal(secondDecision[0].activity.approvalStatus, "declined");
});

test("retained command activity has a fixed item bound and reports omitted items", () => {
  const store = new CommandActivityStore();
  store.bindTurn(identity.threadId, identity.turnId);
  let overflow = [];
  for (let index = 0; index < MAX_RETAINED_ITEMS + 1; index += 1) {
    overflow = store.applyProtocolNotification("item/started", {
      threadId: identity.threadId,
      turnId: identity.turnId,
      item: commandItem({ id: `command-${index}` }),
    });
  }
  assert.equal(store.items.size, MAX_RETAINED_ITEMS);
  assert.match(render(overflow), /activity limit reached/u);
});
