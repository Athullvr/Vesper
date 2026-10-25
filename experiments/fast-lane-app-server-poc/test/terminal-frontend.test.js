"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { LOCAL_INTENTS, RouteMetrics, createLocalResult } = require("../routing-core");
const { TerminalFrontend, createLineIO, renderRoutingSummary, safeStreamText, renderTurnDiffActivity, MAX_TURN_DIFF_RENDERED_LENGTH } = require("../terminal-frontend");
const { FileChangeApprovalStore } = require("../file-change-approval");
const { AppServerClient } = require("../app-server-client");

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

class FakeCodexProcess extends EventEmitter {
  constructor({ onTurnStart = () => {} } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
    this.requests = [];
    this.turnCount = 0;
    this.onTurnStart = onTurnStart;
    this.onClientResponse = () => {};
    this.killed = false;
    this.stdin = { writable: true, write: (line) => this.receive(JSON.parse(line)) };
  }

  receive(message) {
    this.requests.push(message);
    if (!Object.hasOwn(message, "id")) return;
    if (message.method === "initialize") this.respond(message.id, { codexHome: "/mock", platformFamily: "unix", platformOs: "linux", userAgent: "mock" });
    else if (message.method === "thread/start") this.respond(message.id, { thread: { id: "thread-1" }, cwd: message.params.cwd });
    else if (message.method === "thread/resume") this.respond(message.id, { thread: { id: message.params.threadId }, cwd: "/workspace/project" });
    else if (message.method === "turn/start") {
      this.turnCount += 1;
      this.cwd = message.params.cwd;
      this.respond(message.id, { turn: { id: `turn-${this.turnCount}`, items: [], status: "inProgress" } });
      this.onTurnStart(message, this);
    } else if (message.method === "turn/interrupt") this.respond(message.id, {});
    else this.onClientResponse(message, this);
  }

  respond(id, result) { this.send({ id, result }); }
  send(message) { this.stdout.emit("data", `${JSON.stringify(message)}\n`); }
  requestFromServer(id, method, params) { this.send({ id, method, params }); }
  kill() { this.killed = true; }

  completeTurn(startRequest, status, text = "") {
    const turnId = `turn-${this.turnCount}`;
    queueMicrotask(() => {
      this.send({ method: "turn/started", params: { threadId: startRequest.params.threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      if (text) this.send({ method: "item/agentMessage/delta", params: { threadId: startRequest.params.threadId, turnId, itemId: "answer-1", delta: text } });
      this.send({ method: "turn/completed", params: { threadId: startRequest.params.threadId, turn: { id: turnId, status, items: [] } } });
    });
  }
}

function makeFrontend({ answers, appServer, handlers, lineIO, onWrite, metrics, onTask, onWorkspaceCommand, routingDiagnostics = false } = {}) {
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
    metrics,
    onTask,
    onWorkspaceCommand,
    routingDiagnostics,
  });
  return { frontend, io, output: () => outputText };
}

test("terminal renders controlled workflow progress and the evidence report without unsafe control text", () => {
  const { frontend, output } = makeFrontend();
  frontend.handleExecutionEvent({ type: "task-progress", kind: "workflow-stage", stage: "planning" });
  frontend.handleExecutionEvent({ type: "task-progress", kind: "workflow-stage", stage: "approval" });
  frontend.handleExecutionEvent({ type: "task-progress", kind: "workflow-report", report: "Vesper execution evidence\nTests/builds: not run.\u001b[31m" });
  assert.match(output(), /planning from inspected evidence/u);
  assert.match(output(), /waiting for fresh one-time approval/u);
  assert.match(output(), /Vesper execution evidence\nTests\/builds: not run/u);
  assert.doesNotMatch(output(), /\u001b\[31m/u);
});

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
  assert.match(text, /\[Route · local · current_git_branch · handler status confirmed\]/u);
  assert.match(text, /Current Git branch: feature\/phase-two/u);
  assert.match(text, /\[Route · Codex · no local intent matched\]/u);
  assert.match(text, /\[Codex · connecting\]/u);
  assert.match(text, /A rebase replays commits\./u);
  assert.match(text, /Codex provider response completed · workflow completed/u);
  assert.equal(appServer.turns.length, 1);
});

test(":routing displays zero activity without dispatching work or updating session activity", async () => {
  let taskCalls = 0;
  let workspaceCommandCalls = 0;
  const appServer = new FakeAppServer(async () => assert.fail(":routing must not call Codex."));
  const setup = makeFrontend({
    answers: [":routing", ":quit"],
    appServer,
    metrics: new RouteMetrics(),
    onTask: () => { taskCalls += 1; },
    onWorkspaceCommand: () => { workspaceCommandCalls += 1; return false; },
  });

  await setup.frontend.run();
  const text = setup.output();
  assert.match(text, /:routing for session counts/u);
  assert.match(text, /Total tasks routed: 0/u);
  assert.match(text, /Local handled: 0/u);
  assert.match(text, /Local insufficient: 0/u);
  assert.match(text, /Local unavailable: 0/u);
  assert.match(text, /Codex delegated: 0/u);
  assert.match(text, /Codex not dispatched: 0/u);
  assert.equal(taskCalls, 0);
  assert.equal(workspaceCommandCalls, 0);
  assert.equal(appServer.turns.length, 0);
});

test(":routing output is bounded, deterministic, and contains aggregate counts only", () => {
  const metrics = new RouteMetrics();
  metrics.record({ route: "codex" }, 0, { routingDecision: {
    outcome: "codex_delegated",
    reasonCode: "codex_fallback",
    prompt: "private prompt phrase",
    response: "private model response",
    evidence: ["private evidence payload"],
    credentials: "API_KEY=private-token",
    rawError: "private handler error",
  } });

  const summary = renderRoutingSummary(metrics);
  assert.equal(summary, renderRoutingSummary(metrics));
  assert.ok(summary.length < 1_600);
  assert.match(summary, /Total tasks routed: 1/u);
  assert.match(summary, /Codex delegated: 1/u);
  assert.match(summary, /codex_fallback: 1/u);
  assert.doesNotMatch(summary, /private prompt phrase|private model response|private evidence payload|private-token|private handler error/u);
  assert.doesNotMatch(summary, /\u001b/u);

  const missing = renderRoutingSummary(null);
  assert.match(missing, /unavailable/u);
  const partial = renderRoutingSummary({ snapshot: () => ({ routingDecisionCount: 1, routingOutcomes: { codex_delegated: 1 } }) });
  assert.match(partial, /Total tasks routed: 1/u);
  assert.match(partial, /Codex delegated: 1/u);
  assert.match(partial, /Local handled: —/u);
  assert.match(partial, /codex_fallback: —/u);
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
  assert.match(output(), /Codex error .* provider reported that the task failed/u);
  assert.doesNotMatch(output(), /mock app-server initialization failure/u);
  assert.match(output(), /Codex · timed out and interrupted/u);
  assert.match(output(), /Codex provider response completed · workflow completed/u);
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
  assert.match(output(), /\[Route · local · current_git_branch · evidence unknown\]/u);
  assert.match(output(), /\[Route · local · working_tree_status · unavailable; no Codex fallback\]/u);
  assert.doesNotMatch(output(), /confirmed|private failure|Codex · completed/u);
});

test("optional routing diagnostics are sanitized and omit the submitted prompt", async () => {
  const prompt = "Build a website with API_KEY=diagnostic-secret";
  const { frontend, output } = makeFrontend({ answers: [prompt, ":quit"], routingDiagnostics: true });
  await frontend.run();
  assert.match(output(), /\[Routing diagnostic\]/u);
  assert.match(output(), /"reasonCode":"codex_fallback"/u);
  assert.match(output(), /"outcome":"codex_delegated"/u);
  assert.doesNotMatch(output(), /diagnostic-secret|API_KEY=|Build a website/u);
});

test("non-TTY route indicators stay concise across repeated local requests", async () => {
  const answers = [...Array(100).fill("What Git branch am I on?"), ":quit"];
  const appServer = new FakeAppServer(async () => assert.fail("Local requests must not call Codex."));
  const { frontend, output } = makeFrontend({ answers, appServer });
  await frontend.run();
  const text = output();
  assert.equal((text.match(/\[Route · local · current_git_branch · handler status confirmed\]/gu) || []).length, 100);
  assert.ok(text.length < 16_000, `non-TTY output was ${text.length} characters`);
  assert.doesNotMatch(text, /\u001b|\[Routing diagnostic\]/u);
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
  assert.match(output(), /Codex error .* provider reported that the task failed/u);
  assert.doesNotMatch(output(), /Turn failed/u);
  assert.match(output(), /Codex · interrupted/u);
  assert.doesNotMatch(output(), /Codex · completed|Vesper local/u);
  assert.equal(io.questions.length, 3);
});

test("Codex deltas reach the terminal before the turn completes", async () => {
  let setup;
  const appServer = new FakeAppServer(async ({ onDelta }) => {
    onDelta("The streamed answer ");
    assert.match(setup.output(), /The streamed answer /u);
    onDelta("continues here.");
    return { status: "completed" };
  });
  setup = makeFrontend({ appServer, answers: ["Explain a design", ":quit"] });

  await setup.frontend.run();

  assert.match(setup.output(), /The streamed answer continues here\./u);
  assert.ok(setup.output().indexOf("continues here.") < setup.output().indexOf("[Codex provider response completed · workflow completed"));
});

test("Ctrl+C interrupts the active turn and the workspace accepts a later task", async () => {
  let io;
  let turnCount = 0;
  const appServer = new FakeAppServer(async ({ onDelta }) => {
    turnCount += 1;
    if (turnCount === 1) {
      return new Promise((resolve) => queueMicrotask(() => {
        io.interrupt();
        resolve({ status: "interrupted" });
      }));
    }
    onDelta("The next task still works.");
    return { status: "completed" };
  });
  const setup = makeFrontend({ answers: ["Build a website", "Explain Git refs", ":quit"], appServer });
  io = setup.io;

  await setup.frontend.run();
  assert.equal(appServer.interrupted, true);
  assert.match(setup.output(), /interrupting this turn/u);
  assert.match(setup.output(), /Codex · interrupted/u);
  assert.match(setup.output(), /The next task still works\./u);
  assert.match(setup.output(), /Codex provider response completed · workflow completed/u);
  assert.equal(turnCount, 2);
  assert.equal(setup.io.closed, true);
});

test("approval prompts require an explicit yes and only grant one-time protocol decisions", async () => {
  const { frontend: accepting, output: acceptingOutput } = makeFrontend({ answers: ["yes"] });
  const commandResult = await accepting.requestApproval("item/commandExecution/requestApproval", {
    command: "printf '\u001b[31munsafe?\u001b[0m' API_KEY=supersecret",
    cwd: "/workspace/project",
    additionalPermissions: { network: { enabled: true } },
    networkApprovalContext: { host: "example.test", protocol: "https" },
    availableDecisions: ["accept", "decline"],
  });
  assert.deepEqual(commandResult, { decision: "accept" });
  assert.match(acceptingOutput(), /\\x1b/u);
  assert.match(acceptingOutput(), /API_KEY=\[redacted\]/u);
  assert.doesNotMatch(acceptingOutput(), /supersecret/u);
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
  assert.equal(safeStreamText("API_KEY=stream-secret"), "API_KEY=[redacted]");
  assert.equal(safeStreamText("safe\u202e text"), "safe\\u202e text");
});

test("streamed responses redact secrets and stop at a bounded terminal output size", async () => {
  const appServer = new FakeAppServer(async ({ onDelta }) => {
    onDelta("API_KEY=");
    onDelta("stream-secret\n");
    onDelta("-----BEGIN PRI");
    onDelta("VATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\n");
    onDelta("sk-proj-1234");
    onDelta("56789012\n");
    onDelta("https://user:");
    onDelta("url-password@host.test \n");
    onDelta("x".repeat(300_000));
    return { status: "completed" };
  });
  const { frontend, output } = makeFrontend({ appServer, answers: ["Explain the project", ":quit"] });
  await frontend.run();
  assert.match(output(), /API_KEY=\[redacted\]/u);
  assert.doesNotMatch(output(), /stream-secret/u);
  assert.doesNotMatch(output(), /private-key-material/u);
  assert.doesNotMatch(output(), /sk-proj-123456789012/u);
  assert.doesNotMatch(output(), /url-password/u);
  assert.match(output(), /Streamed response truncated at the terminal output limit/u);
  assert.ok(output().length < 260_000);
});

test("app-server command item and output notifications render bounded activity through the terminal", async () => {
  const server = new FakeCodexProcess({ onTurnStart: (request, current) => {
    const params = {
      threadId: "thread-1", turnId: "turn-1", startedAtMs: 1,
      item: {
        type: "commandExecution", id: "command-1", command: "npm test", cwd: "/workspace/project",
        status: "inProgress", exitCode: null, aggregatedOutput: null,
      },
    };
    current.send({ method: "item/started", params });
    current.send({ method: "item/commandExecution/outputDelta", params: {
      threadId: params.threadId, turnId: params.turnId, itemId: params.item.id, delta: "all checks passed\n",
    } });
    current.send({ method: "item/completed", params: {
      ...params, completedAtMs: 2,
      item: { ...params.item, status: "completed", exitCode: 0, aggregatedOutput: "all checks passed\n" },
    } });
    current.completeTurn(request, "completed", "Finished.");
  } });
  const appServer = new AppServerClient({
    spawnProcess: () => server,
  });
  const { frontend, output } = makeFrontend({ appServer, answers: ["Inspect the test command", ":quit"] });
  await frontend.run();

  assert.match(output(), /Codex command #1 · execution started/u);
  assert.match(output(), /Command: npm test/u);
  assert.match(output(), /Working directory: \/workspace\/project/u);
  assert.match(output(), /Codex command #1 · execution completed · exit code 0/u);
  assert.match(output(), /\| all checks passed/u);
  appServer.dispose();
});

test("file-change evidence renders bounded summaries outside approval prompts and never claims a disk write", async () => {
  const server = new FakeCodexProcess({ onTurnStart: (request, current) => {
    setImmediate(() => {
      current.send({ method: "item/started", params: {
        threadId: request.params.threadId,
        turnId: "turn-1",
        startedAtMs: 1,
        item: {
          id: "file-1", type: "fileChange", status: "inProgress",
          changes: [{ path: "/workspace/hello.txt", kind: { type: "update" }, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n" }],
        },
      } });
      current.send({ method: "item/fileChange/patchUpdated", params: {
        threadId: request.params.threadId,
        turnId: "turn-1",
        itemId: "file-1",
        changes: [{ path: "/workspace/updated.txt", kind: { type: "add" }, diff: "--- /dev/null\n+++ b/updated.txt\n@@ -0,0 +1 @@\n+new\n" }],
      } });
      current.completeTurn(request, "completed", "Summary ready.");
    });
  } });
  const appServer = new AppServerClient({ spawnProcess: () => server });
  const { frontend, output } = makeFrontend({ appServer, answers: ["Review the file changes", ":quit"] });
  appServer.onApproval = (method, params, context) => frontend.requestApproval(method, params, context);
  await frontend.run();
  assert.match(output(), /file-change summary #1 · evidence pending/u);
  assert.match(output(), /file-change summary #1 · evidence updated/u);
  assert.match(output(), /file-change summary #1 · evidence invalidated/u);
  assert.match(output(), /Earlier details are no longer current/u);
  assert.match(output(), /File: \/workspace\/updated\.txt/u);
  assert.match(output(), /Change: add \(\+1 \/ −0 lines\)/u);
  assert.doesNotMatch(output(), /approval required|approval approved/u);
  assert.doesNotMatch(output(), /file written|write succeeded|applied successfully/u);
  appServer.dispose();
});

test("approval acceptance is shown separately and does not imply command execution", async () => {
  let startRequest;
  const server = new FakeCodexProcess({ onTurnStart: (request, current) => {
    startRequest = request;
    current.requestFromServer("approval-1", "item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "turn-1", itemId: "command-1", startedAtMs: 1,
      command: "npm test", cwd: "/workspace/project", availableDecisions: ["accept", "decline"],
    });
  } });
  server.onClientResponse = (message, current) => {
    if (message.id === "approval-1") current.completeTurn(startRequest, "completed", "The server did not report a command item.");
  };
  const appServer = new AppServerClient({ spawnProcess: () => server });
  const { frontend, output } = makeFrontend({ appServer, answers: ["Inspect command", "yes", ":quit"] });
  const approvalEvents = [];
  frontend.executionProvider.on("event", (event) => {
    if (event.type === "approval-required" || event.type === "approval-decided") approvalEvents.push(event);
  });
  await frontend.run();
  assert.match(output(), /approval requested/u);
  assert.match(output(), /approval approved/u);
  assert.match(output(), /execution status unavailable|turn ended before command status was reported/u);
  assert.doesNotMatch(output(), /execution completed/u);
  assert.deepEqual(approvalEvents.map((event) => event.type), ["approval-required", "approval-decided"]);
  assert.equal(approvalEvents[0].request.requestId, "approval-1");
  assert.equal(approvalEvents[1].requestId, "approval-1");
  assert.deepEqual([approvalEvents[0].request.conversationId, approvalEvents[0].request.taskId, approvalEvents[0].request.itemId],
    [approvalEvents[1].conversationId, approvalEvents[1].taskId, approvalEvents[1].itemId]);
  assert.deepEqual(server.requests.find((request) => request.id === "approval-1").result, { decision: "accept" });
  appServer.dispose();
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

test("TTY resize listeners are removed on exit and the live diff does not hide the cursor", async () => {
  const outputStream = new EventEmitter();
  outputStream.isTTY = true;
  outputStream.columns = 80;
  outputStream.rows = 24;
  let outputText = "";
  outputStream.write = (text) => { outputText += String(text); return true; };
  const input = { isTTY: true };
  let frontend;
  const appServer = new FakeAppServer(async () => {
    frontend.handleProgress({ type: "turn_identity", threadId: "thread-1", turnId: "turn-1", fileChanges: [] });
    frontend.handleProgress({ type: "turn_diff_updated", activity: {
      threadId: "thread-1", turnId: "turn-1", evidenceState: "available", diff: "+line",
    } });
    assert.equal(outputStream.listenerCount("resize"), 1);
    outputStream.emit("resize");
    return { status: "completed" };
  });
  const lineIO = new FakeLineIO(["Explain the change", ":quit"]);
  frontend = new TerminalFrontend({
    cwd: "/workspace/project", handlers: {}, appServer, input, output: outputStream, lineIO,
  });
  await frontend.run();
  assert.equal(outputStream.listenerCount("resize"), 0);
  assert.equal(lineIO.closed, true);
  assert.doesNotMatch(outputText, /\u001b\[\?25l/u);
});

test("redirected line input reads prompts and EOF without enabling terminal controls", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = createLineIO(input, output);
  t.after(() => { io.close(); input.destroy(); output.destroy(); });
  const answer = io.question("vesper> ");
  input.write("A task from a pipe\n");
  assert.equal(await answer, "A task from a pipe");
  input.end();
  assert.equal(await io.question("vesper> "), null);
  assert.equal(output.isTTY, undefined);
});

test("terminal renders one distinct, bounded turn-level aggregate view for the latest snapshot", () => {
  const { frontend, output } = makeFrontend();
  frontend.handleProgress({ type: "turn_identity", threadId: "thread-1", turnId: "turn-1", fileChanges: [] });
  frontend.handleProgress({ type: "turn_diff_activity", activity: {
    threadId: "other-thread",
    turnId: "turn-1",
    evidenceState: "available",
    closeReason: "completed",
    diff: "foreign thread snapshot",
  } });
  frontend.handleProgress({ type: "turn_diff_activity", activity: {
    threadId: "thread-1",
    turnId: "other-turn",
    evidenceState: "available",
    closeReason: "completed",
    diff: "foreign turn snapshot",
  } });
  frontend.handleProgress({ type: "turn_diff_activity", activity: {
    threadId: "thread-1",
    turnId: "turn-1",
    evidenceState: "available",
    evidenceReason: null,
    closeReason: "completed",
    diff: "--- a/latest.txt\n+++ b/latest.txt\n+latest\n",
    sourceLength: 42,
    redacted: false,
    revision: 2,
  } });
  frontend.handleProgress({ type: "turn_diff_activity", activity: {
    threadId: "thread-1",
    turnId: "turn-1",
    evidenceState: "available",
    evidenceReason: null,
    closeReason: "completed",
    diff: "stale duplicate view",
    sourceLength: 20,
    redacted: false,
    revision: 1,
  } });
  assert.match(output(), /turn-level aggregate diff/u);
  assert.match(output(), /latest\.txt/u);
  assert.doesNotMatch(output(), /foreign thread snapshot|foreign turn snapshot/u);
  assert.doesNotMatch(output(), /stale duplicate view/u);
  assert.match(output(), /not mapped to file-change items/u);
  assert.match(output(), /disk write not verified/u);
  assert.ok(output().length <= MAX_TURN_DIFF_RENDERED_LENGTH);

  const malformed = renderTurnDiffActivity({ threadId: "", turnId: "turn-1", diff: "bad" });
  assert.equal(malformed, "");
});
