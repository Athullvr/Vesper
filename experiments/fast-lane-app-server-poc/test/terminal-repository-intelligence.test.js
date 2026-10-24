"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { TerminalFrontend } = require("../terminal-frontend");
const { createExecutionProvider } = require("../execution-provider");

const COMPLEX_TASK = "Trace checkout from its route through the service and validation layers, then compare how related tests exercise error handling and explain which evidence is missing across the request path.";

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
  assert.match(appServer.turns[0].prompt, /Cross-file candidate search/u);
  assert.match(appServer.turns[0].prompt, /Grounded implementation planning/u);
  assert.match(text(), /\[Route · Codex · no local intent matched\]/u);
  assert.match(text(), /Vesper execution evidence/u);
  assert.match(text(), /Change impact:/u);
  assert.match(text(), /Repository investigation: partial/u);
  assert.match(text(), /not run/u);
  await terminal.toolRuntime.dispose();
  terminal.executionProvider.dispose();
});

test("interactive :impact renders the bounded impact report without submitting a task", async (t) => {
  const root = project(t);
  const appServer = new FakeAppServer();
  const { terminal, text } = makeTerminal(root, appServer);
  await terminal.handlePrompt(":impact checkoutRoute");
  assert.equal(appServer.turns.length, 0);
  assert.match(text(), /Intent: impact/u);
  assert.match(text(), /Cross-file candidate discovery/u);
  assert.match(text(), /Change impact summary/u);
  await terminal.toolRuntime.dispose();
  terminal.executionProvider.dispose();
});

test("interactive :inspect prints a local report and never submits a provider task", async (t) => {
  const root = project(t);
  const appServer = new FakeAppServer();
  const { terminal, text } = makeTerminal(root, appServer);
  await terminal.handlePrompt(":inspect Trace checkoutRoute");
  assert.equal(appServer.turns.length, 0);
  assert.match(text(), /read-only/u);
  assert.match(text(), /checkoutRoute/u);
  assert.match(text(), /no commands or scripts will run/u);
  await terminal.toolRuntime.dispose();
  terminal.executionProvider.dispose();
});

test("terminal :inspect uses the shared model-assisted System Model only for complex questions", async (t) => {
  const root = project(t);
  const priorAssisted = process.env.VESPER_SYSTEM_MODEL_ASSISTED;
  const priorLocalOnly = process.env.VESPER_LOCAL_ONLY;
  process.env.VESPER_SYSTEM_MODEL_ASSISTED = "1";
  delete process.env.VESPER_LOCAL_ONLY;
  t.after(() => {
    if (priorAssisted === undefined) delete process.env.VESPER_SYSTEM_MODEL_ASSISTED;
    else process.env.VESPER_SYSTEM_MODEL_ASSISTED = priorAssisted;
    if (priorLocalOnly === undefined) delete process.env.VESPER_LOCAL_ONLY;
    else process.env.VESPER_LOCAL_ONLY = priorLocalOnly;
  });
  const calls = [];
  const provider = createExecutionProvider({
    providerId: "openai-chat-completions",
    environment: { OPENAI_API_KEY: "fixture-key", VESPER_OPENAI_MODEL: "fixture-model", VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1" },
    conversationDirectory: path.join(root, ".provider-conversations"),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ sufficientEvidence: true, action: null, reason: "The existing evidence is sufficient to stop.", unresolvedQuestions: [], hypotheses: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  let text = "";
  const terminal = new TerminalFrontend({ cwd: root, handlers: {}, executionProvider: provider, input: {},
    output: { write(value) { text += String(value); } }, lineIO: new FakeLineIO(), sessionId: crypto.randomUUID() });
  await terminal.handlePrompt(":inspect Trace checkoutRoute");
  assert.equal(calls.length, 0);
  assert.match(text, /deterministic-fast-path/u);

  await terminal.handlePrompt(`:inspect ${COMPLEX_TASK}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "fixture-model");
  assert.equal(calls[0].body.stream, false);
  assert.match(text, /Adaptive planning: model-assisted · 1 model calls/u);
  assert.match(text, /Evidence coverage:/u);
  assert.equal(provider.getState().conversationId, null, "local inspection does not start or save a provider conversation");
  await terminal.toolRuntime.dispose();
  provider.dispose();
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
