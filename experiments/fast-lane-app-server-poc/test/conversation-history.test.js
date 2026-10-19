"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_TEXT_LENGTH,
  projectConversationHistory,
  unavailableHistory,
} = require("../conversation-history");

function turn(id, items, overrides = {}) {
  return { id, status: "completed", itemsView: "full", items, ...overrides };
}

test("restores ordered user, assistant, tool, and turn records from full history", () => {
  const history = projectConversationHistory({
    threadId: "thread-1",
    turns: [
      turn("turn-1", [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "First question" }] },
        { id: "assistant-1", type: "agentMessage", text: "First answer" },
        { id: "command-1", type: "commandExecution", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "passed" },
      ]),
      turn("turn-2", [
        { id: "user-2", type: "userMessage", content: [{ type: "text", text: "Follow up" }] },
        { id: "assistant-2", type: "agentMessage", text: "Second answer" },
      ]),
    ],
  });

  assert.equal(history.state, "available");
  assert.deepEqual(history.entries.map(({ label, text }) => [label, text]), [
    ["You", "First question"],
    ["Codex", "First answer"],
    ["Command execution · completed", "Command: npm test\nExecution status: completed.\nExit code: 0.\nOutput:\npassed"],
    ["Turn completed", "Codex recorded this turn as completed."],
    ["You", "Follow up"],
    ["Codex", "Second answer"],
    ["Turn completed", "Codex recorded this turn as completed."],
  ]);
});

test("distinguishes validated empty history from unavailable or incomplete history", () => {
  assert.equal(projectConversationHistory({ turns: [] }).state, "empty");
  assert.equal(projectConversationHistory({ turns: [], truncated: true }).state, "partial");
  assert.equal(projectConversationHistory({ turns: [turn("turn-1", [], { itemsView: "notLoaded" })] }).state, "partial");
  assert.equal(projectConversationHistory({ turns: null }).state, "unavailable");
  assert.equal(unavailableHistory("History query failed.").state, "unavailable");
});

test("malformed turn and item records stay partial instead of becoming fabricated empty history", () => {
  const history = projectConversationHistory({
    turns: [
      { id: "", status: "completed", itemsView: "full", items: [] },
      turn("turn-2", [{ id: "item-1", type: "agentMessage" }]),
    ],
  });
  assert.equal(history.state, "partial");
  assert.equal(history.entries.some((entry) => entry.label === "Codex"), false);
  assert.match(history.text, /Some older turns or details are omitted or unavailable/u);
});

test("non-text user content is shown as omitted and marks the restored history partial", () => {
  const history = projectConversationHistory({
    turns: [turn("turn-1", [{
      id: "user-1",
      type: "userMessage",
      content: [{ type: "text", text: "What is in this image?" }, { type: "image", imageUrl: "file:///private/image.png" }],
    }])],
  });

  assert.equal(history.state, "partial");
  assert.equal(history.entries[0].text, "What is in this image?[Image input omitted]");
  assert.doesNotMatch(history.entries[0].text, /private\/image/u);
});

test("preserves interrupted and failed turn outcomes and available error messages", () => {
  const history = projectConversationHistory({
    turns: [
      turn("turn-interrupted", [{ id: "user-1", type: "userMessage", content: [{ type: "text", text: "Stop here" }] }], {
        status: "interrupted",
        error: { message: "Interrupted by the user." },
      }),
      turn("turn-failed", [{ id: "assistant-1", type: "agentMessage", text: "Partial response" }], {
        status: "failed",
        error: { message: "The turn failed." },
      }),
    ],
  });

  assert.deepEqual(history.entries.filter((entry) => entry.kind === "error").map(({ label, text }) => [label, text]), [
    ["Turn interrupted", "Interrupted by the user."],
    ["Turn failed", "The turn failed."],
  ]);
  assert.equal(history.state, "available");
});

test("deduplicates repeated turns and items, and repeated projection is idempotent", () => {
  const duplicateTurn = turn("turn-1", [
    { id: "message-1", type: "agentMessage", text: "Older duplicate" },
    { id: "message-1", type: "agentMessage", text: "Latest copy" },
  ]);
  const first = projectConversationHistory({ turns: [duplicateTurn, duplicateTurn] });
  const second = projectConversationHistory({ turns: [duplicateTurn, duplicateTurn] });

  assert.deepEqual(first, second);
  assert.equal(first.entries.filter((entry) => entry.id === "turn-1:message-1").length, 1);
  assert.equal(first.entries.find((entry) => entry.id === "turn-1:message-1").text, "Latest copy");
  assert.equal(first.state, "partial");
});

test("bounds restored turns, messages, text, control characters, and common secrets", () => {
  const hugeTurns = [turn("turn-1", Array.from({ length: MAX_HISTORY_MESSAGES + 20 }, (_value, index) => ({
    id: `message-${index}`,
    type: "agentMessage",
    text: `Authorization: Bearer secret-${index}\u001b[2J${"x".repeat(2_000)}`,
  })))];
  const history = projectConversationHistory({ turns: hugeTurns });

  assert.equal(history.state, "partial");
  assert.ok(history.entries.length <= MAX_HISTORY_MESSAGES);
  assert.ok(history.entries.reduce((total, entry) => total + entry.label.length + entry.text.length, 0) <= MAX_HISTORY_TEXT_LENGTH);
  assert.equal(history.entries.some((entry) => entry.text.includes("\u001b")), false);
  assert.equal(history.entries.some((entry) => /secret-\d+/u.test(entry.text)), false);
  assert.equal(history.truncated, true);
});

test("file-change history is activity and never claims a successful disk write", () => {
  const history = projectConversationHistory({
    turns: [turn("turn-1", [{
      id: "file-1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/project/file.txt", diff: "proposed" }],
    }])],
  });
  const activity = history.entries[0];

  assert.equal(activity.kind, "tool");
  assert.match(activity.text, /does not verify current disk state/u);
  assert.doesNotMatch(activity.text, /written successfully/u);
});
