"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { AppServerClient, validateApprovalResult } = require("../app-server-client");

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
  t.after(() => client.dispose());
  const failed = assert.rejects(client.runTurn({ prompt: "Inspect this repository", cwd: "/workspace" }), /exited/u);
  await new Promise((resolve) => setImmediate(resolve));
  first.emit("close", 1, null);
  await failed;
  const streamed = [];
  const recovered = client.runTurn({ prompt: "Try again", cwd: "/workspace", onDelta: (text) => streamed.push(text) });
  await new Promise((resolve) => setImmediate(resolve));
  first.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "stale text" } });
  first.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  first.emit("close", 1, null);
  assert.ok(client.activeTurn, "old process must not complete the new turn");
  assert.deepEqual(streamed, []);
  assert.equal(second.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(second.requests.find((request) => request.method === "thread/resume").params.threadId, "thread-1");
  second.completeTurn(nextRequest, "completed", "Recovered.");
  assert.deepEqual(await recovered, { status: "completed" });
  assert.deepEqual(streamed, ["Recovered."]);
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
