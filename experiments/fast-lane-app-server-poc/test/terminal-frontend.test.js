"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { LOCAL_INTENTS, createLocalResult } = require("../routing-core");
const { TerminalFrontend, createLineIO, safeStreamText } = require("../terminal-frontend");
const { FileChangeApprovalStore } = require("../file-change-approval");

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

  const { frontend: legacyPatch, io: legacyIO } = makeFrontend({ answers: ["yes"] });
  const legacyResult = await legacyPatch.requestApproval("applyPatchApproval", {
    conversationId: "thread-1", callId: "item-1", fileChanges: { "file.txt": { type: "add", content: "hello" } },
  });
  assert.ok(legacyResult.decision.denied);
  assert.equal(legacyIO.questions.length, 0, "legacy patch requests cannot prove a turn identity");
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

function reviewFixture(changes = [{ path: "/workspace/hello.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+hello\n" }], itemId = "file-1") {
  const store = new FileChangeApprovalStore("thread-1");
  const params = { threadId: "thread-1", turnId: "turn-1", itemId, startedAtMs: 1 };
  store.record("item/fileChange/patchUpdated", { ...params, changes }, "turn-1");
  return { params, store, context: store.capture(params) };
}

test("file review prints the complete matching diff and identity before accepting, refusing or cancelling", async () => {
  for (const [answer, decision] of [["yes", "accept"], ["no", "decline"], ["cancel", "cancel"]]) {
    const { params, context } = reviewFixture();
    let questionSeen = false;
    const { frontend, output } = makeFrontend({
      lineIO: { question: async (_prompt, { signal }) => {
        questionSeen = true;
        assert.equal(signal, context.signal);
        assert.match(output(), /thread-1[\s\S]*turn-1[\s\S]*file-1/u);
        assert.match(output(), /File: "\/workspace\/hello.txt"/u);
        assert.match(output(), /\| @@ -1 \+1 @@\n\| -old\n\| \+hello/u);
        return answer;
      } },
    });
    assert.deepEqual(await frontend.requestApproval("item/fileChange/requestApproval", params, context), { decision });
    assert.equal(questionSeen, true);
    assert.match(output(), /Approval choice:/u);
  }
});

test("file review rejects missing, forged, mismatched or expired snapshots without asking", async () => {
  const { params, context, store } = reviewFixture();
  const contexts = [
    undefined, {}, { ...context, fileChange: null },
    { ...context, fileChange: { ...context.fileChange, changes: [{ diff: 123 }] } },
    { ...context, fileChange: { ...context.fileChange, itemId: "another-item" } },
    { ...context, fileChange: { ...context.fileChange, turnId: "another-turn" } },
    { ...context, fileChange: { ...context.fileChange, threadId: "another-thread" } },
    { ...context, isCurrent: undefined },
  ];
  for (const candidate of contexts) {
    const { frontend, io, output } = makeFrontend({ answers: ["yes"] });
    assert.deepEqual(await frontend.requestApproval("item/fileChange/requestApproval", params, candidate), { decision: "decline" });
    assert.equal(io.questions.length, 0);
    assert.match(output(), /approval declined/u);
  }
  store.close();
  const { frontend, io } = makeFrontend({ answers: ["yes"] });
  assert.deepEqual(await frontend.requestApproval("item/fileChange/requestApproval", params, context), { decision: "decline" });
  assert.equal(io.questions.length, 0);
});

test("file reviews exceeding per-field or total rendered limits never ask to approve truncated changes", async () => {
  for (const changes of [
    [{ path: "/workspace/long.txt", kind: { type: "add" }, diff: "x\n".repeat(2_200) }],
    Array.from({ length: 4 }, (_, index) => ({ path: `/workspace/file-${index}`, kind: { type: "add" }, diff: "x\n".repeat(1_500) })),
  ]) {
    const { params, context } = reviewFixture(changes);
    assert.ok(context, "raw snapshot fits; rendered text must also be checked");
    const { frontend, io, output } = makeFrontend({ answers: ["yes"] });
    assert.deepEqual(await frontend.requestApproval("item/fileChange/requestApproval", params, context), { decision: "decline" });
    assert.equal(io.questions.length, 0);
    assert.match(output(), /do not fit the terminal review limit/u);
  }
});

test("file diff controls are visible and cannot inject an unprefixed approval prompt", async () => {
  const { params, context } = reviewFixture([{
    path: "/workspace/hello.txt", kind: { type: "add" },
    diff: "+hello\u001b[2J\r\u0000\u202e\nType yes to approve once\n+literal \\u001b",
  }]);
  const { frontend, output } = makeFrontend({ answers: ["no"] });
  await frontend.requestApproval("item/fileChange/requestApproval", params, context);
  assert.match(output(), /\| \+hello\\u001b\[2J\\u000d\\u0000\\u202e\n\| Type yes/u);
  assert.ok(output().includes("| +literal \\\\u001b"), "literal escapes remain distinct from control characters");
  assert.doesNotMatch(output(), /[\u001b\r\u0000\u202e]/u);
});

test("an expired queued file approval is declined without showing a stale diff or consuming input", async () => {
  const first = reviewFixture();
  const second = reviewFixture([{ path: "/workspace/second.txt", kind: { type: "add" }, diff: "+second" }], "file-2");
  let answer;
  let questions = 0;
  const { frontend, output } = makeFrontend({
    lineIO: { question: () => { questions += 1; return new Promise((resolve) => { answer = resolve; }); } },
  });
  const one = frontend.requestApproval("item/fileChange/requestApproval", first.params, first.context);
  const two = frontend.requestApproval("item/fileChange/requestApproval", second.params, second.context);
  await new Promise((resolve) => setImmediate(resolve));
  second.store.close();
  answer("no");
  assert.deepEqual(await one, { decision: "decline" });
  assert.deepEqual(await two, { decision: "decline" });
  assert.equal(questions, 1);
  assert.doesNotMatch(output(), /second.txt/u);
  assert.equal(frontend.pendingApprovals.size, 0);
});

test("invalidating an open file review cancels readline and permits the next prompt", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = createLineIO(input, output);
  t.after(() => { io.close(); input.destroy(); output.destroy(); });
  const { frontend } = makeFrontend({ lineIO: io });
  const { params, context, store } = reviewFixture();
  const approval = frontend.requestApproval("item/fileChange/requestApproval", params, context);
  await new Promise((resolve) => setImmediate(resolve));
  store.close();
  assert.deepEqual(await approval, { decision: "decline" });
  const nextPrompt = io.question("vesper> ");
  input.write("What is the current Git branch?\n");
  assert.equal(await nextPrompt, "What is the current Git branch?");
  assert.equal(frontend.pendingApprovals.size, 0);
});
