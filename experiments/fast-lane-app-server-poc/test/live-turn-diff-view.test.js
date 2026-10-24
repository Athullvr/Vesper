"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TerminalFrontend, renderTurnDiffActivity, MAX_TURN_DIFF_RENDERED_LENGTH } = require("../terminal-frontend");
const { CommandActivityStore } = require("../command-activity");
const { REDRAW_DELAY_MS } = require("../live-turn-diff-view");

class FakeTTY extends EventEmitter {
  constructor({ columns = 80, rows = 24, isTTY = true } = {}) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = isTTY;
    this.writes = [];
    this.failNextWrite = false;
  }

  write(value) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("mock output failure");
    }
    this.writes.push(String(value));
    return true;
  }

  text() { return this.writes.join(""); }
}

function makeFrontend({ output = new FakeTTY(), inputTTY = true, lineIO } = {}) {
  const appServer = new EventEmitter();
  appServer.runTurn = async () => ({ status: "completed" });
  appServer.interrupt = async () => true;
  const oldTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const frontend = new TerminalFrontend({
    cwd: "/workspace",
    handlers: {},
    appServer,
    input: { isTTY: inputTTY },
    output,
    lineIO: lineIO || { question: async () => null, close() {} },
  });
  if (oldTerm === undefined) delete process.env.TERM;
  else process.env.TERM = oldTerm;
  return { frontend, appServer, output };
}

function activity(diff, overrides = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    evidenceState: "available",
    evidenceReason: null,
    closeReason: undefined,
    diff,
    sourceLength: diff.length,
    redacted: false,
    revision: 1,
    ...overrides,
  };
}

function identity(frontend, threadId = "thread-1", turnId = "turn-1") {
  frontend.handleProgress({ type: "turn_identity", threadId, turnId, fileChanges: [] });
}

function update(frontend, diff, overrides = {}) {
  frontend.handleProgress({ type: "turn_diff_updated", activity: activity(diff, overrides) });
}

function final(frontend, diff, closeReason = "completed", overrides = {}) {
  frontend.handleProgress({ type: "turn_diff_activity", activity: activity(diff, { closeReason, ...overrides }) });
}

function waitForRedraw() {
  return new Promise((resolve) => setTimeout(resolve, REDRAW_DELAY_MS + 15));
}

test("live TTY view replaces rapid snapshots and keeps one visible frame", async () => {
  const { frontend, output } = makeFrontend();
  identity(frontend);
  update(frontend, "first complete snapshot");
  update(frontend, "second complete snapshot");
  update(frontend, "latest complete snapshot");
  await waitForRedraw();

  let frames = output.writes.filter((chunk) => chunk.includes("turn-level aggregate diff"));
  assert.equal(frames.length, 1, "rapid updates coalesce to a single replacement frame");
  assert.match(frames[0], /latest complete snapshot/u);
  assert.doesNotMatch(frames[0], /first complete snapshot|second complete snapshot/u);

  update(frontend, "replacement while visible", { revision: 4 });
  await waitForRedraw();
  frames = output.writes.filter((chunk) => chunk.includes("turn-level aggregate diff"));
  assert.equal(frames.length, 2);
  assert.match(output.text(), /\u001b\[\d*A\r\u001b\[J/u, "the old block is erased before the replacement is drawn");
  assert.match(frames[1], /replacement while visible/u);

  final(frontend, "replacement while visible", "completed", { revision: 4 });
  assert.equal(frontend.turnDiffView.closed, true);
  assert.equal(output.listenerCount("resize"), 0);
  frontend.turnDiffView.end();
  assert.match(output.text(), /turn completed/u);
});

test("live updates ignore mismatched identities and a previous turn", async () => {
  const { frontend, output } = makeFrontend();
  identity(frontend);
  update(frontend, "current turn snapshot");
  update(frontend, "wrong thread", { threadId: "thread-other", revision: 2 });
  update(frontend, "wrong turn", { turnId: "turn-other", revision: 3 });
  await waitForRedraw();
  assert.match(output.text(), /current turn snapshot/u);
  assert.doesNotMatch(output.text(), /wrong thread|wrong turn/u);

  identity(frontend, "thread-1", "turn-2");
  update(frontend, "late previous turn", { turnId: "turn-1", revision: 4 });
  update(frontend, "new turn snapshot", { turnId: "turn-2", revision: 1 });
  await waitForRedraw();
  const lastFrame = output.writes.filter((chunk) => chunk.includes("turn-level aggregate diff")).at(-1);
  assert.match(lastFrame, /new turn snapshot/u);
  assert.doesNotMatch(lastFrame, /late previous turn/u);
  frontend.turnDiffView.end();
});

test("completion, interruption, failure and disconnect close the live view", async () => {
  for (const status of ["completed", "interrupted", "failed", "disconnected", "timeout", "client_closed"]) {
    const { frontend, output } = makeFrontend();
    identity(frontend);
    update(frontend, `snapshot for ${status}`);
    await waitForRedraw();
    final(frontend, `snapshot for ${status}`, status);
    assert.equal(frontend.turnDiffView.closed, true, status);
    assert.equal(output.listenerCount("resize"), 0, status);
    const writesAtClose = output.writes.length;
    frontend.write("after lifecycle\n");
    assert.equal(output.writes.length, writesAtClose + 1, "closed views do not schedule another live frame");
    assert.match(output.text(), new RegExp(status === "completed" ? "turn completed" : status === "interrupted" ? "turn interrupted" : status === "failed" ? "turn failed" : status === "disconnected" ? "transport disconnected" : status === "timeout" ? "turn timed out" : "client closed", "u"));
  }
});

test("resize and long multiline snapshots stay bounded to terminal dimensions", async () => {
  const output = new FakeTTY({ columns: 50, rows: 8 });
  const { frontend } = makeFrontend({ output });
  identity(frontend);
  update(frontend, Array.from({ length: 200 }, (_, index) => `+line ${index} ${"x".repeat(100)}`).join("\n"));
  await waitForRedraw();
  assert.ok(frontend.turnDiffView.drawnRows <= 7);
  assert.match(output.text(), /diff view truncated/u);

  output.columns = 24;
  output.rows = 5;
  output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(frontend.turnDiffView.drawnRows <= 4);
  assert.match(output.writes.at(-1), /diff view truncated/u);
  assert.match(output.writes.at(-2), /\u001b\[3A\r\u001b\[J/u, "cleanup stays within the resized terminal viewport");
  assert.ok(output.writes.at(-1).length <= MAX_TURN_DIFF_RENDERED_LENGTH);
  frontend.turnDiffView.end();
});

test("command activity and approval prompts suspend and then restore the live diff", async () => {
  let answer;
  const lineIO = { question: async () => new Promise((resolve) => { answer = resolve; }), close() {} };
  const { frontend, output } = makeFrontend({ lineIO });
  frontend.commandActivity = new CommandActivityStore();
  identity(frontend);
  update(frontend, "before approval");
  await waitForRedraw();

  const approval = frontend.requestApproval("item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "command-1",
    approvalId: "approval-command-1",
    command: "npm test",
    cwd: "/workspace",
    availableDecisions: ["accept", "decline", "cancel"],
  }, { requestId: "rpc-approval-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frontend.turnDiffView.suspended, 1);
  const writesAtPrompt = output.writes.length;
  update(frontend, "updated while approval is open", { revision: 2 });
  frontend.handleProgress({ type: "codex_progress", method: "item/started", params: {
    threadId: "foreign-thread", turnId: "turn-1",
    item: { type: "commandExecution", id: "foreign-command", command: "foreign identity must be ignored", cwd: "/workspace", status: "inProgress" },
  } });
  frontend.handleProgress({ type: "codex_progress", method: "item/started", params: {
    threadId: "thread-1", turnId: "stale-turn",
    item: { type: "commandExecution", id: "stale-command", command: "stale turn must be ignored", cwd: "/workspace", status: "inProgress" },
  } });
  frontend.handleProgress({ type: "codex_progress", method: "item/started", params: {
    item: { type: "commandExecution", id: "missing-identity", command: "missing identity must be ignored", cwd: "/workspace", status: "inProgress" },
  } });
  frontend.handleProgress({ type: "codex_progress", method: "item/started", params: {
    threadId: "thread-1", turnId: "turn-1",
    item: { type: "commandExecution", id: "command-1", command: "npm test", cwd: "/workspace", status: "inProgress" },
  } });
  await waitForRedraw();
  assert.equal(output.writes.some((chunk) => chunk.includes("updated while approval is open")), false);
  assert.ok(output.writes.length > writesAtPrompt, "approval and command activity still render while the diff view is suspended");
  assert.doesNotMatch(output.text(), /foreign identity must be ignored|stale turn must be ignored|missing identity must be ignored/u);

  answer("no");
  assert.deepEqual(await approval, { decision: "decline" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(frontend.turnDiffView.suspended, 0);
  assert.match(output.text(), /updated while approval is open/u);
  assert.match(output.text(), /execution started/u);
  frontend.turnDiffView.end();
});

test("redirected output receives one bounded final snapshot without live redraws", async () => {
  const output = new FakeTTY({ isTTY: false });
  const { frontend } = makeFrontend({ output, inputTTY: false });
  identity(frontend);
  update(frontend, "old redirected snapshot");
  update(frontend, "latest redirected snapshot", { revision: 2 });
  await waitForRedraw();
  assert.equal(output.writes.length, 0);
  final(frontend, "latest redirected snapshot", "completed", { revision: 2 });
  assert.equal(output.writes.length, 1);
  assert.match(output.text(), /latest redirected snapshot/u);
  assert.doesNotMatch(output.text(), /old redirected snapshot/u);
  assert.equal(output.text().includes("\u001b"), false);
});

test("live rendering keeps redaction, control escaping and display bounds", async () => {
  const { frontend, output } = makeFrontend({ output: new FakeTTY({ columns: 100, rows: 12 }) });
  identity(frontend);
  update(frontend, `+API_KEY=topsecret\n+owned \u001b]0;title\u0007\n${"x".repeat(30_000)}`);
  await waitForRedraw();
  const visibleFrame = output.writes.find((chunk) => chunk.includes("turn-level aggregate diff"));
  assert.ok(visibleFrame);
  assert.equal(visibleFrame.includes("topsecret"), false);
  assert.equal(visibleFrame.includes("\u001b]0;title"), false);
  assert.match(visibleFrame, /API_KEY=\[redacted\]/u);
  assert.match(visibleFrame, /\\x1b\]0;title\\u0007/u);
  assert.match(visibleFrame, /truncated/u);
  assert.ok(visibleFrame.length < 100 * 12);
  frontend.turnDiffView.end();
});

test("rendering errors disable redraw and recover with the bounded static close view", () => {
  const output = new FakeTTY();
  const { frontend } = makeFrontend({ output });
  identity(frontend);
  output.failNextWrite = true;
  update(frontend, "snapshot after output failure");
  return waitForRedraw().then(() => {
    assert.equal(frontend.turnDiffView.failed, true);
    assert.equal(output.listenerCount("resize"), 0);
    final(frontend, "snapshot after output failure", "completed");
    assert.match(output.text(), /snapshot after output failure/u);
    assert.match(output.text(), /turn completed/u);
    assert.equal(frontend.turnDiffView.closed, true);
  });
});

test("final and live renderers state that an aggregate snapshot is not a disk-write result", async () => {
  const { frontend, output } = makeFrontend();
  identity(frontend);
  update(frontend, "proposed content");
  await waitForRedraw();
  assert.match(output.text(), /disk write not verified/u);
  assert.match(renderTurnDiffActivity(activity("proposed content", { closeReason: "completed" })), /disk write not verified/u);
  frontend.turnDiffView.end();
});
