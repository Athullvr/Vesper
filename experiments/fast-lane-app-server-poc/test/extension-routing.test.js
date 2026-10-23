"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const childProcess = require("node:child_process");
const vm = require("node:vm");
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

test("VS Code can select OpenAI and labels normalized output as generated text, not executed", async (t) => {
  const root = makeTempDirectory("vesper-vscode-openai-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    const events = [
      { choices: [{ delta: { content: "Remote guidance." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
    return new Response(`${events}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], {
    environment: {
      VESPER_PROVIDER: "openai-chat-completions",
      OPENAI_API_KEY: "fixture-only-secret",
      VESPER_OPENAI_MODEL: "fixture-model",
      VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1",
      VESPER_OPENAI_TIMEOUT_MS: "4000",
    },
  });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("provider-info").providerId, "openai-chat-completions");
  await panel.send({ type: "submit", text: "Explain this API shape." });

  assert.equal(panel.all("assistant-delta").map((message) => message.text).join(""), "Remote guidance.");
  assert.equal(panel.last("assistant-done").generatedTextOnly, true);
  assert.equal(panel.last("assistant-done").model, "fixture-model");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.fixture.test/v1/chat/completions");
  assert.equal(calls[0].authorization, "Bearer fixture-only-secret");
  assert.equal(JSON.stringify(calls[0].body).includes(fs.realpathSync(project)), false);
  const session = harness.store().findLatestByCwd(fs.realpathSync(project));
  assert.equal(session.providerId, "openai-chat-completions");
  assert.match(session.providerConversationId, /^oai_[0-9a-f-]{36}$/u);
  assert.doesNotMatch(fs.readFileSync(path.join(harness.home, "sessions", `${session.sessionId}.json`), "utf8"), /Explain this API shape|fixture-only-secret/u);

  const webview = mountWebview(panel.html);
  webview.dispatch(panel.last("provider-info"));
  webview.dispatch({ type: "assistant-start", requestId: 1, providerId: "openai-chat-completions" });
  webview.dispatch({ type: "assistant-delta", requestId: 1, text: "Remote guidance." });
  webview.dispatch(panel.last("assistant-done"));
  assert.match(webview.elements.get("messages").children[0].children[0].textContent, /generated text · not executed · files unchanged/u);
  assert.match(webview.elements.get("status").textContent, /text generated, not executed/u);
  assert.match(webview.elements.get("provider-privacy").textContent, /OpenAI receives submitted task and saved conversation text only/u);
  assert.match(panel.html, /project files are not sent/u);
});

test("VS Code routes opted-in OpenAI read-only calls through the project runtime and renders tool activity", async (t) => {
  const root = makeTempDirectory("vesper-vscode-openai-tools-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "VS Code project evidence.\n", "utf8");
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 1) {
      assert.ok(body.tools.some((entry) => entry.function.name === "read_file"));
      assert.equal(body.tools.some((entry) => entry.function.name === "run_command"), false);
      assert.equal(body.tools.some((entry) => entry.function.name === "apply_file_change"), false);
      const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
      return new Response(`${events}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    assert.ok(body.messages.some((message) => message.role === "tool" && message.content.includes("VS Code project evidence.")));
    const events = [
      { choices: [{ delta: { content: "I inspected the project README." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
    return new Response(`${events}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], {
    environment: {
      VESPER_PROVIDER: "openai-chat-completions",
      OPENAI_API_KEY: "fixture-only-secret",
      VESPER_OPENAI_MODEL: "fixture-model",
      VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1",
      VESPER_OPENAI_TIMEOUT_MS: "4000",
      VESPER_OPENAI_TOOL_CALLING_MODEL: "fixture-model",
    },
  });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  await panel.send({ type: "submit", text: "Inspect the README." });
  assert.equal(calls.length, 2);
  const assistantText = panel.all("assistant-delta").map((message) => message.text).join("");
  assert.match(assistantText, /^I inspected the project README\./u);
  assert.match(assistantText, /Vesper execution evidence[\s\S]*read_file: `README\.md` \(verified\)/u);
  assert.match(assistantText, /Tests\/builds: not run by Vesper/u);
  assert.ok(panel.all("workflow-stage").some((message) => message.stage === "planning"));
  const toolEvents = panel.all("tool-activity");
  assert.ok(toolEvents.some((event) => event.toolId === "read_file" && event.state === "requested"));
  assert.ok(toolEvents.some((event) => event.toolId === "read_file" && event.state === "verified" && event.verified));
  assert.match(panel.last("provider-info").displayName, /OpenAI/u);
  const webview = mountWebview(panel.html);
  webview.dispatch(panel.last("provider-info"));
  webview.dispatch({ type: "assistant-start", requestId: panel.last("assistant-start").requestId, providerId: "openai-chat-completions" });
  for (const event of toolEvents) webview.dispatch(event);
  assert.ok(webview.elements.get("messages").children.some((entry) => entry.children[0].textContent.includes("Vesper tool · read_file")));
  assert.match(webview.elements.get("provider-privacy").textContent, /bounded results from Vesper project inspection/u);
});

test("VS Code can use NVIDIA NIM through the compatible text adapter without implying execution", async (t) => {
  const root = makeTempDirectory("vesper-vscode-nim-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    const events = [
      { choices: [{ delta: { content: "NIM guidance." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
    return new Response(`${events}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], {
    environment: {
      VESPER_PROVIDER: "nvidia-nim",
      NVIDIA_API_KEY: "nvidia-fixture-secret",
      VESPER_NVIDIA_MODEL: "fixture/nim-model",
      VESPER_NVIDIA_BASE_URL: "https://nim.fixture.test/v1",
    },
  });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("provider-info").providerId, "nvidia-nim");
  assert.equal(panel.last("provider-info").model, "fixture/nim-model");
  await panel.send({ type: "submit", text: "Explain this NIM fixture." });

  assert.equal(panel.all("assistant-delta").map((message) => message.text).join(""), "NIM guidance.");
  assert.equal(panel.last("assistant-done").generatedTextOnly, true);
  assert.equal(panel.last("assistant-done").model, "fixture/nim-model");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nim.fixture.test/v1/chat/completions");
  assert.equal(calls[0].authorization, "Bearer nvidia-fixture-secret");
  assert.equal(Object.hasOwn(calls[0].body, "tools"), false);
  const session = harness.store().findLatestByCwd(fs.realpathSync(project));
  assert.equal(session.providerId, "nvidia-nim");
  assert.equal(session.modelId, "fixture/nim-model");
  assert.match(session.providerConversationId, /^nim_[0-9a-f-]{36}$/u);
  assert.doesNotMatch(fs.readFileSync(path.join(harness.home, "sessions", `${session.sessionId}.json`), "utf8"), /Explain this NIM fixture|nvidia-fixture-secret/u);

  const webview = mountWebview(panel.html);
  webview.dispatch(panel.last("provider-info"));
  webview.dispatch({ type: "assistant-start", requestId: 1, providerId: "nvidia-nim" });
  webview.dispatch({ type: "assistant-delta", requestId: 1, text: "NIM guidance." });
  webview.dispatch(panel.last("assistant-done"));
  assert.match(webview.elements.get("messages").children[0].children[0].textContent, /NVIDIA NIM · generated text · not executed · files unchanged/u);
  assert.match(webview.elements.get("status").textContent, /NVIDIA NIM · text generated, not executed/u);
  assert.match(webview.elements.get("provider-privacy").textContent, /NVIDIA NIM receives submitted task and saved conversation text only/u);
});

test("VS Code keeps a saved provider and uses VESPER_PROVIDER only for a new session", async (t) => {
  const root = makeTempDirectory("vesper-vscode-provider-resume-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], {
    environment: {
      VESPER_PROVIDER: "openai-chat-completions",
      OPENAI_API_KEY: "fixture-only-secret",
      VESPER_OPENAI_MODEL: "fixture-model",
      VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1",
    },
  });
  const saved = harness.store().create(fs.realpathSync(project), { providerId: "codex-app-server" });
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("provider-info").providerId, "codex-app-server");
  assert.match(panel.last("session-state").text, /first Codex app-server conversation/u);

  await panel.send({ type: "start-new-session" });
  const sessions = harness.store().listByCwd(fs.realpathSync(project));
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((session) => session.sessionId === saved.sessionId && session.providerId === "codex-app-server"));
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(project)).providerId, "openai-chat-completions");
  assert.equal(panel.last("provider-info").providerId, "openai-chat-completions");
});

test("VS Code Plan preview uses the panel bridge without starting a Codex thread or logging task text", async (t) => {
  const root = makeTempDirectory("vesper-vscode-plan-preview-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }]);
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  const task = "Query the PostgreSQL database using token sk-proj-1234567890abcdef";
  await panel.send({ type: "plan-preview", text: task });

  assert.match(panel.html, /id="preview-plan"/u);
  assert.match(panel.last("plan-preview")?.text || "", /Vesper plan · advisory only · not executed/u);
  assert.equal(harness.state.children.length, 0);
  assert.equal(harness.requests.length, 0);
  assert.doesNotMatch(harness.logs.join("\n"), /Query the PostgreSQL database|sk-proj-1234567890abcdef/u);
  assert.doesNotMatch(panel.last("plan-preview")?.text || "", /sk-proj-1234567890abcdef/u);
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
  assert.equal(panel.last("session-state").state, "connected");
  assert.deepEqual(panel.all("conversation-history").at(-1).entries.map((entry) => entry.text), [
    "Inspect this project.",
    "Answer 1.",
    "Codex recorded this turn as completed.",
    "Continue after reopening the panel.",
    "Answer 2.",
    "Codex recorded this turn as completed.",
  ]);
  await panel.send({ type: "submit", text: "Continue after restarting VS Code." });

  const resumed = harness.requests.filter((request) => request.method === "thread/resume");
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0].params, { threadId: original.threadId, sandbox: "read-only" });
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, initialStartCount);
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").at(-1).params.threadId, original.threadId);
  assert.equal(harness.store().findLatestByCwd(fs.realpathSync(project)).sessionId, original.sessionId);
  assert.equal(panel.last("session-state").text, "Connected · this Vesper session is saved.");
});

test("panel reopened while the first thread is starting waits for history instead of showing an empty conversation", async (t) => {
  const root = makeTempDirectory("vesper-vscode-history-thread-starting-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], { holdThreadStarts: 1 });
  const firstPanel = harness.openPanel();
  await firstPanel.send({ type: "ready" });

  const submitting = firstPanel.send({ type: "submit", text: "Recover this active conversation." });
  await waitFor(() => harness.state.pendingThreadStarts.length === 1);
  firstPanel.close();

  const reopenedPanel = harness.openPanel();
  await reopenedPanel.send({ type: "ready" });
  assert.equal(reopenedPanel.last("conversation-history").state, "loading");
  assert.doesNotMatch(reopenedPanel.all("conversation-history").map((message) => message.text).join(" "), /no saved Vesper conversation exists/u);

  harness.releaseThreadStart();
  await submitting;
  await waitFor(() => reopenedPanel.last("conversation-history")?.state === "available");
  assert.deepEqual(reopenedPanel.last("conversation-history").entries.map((entry) => entry.text), [
    "Recover this active conversation.",
    "Answer 1.",
    "Codex recorded this turn as completed.",
  ]);
});

test("history retrieval failure is explicit, does not erase the saved mapping, and leaves a verified thread usable", async (t) => {
  const root = makeTempDirectory("vesper-vscode-history-unavailable-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], { historyFailures: 1 });
  const saved = harness.store().create(fs.realpathSync(project));
  harness.store().update(saved.sessionId, { threadId: "saved-thread" });
  harness.state.threadCwds.set("saved-thread", fs.realpathSync(project));

  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  const history = panel.last("conversation-history");
  assert.equal(history.state, "unavailable");
  assert.match(history.text, /not treated it as empty/u);
  assert.equal(panel.last("session-state").state, "connected");
  assert.equal(harness.store().load(saved.sessionId).threadId, "saved-thread");

  await panel.send({ type: "submit", text: "Continue with history unavailable." });
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(harness.store().load(saved.sessionId).threadId, "saved-thread");
});

test("valid empty history is shown as empty rather than unavailable", async (t) => {
  const root = makeTempDirectory("vesper-vscode-history-empty-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }]);
  const saved = harness.store().create(fs.realpathSync(project));
  harness.store().update(saved.sessionId, { threadId: "saved-thread" });
  harness.state.threadCwds.set("saved-thread", fs.realpathSync(project));

  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  assert.equal(panel.last("conversation-history").state, "empty");
  assert.match(panel.last("conversation-history").text, /no conversation turns yet/u);
});

test("stale history from a previous project cannot replace the newly selected project history", async (t) => {
  const root = makeTempDirectory("vesper-vscode-stale-history-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const projectA = { name: "Project A", uri: { fsPath: a } };
  const projectB = { name: "Project B", uri: { fsPath: b } };
  const harness = createHarness(t, [projectA, projectB], { holdHistoryResponses: 1 });
  const aSession = harness.store().create(fs.realpathSync(a));
  harness.store().update(aSession.sessionId, { threadId: "thread-a" });
  const bSession = harness.store().create(fs.realpathSync(b));
  harness.store().update(bSession.sessionId, { threadId: "thread-b" });
  harness.state.threadCwds.set("thread-a", fs.realpathSync(a));
  harness.state.threadCwds.set("thread-b", fs.realpathSync(b));
  harness.state.historyByThread.set("thread-a", [storedTurn("turn-a", "Old project history")]);
  harness.state.historyByThread.set("thread-b", [storedTurn("turn-b", "New project history")]);

  const panel = harness.openPanel();
  const ready = panel.send({ type: "ready" });
  await waitFor(() => harness.state.pendingHistoryResponses.length === 1);
  harness.pick(projectB);
  await panel.send({ type: "select-project" });
  assert.equal(panel.last("conversation-history").entries[0].text, "New project history");

  harness.releaseHistoryResponse(0);
  await ready;
  assert.equal(panel.last("conversation-history").entries[0].text, "New project history");
  assert.equal(panel.all("conversation-history").some((message) => message.entries?.some((entry) => entry.text === "Old project history")), false);
});

test("stale history from a replaced session cannot repopulate a new conversation", async (t) => {
  const root = makeTempDirectory("vesper-vscode-history-session-switch-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const harness = createHarness(t, [{ name: "Project", uri: { fsPath: project } }], { holdHistoryResponses: 1 });
  const oldSession = harness.store().create(fs.realpathSync(project));
  harness.store().update(oldSession.sessionId, { threadId: "thread-old" });
  harness.state.threadCwds.set("thread-old", fs.realpathSync(project));
  harness.state.historyByThread.set("thread-old", [storedTurn("turn-old", "Old session transcript")]);

  const panel = harness.openPanel();
  const ready = panel.send({ type: "ready" });
  await waitFor(() => harness.state.pendingHistoryResponses.length === 1);
  await panel.send({ type: "start-new-session" });
  await ready;
  assert.equal(panel.last("conversation-history").state, "empty");

  harness.releaseHistoryResponse();
  assert.equal(panel.last("conversation-history").state, "empty");
  assert.equal(panel.all("conversation-history").some((message) => message.entries?.some((entry) => entry.text === "Old session transcript")), false);
  assert.notEqual(harness.store().findLatestByCwd(fs.realpathSync(project)).sessionId, oldSession.sessionId);
});

test("webview cannot select arbitrary session IDs or project paths for history retrieval", async (t) => {
  const project = fs.realpathSync(process.cwd());
  const harness = createHarness(t, [{ name: "Vesper", uri: { fsPath: project } }]);
  const panel = harness.openPanel();
  await panel.send({ type: "ready" });
  const before = harness.requests.filter((request) => request.method === "thread/turns/list").length;

  await panel.send({ type: "restore-history", sessionId: "attacker-session", projectPath: "/etc" });
  assert.equal(harness.requests.filter((request) => request.method === "thread/turns/list").length, before);
  assert.equal(harness.store().findLatestByCwd(project), null);
});

test("webview replaces restored history, distinguishes unavailable history, and renders content as text", async (t) => {
  const project = fs.realpathSync(process.cwd());
  const harness = createHarness(t, [{ name: "Vesper", uri: { fsPath: project } }]);
  const panel = harness.openPanel();
  const webview = mountWebview(panel.html);
  const history = {
    type: "conversation-history",
    state: "available",
    text: "Saved history restored.",
    entries: [
      { id: "turn-1:user", kind: "user", label: "You", text: "Question <b>not HTML</b>" },
      { id: "turn-1:assistant", kind: "assistant", label: "Codex", text: "Answer" },
    ],
  };

  webview.dispatch(history);
  assert.equal(webview.elements.get("messages").children.length, 2);
  assert.equal(webview.elements.get("messages").children[0].children[1].textContent, "Question <b>not HTML</b>");
  assert.equal(webview.elements.get("messages").children[0].children[1].innerHTML, undefined);

  webview.dispatch(history);
  assert.equal(webview.elements.get("messages").children.length, 2, "restoring the same snapshot replaces prior DOM entries");
  webview.dispatch({ type: "conversation-history", state: "unavailable", text: "History was not available." });
  assert.equal(webview.elements.get("messages").children.length, 0, "unavailable history clears the old snapshot instead of presenting it as current");
  assert.equal(webview.elements.get("history-state").textContent, "History was not available.");
  webview.dispatch(history);
  assert.equal(webview.elements.get("messages").children.length, 2);
  webview.dispatch({ type: "conversation-history", state: "empty", text: "No saved turns.", entries: [] });
  assert.equal(webview.elements.get("messages").children.length, 0);
  assert.equal(webview.elements.get("history-state").textContent, "No saved turns.");
});

test("VS Code panel renders normalized Vesper tool activity as bounded text for the active request", async (t) => {
  const project = fs.realpathSync(process.cwd());
  const harness = createHarness(t, [{ name: "Vesper", uri: { fsPath: project } }]);
  const panel = harness.openPanel();
  const webview = mountWebview(panel.html);
  webview.dispatch({ type: "assistant-start", requestId: "request-1", providerId: "openai-chat-completions" });
  webview.dispatch({ type: "tool-activity", requestId: "stale-request", toolId: "read_file", state: "verified", verified: true, summary: "stale" });
  webview.dispatch({ type: "tool-activity", requestId: "request-1", toolId: "read_file", state: "verified", verified: true, summary: "{\"path\":\"src/main.js\"}" });
  const activity = webview.elements.get("messages").children.at(-1);
  assert.equal(activity.children[0].textContent, "Vesper tool · read_file · verified · verified");
  assert.equal(activity.children[1].textContent, "{\"path\":\"src/main.js\"}");
  assert.equal(activity.children[1].innerHTML, undefined);
  assert.equal(webview.elements.get("messages").children.length, 2, "stale-request activity was ignored");
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
  const processesBeforeUnavailableSubmit = harness.state.children.length;
  fs.rmdirSync(a);

  await panel.send({ type: "submit", text: "Inspect the unavailable project." });
  assert.equal(harness.state.children.length, processesBeforeUnavailableSubmit);
  assert.equal(harness.requests.some((request) => request.method === "turn/start"), false);
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
  const previousEnvironment = Object.fromEntries(Object.keys(options.environment || {}).map((key) => [key, process.env[key]]));
  process.env.VESPER_HOME = home;
  for (const [key, value] of Object.entries(options.environment || {})) process.env[key] = value;
  const state = {
    requests: [],
    serverRequests: [],
    clientResponses: [],
    children: [],
    threadCwds: new Map(),
    threadCount: 0,
    turnCount: 0,
    resumeFailures: options.resumeFailures || 0,
    historyFailures: options.historyFailures || 0,
    holdHistoryResponses: options.holdHistoryResponses || 0,
    holdThreadStarts: options.holdThreadStarts || 0,
    pendingThreadStarts: [],
    pendingHistoryResponses: [],
    historyByThread: new Map(),
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
        if (state.holdThreadStarts > 0) {
          state.holdThreadStarts -= 1;
          state.pendingThreadStarts.push({ child: this, request: message });
        } else {
          this.respondThreadStart(message);
        }
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
      } else if (message.method === "thread/turns/list") {
        if (state.historyFailures > 0) {
          state.historyFailures -= 1;
          this.send({ id: message.id, error: { code: -32601, message: "mock history unavailable" } });
        } else if (state.holdHistoryResponses > 0) {
          state.holdHistoryResponses -= 1;
          state.pendingHistoryResponses.push({ child: this, request: message });
        } else {
          this.respondHistory(message);
        }
      } else if (message.method === "turn/start") {
        assert.equal(state.threadCwds.get(message.params.threadId), message.params.cwd);
        const turnId = `turn-${++state.turnCount}`;
        const active = { threadId: message.params.threadId, turnId, request: message, prompt: message.params.input?.[0]?.text };
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
      if (!active.historyStored) {
        const items = [{
          id: `${active.turnId}-user`,
          type: "userMessage",
          content: [{ type: "text", text: active.prompt || "" }],
        }];
        if (text) items.push({ id: `${active.turnId}-assistant`, type: "agentMessage", text });
        const record = { id: active.turnId, status, itemsView: "full", items };
        if (status === "failed" || status === "interrupted") record.error = { message: `Turn ${status}.` };
        const history = state.historyByThread.get(active.threadId) || [];
        history.push(record);
        state.historyByThread.set(active.threadId, history);
        active.historyStored = true;
      }
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

    respondHistory(request) {
      const all = state.historyByThread.get(request.params.threadId) || [];
      const limit = Number.isSafeInteger(request.params.limit) ? request.params.limit : 50;
      const selected = all.slice(-limit);
      this.send({
        id: request.id,
        result: {
          data: selected.slice().reverse(),
          nextCursor: all.length > limit ? "older-history" : null,
        },
      });
    }

    respondThreadStart(request) {
      assert.equal(request.params.cwd, this.cwd);
      const threadId = `thread-${++state.threadCount}`;
      state.threadCwds.set(threadId, request.params.cwd);
      state.historyByThread.set(threadId, []);
      this.send({ id: request.id, result: { thread: { id: threadId }, cwd: request.params.cwd } });
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
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
    releaseHistoryResponse: (index = 0) => {
      const pending = state.pendingHistoryResponses.splice(index, 1)[0];
      if (!pending) return false;
      pending.child.respondHistory(pending.request);
      return true;
    },
    releaseThreadStart: (index = 0) => {
      const pending = state.pendingThreadStarts.splice(index, 1)[0];
      if (!pending) return false;
      pending.child.respondThreadStart(pending.request);
      return true;
    },
  };
}

function storedTurn(id, text) {
  return {
    id,
    status: "completed",
    itemsView: "full",
    items: [{ id: `${id}-assistant`, type: "agentMessage", text }],
  };
}

function mountWebview(html) {
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
  assert.equal(typeof script, "string", "the panel HTML contains its nonce-bound script");
  const ids = [
    "messages", "status", "provider-info", "provider-privacy", "form", "prompt", "preview-plan", "send", "stop", "choose-project", "project-name",
    "project-path", "session-state", "history-state", "recovery-actions", "retry-resume", "start-new-session",
  ];
  const elements = new Map(ids.map((id) => [id, new MockElement(id)]));
  let onMessage;
  const posted = [];
  const document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tagName) => new MockElement(tagName),
  };
  const window = {
    addEventListener: (type, listener) => { if (type === "message") onMessage = listener; },
  };
  vm.runInNewContext(script, {
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
  }, { timeout: 1_000 });
  return {
    elements,
    posted,
    dispatch: (data) => onMessage({ data }),
  };
}

class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
  }

  addEventListener() {}

  append(...elements) {
    this.children.push(...elements);
  }

  replaceChildren(...elements) {
    this.children = [...elements];
  }

  focus() {}

  requestSubmit() {}
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
