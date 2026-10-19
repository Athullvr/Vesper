"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { AppServerClient, validateApprovalResult } = require("../app-server-client");
const { TerminalFrontend } = require("../terminal-frontend");

class FakeAppServerProcess extends EventEmitter {
  constructor({ onTurnStart, onInterrupt } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
    this.stdin = { writable: true, write: (line) => this.receive(JSON.parse(line)) };
    this.requests = [];
    this.serverResponses = [];
    this.turnCount = 0;
    this.historyResponse = { data: [], nextCursor: null };
    this.historyError = null;
    this.onTurnStart = onTurnStart || ((message, server) => server.completeTurn(message, "completed", `Answer ${server.turnCount}.`));
    this.onInterrupt = onInterrupt || ((_message, server) => server.respond(_message.id, {}));
    this.killed = false;
  }

  receive(message) {
    this.requests.push(message);
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
    if (message.method === "initialize") {
      this.respond(message.id, { codexHome: "/mock/codex", platformFamily: "unix", platformOs: "linux", userAgent: "mock" });
    } else if (message.method === "thread/start") {
      this.respond(message.id, { thread: { id: "thread-1" }, cwd: message.params.cwd });
    } else if (message.method === "thread/resume") {
      this.respond(message.id, { thread: { id: message.params.threadId }, cwd: this.cwd || "/workspace" });
    } else if (message.method === "thread/turns/list") {
      if (this.historyError) this.send({ id: message.id, error: this.historyError });
      else this.respond(message.id, this.historyResponse);
    } else if (message.method === "turn/start") {
      this.turnCount += 1;
      this.cwd = message.params.cwd;
      this.respond(message.id, { turn: { id: `turn-${this.turnCount}`, items: [], status: "inProgress" } });
      this.onTurnStart(message, this);
    } else if (message.method === "turn/interrupt") {
      this.onInterrupt(message, this);
    }
  }

  respond(id, result) {
    this.send({ id, result });
  }

  send(message) {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`);
  }

  completeTurn(startRequest, status, text = "", errorMessage) {
    const turnId = `turn-${this.turnCount}`;
    queueMicrotask(() => {
      this.send({ method: "turn/started", params: { threadId: startRequest.params.threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      if (text) this.send({ method: "item/agentMessage/delta", params: { threadId: startRequest.params.threadId, turnId, itemId: "item-1", delta: text } });
      const turn = { id: turnId, status, items: [] };
      if (errorMessage) turn.error = { message: errorMessage };
      this.send({ method: "turn/completed", params: { threadId: startRequest.params.threadId, turn } });
    });
  }

  requestFromServer(id, method, params) {
    this.send({ id, method, params });
  }

  kill() {
    this.killed = true;
  }
}

function createClient(server, options = {}) {
  const spawnCalls = [];
  const client = new AppServerClient({
    spawnProcess: (command, args, spawnOptions) => {
      spawnCalls.push({ command, args, options: spawnOptions });
      return server;
    },
    ...options,
  });
  return { client, spawnCalls };
}

test("initializes with the installed protocol, starts one thread, streams two turns on that thread, and passes cwd", async (t) => {
  const server = new FakeAppServerProcess();
  const streamed = [];
  const persistedThreadIds = [];
  const { client, spawnCalls } = createClient(server, { onThreadId: async (id) => persistedThreadIds.push(id) });
  t.after(() => client.dispose());

  const first = await client.runTurn({ prompt: "Explain a rebase.", cwd: "/workspace/project", onDelta: (delta) => streamed.push(delta) });
  const second = await client.runTurn({ prompt: "Explain it with an example.", cwd: "/workspace/project", onDelta: (delta) => streamed.push(delta) });

  assert.deepEqual(first, { status: "completed" });
  assert.deepEqual(second, { status: "completed" });
  assert.deepEqual(streamed, ["Answer 1.", "Answer 2."]);
  assert.deepEqual(persistedThreadIds, ["thread-1"]);
  assert.deepEqual(spawnCalls[0], {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    options: { cwd: "/workspace/project", stdio: ["pipe", "pipe", "pipe"] },
  });
  assert.equal(server.requests.find((request) => request.method === "initialize").params.clientInfo.name, "vesper_terminal");
  assert.equal(server.requests.some((request) => request.method === "initialized"), true);
  assert.equal(server.requests.filter((request) => request.method === "thread/start").length, 1);
  assert.equal(server.requests.some((request) => request.method === "thread/resume"), false);
  const turnRequests = server.requests.filter((request) => request.method === "turn/start");
  assert.equal(turnRequests.length, 2);
  assert.deepEqual(turnRequests.map((request) => request.params.threadId), ["thread-1", "thread-1"]);
  assert.deepEqual(turnRequests.map((request) => request.params.cwd), ["/workspace/project", "/workspace/project"]);
  assert.deepEqual(turnRequests.map((request) => request.params.input[0].text), ["Explain a rebase.", "Explain it with an example."]);
  assert.equal(turnRequests.every((request) => !Object.hasOwn(request.params, "sandboxPolicy") && !Object.hasOwn(request.params, "approvalPolicy")), true);
  assert.equal(Object.hasOwn(server.requests.find((request) => request.method === "thread/start").params, "sandbox"), false);
  assert.equal(Object.hasOwn(server.requests.find((request) => request.method === "thread/start").params, "approvalPolicy"), false);
});

test("an initialization RPC failure closes the unusable process and a later fallback can recover", async (t) => {
  const server = new FakeAppServerProcess();
  const recoveryServer = new FakeAppServerProcess();
  server.receive = function (message) {
    this.requests.push(message);
    if (message.method === "initialize") {
      this.send({ id: message.id, error: { code: -32000, message: "mock initialization failure" } });
    }
  };
  let spawnCount = 0;
  const client = new AppServerClient({
    spawnProcess: () => {
      spawnCount += 1;
      return spawnCount === 1 ? server : recoveryServer;
    },
  });
  t.after(() => client.dispose());

  await assert.rejects(client.runTurn({ prompt: "Explain a rebase.", cwd: "/workspace/project" }), /mock initialization failure/u);
  assert.equal(server.killed, true);
  assert.equal(server.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(server.requests.some((request) => request.method === "turn/start"), false);

  assert.deepEqual(await client.runTurn({ prompt: "Try again.", cwd: "/workspace/project" }), { status: "completed" });
  assert.equal(spawnCount, 2);
  assert.equal(recoveryServer.requests.some((request) => request.method === "thread/start"), true);
  assert.equal(recoveryServer.requests.some((request) => request.method === "turn/start"), true);
});

test("resumes the saved thread and never silently replaces it with a new one", async (t) => {
  const server = new FakeAppServerProcess();
  const { client } = createClient(server, { initialThreadId: "saved-thread" });
  t.after(() => client.dispose());
  server.cwd = "/workspace/project";

  await client.runTurn({ prompt: "Continue this task.", cwd: "/workspace/project" });
  assert.equal(server.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(server.requests.find((request) => request.method === "thread/resume").params.threadId, "saved-thread");
  assert.equal(server.requests.find((request) => request.method === "turn/start").params.threadId, "saved-thread");
});

test("explicit reconnect resumes the saved thread under a read-only sandbox without starting a replacement", async (t) => {
  const server = new FakeAppServerProcess();
  server.cwd = "/workspace/project";
  const { client } = createClient(server, { initialThreadId: "saved-thread", sandbox: "read-only" });
  t.after(() => client.dispose());

  assert.equal(await client.resumeThread("/workspace/project"), "saved-thread");
  assert.deepEqual(server.requests.find((request) => request.method === "thread/resume").params, {
    threadId: "saved-thread",
    sandbox: "read-only",
  });
  assert.equal(server.requests.some((request) => request.method === "thread/start"), false);
  assert.throws(() => new AppServerClient({ sandbox: "workspace-write" }), /must be read-only/u);
});

test("reads bounded persisted turn history in chronological order after verifying the saved thread", async (t) => {
  const server = new FakeAppServerProcess();
  server.cwd = "/workspace/project";
  server.historyResponse = {
    data: [
      { id: "turn-2", status: "completed", itemsView: "full", items: [{ id: "message-2", type: "agentMessage", text: "Second" }] },
      { id: "turn-1", status: "completed", itemsView: "full", items: [{ id: "message-1", type: "userMessage", content: [{ type: "text", text: "First" }] }] },
    ],
    nextCursor: "older-turns",
  };
  const { client } = createClient(server, { initialThreadId: "saved-thread", sandbox: "read-only" });
  t.after(() => client.dispose());

  await client.resumeThread("/workspace/project");
  const history = await client.readThreadHistory();

  assert.deepEqual(server.requests.find((request) => request.method === "thread/turns/list").params, {
    threadId: "saved-thread",
    limit: 50,
    sortDirection: "desc",
    itemsView: "full",
  });
  assert.deepEqual(history.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
  assert.equal(history.threadId, "saved-thread");
  assert.equal(history.truncated, true);
  assert.equal(client.threadReady, true);
});

test("history retrieval failure keeps the verified session thread usable", async (t) => {
  const server = new FakeAppServerProcess();
  server.cwd = "/workspace/project";
  server.historyError = { code: -32601, message: "history method unavailable" };
  const { client } = createClient(server, { initialThreadId: "saved-thread" });
  t.after(() => client.dispose());

  await client.resumeThread("/workspace/project");
  await assert.rejects(client.readThreadHistory(), /history method unavailable/u);
  assert.equal(client.threadId, "saved-thread");
  assert.equal(client.threadReady, true);

  server.historyError = null;
  server.historyResponse = { data: [], nextCursor: null };
  assert.deepEqual(await client.readThreadHistory(), {
    threadId: "saved-thread",
    turns: [],
    truncated: false,
  });
});

test("history responses from a replaced app-server process cannot enter the recovered thread view", async (t) => {
  const first = new FakeAppServerProcess();
  const second = new FakeAppServerProcess();
  first.cwd = second.cwd = "/workspace/project";
  first.historyResponse = { data: [{ id: "stale-turn", status: "completed", itemsView: "full", items: [] }], nextCursor: null };
  second.historyResponse = { data: [{ id: "current-turn", status: "completed", itemsView: "full", items: [] }], nextCursor: null };
  const receive = first.receive.bind(first);
  let pendingHistoryRequest;
  first.receive = (message) => {
    if (message.method === "thread/turns/list") {
      first.requests.push(message);
      pendingHistoryRequest = message;
      return;
    }
    receive(message);
  };
  let spawnCount = 0;
  const client = new AppServerClient({
    initialThreadId: "saved-thread",
    spawnProcess: () => ++spawnCount === 1 ? first : second,
  });
  t.after(() => client.dispose());

  await client.resumeThread("/workspace/project");
  const staleRead = client.readThreadHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pendingHistoryRequest);
  first.emit("close", 1, null);
  await assert.rejects(staleRead, /exited/u);

  await client.resumeThread("/workspace/project");
  first.respond(pendingHistoryRequest.id, first.historyResponse);
  const current = await client.readThreadHistory();
  assert.deepEqual(current.turns.map((turn) => turn.id), ["current-turn"]);
});

test("a failed resume stops instead of silently starting a fresh conversation", async (t) => {
  const server = new FakeAppServerProcess();
  server.receive = function (message) {
    this.requests.push(message);
    if (message.method === "initialize") this.respond(message.id, { codexHome: "/mock/codex", platformFamily: "unix", platformOs: "linux", userAgent: "mock" });
    else if (message.method === "thread/resume") this.send({ id: message.id, error: { code: -32000, message: "saved thread unavailable" } });
  };
  const { client } = createClient(server, { initialThreadId: "saved-thread" });
  t.after(() => client.dispose());

  await assert.rejects(client.runTurn({ prompt: "Continue.", cwd: "/workspace/project" }), /saved thread unavailable/u);
  assert.equal(server.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(server.requests.some((request) => request.method === "turn/start"), false);
});

test("interruption sends thread and turn ids and resolves only after a terminal event", async (t) => {
  const server = new FakeAppServerProcess({ onTurnStart: (message, current) => {
    queueMicrotask(() => current.send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "inProgress", items: [] } } }));
  }, onInterrupt: (message, current) => {
    current.respond(message.id, {});
    current.send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } });
  } });
  const { client } = createClient(server);
  t.after(() => client.dispose());

  const turn = client.runTurn({ prompt: "Work until I stop you.", cwd: "/workspace/project" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await client.interrupt(), true);
  assert.deepEqual(await turn, { status: "interrupted" });
  const interrupt = server.requests.find((request) => request.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
});

test("turn failures are surfaced with the server error", async (t) => {
  const server = new FakeAppServerProcess({ onTurnStart: (message, current) => current.completeTurn(message, "failed", "", "mock turn failure") });
  const { client } = createClient(server);
  t.after(() => client.dispose());
  await assert.rejects(client.runTurn({ prompt: "Fail safely.", cwd: "/workspace/project" }), /mock turn failure/u);
});

test("turn timeout requests interruption and resolves as timed out after confirmation", async (t) => {
  const server = new FakeAppServerProcess({
    onTurnStart: (message, current) => queueMicrotask(() => current.send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "inProgress", items: [] } } })),
    onInterrupt: (message, current) => {
      current.respond(message.id, {});
      current.send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } });
    },
  });
  const { client } = createClient(server, { turnTimeoutMs: 10, interruptGraceMs: 100 });
  t.after(() => client.dispose());

  assert.deepEqual(await client.runTurn({ prompt: "A timed diagnostic.", cwd: "/workspace/project" }), { status: "timeout" });
  assert.equal(server.requests.some((request) => request.method === "turn/interrupt"), true);
});

test("approval requests use one-time supported decisions and permissions are limited to the current turn", async (t) => {
  const approvalCalls = [];
  const server = new FakeAppServerProcess({ onTurnStart: (message, current) => {
    current.respond(message.id, { turn: { id: "turn-1", items: [], status: "inProgress" } });
    current.requestFromServer("approval-1", "item/commandExecution/requestApproval", {
      itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1", command: "npm test", cwd: "/workspace/project",
    });
    setImmediate(() => current.completeTurn(message, "completed"));
  } });
  const { client } = createClient(server, {
    onApproval: async (method, params) => {
      approvalCalls.push({ method, params });
      return { decision: "accept" };
    },
  });
  t.after(() => client.dispose());

  await client.runTurn({ prompt: "Run a safe check.", cwd: "/workspace/project" });
  const approvalResponse = server.requests.find((request) => request.id === "approval-1");
  assert.deepEqual(approvalResponse.result, { decision: "accept" });
  assert.equal(approvalCalls[0].method, "item/commandExecution/requestApproval");

  server.requestFromServer("approval-stale", "item/commandExecution/requestApproval", {
    itemId: "item-stale", startedAtMs: 2, threadId: "thread-1", turnId: "turn-1", command: "npm test",
  });
  assert.deepEqual(server.requests.find((request) => request.id === "approval-stale").result, { decision: "decline" });
  assert.equal(approvalCalls.length, 1);

  assert.deepEqual(validateApprovalResult("item/permissions/requestApproval", { permissions: {}, scope: "turn" }), { permissions: {}, scope: "turn" });
  assert.throws(() => validateApprovalResult("item/permissions/requestApproval", { permissions: { network: { enabled: true } }, scope: "session" }), /turn-scoped/u);
  assert.throws(() => validateApprovalResult("item/commandExecution/requestApproval", { decision: "acceptForSession" }), /not supported/u);
});

test("legacy approval denials match the installed schema without granting persistent approval", async (t) => {
  const server = new FakeAppServerProcess();
  const { client } = createClient(server);
  t.after(() => client.dispose());
  await client.connect("/workspace/project");

  server.requestFromServer("patch-approval", "applyPatchApproval", {});
  server.requestFromServer("exec-approval", "execCommandApproval", {});

  const denial = { decision: { denied: { rejection: "Declined by Vesper." } } };
  assert.deepEqual(server.requests.find((request) => request.id === "patch-approval"), { id: "patch-approval", result: denial });
  assert.deepEqual(server.requests.find((request) => request.id === "exec-approval"), { id: "exec-approval", result: denial });
  assert.deepEqual(validateApprovalResult("execCommandApproval", denial), denial);
  assert.throws(() => validateApprovalResult("execCommandApproval", { decision: "denied" }), /Legacy approval decision/u);
  assert.throws(() => validateApprovalResult("applyPatchApproval", { decision: "approved_for_session" }), /Legacy approval decision/u);
});

test("late events from a disconnected process cannot complete or stream into a recovered turn", async (t) => {
  const first = new FakeAppServerProcess({ onTurnStart() {} });
  let nextRequest;
  const second = new FakeAppServerProcess({ onTurnStart: (request) => { nextRequest = request; } });
  let spawns = 0;
  const client = new AppServerClient({ spawnProcess: () => ++spawns === 1 ? first : second });
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());
  const failed = assert.rejects(client.runTurn({ prompt: "Inspect this repository", cwd: "/workspace" }), /exited/u);
  await new Promise((resolve) => setImmediate(resolve));
  first.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "old process snapshot" } });
  first.send({ method: "item/started", params: {
    threadId: "thread-1", turnId: "turn-1", startedAtMs: 1,
    item: { type: "commandExecution", id: "command-1", command: "old command", cwd: "/workspace", status: "inProgress" },
  } });
  first.emit("close", 1, null);
  await failed;
  const disconnectedView = progress.find((event) => event.type === "turn_diff_activity");
  assert.equal(disconnectedView.activity.closeReason, "disconnected");
  assert.equal(disconnectedView.activity.diff, "old process snapshot");
  const streamed = [];
  const recovered = client.runTurn({ prompt: "Try again", cwd: "/workspace", onDelta: (text) => streamed.push(text) });
  await new Promise((resolve) => setImmediate(resolve));
  const currentDiff = client.activeTurn.turnDiff.snapshot();
  const beforeLateDiff = progress.filter((event) => event.type === "turn_diff_activity").length;
  const beforeLateLiveDiff = progress.filter((event) => event.type === "turn_diff_updated").length;
  first.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "stale old process snapshot" } });
  assert.deepEqual(client.activeTurn.turnDiff.snapshot(), currentDiff, "a replaced process cannot update the active aggregate view");
  assert.equal(progress.filter((event) => event.type === "turn_diff_activity").length, beforeLateDiff);
  assert.equal(progress.filter((event) => event.type === "turn_diff_updated").length, beforeLateLiveDiff, "a replaced process cannot publish a live view update");
  first.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "stale text" } });
  first.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  first.emit("close", 1, null);
  assert.ok(client.activeTurn, "old process must not complete the new turn");
  assert.deepEqual(streamed, []);
  const beforeLateCommand = progress.filter((event) => event.type === "codex_progress").length;
  first.send({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", completedAtMs: 2,
    item: { type: "commandExecution", id: "command-1", command: "stale replacement command", cwd: "/workspace", status: "completed", exitCode: 0 },
  } });
  assert.equal(progress.filter((event) => event.type === "codex_progress").length, beforeLateCommand);
  assert.equal(second.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(second.requests.find((request) => request.method === "thread/resume").params.threadId, "thread-1");
  second.completeTurn(nextRequest, "completed", "Recovered.");
  assert.deepEqual(await recovered, { status: "completed" });
  assert.deepEqual(streamed, ["Recovered."]);
});

test("notifications arriving before turn/start acknowledgement wait for authoritative turn identity", async (t) => {
  const server = new FakeAppServerProcess();
  const receive = server.receive.bind(server);
  let startRequest;
  server.receive = (message) => {
    if (message.method === "turn/start") {
      startRequest = message;
      server.requests.push(message);
      server.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "stale-turn", status: "inProgress" } } });
      server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "stale-turn", status: "completed" } } });
      server.send({ method: "item/started", params: {
        threadId: "thread-1", turnId: "stale-turn", startedAtMs: 1,
        item: { type: "commandExecution", id: "stale-command", command: "stale", cwd: "/workspace", status: "inProgress" },
      } });
      server.send({ method: "item/fileChange/patchUpdated", params: {
        threadId: "thread-1", turnId: "stale-turn", itemId: "stale-file",
        changes: [{ path: "/workspace/stale.txt", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+stale\n" }],
      } });
    } else receive(message);
  };
  const { client } = createClient(server);
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());

  const turn = client.runTurn({ prompt: "Inspect", cwd: "/workspace" });
  let settled = false;
  turn.then(() => { settled = true; }, () => { settled = true; });
  await nextEvent();
  assert.equal(client.activeTurn?.turnId, null);
  assert.equal(settled, false);
  server.respond(startRequest.id, { turn: { id: "current-turn", status: "inProgress", items: [] } });
  await nextEvent();
  assert.equal(client.activeTurn?.turnId, "current-turn");
  assert.equal(progress.some((event) => event.type === "turn_identity" && event.turnId === "current-turn"), true);
  const currentIdentity = progress.find((event) => event.type === "turn_identity" && event.turnId === "current-turn");
  assert.deepEqual(currentIdentity.fileChanges, [], "pre-ack summaries are filtered by the acknowledged turn ID");
  assert.equal(progress.some((event) => event.type === "file_change_activity"), false);
  assert.equal(progress.some((event) => event.type === "turn_identity" && event.turnId === "stale-turn"), false);
  assert.equal(progress.some((event) => event.type === "turn_status" && event.turnId === "stale-turn"), false);
  assert.equal(progress.filter((event) => event.type === "codex_progress").some((event) => event.params.turnId === "stale-turn"), true,
    "raw activity is retained for the terminal reducer to discard after authoritative binding");
  server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "current-turn", status: "completed" } } });
  assert.deepEqual(await turn, { status: "completed" });
});

test("command approvals require the authoritative turn and item identity", async (t) => {
  let approvals = 0;
  const server = new FakeAppServerProcess({ onTurnStart: (request, current) => {
    current.requestFromServer("stale-command-approval", "item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "older-turn", itemId: "command-1", command: "npm test",
    });
    current.requestFromServer("missing-item-approval", "item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "turn-1", command: "npm test",
    });
    current.completeTurn(request, "completed");
  } });
  const { client } = createClient(server, { onApproval: async () => {
    approvals += 1;
    return { decision: "accept" };
  } });
  t.after(() => client.dispose());

  assert.deepEqual(await client.runTurn({ prompt: "Inspect", cwd: "/workspace" }), { status: "completed" });
  assert.equal(approvals, 0);
  assert.deepEqual(server.requests.find((message) => message.id === "stale-command-approval").result, { decision: "decline" });
  assert.deepEqual(server.requests.find((message) => message.id === "missing-item-approval").result, { decision: "decline" });
});

test("stale turn notifications cannot change identity and current tool payloads are preserved", async (t) => {
  const server = new FakeAppServerProcess();
  const { client } = createClient(server);
  t.after(() => client.dispose());
  await client.runTurn({ prompt: "First request", cwd: "/workspace" });
  let request;
  server.onTurnStart = (value) => { request = value; };
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  const turn = client.runTurn({ prompt: "Second request", cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  server.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  assert.equal(client.activeTurn?.turnId, "turn-2");
  const params = { threadId: "thread-1", turnId: "turn-2", item: { id: "command-1", type: "commandExecution", command: "git status", status: "completed", exitCode: 0, aggregatedOutput: "clean" } };
  server.send({ method: "item/completed", params: { ...params, turnId: "turn-1" } });
  server.send({ method: "item/completed", params });
  const activity = progress.filter((event) => event.type === "codex_progress");
  assert.deepEqual(activity, [{ type: "codex_progress", method: "item/completed", params }]);
  server.completeTurn(request, "completed");
  assert.deepEqual(await turn, { status: "completed" });
});

test("an approval answer from a disconnected process is never written to its replacement", async (t) => {
  let answer;
  const first = new FakeAppServerProcess({ onTurnStart: (_request, server) => {
    server.requestFromServer("approval-1", "item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "git status",
    });
  } });
  const second = new FakeAppServerProcess({ onTurnStart() {} });
  let spawns = 0;
  const client = new AppServerClient({
    spawnProcess: () => ++spawns === 1 ? first : second,
    onApproval: () => new Promise((resolve) => { answer = resolve; }),
  });
  t.after(() => client.dispose());
  const failed = assert.rejects(client.runTurn({ prompt: "Inspect", cwd: "/workspace" }), /exited/u);
  await new Promise((resolve) => setImmediate(resolve));
  first.emit("close", 1, null);
  await failed;
  const recovery = client.runTurn({ prompt: "Inspect again", cwd: "/workspace" });
  const stopped = assert.rejects(recovery, /closed/u);
  await new Promise((resolve) => setImmediate(resolve));
  answer({ decision: "accept" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.requests.some((message) => message.id === "approval-1"), false);
  client.dispose();
  await stopped;
});

test("resume rejects a mismatched server thread or cwd before any turn", async (t) => {
  for (const response of [
    { thread: { id: "wrong-thread" }, cwd: "/workspace" },
    { thread: { id: "saved-thread" }, cwd: "/different-project" },
  ]) {
    const server = new FakeAppServerProcess();
    const receive = server.receive.bind(server);
    server.receive = (message) => {
      if (message.method === "thread/resume") {
        server.requests.push(message);
        server.respond(message.id, response);
      } else receive(message);
    };
    const { client } = createClient(server, { initialThreadId: "saved-thread" });
    t.after(() => client.dispose());
    await assert.rejects(client.runTurn({ prompt: "Continue", cwd: "/workspace" }), /different/u);
    assert.equal(server.requests.some((message) => ["thread/start", "turn/start"].includes(message.method)), false);
  }
});

test("terminal approval choices reach the app-server and its outcome controls completion", async (t) => {
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    for (const answer of ["yes", "no", "cancel"]) {
      await t.test(`${method}: ${answer}`, async (t) => {
        let startRequest;
        let operations = 0;
        let response;
        const server = new FakeAppServerProcess({ onTurnStart: (request, current) => {
          startRequest = request;
          if (method === "item/fileChange/requestApproval") {
            current.send({ method: "item/started", params: {
              threadId: "thread-1", turnId: "turn-1", startedAtMs: 1,
              item: { type: "fileChange", id: "item-1", status: "inProgress",
                changes: [{ path: "/workspace/example.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" }] },
            } });
          }
          current.requestFromServer("approval-1", method, {
            threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1,
            command: "git status", cwd: "/workspace", reason: "Fixture operation",
            permissions: { network: { enabled: true } },
          });
        } });
        const receive = server.receive.bind(server);
        server.receive = (message) => {
          receive(message);
          if (message.id !== "approval-1") return;
          response = message.result;
          const accepted = response?.decision === "accept" || response?.permissions?.network?.enabled === true;
          if (accepted) operations += 1;
          server.completeTurn(startRequest, answer === "cancel" && response.decision === "cancel" ? "interrupted" : "completed",
            accepted ? "Operation completed." : "Operation declined; no operation performed.");
        };
        let frontend;
        const { client } = createClient(server, { onApproval: (name, params, context) => frontend.requestApproval(name, params, context) });
        t.after(() => client.dispose());
        const answers = ["Inspect this repository", answer, ":quit"];
        let text = "";
        frontend = new TerminalFrontend({
          cwd: "/workspace", handlers: {}, appServer: client,
          output: { write: (chunk) => { text += chunk; } },
          lineIO: { question: async () => {
            const answer = answers.shift();
            if (method === "item/fileChange/requestApproval" && ["yes", "no", "cancel"].includes(answer)) {
              assert.match(text, /Diff \(server snapshot\):/u, "the diff must be printed before asking");
              assert.equal(operations, 0);
            }
            return answer;
          }, close() {}, onInterrupt() {} },
        });
        await frontend.run();
        assert.equal(operations, answer === "yes" ? 1 : 0);
        if (method === "item/permissions/requestApproval") {
          assert.deepEqual(response, { permissions: answer === "yes" ? { network: { enabled: true } } : {}, scope: "turn" });
        } else {
          assert.deepEqual(response, { decision: answer === "yes" ? "accept" : answer === "cancel" ? "cancel" : "decline" });
        }
        assert.match(text, /Codex approval required/u);
        assert.match(text, /Approval choice:/u);
        if (method === "item/fileChange/requestApproval") assert.match(text, /Diff \(server snapshot\): \| @@ -1 \+1 @@\n\| -old\n\| \+new/u);
        assert.doesNotMatch(text, /Vesper local/u);
        if (answer === "yes") assert.match(text, /Operation completed/u);
        else assert.match(text, /Operation declined; no operation performed/u);
        if (answer === "cancel" && method !== "item/permissions/requestApproval") {
          assert.match(text, /Codex · interrupted/u);
          assert.doesNotMatch(text, /Codex · completed/u);
        }
      });
    }
  }
});

test("unconfirmed timeout closes the connection and cannot be reported as completed", async (t) => {
  const server = new FakeAppServerProcess({ onTurnStart() {} });
  const recoveryServer = new FakeAppServerProcess();
  let spawns = 0;
  const { client } = createClient(server, {
    turnTimeoutMs: 10, interruptGraceMs: 10,
    spawnProcess: () => ++spawns === 1 ? server : recoveryServer,
  });
  t.after(() => client.dispose());
  await assert.rejects(client.runTurn({ prompt: "Inspect", cwd: "/workspace" }), /did not confirm interruption/u);
  assert.equal(server.killed, true);
  assert.equal(client.activeTurn, undefined);
  assert.deepEqual(await client.runTurn({ prompt: "Retry", cwd: "/workspace" }), { status: "completed" });
  assert.equal(recoveryServer.requests.find((message) => message.method === "thread/resume").params.threadId, "thread-1");
  assert.equal(recoveryServer.requests.some((message) => message.method === "thread/start"), false);
});

test("a failure notification before the turn/start reply is reported without an unhandled rejection", async (t) => {
  const server = new FakeAppServerProcess();
  const receive = server.receive.bind(server);
  server.receive = (message) => {
    if (message.method !== "turn/start") return receive(message);
    server.requests.push(message);
    server.turnCount += 1;
    server.completeTurn(message, "failed", "", "early turn failure");
    setImmediate(() => server.respond(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } }));
  };
  const { client } = createClient(server);
  t.after(() => client.dispose());
  await assert.rejects(client.runTurn({ prompt: "Inspect", cwd: "/workspace" }), /early turn failure/u);
});

test("an unsupported server request ends the uncertain operation before another fallback", async (t) => {
  const server = new FakeAppServerProcess({ onTurnStart: (_request, current) => {
    setImmediate(() => current.requestFromServer("unsupported-1", "item/tool/requestUserInput", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", questions: [],
    }));
  } });
  const { client } = createClient(server);
  t.after(() => client.dispose());
  await assert.rejects(client.runTurn({ prompt: "Inspect", cwd: "/workspace" }), /unsupported/u);
  assert.equal(server.requests.find((message) => message.id === "unsupported-1").error.code, -32601);
  assert.equal(server.killed, true);
  assert.equal(client.child, undefined);
});

test("turn/start timeout closes the transport because server acceptance is unknown", async (t) => {
  const server = new FakeAppServerProcess();
  const receive = server.receive.bind(server);
  server.receive = (message) => {
    if (message.method === "turn/start") server.requests.push(message);
    else receive(message);
  };
  const { client } = createClient(server, { rpcTimeoutMs: 10 });
  t.after(() => client.dispose());
  await assert.rejects(client.runTurn({ prompt: "Inspect", cwd: "/workspace" }), /Timed out waiting.*turn\/start/u);
  assert.equal(server.killed, true);
  assert.equal(client.activeTurn, undefined);
});

const fileApprovalMethod = "item/fileChange/requestApproval";
const sampleChanges = () => [{ path: "/workspace/example.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" }];
const nextEvent = () => new Promise((resolve) => setImmediate(resolve));

function fileItem(server, { threadId = "thread-1", turnId = "turn-1", itemId = "file-1", changes = sampleChanges(), status = "inProgress", method = "item/started" } = {}) {
  server.send({ method, params: { threadId, turnId, startedAtMs: 1, completedAtMs: 2,
    item: { type: "fileChange", id: itemId, status, changes } } });
}

async function fileRequest(server, id, overrides = {}) {
  server.requestFromServer(id, fileApprovalMethod, {
    threadId: "thread-1", turnId: "turn-1", itemId: "file-1", startedAtMs: 1, ...overrides,
  });
  await nextEvent();
  return server.requests.find((message) => message.id === id && !message.method)?.result;
}

async function openFileTurn(t, options = {}) {
  let start;
  const server = new FakeAppServerProcess({ onTurnStart: (request) => { start = request; } });
  const calls = [];
  const { client } = createClient(server, {
    ...options,
    onApproval: async (method, params, context) => {
      calls.push({ method, params, context });
      return options.onApproval ? options.onApproval(method, params, context) : { decision: "accept" };
    },
  });
  t.after(() => client.dispose());
  const turn = client.runTurn({ prompt: "Update a file", cwd: "/workspace" });
  turn.catch(() => {}); // Cleanup can reject a still-pending fixture turn.
  await nextEvent();
  return { server, client, calls, turn, finish: async () => {
    server.completeTurn(start, "completed");
    return turn;
  } };
}

test("file approvals retain immutable item-specific snapshots and replacement patches", async (t) => {
  const { server, calls, finish } = await openFileTurn(t);
  fileItem(server, { itemId: "file-1" });
  fileItem(server, { itemId: "file-2", changes: [{ path: "/workspace/second.txt", kind: { type: "add" }, diff: "+second\n" }] });
  server.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
    changes: [{ path: "/workspace/example.txt", kind: { type: "update", move_path: "/workspace/moved.txt" }, diff: "@@ -1 +1 @@\n-old\n+revised\n" }],
  } });
  assert.deepEqual(await fileRequest(server, "approve-2", { itemId: "file-2" }), { decision: "accept" });
  assert.deepEqual(await fileRequest(server, "approve-1"), { decision: "accept" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.fileChange.itemId, "file-2");
  const snapshot = calls[1].context.fileChange;
  assert.deepEqual([snapshot.threadId, snapshot.turnId, snapshot.itemId], ["thread-1", "turn-1", "file-1"]);
  assert.equal(snapshot.changes[0].kind.move_path, "/workspace/moved.txt");
  assert.match(snapshot.changes[0].diff, /\+revised/u);
  assert.throws(() => { snapshot.changes[0].diff = "altered"; }, TypeError);
  assert.throws(() => { snapshot.changes[0].kind.move_path = "altered"; }, TypeError);
  assert.equal(Object.isFrozen(snapshot.changes), true);
  assert.deepEqual(await fileRequest(server, "replay"), { decision: "decline" });
  await finish();
  assert.equal(calls[1].context.signal.aborted, true);
});

test("missing, malformed and oversized file snapshots decline without invoking an approval UI", async (t) => {
  const { server, calls, finish } = await openFileTurn(t);
  assert.deepEqual(await fileRequest(server, "missing"), { decision: "decline" });
  const invalid = [
    null, [], {}, [null], [{ ...sampleChanges()[0], diff: 5 }],
    [{ ...sampleChanges()[0], diff: "" }], [{ ...sampleChanges()[0], diff: " \n" }],
    [{ ...sampleChanges()[0], diff: "x".repeat(8_001) }],
    [{ ...sampleChanges()[0], path: "" }], [{ ...sampleChanges()[0], path: "bad\npath" }],
    [{ ...sampleChanges()[0], path: "/workspace/hidden\u202epath" }],
    [{ ...sampleChanges()[0], kind: { type: "unknown" } }],
    [{ ...sampleChanges()[0], kind: { type: "update", move_path: 42 } }],
    [{ ...sampleChanges()[0], binary: true }],
    [sampleChanges()[0], sampleChanges()[0]],
    Array.from({ length: 4 }, (_, i) => ({ path: `/workspace/file-${i}`, kind: { type: "add" }, diff: "x".repeat(6_000) })),
  ];
  for (const [index, changes] of invalid.entries()) {
    const itemId = `bad-${index}`;
    fileItem(server, { itemId, changes });
    assert.deepEqual(await fileRequest(server, `invalid-${index}`, { itemId }), { decision: "decline" }, `case ${index}`);
  }
  assert.equal(calls.length, 0);
  // A later independent item in the same turn can still be reviewed.
  fileItem(server, { itemId: "good" });
  assert.deepEqual(await fileRequest(server, "recovered", { itemId: "good" }), { decision: "accept" });
  assert.equal(calls.length, 1);
  await finish();
});

test("file approval identity never falls back to another thread, turn or item", async (t) => {
  const { server, calls, finish } = await openFileTurn(t);
  fileItem(server);
  for (const [index, params] of [
    { threadId: "other-thread" }, { turnId: "other-turn" }, { itemId: "other-item" },
    { threadId: "" }, { turnId: null }, { itemId: "" },
  ].entries()) {
    assert.deepEqual(await fileRequest(server, `mismatch-${index}`, params), { decision: "decline" });
  }
  // Well-scoped foreign updates must not replace the valid current snapshot.
  fileItem(server, { threadId: "other-thread", changes: [{ ...sampleChanges()[0], diff: "+foreign thread" }] });
  server.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "previous-turn", itemId: "file-1", changes: [{ ...sampleChanges()[0], diff: "+stale turn" }],
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await fileRequest(server, "current"), { decision: "accept" });
  assert.equal(calls[0].context.fileChange.changes[0].diff, sampleChanges()[0].diff);
  await finish();
});

test("invalid updates and completed items cannot reuse an earlier valid file diff", async (t) => {
  const { server, calls, finish } = await openFileTurn(t);
  for (const [index, status] of ["completed", "failed", "declined"].entries()) {
    const itemId = `ended-${index}`;
    fileItem(server, { itemId });
    fileItem(server, { itemId, method: "item/completed", status });
    server.send({ method: "item/fileChange/patchUpdated", params: {
      threadId: "thread-1", turnId: "turn-1", itemId, changes: sampleChanges(),
    } });
    assert.deepEqual(await fileRequest(server, `ended-request-${index}`, { itemId }), { decision: "decline" });
  }
  fileItem(server);
  server.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "file-1", changes: null,
  } });
  assert.deepEqual(await fileRequest(server, "malformed-replacement"), { decision: "decline" });
  fileItem(server, { itemId: "another" });
  server.send({ method: "item/fileChange/patchUpdated", params: { itemId: "another", changes: sampleChanges() } });
  assert.deepEqual(await fileRequest(server, "unscoped", { itemId: "another" }), { decision: "decline" });
  assert.equal(calls.length, 0);
  await finish();
});

test("file diff changes during review invalidate the answer and duplicate requests cannot approve twice", async (t) => {
  let answer;
  const { server, calls, finish } = await openFileTurn(t, {
    onApproval: () => new Promise((resolve) => { answer = resolve; }),
  });
  fileItem(server);
  assert.equal(await fileRequest(server, "pending"), undefined);
  assert.deepEqual(await fileRequest(server, "duplicate"), { decision: "decline" });
  const context = calls[0].context;
  server.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
    changes: [{ ...sampleChanges()[0], diff: "+changed while reviewing" }],
  } });
  assert.equal(context.signal.aborted, true);
  assert.equal(context.isCurrent(), false);
  answer({ decision: "accept" });
  await nextEvent();
  assert.deepEqual(server.requests.find((message) => message.id === "pending").result, { decision: "decline" });
  assert.deepEqual(await fileRequest(server, "reused-item"), { decision: "decline" });
  assert.equal(calls.length, 1);
  await finish();
});

test("file approvals wait for the authoritative start reply and ignore pre-ack stale identities", async (t) => {
  const server = new FakeAppServerProcess();
  const receive = server.receive.bind(server);
  let start;
  server.receive = (message) => {
    if (message.method === "turn/start") { start = message; server.requests.push(message); }
    else receive(message);
  };
  let approvals = 0;
  const { client } = createClient(server, { onApproval: async (_method, _params, context) => {
    approvals += 1;
    assert.equal(context.fileChange.turnId, "authoritative-turn");
    return { decision: "accept" };
  } });
  t.after(() => client.dispose());
  const turn = client.runTurn({ prompt: "Edit a file", cwd: "/workspace" });
  await nextEvent();
  server.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "stale-turn", status: "inProgress" } } });
  fileItem(server, { turnId: "stale-turn" });
  fileItem(server, { turnId: "authoritative-turn" });
  assert.equal(await fileRequest(server, "early", { turnId: "authoritative-turn" }), undefined);
  assert.equal(await fileRequest(server, "old", { turnId: "stale-turn" }), undefined);
  assert.equal(approvals, 0);
  server.respond(start.id, { turn: { id: "authoritative-turn", status: "inProgress", items: [] } });
  await nextEvent();
  assert.equal(approvals, 1);
  assert.deepEqual(server.requests.find((message) => message.id === "early").result, { decision: "accept" });
  assert.deepEqual(server.requests.find((message) => message.id === "old").result, { decision: "decline" });
  server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "authoritative-turn", status: "completed" } } });
  assert.deepEqual(await turn, { status: "completed" });
});

test("the file snapshot is bound at approval receipt, not after waiting for the start reply", async (t) => {
  for (const initiallyMissing of [false, true]) {
    const server = new FakeAppServerProcess();
    const receive = server.receive.bind(server);
    let start;
    server.receive = (message) => {
      if (message.method === "turn/start") { start = message; server.requests.push(message); }
      else receive(message);
    };
    let approvals = 0;
    const { client } = createClient(server, { onApproval: async () => { approvals += 1; return { decision: "accept" }; } });
    t.after(() => client.dispose());
    const turn = client.runTurn({ prompt: "Edit", cwd: "/workspace" });
    turn.catch(() => {});
    await nextEvent();
    if (!initiallyMissing) fileItem(server);
    assert.equal(await fileRequest(server, "pending-start"), undefined);
    fileItem(server, { changes: [{ ...sampleChanges()[0], diff: "+arrived after the approval request" }] });
    server.respond(start.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
    await nextEvent();
    assert.equal(approvals, 0, "a later snapshot cannot authorize an earlier request");
    assert.deepEqual(server.requests.find((message) => message.id === "pending-start").result, { decision: "decline" });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await turn;
  }
});

test("file snapshots and pending answers cannot survive disconnect and same-thread resumption", async (t) => {
  const first = new FakeAppServerProcess({ onTurnStart() {} });
  const second = new FakeAppServerProcess({ onTurnStart() {} });
  let spawns = 0;
  let answer;
  const contexts = [];
  const progress = [];
  const client = new AppServerClient({
    initialThreadId: "saved-thread",
    spawnProcess: () => ++spawns === 1 ? first : second,
    onApproval: async (_method, _params, context) => {
      contexts.push(context);
      if (contexts.length === 1) return new Promise((resolve) => { answer = resolve; });
      return { decision: "accept" };
    },
  });
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());
  const failed = assert.rejects(client.runTurn({ prompt: "Edit", cwd: "/workspace" }), /exited/u);
  await nextEvent();
  fileItem(first, { threadId: "saved-thread" });
  await fileRequest(first, "old-request", { threadId: "saved-thread" });
  first.emit("close", 1, null);
  await failed;
  assert.equal(contexts[0].signal.aborted, true);
  const recovered = client.runTurn({ prompt: "Try again", cwd: "/workspace" });
  await nextEvent();
  // Identical wire IDs from the old process must not populate the new cache.
  fileItem(first, { threadId: "saved-thread" });
  first.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "saved-thread", turnId: "turn-1", itemId: "file-1", changes: sampleChanges(),
  } });
  answer({ decision: "accept" });
  await nextEvent();
  assert.equal(progress.some((event) => event.type === "file_approval_declined"), false, "old approval must not emit into a recovered turn");
  assert.deepEqual(await fileRequest(second, "missing-after-resume", { threadId: "saved-thread" }), { decision: "decline" });
  assert.equal(second.requests.some((message) => message.id === "old-request"), false);
  assert.equal(second.requests.some((message) => message.method === "thread/start"), false);
  assert.equal(second.requests.find((message) => message.method === "thread/resume").params.threadId, "saved-thread");
  fileItem(second, { threadId: "saved-thread" });
  assert.deepEqual(await fileRequest(second, "fresh-after-resume", { threadId: "saved-thread" }), { decision: "accept" });
  second.send({ method: "turn/completed", params: { threadId: "saved-thread", turn: { id: "turn-1", status: "completed" } } });
  assert.deepEqual(await recovered, { status: "completed" });
});

test("session write-root requests and legacy patch requests cannot bypass exact one-time file review", async (t) => {
  const { server, calls, finish } = await openFileTurn(t);
  fileItem(server);
  assert.deepEqual(await fileRequest(server, "root-grant", { grantRoot: "/workspace" }), { decision: "decline" });
  server.requestFromServer("legacy-patch", "applyPatchApproval", {
    conversationId: "thread-1", callId: "file-1",
    fileChanges: { "/workspace/example.txt": { type: "update", unified_diff: sampleChanges()[0].diff } },
  });
  await nextEvent();
  assert.ok(server.requests.find((message) => message.id === "legacy-patch").result.decision.denied);
  assert.equal(calls.length, 0);
  assert.deepEqual(await fileRequest(server, "ordinary"), { decision: "accept" });
  await finish();
});

test("file snapshot storage has a per-turn bound and fails closed on overflow", async (t) => {
  const { server, calls, finish } = await openFileTurn(t);
  for (let index = 0; index < 65; index += 1) fileItem(server, { itemId: `file-${index}` });
  assert.deepEqual(await fileRequest(server, "overflow"), { decision: "decline" });
  assert.equal(calls.length, 0);
  await finish();
});

test("file-change summaries follow cached item evidence from pending through update to completion", async (t) => {
  const server = new FakeAppServerProcess({ onTurnStart: (request, current) => {
    setImmediate(() => {
      const threadId = request.params.threadId;
      current.send({ method: "item/started", params: {
        threadId,
        turnId: "turn-1",
        startedAtMs: 1,
        item: {
          id: "file-1", type: "fileChange", status: "inProgress",
          changes: [{ path: "/workspace/example.txt", kind: { type: "update" }, diff: "--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n" }],
        },
      } });
      current.send({ method: "item/fileChange/patchUpdated", params: {
        threadId,
        turnId: "turn-1",
        itemId: "file-1",
        changes: [{ path: "/workspace/updated.txt", kind: { type: "add" }, diff: "--- /dev/null\n+++ b/updated.txt\n@@ -0,0 +1 @@\n+added\n" }],
      } });
      current.send({ method: "item/completed", params: {
        threadId,
        turnId: "turn-1",
        completedAtMs: 2,
        item: { id: "file-1", type: "fileChange", status: "completed", changes: [] },
      } });
      current.completeTurn(request, "completed");
    });
  } });
  const { client } = createClient(server);
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());

  assert.deepEqual(await client.runTurn({ prompt: "Inspect these changes", cwd: "/workspace" }), { status: "completed" });
  assert.deepEqual(progress.filter((event) => event.type === "file_change_activity").map((event) => event.activity.state), [
    "pending", "updated", "completed",
  ]);
  const updated = progress.find((event) => event.type === "file_change_activity" && event.activity.state === "updated");
  assert.deepEqual(updated.activity.changes.map((item) => item.path), ["/workspace/updated.txt"]);
  assert.equal(updated.activity.changes[0].addedLines, 1);
  assert.equal(updated.activity.changes[0].removedLines, 0);
  const completed = progress.find((event) => event.type === "file_change_activity" && event.activity.state === "completed");
  assert.deepEqual(completed.activity.changes, []);
});

test("turn interruption invalidates file summaries and late events from the replaced process are ignored", async (t) => {
  const first = new FakeAppServerProcess({ onTurnStart() {} });
  const second = new FakeAppServerProcess({ onTurnStart() {} });
  let spawns = 0;
  const client = new AppServerClient({ spawnProcess: () => ++spawns === 1 ? first : second });
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());

  const abandoned = assert.rejects(client.runTurn({ prompt: "Inspect file activity", cwd: "/workspace" }), /exited/u);
  await nextEvent();
  await nextEvent();
  first.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
    changes: [{ path: "/workspace/current.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-before\n+after\n" }],
  } });
  assert.equal(progress.some((event) => event.type === "file_change_activity" && event.activity.state === "updated"), true);
  first.emit("close", 1, null);
  await abandoned;
  assert.equal(progress.some((event) => event.type === "file_change_activity" && event.activity.state === "invalidated"), true);

  const recovered = client.runTurn({ prompt: "Resume", cwd: "/workspace" });
  await nextEvent();
  const before = progress.filter((event) => event.type === "file_change_activity").length;
  first.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
    changes: [{ path: "/workspace/stale.txt", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+stale\n" }],
  } });
  assert.equal(progress.filter((event) => event.type === "file_change_activity").length, before);
  assert.ok(second.requests.some((message) => message.method === "thread/resume"));
  second.send({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "resume-file",
    changes: [{ path: "/workspace/resumed.txt", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+proposed\n" }],
  } });
  assert.equal(progress.some((event) => event.type === "file_change_activity" && event.activity.itemId === "resume-file" && event.activity.state === "updated"), true);
  second.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });
  assert.deepEqual(await recovered, { status: "interrupted" });
  assert.equal(progress.some((event) => event.type === "file_change_activity" && event.activity.itemId === "resume-file" && event.activity.state === "invalidated"), true);
});

test("turn diff updates replace the aggregate snapshot and never become per-item approval evidence", async (t) => {
  let client;
  let approvalEvidence;
  const server = new FakeAppServerProcess({ onTurnStart: (request, current) => {
    current.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "first complete snapshot" } });
    current.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "latest complete snapshot" } });
    approvalEvidence = client.activeTurn.fileChanges.capture({ threadId: "thread-1", turnId: "turn-1", itemId: "file-1" });
    current.completeTurn(request, "completed");
  } });
  ({ client } = createClient(server));
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());

  assert.deepEqual(await client.runTurn({ prompt: "Inspect proposed changes", cwd: "/workspace" }), { status: "completed" });
  const views = progress.filter((event) => event.type === "turn_diff_activity");
  const liveViews = progress.filter((event) => event.type === "turn_diff_updated");
  assert.equal(views.length, 1, "complete snapshots are projected once when the turn closes");
  assert.equal(liveViews.length, 1, "pre-ack complete snapshots bind to the authoritative turn before live forwarding");
  assert.equal(liveViews[0].activity.diff, "latest complete snapshot");
  assert.equal(views[0].activity.diff, "latest complete snapshot");
  assert.equal(views[0].activity.evidenceState, "available");
  assert.equal(views[0].activity.closeReason, "completed");
  assert.equal(Object.hasOwn(views[0].activity, "itemId"), false);
  assert.equal(approvalEvidence, null, "aggregate diffs cannot create file-item approval evidence");
  assert.equal(progress.some((event) => event.type === "codex_progress" && event.method === "turn/diff/updated"), false);
});

test("accepted turn diff snapshots are forwarded live only for the active thread and turn", async (t) => {
  const server = new FakeAppServerProcess({ onTurnStart: (request, current) => {
    setImmediate(() => {
      current.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "live first" } });
      current.send({ method: "turn/diff/updated", params: { threadId: "foreign", turnId: "turn-1", diff: "foreign thread" } });
      current.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "foreign-turn", diff: "foreign turn" } });
      current.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "live replacement" } });
      current.completeTurn(request, "completed");
    });
  } });
  const { client } = createClient(server);
  const progress = [];
  client.on("progress", (event) => progress.push(event));
  t.after(() => client.dispose());

  assert.deepEqual(await client.runTurn({ prompt: "Observe aggregate updates", cwd: "/workspace" }), { status: "completed" });
  const live = progress.filter((event) => event.type === "turn_diff_updated");
  assert.deepEqual(live.map((event) => event.activity.diff), ["live first", "live replacement"]);
  assert.equal(live.every((event) => event.activity.threadId === "thread-1" && event.activity.turnId === "turn-1"), true);
});

test("turn diff view closes with the protocol turn outcome for completion, interruption and failure", async (t) => {
  for (const status of ["completed", "interrupted", "failed"]) {
    const server = new FakeAppServerProcess({ onTurnStart: (request, current) => {
      current.send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: `snapshot before ${status}` } });
      current.completeTurn(request, status, "", status === "failed" ? "mock failure" : undefined);
    } });
    const { client } = createClient(server);
    const progress = [];
    client.on("progress", (event) => progress.push(event));
    t.after(() => client.dispose());

    const turn = client.runTurn({ prompt: "Observe this turn", cwd: "/workspace" });
    if (status === "failed") await assert.rejects(turn, /mock failure/u);
    else assert.deepEqual(await turn, { status });
    const activity = progress.find((event) => event.type === "turn_diff_activity")?.activity;
    assert.equal(activity?.closeReason, status);
    assert.equal(activity?.diff, `snapshot before ${status}`);
    assert.equal(activity?.evidenceState, "available");
  }
});
