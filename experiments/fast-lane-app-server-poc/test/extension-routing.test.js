"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const childProcess = require("node:child_process");
const { SessionStore } = require("../session-store");

test("VS Code keeps local routing local and persists only the Vesper session and Codex thread identifiers", async (t) => {
  const project = fs.realpathSync(process.cwd());
  const harness = createHarness(t, [{ name: "Vesper", uri: { fsPath: project } }]);
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });

  await panel.send({ type: "submit", text: "What Git branch am I on?" });
  assert.equal(panel.last("local-answer")?.result.intent, "current_git_branch");
  assert.equal(harness.state.children.length, 0);
  assert.equal(harness.store().findLatestByCwd(project), null);

  await panel.send({ type: "submit", text: "Explain a rebase in one sentence." });
  assert.equal(panel.all("assistant-delta").map((message) => message.text).join(""), "Answer 1.");
  assert.equal(panel.all("assistant-done").length, 1);
  const session = harness.store().findLatestByCwd(project);
  assert.ok(session?.sessionId);
  assert.equal(session.threadId, "thread-1");
  const stored = fs.readFileSync(path.join(harness.home, "sessions", `${session.sessionId}.json`), "utf8");
  assert.equal(stored.includes("Explain a rebase"), false);
  assert.equal(stored.includes("Answer 1"), false);
  assert.deepEqual(harness.requests.filter((request) => ["thread/start", "turn/start"].includes(request.method)).map((request) => request.method), [
    "thread/start", "turn/start",
  ]);
  assert.equal(harness.requests.find((request) => request.method === "thread/start").params.sandbox, "read-only");
  assert.equal(panel.last("session-state").state, "connected");
});

test("panel reopen and extension restart restore the same persisted Vesper session and Codex thread", async (t) => {
  const root = makeTempDirectory("vesper-vscode-resume-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }]);
  let panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "Inspect this project." });

  const original = harness.store().findLatestByCwd(fs.realpathSync(project));
  assert.equal(original.threadId, "thread-1");
  const initialStartCount = harness.requests.filter((request) => request.method === "thread/start").length;

  panel.close();
  panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("session-state").state, "connected", "the same extension host retains its connected runtime");
  await panel.send({ type: "submit", text: "Continue after reopening the panel." });
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, initialStartCount);

  harness.restartExtension();
  panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("session-state").state, "saved");
  assert.match(panel.last("session-state").text, /verify the same Codex thread/u);
  await panel.send({ type: "submit", text: "Continue after restarting VS Code." });

  const resumed = harness.requests.filter((request) => request.method === "thread/resume");
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0].params, { threadId: original.threadId, sandbox: "read-only" });
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, initialStartCount);
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").at(-1).params.threadId, original.threadId);
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(project)).sessionId, original.sessionId);
  assert.equal(panel.last("session-state").text, "Connected · this Vesper session is saved.");
});

test("workspace folders stay isolated and interrupt targets only the active thread and turn", async (t) => {
  const root = makeTempDirectory("vesper-vscode-projects-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const projectA = { name: "Project A", uri: { fsPath: a } };
  const projectB = { name: "Project B", uri: { fsPath: b } };
  const harness = createHarness(t, [projectA, projectB], { heldTurns: [2] });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "Inspect project A." });
  harness.pick(projectB);
  await panel.send({ type: "select-project" });

  const secondTurn = panel.send({ type: "submit", text: "Inspect project B." });
  await waitFor(() => panel.all("assistant-running").some((message) => message.turnId === "turn-2"));
  const requestId = panel.last("assistant-start").requestId;
  await panel.send({ type: "interrupt", requestId: requestId + 50 });
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  await panel.send({ type: "interrupt", requestId });
  await secondTurn;

  const interrupt = harness.requests.find((request) => request.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-2", turnId: "turn-2" });
  assert.equal(panel.last("assistant-error").state, "interrupted");
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(a)).threadId, "thread-1");
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(b)).threadId, "thread-2");

  harness.pick(projectA);
  await panel.send({ type: "select-project" });
  await panel.send({ type: "submit", text: "Continue project A." });
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, 2);
  assert.equal(harness.requests.find((request) => request.method === "thread/resume").params.threadId, "thread-1");
  assert.deepEqual(harness.requests.filter((request) => request.method === "turn/start").map((request) => request.params.threadId), [
    "thread-1", "thread-2", "thread-1",
  ]);
});

test("failed resume keeps the saved mapping, blocks duplicate turns, and exposes safe retry and new-session actions", async (t) => {
  const root = makeTempDirectory("vesper-vscode-failed-resume-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], { resumeFailures: 1 });
  const saved = harness.store().create(fs.realpathSync(project));
  harness.store().update(saved.sessionId, { threadId: "saved-thread" });
  harness.state.threadCwds.set("saved-thread", fs.realpathSync(project));

  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "Continue my saved work." });
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(harness.requests.some((request) => request.method === "thread/start" || request.method === "turn/start"), false);
  assert.equal(harness.store().load(saved.sessionId).threadId, "saved-thread");
  assert.equal(panel.last("session-state").state, "recovery-required");
  assert.equal(panel.last("session-state").canRetry, true);
  assert.equal(panel.last("session-state").canStartNew, true);

  await panel.send({ type: "submit", text: "Do not send while disconnected." });
  assert.equal(harness.requests.some((request) => request.method === "turn/start"), false);
  await panel.send({ type: "retry-resume" });
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 2);
  assert.equal(harness.requests.some((request) => request.method === "thread/start" || request.method === "turn/start"), false);
  assert.equal(panel.last("session-state").state, "connected");
  await panel.send({ type: "submit", text: "Continue after reconnect." });
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").at(-1).params.threadId, "saved-thread");
});

test("disconnect and failed reconnect keep the same thread and ignore late events from the replaced process", async (t) => {
  const root = makeTempDirectory("vesper-vscode-disconnect-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }]);
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "Start the session." });
  const session = harness.store().findLatestByCwd(fs.realpathSync(project));
  const oldProcess = harness.state.children[0];
  oldProcess.disconnect();
  assert.equal(panel.last("session-state").state, "disconnected");
  assert.equal(panel.last("session-state").canRetry, true);

  harness.state.resumeFailures = 1;
  const startsBeforeReconnect = harness.requests.filter((request) => ["thread/start", "turn/start"].includes(request.method)).length;
  const threadStartsBeforeReconnect = harness.requests.filter((request) => request.method === "thread/start").length;
  await panel.send({ type: "retry-resume" });
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(harness.requests.filter((request) => ["thread/start", "turn/start"].includes(request.method)).length, startsBeforeReconnect);
  assert.equal(panel.last("session-state").state, "recovery-required");
  oldProcess.send({ method: "item/agentMessage/delta", params: { threadId: session.threadId, turnId: "turn-1", delta: "late after disconnect" } });
  assert.equal(panel.all("assistant-delta").some((message) => message.text === "late after disconnect"), false);

  await panel.send({ type: "retry-resume" });
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 2);
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, threadStartsBeforeReconnect);
  assert.equal(panel.last("session-state").state, "connected");
  await panel.send({ type: "submit", text: "Continue the existing thread." });
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").at(-1).params.threadId, session.threadId);
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(project)).sessionId, session.sessionId);
});

test("an unavailable saved thread is never silently replaced; starting a new session preserves the old record", async (t) => {
  const root = makeTempDirectory("vesper-vscode-expired-thread-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }]);
  const saved = harness.store().create(fs.realpathSync(project));
  harness.store().update(saved.sessionId, { threadId: "expired-thread" });
  // This thread is intentionally absent from the mock app-server's thread registry.
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "Continue an expired thread." });

  assert.equal(harness.requests.some((request) => request.method === "thread/start" || request.method === "turn/start"), false);
  assert.equal(harness.store().load(saved.sessionId).threadId, "expired-thread");
  assert.equal(panel.last("session-state").state, "recovery-required");
  await panel.send({ type: "start-new-session" });
  const replacement = harness.store().findLatestByCwd(fs.realpathSync(project));
  assert.notEqual(replacement.sessionId, saved.sessionId);
  assert.equal(harness.store().load(saved.sessionId).threadId, "expired-thread");
  assert.match(panel.last("session-state").text, /previous saved session was retained/u);

  await panel.send({ type: "submit", text: "Start the explicitly selected new conversation." });
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, 1);
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(project)).threadId, "thread-1");
});

test("a missing thread id starts the first thread in the same saved Vesper session", async (t) => {
  const root = makeTempDirectory("vesper-vscode-no-thread-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }]);
  const saved = harness.store().create(fs.realpathSync(project));
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("session-state").state, "new");
  await panel.send({ type: "submit", text: "Start this saved session." });
  const updated = harness.store().load(saved.sessionId);
  assert.equal(updated.sessionId, saved.sessionId);
  assert.equal(updated.threadId, "thread-1");
  assert.equal(harness.requests.some((request) => request.method === "thread/resume"), false);
});

test("a removed workspace stays unavailable instead of falling back to another open folder", async (t) => {
  const root = makeTempDirectory("vesper-vscode-moved-project-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const folderA = { name: "Project A", uri: { fsPath: a } };
  const folderB = { name: "Project B", uri: { fsPath: b } };
  const harness = createHarness(t, [folderA, folderB]);
  const saved = harness.store().create(fs.realpathSync(a));
  harness.store().update(saved.sessionId, { threadId: "project-a-thread" });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  fs.rmdirSync(a);

  await panel.send({ type: "submit", text: "Inspect the unavailable project." });
  assert.equal(harness.state.children.length, 0);
  assert.equal(panel.last("session-state").state, "unavailable");
  assert.match(panel.last("input-error").text, /workspace folder is unavailable/u);
  assert.equal(harness.store().load(saved.sessionId).threadId, "project-a-thread");
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(b)), null);
});

test("old turn completion and old process output cannot overwrite a newer turn or selected project", async (t) => {
  const root = makeTempDirectory("vesper-vscode-stale-events-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const folderA = { name: "Project A", uri: { fsPath: a } };
  const folderB = { name: "Project B", uri: { fsPath: b } };
  const harness = createHarness(t, [folderA, folderB], { heldTurns: [2] });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "First turn." });
  const oldProcess = harness.state.children[0];

  const secondTurn = panel.send({ type: "submit", text: "Second turn." });
  await waitFor(() => panel.all("assistant-running").some((message) => message.turnId === "turn-2"));
  const secondRequestId = panel.all("assistant-start").at(-1).requestId;
  oldProcess.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "stale text" } });
  oldProcess.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } } });
  assert.equal(panel.all("assistant-done").filter((message) => message.requestId === secondRequestId).length, 0);
  assert.equal(panel.all("assistant-delta").some((message) => message.text === "stale text"), false);

  const active = harness.state.children.at(-1).activeTurns.get("turn-2");
  harness.state.children.at(-1).completeTurn(active, "completed", "Second turn answer.");
  await secondTurn;
  assert.equal(panel.all("assistant-done").some((message) => message.requestId === secondRequestId), true);

  harness.pick(folderB);
  await panel.send({ type: "select-project" });
  const projectBTurn = panel.send({ type: "submit", text: "Project B turn." });
  await waitFor(() => panel.last("assistant-done")?.requestId !== undefined);
  oldProcess.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "late old project" } });
  await projectBTurn;
  assert.equal(panel.all("assistant-delta").some((message) => message.text === "late old project"), false);
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(b)).threadId, "thread-2");
});

test("approval refusals and the read-only sandbox remain active in the persistent extension runtime", async (t) => {
  const root = makeTempDirectory("vesper-vscode-approvals-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], { approvalTurns: [1], heldTurns: [1] });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  const turn = panel.send({ type: "submit", text: "Please inspect safely." });
  await waitFor(() => harness.state.serverRequests.some((request) => request.method === "item/fileChange/requestApproval"));
  await waitFor(() => harness.state.clientResponses.some((response) => response.id === "approval-1"));
  const approvalResponse = harness.state.clientResponses.find((response) => response.id === "approval-1");
  assert.deepEqual(approvalResponse.result, { decision: "decline" });
  const start = harness.requests.find((request) => request.method === "thread/start");
  assert.equal(start.params.sandbox, "read-only");
  const active = harness.state.children[0].activeTurns.get("turn-1");
  harness.state.children[0].completeTurn(active, "completed", "Read-only answer.");
  await turn;
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(project)).threadId, "thread-1");
});

function createHarness(t, folders, options = {}) {
  const home = makeTempDirectory("vesper-vscode-home-");
  const previousHome = process.env.VESPER_HOME;
  process.env.VESPER_HOME = home;
  const state = {
    requests: [],
    serverRequests: [],
    clientResponses: [],
    children: [],
    threadCwds: new Map(),
    threadCount: 0,
    turnCount: 0,
    resumeFailures: options.resumeFailures || 0,
    heldTurns: new Set(options.heldTurns || []),
    approvalTurns: new Set(options.approvalTurns || []),
    statusForTurn: options.statusForTurn || (() => "completed"),
  };
  const originalExecFile = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
  const originalLoad = Module._load;
  const panels = [];
  const logs = [];
  let openCommand;
  let pickedFolder;

  class FakeChild extends EventEmitter {
    constructor(spawnOptions) {
      super();
      this.cwd = spawnOptions.cwd;
      this.killed = false;
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdout.setEncoding = () => {};
      this.stderr.setEncoding = () => {};
      this.activeTurns = new Map();
      this.stdin = { writable: true, write: (line) => this.receive(JSON.parse(line)) };
    }

    send(message) {
      this.stdout.emit("data", `${JSON.stringify(message)}\n`);
    }

    receive(message) {
      if (!message.method) {
        state.clientResponses.push(message);
        return;
      }
      state.requests.push(message);
      if (message.method === "initialize") {
        this.send({ id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        assert.equal(message.params.cwd, this.cwd);
        const threadId = `thread-${++state.threadCount}`;
        state.threadCwds.set(threadId, message.params.cwd);
        this.send({ id: message.id, result: { thread: { id: threadId }, cwd: message.params.cwd } });
      } else if (message.method === "thread/resume") {
        if (state.resumeFailures > 0) {
          state.resumeFailures -= 1;
          this.send({ id: message.id, error: { code: -32000, message: "saved thread is unavailable" } });
          return;
        }
        const cwd = state.threadCwds.get(message.params.threadId);
        if (!cwd) {
          this.send({ id: message.id, error: { code: -32000, message: "saved thread is unavailable" } });
          return;
        }
        this.send({ id: message.id, result: { thread: { id: message.params.threadId }, cwd } });
      } else if (message.method === "turn/start") {
        assert.equal(state.threadCwds.get(message.params.threadId), message.params.cwd);
        const turnId = `turn-${++state.turnCount}`;
        const active = { threadId: message.params.threadId, turnId, request: message };
        this.activeTurns.set(turnId, active);
        this.send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        queueMicrotask(() => {
          this.send({ method: "turn/started", params: { threadId: active.threadId, turn: { id: turnId, status: "inProgress" } } });
          if (state.approvalTurns.has(state.turnCount)) {
            const approval = {
              id: "approval-1",
              method: "item/fileChange/requestApproval",
              params: { threadId: active.threadId, turnId, itemId: "file-1" },
            };
            state.serverRequests.push(approval);
            this.send(approval);
          }
          if (!state.heldTurns.has(state.turnCount)) {
            this.completeTurn(active, state.statusForTurn(state.turnCount), `Answer ${state.turnCount}.`);
          }
        });
      } else if (message.method === "turn/interrupt") {
        const active = this.activeTurns.get(message.params.turnId);
        assert.deepEqual(message.params, { threadId: active?.threadId, turnId: active?.turnId });
        this.send({ id: message.id, result: {} });
        this.completeTurn(active, "interrupted", "");
      }
    }

    completeTurn(active, status, text) {
      if (!active) throw new Error("No matching fake server turn is active.");
      if (text) {
        this.send({
          method: "item/agentMessage/delta",
          params: { threadId: active.threadId, turnId: active.turnId, delta: text },
        });
      }
      this.send({
        method: "turn/completed",
        params: { threadId: active.threadId, turn: { id: active.turnId, status } },
      });
    }

    disconnect() {
      this.emit("close", 1, null);
    }

    kill() {
      this.killed = true;
    }
  }

  const vscode = {
    ViewColumn: { Beside: 2 },
    commands: {
      registerCommand: (_name, callback) => { openCommand = callback; return { dispose() {} }; },
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => logs.push(line), dispose() {} }),
      showWorkspaceFolderPick: async () => pickedFolder,
      activeTextEditor: undefined,
      createWebviewPanel: () => {
        const entry = { messages: [], html: "", receive: undefined, disposed: undefined };
        entry.webview = {
          cspSource: "vscode:",
          set html(value) { entry.html = value; },
          postMessage: (message) => { entry.messages.push(message); return Promise.resolve(true); },
          onDidReceiveMessage: (callback) => { entry.receive = callback; return { dispose() {} }; },
        };
        entry.onDidDispose = (callback) => { entry.disposed = callback; return { dispose() {} }; };
        entry.reveal = () => {};
        entry.close = () => entry.disposed?.();
        entry.send = (message) => entry.receive(message);
        entry.all = (type) => entry.messages.filter((message) => message.type === type);
        entry.last = (type) => entry.all(type).at(-1);
        panels.push(entry);
        return entry;
      },
    },
    workspace: {
      workspaceFolders: folders,
      getWorkspaceFolder: () => undefined,
    },
  };

  childProcess.execFile = (command, args, spawnOptions, callback) => {
    if (command === "git" && args[0] === "branch") callback(null, "feature/vscode\n", "");
    else callback(new Error("Unexpected local command."));
  };
  childProcess.spawn = (_command, _args, spawnOptions) => {
    const child = new FakeChild(spawnOptions);
    state.children.push(child);
    return child;
  };
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
  };

  let extension;
  let context;
  const extensionPath = path.resolve(__dirname, "..", "extension.js");
  const appClientPath = path.resolve(__dirname, "..", "app-server-client.js");
  function loadExtension() {
    delete require.cache[extensionPath];
    delete require.cache[appClientPath];
    extension = require(extensionPath);
    context = { subscriptions: [] };
    extension.activate(context);
  }
  loadExtension();

  t.after(() => {
    for (const entry of panels) entry.close();
    extension?.deactivate();
    for (const subscription of context?.subscriptions || []) subscription.dispose?.();
    if (previousHome === undefined) delete process.env.VESPER_HOME;
    else process.env.VESPER_HOME = previousHome;
    childProcess.execFile = originalExecFile;
    childProcess.spawn = originalSpawn;
    Module._load = originalLoad;
    delete require.cache[extensionPath];
    delete require.cache[appClientPath];
    fs.rmSync(home, { recursive: true, force: true });
  });

  return {
    home,
    state,
    requests: state.requests,
    logs,
    store: () => new SessionStore({ directory: path.join(home, "sessions") }),
    pick: (folder) => { pickedFolder = folder; },
    openPanel: () => {
      openCommand();
      const entry = panels.at(-1);
      return entry;
    },
    restartExtension: () => {
      for (const entry of panels) entry.close();
      extension.deactivate();
      for (const subscription of context.subscriptions) subscription.dispose?.();
      loadExtension();
    },
  };
}

function makeTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the expected extension state.");
}
