"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { LOCAL_INTENTS, createLocalResult } = require("../routing-core");
const { TerminalFrontend, safeStreamText } = require("../terminal-frontend");

class FakeLineIO {
  constructor(answers = []) {
    this.answers = [...answers];
    this.questions = [];
    this.interruptHandler = undefined;
    this.closed = false;
  }

  async question(prompt) {
    this.questions.push(prompt);
    return this.answers.length ? this.answers.shift() : null;
  }

  onInterrupt(handler) {
    this.interruptHandler = handler;
  }

  interrupt() {
    this.interruptHandler?.();
  }

  close() {
    this.closed = true;
  }
}

class FakeAppServer extends EventEmitter {
  constructor(runTurn) {
    super();
    this.runTurnImpl = runTurn;
    this.turns = [];
    this.interrupted = false;
  }

  async runTurn(request) {
    this.turns.push(request);
    return this.runTurnImpl(request, this);
  }

  async interrupt() {
    this.interrupted = true;
    return true;
  }

  dispose() {}
}

function makeFrontend({ answers, appServer, handlers, lineIO, onWrite } = {}) {
  const io = lineIO || new FakeLineIO(answers);
  let outputText = "";
  const output = { write: (text) => { outputText += String(text); onWrite?.(String(text)); } };
  const frontend = new TerminalFrontend({
    cwd: "/workspace/project",
    handlers: handlers || {
      [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => createLocalResult({
        intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
        status: "confirmed",
        value: { branch: "feature/phase-two" },
        summary: "Current Git branch: feature/phase-two",
        evidence: ["mock branch evidence"],
        source: { kind: "git" },
        freshness: { state: "observed" },
      }),
    },
    appServer: appServer || new FakeAppServer(async ({ onDelta }) => {
      onDelta("A streamed answer.");
      return { status: "completed" };
    }),
    output,
    lineIO: io,
  });
  return { frontend, io, output: () => outputText };
}

test("local question is labeled local, uses no app-server turn, and Codex fallback streams in the same terminal", async () => {
  const appServer = new FakeAppServer(async ({ prompt, cwd, onDelta }) => {
    assert.equal(prompt, "Explain a rebase in one sentence.");
    assert.equal(cwd, "/workspace/project");
    onDelta("A rebase replays commits.");
    return { status: "completed" };
  });
  const { frontend, output } = makeFrontend({
    answers: ["What Git branch am I on?", "Explain a rebase in one sentence.", ":quit"],
    appServer,
  });

  await frontend.run();
  const text = output();
  assert.match(text, /Vesper local · confirmed · no Codex turn/u);
  assert.match(text, /local_exact_match\/current_git_branch/u);
  assert.match(text, /Current Git branch: feature\/phase-two/u);
  assert.match(text, /A rebase replays commits\./u);
  assert.match(text, /Codex · completed/u);
  assert.equal(appServer.turns.length, 1);
});

test("initialization failures and timeouts are visible and the input loop recovers", async () => {
  let calls = 0;
  const appServer = new FakeAppServer(async () => {
    calls += 1;
    if (calls === 1) throw new Error("mock app-server initialization failure");
    if (calls === 2) return { status: "timeout" };
    return { status: "completed" };
  });
  const { frontend, output } = makeFrontend({ answers: ["Build a website", "Explain Git refs", "Try another request", ":quit"], appServer });

  await frontend.run();
  assert.match(output(), /Codex error .* mock app-server initialization failure/u);
  assert.match(output(), /Codex · timed out and interrupted/u);
  assert.match(output(), /Codex · completed/u);
  assert.equal(appServer.turns.length, 3);
});

test("insufficient evidence and handler failure remain local uncertainty without any Codex turn", async () => {
  const appServer = new FakeAppServer(async () => assert.fail("Local uncertainty must not silently invoke Codex"));
  const { frontend, output } = makeFrontend({
    appServer,
    answers: ["What is the current Git branch?", "Show working-tree status.", ":quit"],
    handlers: {
      [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => createLocalResult({
        intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH, status: "unknown", summary: "Detached checkout.",
        evidence: ["No branch name."], source: { kind: "git" }, freshness: { state: "observed" },
      }),
      [LOCAL_INTENTS.WORKING_TREE_STATUS]: async () => { throw new Error("private failure"); },
    },
  });
  await frontend.run();
  assert.equal(appServer.turns.length, 0);
  assert.match(output(), /Vesper local · unknown/u);
  assert.match(output(), /Vesper local · unavailable/u);
  assert.doesNotMatch(output(), /confirmed|private failure|Codex · completed/u);
});

test("failed and interrupted fallback turns never print a completed or confirmed local answer", async () => {
  let calls = 0;
  const appServer = new FakeAppServer(async ({ onDelta }) => {
    onDelta("Partial output.");
    if (++calls === 1) throw new Error("Turn failed");
    return { status: "interrupted" };
  });
  const { frontend, output, io } = makeFrontend({
    appServer, answers: ["Inspect the repository", "Analyze the bug", ":quit"],
  });
  await frontend.run();
  assert.match(output(), /Codex error .* Turn failed/u);
  assert.match(output(), /Codex · interrupted/u);
  assert.doesNotMatch(output(), /Codex · completed|Vesper local/u);
  assert.equal(io.questions.length, 3);
});

test("Ctrl+C requests interruption, reports terminal status, and ends the current frontend run", async () => {
  let io;
  const appServer = new FakeAppServer(async () => new Promise((resolve) => {
    queueMicrotask(() => {
      io.interrupt();
      resolve({ status: "interrupted" });
    });
  }));
  const setup = makeFrontend({ answers: ["Build a website", ":quit"], appServer });
  io = setup.io;

  await setup.frontend.run();
  assert.equal(appServer.interrupted, true);
  assert.match(setup.output(), /interrupting Codex/u);
  assert.match(setup.output(), /Codex · interrupted/u);
  assert.equal(setup.io.closed, true);
});

test("approval prompts require an explicit yes and only grant one-time protocol decisions", async () => {
  const { frontend: accepting, output: acceptingOutput } = makeFrontend({ answers: ["yes"] });
  const commandResult = await accepting.requestApproval("item/commandExecution/requestApproval", {
    command: "printf '\u001b[31munsafe?\u001b[0m'",
    cwd: "/workspace/project",
    additionalPermissions: { network: { enabled: true } },
    networkApprovalContext: { host: "example.test", protocol: "https" },
    availableDecisions: ["accept", "decline"],
  });
  assert.deepEqual(commandResult, { decision: "accept" });
  assert.match(acceptingOutput(), /\\x1b/u);
  assert.match(acceptingOutput(), /example\.test/u);
  assert.match(acceptingOutput(), /Additional permissions requested/u);
  assert.equal(acceptingOutput().includes("\u001b"), false);

  const { frontend: declining } = makeFrontend({ answers: ["no"] });
  assert.deepEqual(await declining.requestApproval("item/fileChange/requestApproval", { reason: "write requested" }), { decision: "decline" });

  const { frontend: permissionApproval } = makeFrontend({ answers: ["yes"] });
  assert.deepEqual(await permissionApproval.requestApproval("item/permissions/requestApproval", {
    permissions: { network: { enabled: true } },
    reason: "network access required",
  }), { permissions: { network: { enabled: true } }, scope: "turn" });

  const { frontend: permissionDeny } = makeFrontend({ answers: [""] });
  assert.deepEqual(await permissionDeny.requestApproval("item/permissions/requestApproval", {
    permissions: { network: { enabled: true } },
  }), { permissions: {}, scope: "turn" });

  const { frontend: legacyDeny } = makeFrontend({ answers: ["no"] });
  assert.deepEqual(await legacyDeny.requestApproval("execCommandApproval", {
    command: ["npm", "test"],
    cwd: "/workspace/project",
  }), { decision: { denied: { rejection: "User declined the request." } } });

  const { frontend: legacyAccept } = makeFrontend({ answers: ["yes"] });
  assert.deepEqual(await legacyAccept.requestApproval("applyPatchApproval", { reason: "reviewed patch" }), { decision: "approved" });
});

test("a command cannot be approved when the server does not offer the one-time accept decision", async () => {
  const { frontend, io } = makeFrontend({ answers: ["yes"] });
  const result = await frontend.requestApproval("item/commandExecution/requestApproval", {
    command: "dangerous-looking-command",
    availableDecisions: ["decline", "cancel"],
  });
  assert.deepEqual(result, { decision: "decline" });
  assert.equal(io.questions.length, 0);
});

test("approval details that exceed the review limit are declined without asking", async () => {
  const { frontend, io } = makeFrontend({ answers: ["yes"] });
  const result = await frontend.requestApproval("item/commandExecution/requestApproval", {
    command: "x".repeat(9_000),
    availableDecisions: ["accept", "decline"],
  });
  assert.deepEqual(result, { decision: "decline" });
  assert.equal(io.questions.length, 0);
});

test("streamed model text cannot inject terminal control sequences", () => {
  assert.equal(safeStreamText("answer\u001b[2J\rnext"), "answer\\x1b[2J\\rnext");
});
