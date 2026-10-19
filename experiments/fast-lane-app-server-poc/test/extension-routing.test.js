"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const childProcess = require("node:child_process");
const path = require("node:path");

test("extension keeps local questions off Codex and streams fallback events through the existing panel bridge", async (t) => {
  const logs = [];
  const panelMessages = [];
  const protocolMethods = [];
  let spawnCount = 0;
  let openPanel;
  let receivePanelMessage;

  const originalExecFile = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
  const originalLoad = Module._load;

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.killed = false;
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdout.setEncoding = () => {};
      this.stderr.setEncoding = () => {};
      this.stdin = { writable: true, write: (line) => this.handleRequest(JSON.parse(line)) };
    }

    send(message) {
      this.stdout.emit("data", `${JSON.stringify(message)}\n`);
    }

    handleRequest(message) {
      if (message.method) protocolMethods.push(message.method);
      if (message.method === "initialize") this.send({ id: message.id, result: {} });
      if (message.method === "thread/start") this.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        assert.equal(message.params.input[0].text, "Explain a rebase in one sentence.");
        this.send({ id: message.id, result: {} });
        queueMicrotask(() => {
          this.send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
          this.send({ method: "item/agentMessage/delta", params: { delta: "A rebase " } });
          this.send({ method: "item/agentMessage/delta", params: { delta: "replays commits." } });
          this.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
        });
      }
    }

    kill() {
      this.killed = true;
    }
  }

  childProcess.execFile = (command, args, options, callback) => {
    assert.equal(command, "git");
    assert.deepEqual(args, ["branch", "--show-current"]);
    callback(null, "feature/routing\n", "");
  };
  childProcess.spawn = () => {
    spawnCount += 1;
    return new FakeChild();
  };

  const vscode = {
    ViewColumn: { Beside: 2 },
    commands: {
      registerCommand: (_name, callback) => {
        openPanel = callback;
        return { dispose() {} };
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => logs.push(line), dispose() {} }),
      createWebviewPanel: () => ({
        webview: {
          cspSource: "vscode:",
          set html(_html) {},
          postMessage: (message) => { panelMessages.push(message); return Promise.resolve(true); },
          onDidReceiveMessage: (callback) => { receivePanelMessage = callback; return { dispose() {} }; },
        },
        onDidDispose() {},
        reveal() {},
      }),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getWorkspaceFolder: () => undefined,
    },
  };

  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  const extensionPath = path.resolve(__dirname, "..", "extension.js");
  delete require.cache[extensionPath];
  const extension = require(extensionPath);
  Module._load = originalLoad;
  const context = { subscriptions: [] };

  t.after(() => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    extension.deactivate();
    childProcess.execFile = originalExecFile;
    childProcess.spawn = originalSpawn;
    Module._load = originalLoad;
    delete require.cache[extensionPath];
  });

  extension.activate(context);
  openPanel();
  await receivePanelMessage({ type: "ready" });
  await receivePanelMessage({ type: "submit", text: "What Git branch am I on?" });

  const localAnswer = panelMessages.find((message) => message.type === "local-answer");
  assert.equal(localAnswer.text, "Current Git branch: feature/routing");
  assert.equal(localAnswer.result.intent, "current_git_branch");
  assert.equal(spawnCount, 0);
  assert.equal(protocolMethods.includes("thread/start"), false);
  assert.equal(protocolMethods.includes("turn/start"), false);

  await receivePanelMessage({ type: "submit", text: "Explain a rebase in one sentence." });
  const deltas = panelMessages.filter((message) => message.type === "assistant-delta").map((message) => message.text);
  assert.equal(deltas.join(""), "A rebase replays commits.");
  assert.equal(panelMessages.some((message) => message.type === "assistant-done"), true);
  assert.equal(spawnCount, 1);
  assert.deepEqual(protocolMethods.filter((method) => method === "thread/start" || method === "turn/start"), ["thread/start", "turn/start"]);
  assert.equal(logs.some((line) => line.includes("What Git branch am I on?")), false);
  assert.equal(logs.some((line) => line.includes("A rebase replays commits.")), false);
  assert.equal(logs.some((line) => line.includes("reason=local_exact_match")), true);
  assert.equal(logs.some((line) => line.includes("reason=codex_fallback")), true);
  assert.equal(logs.some((line) => line.includes("local_routes=1 fallback_routes=1")), true);
});
