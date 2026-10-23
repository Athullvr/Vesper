"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createExecutionProvider, getProviderStatus, OPENAI_PROVIDER_ID, resolveDefaultProviderId } = require("../execution-provider");
const { parseArgs, runVesper } = require("../cli");
const { TerminalFrontend } = require("../terminal-frontend");
const { SessionStore } = require("../session-store");

const PROJECT = path.resolve(process.cwd());
const API_KEY = "local-fixture-secret-value";

function temporaryRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-openai-provider-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function environment(baseUrl, overrides = {}) {
  return {
    OPENAI_API_KEY: API_KEY,
    VESPER_OPENAI_MODEL: "fixture-model",
    VESPER_OPENAI_BASE_URL: baseUrl,
    VESPER_OPENAI_TIMEOUT_MS: "4000",
    ...overrides,
  };
}

function sseResponse(chunks, { end = true } = {}) {
  const records = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(`${records}${end ? "data: [DONE]\n\n" : ""}`, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function capture() {
  let value = "";
  return { stream: { write: (chunk) => { value += String(chunk); } }, text: () => value };
}

test("provider selection keeps Codex as default and CLI status stays local unless --check is explicit", async (t) => {
  assert.equal(resolveDefaultProviderId({}), "codex-app-server");
  assert.equal(resolveDefaultProviderId({ VESPER_PROVIDER: OPENAI_PROVIDER_ID }), OPENAI_PROVIDER_ID);
  assert.deepEqual(parseArgs(["--provider", OPENAI_PROVIDER_ID, "--new", PROJECT]), {
    command: "run", newSession: true, resumeId: null, help: false, projectDirectory: PROJECT, providerId: OPENAI_PROVIDER_ID,
  });

  const root = temporaryRoot(t);
  let networkRequests = 0;
  const env = environment("https://api.example.test/v1");
  const output = capture();
  const errors = capture();
  const dependencies = {
    environment: env,
    fetchImpl: async () => { networkRequests += 1; throw new Error("unexpected network request"); },
    output: output.stream,
    errorOutput: errors.stream,
  };
  assert.equal(await runVesper(["providers"], dependencies), 0);
  assert.equal(await runVesper(["providers", "status", "--provider", OPENAI_PROVIDER_ID], dependencies), 0);
  assert.equal(networkRequests, 0);
  assert.match(output.text(), /API key: present .*value hidden/u);
  assert.doesNotMatch(output.text(), new RegExp(API_KEY, "u"));
  assert.match(output.text(), /vesper providers status .*--check/u);
  assert.equal(errors.text(), "");
  assert.equal(getProviderStatus(OPENAI_PROVIDER_ID, env).reachability, "not checked");
});

test("a Vesper session cannot switch providers implicitly; --new creates a separate provider session", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const saved = store.create(PROJECT, { providerId: "codex-app-server" });
  const output = capture();
  const errors = capture();
  const env = environment("https://api.fixture.test/v1");
  const rejected = await runVesper(["--provider", OPENAI_PROVIDER_ID, PROJECT], {
    store, environment: env, output: output.stream, errorOutput: errors.stream,
  });
  assert.equal(rejected, 1);
  assert.match(errors.text(), /latest session .*belongs to provider codex-app-server.*Use --new/u);
  assert.equal(store.findLatestByCwd(PROJECT).sessionId, saved.sessionId);

  const newOutput = capture();
  const created = await runVesper(["--provider", OPENAI_PROVIDER_ID, "--new", PROJECT], {
    store,
    environment: env,
    output: newOutput.stream,
    errorOutput: errors.stream,
    conversationDirectory: path.join(root, "provider-conversations"),
    lineIO: { async question() { return null; }, onInterrupt() {}, close() {} },
  });
  assert.equal(created, 0);
  const sessions = store.listByCwd(PROJECT);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((session) => session.providerId === OPENAI_PROVIDER_ID).length, 1);
  assert.ok(sessions.some((session) => session.sessionId === saved.sessionId));
  assert.match(newOutput.text(), /Execution provider: openai-chat-completions · model fixture-model/u);
});

test("VESPER_PROVIDER selects new sessions while saved sessions keep their provider", async (t) => {
  const store = new SessionStore({ directory: path.join(temporaryRoot(t), "sessions") });
  store.create(PROJECT, { providerId: "codex-app-server" });
  let selectedProviderId;
  const provider = new EventEmitter();
  provider.id = "codex-app-server";
  provider.capabilities = Object.fromEntries([
    "streaming", "interruptions", "resume", "conversationHistory", "approvalEvents", "fileChanges",
    "commandExecutionEvents", "recovery", "persistentSessions",
  ].map((key) => [key, false]));
  provider.initialize = async () => ({ available: true });
  provider.startConversation = async () => ({ conversationId: null });
  provider.resumeConversation = async () => ({ conversationId: null });
  provider.readConversationHistory = async () => ({ state: "empty", entries: [] });
  provider.submitTask = async () => ({ status: "completed" });
  provider.interrupt = async () => false;
  provider.recover = async () => ({ available: false });
  provider.getState = () => ({ conversationReady: false, conversationId: null });
  provider.dispose = () => {};
  const output = capture();
  const result = await runVesper([PROJECT], {
    store,
    environment: environment("https://api.fixture.test/v1", { VESPER_PROVIDER: OPENAI_PROVIDER_ID }),
    executionProviderFactory: ({ providerId }) => { selectedProviderId = providerId; return provider; },
    output: output.stream,
    errorOutput: capture().stream,
    lineIO: { async question() { return null; }, onInterrupt() {}, close() {} },
  });
  assert.equal(result, 0);
  assert.equal(selectedProviderId, "codex-app-server");
  assert.match(output.text(), /Execution provider: codex-app-server/u);
});

test("explicit provider status check uses only GET /models and reports model reachability", async (t) => {
  let calls = [];
  const baseUrl = "http://127.0.0.1:43129/v1";
  const output = capture();
  const errors = capture();
  const status = await runVesper(["providers", "status", "--provider", OPENAI_PROVIDER_ID, "--check"], {
    environment: environment(baseUrl),
    projectDirectory: PROJECT,
    conversationDirectory: path.join(temporaryRoot(t), "conversations"),
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, url, authorization: options.headers.Authorization });
      assert.equal(options.method, "GET");
      assert.equal(url, `${baseUrl}/models`);
      return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
    output: output.stream,
    errorOutput: errors.stream,
  });

  assert.equal(status, 0);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [["GET", `${baseUrl}/models`]]);
  assert.equal(calls[0].authorization, `Bearer ${API_KEY}`);
  assert.match(output.text(), /Model: fixture-model/u);
  assert.match(output.text(), /Reachability: yes · configured model listed/u);
  assert.doesNotMatch(output.text(), new RegExp(API_KEY, "u"));
  assert.equal(errors.text(), "");
});

test("an HTTP authentication error is reachable but unavailable", async (t) => {
  const output = capture();
  const status = await runVesper(["providers", "status", "--provider", OPENAI_PROVIDER_ID, "--check"], {
    environment: environment("http://127.0.0.1:43135/v1"),
    projectDirectory: PROJECT,
    conversationDirectory: path.join(temporaryRoot(t), "conversations"),
    fetchImpl: async () => new Response("{\"error\":{\"message\":\"secret should not be read\"}}", { status: 401 }),
    output: output.stream,
    errorOutput: capture().stream,
  });
  assert.equal(status, 1);
  assert.match(output.text(), /Reachability: yes · API check failed/u);
  assert.match(output.text(), /HTTP 401/u);
  assert.doesNotMatch(output.text(), /secret should not be read/u);
});

test("Chat Completions streams text and resumes its bounded project-scoped local transcript", async (t) => {
  const root = temporaryRoot(t);
  const requests = [];
  const baseUrl = "http://127.0.0.1:43130/v1";
  const fetchImpl = async (url, options) => {
    const parsed = JSON.parse(options.body);
    requests.push({ method: options.method, url, authorization: options.headers.Authorization, body: parsed });
    assert.equal(options.method, "POST");
    assert.equal(url, `${baseUrl}/chat/completions`);
    assert.equal(parsed.stream, true);
    assert.equal(parsed.store, false);
    assert.equal(parsed.n, 1);
    assert.equal(Object.hasOwn(parsed, "tools"), false);
    assert.equal(JSON.stringify(parsed).includes(PROJECT), false);
    return sseResponse([
      { choices: [{ delta: { content: "Answer " }, finish_reason: null }] },
      { choices: [{ delta: { content: "one." }, finish_reason: "stop" }] },
    ]);
  };
  const conversationDirectory = path.join(root, "sessions", "provider-conversations");
  const mappedIds = [];
  const provider = createExecutionProvider({
    providerId: OPENAI_PROVIDER_ID,
    environment: environment(baseUrl),
    conversationDirectory,
    fetchImpl,
    onConversationId: async (id) => mappedIds.push(id),
  });
  const events = [];
  provider.on("event", (event) => events.push(event));
  assert.equal(provider.getState().availability, "unknown", "valid configuration alone does not prove reachability");

  const result = await provider.submitTask({ task: "Explain this API shape.", projectPath: PROJECT });
  assert.equal(result.status, "completed");
  assert.equal(result.executedCommands, false);
  assert.equal(result.changedFiles, false);
  assert.equal(result.model, "fixture-model");
  assert.equal(provider.getState().availability, "available");
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "Answer one.");
  assert.equal(events.some((event) => event.type === "task-state" && event.state === "completed"), true);
  assert.equal(mappedIds.length, 1);
  assert.match(mappedIds[0], /^oai_[0-9a-f-]{36}$/u);
  assert.deepEqual(requests[0].body.messages.map((message) => message.role), ["developer", "user"]);
  assert.match(requests[0].body.messages[0].content, /cannot inspect the user's project/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(conversationDirectory, `${mappedIds[0]}.json`), "utf8")).messages, [
    { role: "user", content: "Explain this API shape." },
    { role: "assistant", content: "Answer one." },
  ]);
  assert.equal(fs.statSync(conversationDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(conversationDirectory, `${mappedIds[0]}.json`)).mode & 0o777, 0o600);

  const resumed = createExecutionProvider({
    providerId: OPENAI_PROVIDER_ID,
    environment: environment(baseUrl),
    conversationDirectory,
    fetchImpl,
  });
  await assert.rejects(resumed.resumeConversation({ projectPath: "/workspace/different-project", conversationId: mappedIds[0] }),
    (error) => error.code === "RESUME_FAILED");
  await resumed.resumeConversation({ projectPath: PROJECT, conversationId: mappedIds[0] });
  const history = await resumed.readConversationHistory();
  assert.equal(history.state, "available");
  assert.deepEqual(history.entries.map((entry) => entry.text), ["Explain this API shape.", "Answer one."]);
  assert.match(history.entries[1].label, /not executed/u);
  await resumed.submitTask({ task: "Continue the same conversation.", projectPath: PROJECT });
  assert.deepEqual(requests[1].body.messages.slice(-3).map((message) => message.content), [
    "Explain this API shape.", "Answer one.", "Continue the same conversation.",
  ]);
  assert.equal(resumed.getState().conversationId, mappedIds[0]);

  let terminalOutput = "";
  let asked = false;
  const terminal = new TerminalFrontend({
    cwd: PROJECT,
    handlers: {},
    executionProvider: resumed,
    output: { write: (value) => { terminalOutput += String(value); } },
    lineIO: { async question() { if (asked) return null; asked = true; return "Draft an implementation outline."; }, onInterrupt() {}, close() {} },
  });
  await terminal.run();
  assert.match(terminalOutput, /OpenAI Chat Completions API · fixture-model \(text only; generated text is not executed\)/u);
  assert.match(terminalOutput, /OpenAI text generated · not executed · files unchanged/u);
  assert.match(terminalOutput, /Answer one\./u);
  provider.dispose();
  resumed.dispose();
});

test("malformed and truncated SSE streams become uncertain and are never resubmitted", async (t) => {
  for (const kind of ["malformed", "truncated"]) {
    const root = temporaryRoot(t);
    let postCount = 0;
    const baseUrl = `http://127.0.0.1:4313${kind === "malformed" ? "1" : "2"}/v1`;
    const fetchImpl = async () => {
      postCount += 1;
      const body = kind === "malformed" ? "data: {not-json}\n\n" : 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider = createExecutionProvider({
      providerId: OPENAI_PROVIDER_ID,
      environment: environment(baseUrl),
      conversationDirectory: path.join(root, "conversations"),
      fetchImpl,
    });
    await assert.rejects(provider.submitTask({ task: `Cause ${kind}`, projectPath: PROJECT }), (error) => {
      assert.equal(error.code, "SUBMISSION_OUTCOME_UNCERTAIN");
      assert.equal(error.retryable, false);
      return true;
    });
    await assert.rejects(provider.submitTask({ task: `Retry ${kind}`, projectPath: PROJECT }), (error) => error.code === "SUBMISSION_OUTCOME_UNCERTAIN");
    assert.equal(postCount, 1);
    const state = provider.getState();
    assert.equal(state.state, "uncertain");
    await assert.rejects(provider.recover({ projectPath: PROJECT }), (error) => error.code === "UNSUPPORTED_OPERATION");
    assert.equal(provider.capabilities.recovery, false);
    provider.dispose();
  }
});

test("a network failure after dispatch is sanitized and never automatically retried", async (t) => {
  const root = temporaryRoot(t);
  let postCount = 0;
  const provider = createExecutionProvider({
    providerId: OPENAI_PROVIDER_ID,
    environment: environment("http://127.0.0.1:43136/v1"),
    conversationDirectory: path.join(root, "conversations"),
    fetchImpl: async () => { postCount += 1; throw new Error(`socket failure ${API_KEY}`); },
  });
  await assert.rejects(provider.submitTask({ task: "A request with uncertain outcome.", projectPath: PROJECT }), (error) => {
    assert.equal(error.code, "SUBMISSION_OUTCOME_UNCERTAIN");
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, new RegExp(API_KEY, "u"));
    return true;
  });
  await assert.rejects(provider.submitTask({ task: "Do not submit again.", projectPath: PROJECT }), (error) => error.code === "SUBMISSION_OUTCOME_UNCERTAIN");
  assert.equal(postCount, 1);
  assert.equal(provider.getState().reachability, "no");
  provider.dispose();
});

test("interrupt aborts the local stream, retains uncertainty, and does not claim remote cancellation", async (t) => {
  const root = temporaryRoot(t);
  let postCount = 0;
  let responseReady;
  const started = new Promise((resolve) => { responseReady = resolve; });
  const baseUrl = "http://127.0.0.1:43133/v1";
  const fetchImpl = async () => {
    postCount += 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial response"},"finish_reason":null}]}\n\n'));
        responseReady();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createExecutionProvider({
    providerId: OPENAI_PROVIDER_ID,
    environment: environment(baseUrl),
    conversationDirectory: path.join(root, "conversations"),
    fetchImpl,
  });
  const pending = provider.submitTask({ task: "Please start a long response.", projectPath: PROJECT });
  await started;
  assert.equal(await provider.interrupt(), true);
  const result = await pending;
  assert.equal(result.status, "interrupted");
  assert.equal(result.completionKnown, false);
  assert.equal(result.recoveryCode, "submission-outcome-uncertain");
  await assert.rejects(provider.submitTask({ task: "Do not duplicate the previous task.", projectPath: PROJECT }), (error) => error.code === "SUBMISSION_OUTCOME_UNCERTAIN");
  assert.equal(postCount, 1);
  provider.dispose();
});

test("configuration and API errors do not disclose credential-bearing values", async (t) => {
  const secretEndpoint = "https://user:credential-in-url@example.test/v1";
  const status = getProviderStatus(OPENAI_PROVIDER_ID, environment(secretEndpoint));
  assert.equal(status.configured, false);
  assert.doesNotMatch(JSON.stringify(status), /credential-in-url|local-fixture-secret-value/u);

  const root = temporaryRoot(t);
  const baseUrl = "http://127.0.0.1:43134/v1";
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: `Rejected ${API_KEY}` } }), {
    status: 401, headers: { "content-type": "application/json" },
  });
  const provider = createExecutionProvider({
    providerId: OPENAI_PROVIDER_ID,
    environment: environment(baseUrl),
    conversationDirectory: path.join(root, "conversations"),
    fetchImpl,
  });
  await assert.rejects(provider.submitTask({ task: "A safe task.", projectPath: PROJECT }), (error) => {
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.doesNotMatch(error.message, new RegExp(API_KEY, "u"));
    return true;
  });
  provider.dispose();
});

