"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createExecutionProvider } = require("../execution-provider");
const { createPermissionedToolRuntime } = require("../permissioned-tool-runtime");
const { TerminalFrontend } = require("../terminal-frontend");

const SESSION_ID = "8baf4d07-6a0e-43a3-9b3c-9e3128fc4eaa";
const API_KEY = "local-structured-tool-fixture-key";

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-tool-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function localServer(t, handler) {
  const server = http.createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  // Deliberately split JSON and SSE records across transport writes.
  for (let offset = 0; offset < Buffer.byteLength(body); offset += 11) {
    response.write(Buffer.from(body).subarray(offset, offset + 11));
  }
  response.end();
}

function completeJson(response, content, extra = {}) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: "stop" }],
  }));
}

function providerEnvironment(baseUrl, providerId = "openai-chat-completions", overrides = {}) {
  const shared = {
    VESPER_OPENAI_API_KEY: API_KEY,
    VESPER_OPENAI_MODEL: "fixture-model",
    VESPER_OPENAI_BASE_URL: baseUrl,
    VESPER_OPENAI_TIMEOUT_MS: "4000",
    VESPER_OPENAI_TOOL_CALLING_MODEL: "fixture-model",
    VESPER_OPENAI_MAX_AGENT_ELAPSED_MS: "4000",
  };
  if (providerId === "nvidia-nim") {
    delete shared.VESPER_OPENAI_API_KEY;
    delete shared.VESPER_OPENAI_MODEL;
    delete shared.VESPER_OPENAI_BASE_URL;
    delete shared.VESPER_OPENAI_TIMEOUT_MS;
    delete shared.VESPER_OPENAI_TOOL_CALLING_MODEL;
    delete shared.VESPER_OPENAI_MAX_AGENT_ELAPSED_MS;
    Object.assign(shared, {
      VESPER_NVIDIA_API_KEY: API_KEY,
      VESPER_NVIDIA_MODEL: "fixture-model",
      VESPER_NVIDIA_BASE_URL: baseUrl,
      VESPER_NVIDIA_TIMEOUT_MS: "4000",
      VESPER_NVIDIA_TOOL_CALLING_MODEL: "fixture-model",
      VESPER_NVIDIA_MAX_AGENT_ELAPSED_MS: "4000",
    });
  }
  return { ...shared, ...overrides };
}

function createProvider({ root, project, baseUrl, providerId = "openai-chat-completions", environment, onConversationId } = {}) {
  return createExecutionProvider({
    providerId,
    environment: environment || providerEnvironment(baseUrl, providerId),
    conversationDirectory: path.join(root, "conversations"),
    onConversationId,
  });
}

test("structured streamed calls assemble fragments, invoke multiple read-only tools, and return bounded results for a final JSON response", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "Local project evidence.\n", "utf8");
  const requests = [];
  const baseUrl = await localServer(t, async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    const body = await readJson(request);
    requests.push(body);
    if (requests.length === 1) {
      assert.ok(Array.isArray(body.tools));
      assert.ok(body.tools.some((entry) => entry.function.name === "read_file"));
      assert.ok(body.tools.some((entry) => entry.function.name === "list_files"));
      assert.ok(body.tools.every((entry) => entry.function.name !== "run_command"));
      sse(response, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_", type: "function", function: { name: "read_", arguments: "{\"path\":\"READ" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: "read", function: { name: "file", arguments: "ME.md\"}" } },
          { index: 1, id: "call_list", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } },
        ] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
      return;
    }
    assert.equal(requests.length, 2);
    const toolMessages = body.messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.ok(toolMessages.some((message) => message.content.includes("Local project evidence.")));
    assert.ok(toolMessages.some((message) => message.content.includes("README.md")));
    completeJson(response, "I inspected the README and project listing through Vesper.");
  });

  const provider = createProvider({ root, project, baseUrl });
  const runtime = createPermissionedToolRuntime({ projectRoot: project, sessionId: SESSION_ID });
  provider.setToolRuntime(runtime);
  const events = [];
  provider.on("event", (event) => events.push(event));
  try {
    const result = await provider.submitTask({ task: "Inspect the README and files.", projectPath: project });
    assert.equal(result.status, "completed");
    assert.equal(result.toolCallCount, 2);
    assert.equal(result.changedFiles, false);
    assert.deepEqual(events.filter((event) => event.type === "tool-call" && event.state === "requested").map((event) => event.toolId), ["read_file", "list_files"]);
    assert.equal(events.filter((event) => event.type === "tool-result" && event.state === "verified").length, 2);
    const history = await provider.readConversationHistory();
    assert.ok(history.entries.some((entry) => entry.text.includes("read_file, list_files")));
    assert.equal(requests[0].tool_choice, "auto");
    const conversationId = result.conversationId;
    provider.dispose();
    const resumed = createProvider({ root, project, baseUrl });
    await resumed.resumeConversation({ projectPath: project, conversationId });
    const resumedHistory = await resumed.readConversationHistory();
    assert.ok(resumedHistory.entries.some((entry) => entry.label === "Vesper permissioned tool result"));
    assert.ok(resumedHistory.entries.some((entry) => entry.text.includes("Local project evidence.")));
    resumed.dispose();
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

test("unknown tool names and malformed arguments become explicit tool errors and never reach the runtime", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const requests = [];
  const baseUrl = await localServer(t, async (request, response) => {
    requests.push(await readJson(request));
    if (requests.length === 1) {
      sse(response, [{ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_unknown", type: "function", function: { name: "delete_project", arguments: "{}" } },
        { index: 1, id: "call_badjson", type: "function", function: { name: "read_file", arguments: "{" } },
      ] }, finish_reason: "tool_calls" }] }]);
    } else {
      const toolMessages = requests.at(-1).messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 2);
      assert.ok(toolMessages.some((message) => message.content.includes("UNSUPPORTED_TOOL")));
      assert.ok(toolMessages.some((message) => message.content.includes("INVALID_ARGUMENT")));
      completeJson(response, "Vesper rejected both malformed requests.");
    }
  });
  const provider = createProvider({ root, project, baseUrl });
  const runtime = createPermissionedToolRuntime({ projectRoot: project, sessionId: SESSION_ID });
  provider.setToolRuntime(runtime);
  try {
    const result = await provider.submitTask({ task: "Inspect safely.", projectPath: project });
    assert.equal(result.status, "completed");
    assert.deepEqual(runtime.getAuditEvents(), []);
    assert.equal(requests.length, 2);
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

test("tool results are capped before being returned to the remote model", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "large.txt"), "private-project-content-".repeat(500), "utf8");
  let calls = 0;
  const baseUrl = await localServer(t, async (request, response) => {
    const body = await readJson(request);
    calls += 1;
    if (calls === 1) {
      sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_large", type: "function", function: {
        name: "read_file", arguments: "{\"path\":\"large.txt\"}",
      } }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    const toolMessage = body.messages.find((message) => message.role === "tool");
    assert.ok(Buffer.byteLength(toolMessage.content) <= 1_024);
    assert.match(toolMessage.content, /"truncated":true/u);
    assert.doesNotMatch(toolMessage.content, /private-project-content/u);
    completeJson(response, "The file result was capped.");
  });
  const environment = providerEnvironment(baseUrl, "openai-chat-completions", { VESPER_OPENAI_MAX_TOOL_RESULT_BYTES: "1024" });
  const provider = createProvider({ root, project, baseUrl, environment });
  const runtime = createPermissionedToolRuntime({ projectRoot: project, sessionId: SESSION_ID });
  provider.setToolRuntime(runtime);
  try {
    assert.equal((await provider.submitTask({ task: "Read the large file.", projectPath: project })).status, "completed");
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

test("model-requested file changes use the terminal's exact one-time approval and are verified after application", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "notes.txt"), "old value\n", "utf8");
  let proposalId;
  let requestCount = 0;
  const baseUrl = await localServer(t, async (request, response) => {
    const body = await readJson(request);
    requestCount += 1;
    if (requestCount === 1) {
      sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_propose", type: "function", function: {
        name: "propose_file_change", arguments: JSON.stringify({ path: "notes.txt", content: "new value\n" }),
      } }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    if (requestCount === 2) {
      const proposalToolResult = JSON.parse(body.messages.find((message) => message.role === "tool").content);
      proposalId = proposalToolResult.proposal.proposalId;
      assert.equal(proposalToolResult.state, "proposed");
      assert.equal(proposalToolResult.proposal.message, "Proposal created. No file was changed. A separate Vesper approval is required to apply it.");
      assert.equal(Object.hasOwn(proposalToolResult.proposal, "review"), false);
      sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_apply", type: "function", function: {
        name: "apply_file_change", arguments: JSON.stringify({ proposalId }),
      } }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    const result = JSON.parse(body.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_apply").content);
    assert.equal(result.state, "verified");
    assert.equal(result.proposalState, "applied");
    completeJson(response, "The approved change is applied and verified.");
  });
  const provider = createProvider({ root, project, baseUrl });
  let approvalPromptCount = 0;
  const output = { isTTY: true, text: "", write(value) { this.text += String(value); } };
  const terminal = new TerminalFrontend({
    cwd: project,
    handlers: {},
    executionProvider: provider,
    sessionId: SESSION_ID,
    input: { isTTY: true },
    output,
    lineIO: {
      async question(prompt) {
        if (prompt.includes("Approve file change once?")) {
          approvalPromptCount += 1;
          return "yes";
        }
        return null;
      },
      onInterrupt() {},
      close() {},
    },
  });
  try {
    assert.ok(terminal.toolRuntime.getDefinitions().find((entry) => entry.id === "apply_file_change").enabled);
    assert.equal(terminal.toolRuntime.getDefinitions().find((entry) => entry.id === "run_command").enabled, false);
    const result = await provider.submitTask({ task: "Update notes.txt.", projectPath: project });
    assert.equal(result.status, "completed");
    assert.equal(result.changedFiles, true);
    assert.equal(approvalPromptCount, 1);
    assert.equal(fs.readFileSync(path.join(project, "notes.txt"), "utf8"), "new value\n");
    assert.match(output.text, /Complete original content:[\s\S]*old value/u);
    assert.match(output.text, /Complete proposed content:[\s\S]*new value/u);
    assert.match(output.text, /approved once/u);
    assert.ok(proposalId);
  } finally {
    await terminal.toolRuntime.dispose();
    provider.dispose();
  }
});

test("disposing an active provider interrupts a pending tool approval before any file write", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const target = path.join(project, "notes.txt");
  fs.writeFileSync(target, "original\n", "utf8");
  let requestCount = 0;
  let approvalStarted;
  const waitingForApproval = new Promise((resolve) => { approvalStarted = resolve; });
  const baseUrl = await localServer(t, async (request, response) => {
    const body = await readJson(request);
    requestCount += 1;
    if (requestCount === 1) {
      sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_propose", type: "function", function: {
        name: "propose_file_change", arguments: JSON.stringify({ path: "notes.txt", content: "changed\n" }),
      } }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    const proposal = JSON.parse(body.messages.find((message) => message.role === "tool").content).proposal;
    sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_apply", type: "function", function: {
      name: "apply_file_change", arguments: JSON.stringify({ proposalId: proposal.proposalId }),
    } }] }, finish_reason: "tool_calls" }] }]);
  });
  const provider = createProvider({ root, project, baseUrl });
  const runtime = createPermissionedToolRuntime({
    projectRoot: project,
    sessionId: SESSION_ID,
    approvalHandler: async (_snapshot, { signal } = {}) => new Promise((resolve) => {
      approvalStarted();
      signal?.addEventListener("abort", () => resolve("approve-once"), { once: true });
    }),
  });
  provider.setToolRuntime(runtime);
  try {
    const task = provider.submitTask({ task: "Change notes.txt.", projectPath: project });
    await waitingForApproval;
    provider.dispose();
    await assert.rejects(task, (error) => error.code === "CONNECTION_LOST");
    assert.equal(requestCount, 2);
    assert.equal(fs.readFileSync(target, "utf8"), "original\n");
    assert.ok(runtime.getAuditEvents().some((event) => event.toolId === "apply_file_change" && event.state === "interrupted"));
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

test("NVIDIA NIM keeps its provider identity and only sends tool definitions for its exact configured model", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  let requestBody;
  const baseUrl = await localServer(t, async (request, response) => {
    requestBody = await readJson(request);
    completeJson(response, "NIM fixture response.");
  });
  const provider = createProvider({ root, project, baseUrl, providerId: "nvidia-nim" });
  const runtime = createPermissionedToolRuntime({ projectRoot: project, sessionId: SESSION_ID });
  provider.setToolRuntime(runtime);
  try {
    assert.equal(provider.id, "nvidia-nim");
    assert.equal(provider.getState().toolCallingEnabled, true);
    const result = await provider.submitTask({ task: "Describe this project.", projectPath: project });
    assert.equal(result.status, "completed");
    assert.ok(requestBody.tools.some((entry) => entry.function.name === "read_file"));
    assert.equal(requestBody.tools.some((entry) => entry.function.name === "run_command"), false);
    assert.equal(requestBody.tools.some((entry) => entry.function.name === "apply_file_change"), false);
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

test("tool-call budget fails before any tool executes; approval-gated tools stay disabled without a review UI", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  let requests = 0;
  const baseUrl = await localServer(t, async (request, response) => {
    requests += 1;
    await readJson(request);
    sse(response, [{ choices: [{ delta: { tool_calls: [
      { index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"missing.txt\"}" } },
      { index: 1, id: "call_b", type: "function", function: { name: "list_files", arguments: "{}" } },
    ] }, finish_reason: "tool_calls" }] }]);
  });
  const environment = providerEnvironment(baseUrl, "openai-chat-completions", { VESPER_OPENAI_MAX_TOOL_CALLS: "1" });
  const provider = createProvider({ root, project, baseUrl, environment });
  const runtime = createPermissionedToolRuntime({ projectRoot: project, sessionId: SESSION_ID });
  provider.setToolRuntime(runtime);
  try {
    assert.equal(runtime.getDefinitions().find((entry) => entry.id === "apply_file_change").enabled, false);
    await assert.rejects(provider.submitTask({ task: "Inspect files.", projectPath: project }), (error) => error.code === "TASK_FAILED");
    assert.equal(requests, 1);
    assert.deepEqual(runtime.getAuditEvents(), []);
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

test("tool-iteration budget stops the loop before dispatching another call", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "a.txt"), "a\n");
  let requests = 0;
  const baseUrl = await localServer(t, async (request, response) => {
    requests += 1;
    await readJson(request);
    sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: {
      name: "read_file", arguments: "{\"path\":\"a.txt\"}",
    } }] }, finish_reason: "tool_calls" }] }]);
  });
  const environment = providerEnvironment(baseUrl, "openai-chat-completions", { VESPER_OPENAI_MAX_TOOL_ITERATIONS: "1" });
  const provider = createProvider({ root, project, baseUrl, environment });
  const runtime = createPermissionedToolRuntime({ projectRoot: project, sessionId: SESSION_ID });
  provider.setToolRuntime(runtime);
  try {
    await assert.rejects(provider.submitTask({ task: "Read a file.", projectPath: project }), (error) => error.code === "TASK_FAILED");
    assert.equal(requests, 2, "the second response reaches the configured iteration boundary, but no third request is submitted");
    assert.equal(runtime.getAuditEvents().filter((event) => event.toolId === "read_file" && event.state === "verified").length, 1);
  } finally {
    await runtime.dispose();
    provider.dispose();
  }
});

