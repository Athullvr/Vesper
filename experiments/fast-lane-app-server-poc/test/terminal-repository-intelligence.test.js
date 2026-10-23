"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { TerminalFrontend } = require("../terminal-frontend");

class FakeLineIO {
  constructor() { this.interruptHandler = null; }
  async question() { return null; }
  onInterrupt(handler) { this.interruptHandler = handler; }
  cancelPending() {}
  close() {}
}

class FakeAppServer extends EventEmitter {
  constructor() { super(); this.turns = []; this.interrupted = false; }
  async runTurn(request) { this.turns.push(request); request.onDelta("Done."); return { status: "completed" }; }
  async interrupt() { this.interrupted = true; return true; }
  dispose() {}
}

function project(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-terminal-repo-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "src/index.js", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src", "index.js"), "function checkoutRoute(request) { return request; }\n");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return root;
}

function makeTerminal(root, appServer, sessionId = crypto.randomUUID()) {
  let text = "";
  const output = { write(value) { text += String(value); } };
  const terminal = new TerminalFrontend({ cwd: root, handlers: {}, appServer, input: {}, output, lineIO: new FakeLineIO(), sessionId });
  return { terminal, text: () => text };
}

test("code-oriented terminal tasks get local evidence without changing the route or bypassing Codex", async (t) => {
  const root = project(t);
  const appServer = new FakeAppServer();
  const { terminal, text } = makeTerminal(root, appServer);
  await terminal.handlePrompt("Implement the checkout route");
  assert.equal(appServer.turns.length, 1);
  assert.match(appServer.turns[0].prompt, /Vesper local repository evidence/u);
  assert.match(appServer.turns[0].prompt, /src\/index\.js/u);
  assert.match(text(), /\[Route · Codex · no local intent matched\]/u);
  assert.match(text(), /Vesper execution evidence/u);
  assert.match(text(), /Repository investigation: partial/u);
  assert.match(text(), /not run/u);
  await terminal.toolRuntime.dispose();
  terminal.executionProvider.dispose();
});

test("interactive :inspect prints a local report and never submits a provider task", async (t) => {
  const root = project(t);
  const appServer = new FakeAppServer();
  const { terminal, text } = makeTerminal(root, appServer);
  await terminal.handlePrompt(":inspect Trace checkoutRoute");
  assert.equal(appServer.turns.length, 0);
  assert.match(text(), /deterministic and read-only/u);
  assert.match(text(), /checkoutRoute/u);
  assert.match(text(), /no commands or scripts will run/u);
  await terminal.toolRuntime.dispose();
  terminal.executionProvider.dispose();
});

test("Ctrl+C during local investigation cancels before provider submission", async (t) => {
  const root = project(t);
  const appServer = new FakeAppServer();
  const { terminal, text } = makeTerminal(root, appServer);
  let resolveInspection;
  let interrupted = false;
  terminal.systemModel = {
    investigate: () => new Promise((resolve) => { resolveInspection = resolve; }),
    interrupt: async () => { interrupted = true; resolveInspection?.({ status: "cancelled", project: {}, findings: [], plan: [], incomplete: [], providerContext: "" }); return true; },
  };
  const task = terminal.handlePrompt("Implement the checkout route");
  await new Promise((resolve) => setImmediate(resolve));
  terminal.handleInterrupt();
  await task;
  assert.equal(interrupted, true);
  assert.equal(appServer.turns.length, 0);
  assert.match(text(), /provider task was not submitted/u);
  await terminal.toolRuntime.dispose();
  terminal.executionProvider.dispose();
});
