"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createExecutionProvider, getProviderStatus, listProviders, resolveDefaultProviderId } = require("../execution-provider");
const { NVIDIA_PROVIDER_ID } = require("../nvidia-nim-provider");
const { parseArgs, runVesper } = require("../cli");
const { SessionStore } = require("../session-store");

const PROJECT = path.resolve(process.cwd());
const API_KEY = "nvidia-fixture-secret-value";

function temporaryRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-nim-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function capture() {
  let value = "";
  return { stream: { write: (chunk) => { value += String(chunk); } }, text: () => value };
}

function fixtureEnvironment(overrides = {}) {
  return {
    VESPER_NVIDIA_API_KEY: API_KEY,
    VESPER_NVIDIA_MODEL: "fixture/nim-model",
    VESPER_NVIDIA_BASE_URL: "https://nim.example.test/v1",
    VESPER_NVIDIA_TIMEOUT_MS: "5000",
    ...overrides,
  };
}

function sseResponse() {
  const records = [
    { choices: [{ delta: { content: "Generated " }, finish_reason: null }] },
    { choices: [{ delta: { content: "text." }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ].map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");
  return new Response(`${records}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

test("NVIDIA NIM is an explicit provider with configuration-only model status and redacted secrets", () => {
  assert.equal(resolveDefaultProviderId({}), "codex-app-server");
  assert.ok(listProviders().some((provider) => provider.id === NVIDIA_PROVIDER_ID));
  const status = getProviderStatus(NVIDIA_PROVIDER_ID, fixtureEnvironment());
  assert.equal(status.configured, true);
  assert.equal(status.model, "fixture/nim-model");
  assert.equal(status.modelFreshness, "configured; not verified");
  assert.equal(status.reachability, "not checked");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(API_KEY, "u"));
  assert.equal(status.modelFeatures.toolCalling.includes("exact-model opt-in required"), true);

  const invalid = getProviderStatus(NVIDIA_PROVIDER_ID, fixtureEnvironment({ VESPER_NVIDIA_BASE_URL: "http://nim.example.test/v1" }));
  assert.equal(invalid.configured, false);
  assert.match(invalid.configurationMessages.join(" "), /VESPER_NVIDIA_BASE_URL must use HTTPS/u);
});

test("provider listing and configuration status stay offline and never reveal the configured key", async () => {
  const environment = fixtureEnvironment({ VESPER_PROVIDER: NVIDIA_PROVIDER_ID });
  const listing = capture();
  const listingErrors = capture();
  const status = capture();
  const statusErrors = capture();
  const fetchImpl = async () => assert.fail("Provider listing and configuration status must not contact an API.");

  assert.equal(await runVesper(["providers"], { environment, fetchImpl, output: listing.stream, errorOutput: listingErrors.stream }), 0);
  assert.equal(await runVesper(["providers", "status", "--provider", NVIDIA_PROVIDER_ID], {
    environment, fetchImpl, output: status.stream, errorOutput: statusErrors.stream,
  }), 0);
  assert.match(listing.text(), /Selected provider for new sessions: nvidia-nim/u);
  assert.match(listing.text(), /fixture\/nim-model \(not live-verified\)/u);
  assert.match(status.text(), /Reachability: not checked/u);
  assert.match(status.text(), /toolCalling: disabled by default; exact-model opt-in required/u);
  assert.doesNotMatch(`${listing.text()}${status.text()}${listingErrors.text()}${statusErrors.text()}`, new RegExp(API_KEY, "u"));
  assert.equal(listingErrors.text(), "");
  assert.equal(statusErrors.text(), "");
});

test("bounded model display still checks availability across the full bounded response", async (t) => {
  const root = temporaryRoot(t);
  const modelId = "fixture/last-model";
  const models = Array.from({ length: 110 }, (_, index) => ({ id: `fixture/model-${index}` }));
  models.push({ id: modelId });
  const provider = createExecutionProvider({
    providerId: NVIDIA_PROVIDER_ID,
    environment: fixtureEnvironment({ VESPER_NVIDIA_MODEL: modelId }),
    conversationDirectory: path.join(root, "conversations"),
    fetchImpl: async () => new Response(JSON.stringify({ data: models }), { status: 200 }),
  });
  const result = await provider.initialize({ projectPath: PROJECT, checkConnection: true });
  assert.equal(result.modelAvailable, true);
  assert.equal(result.modelIds.length, 100);
  assert.equal(result.modelIds.includes(modelId), false);
  provider.dispose();
});

test("NIM model check and streamed task reuse the compatible adapter and persist a provider-owned transcript", async (t) => {
  const root = temporaryRoot(t);
  const requests = [];
  const provider = createExecutionProvider({
    providerId: NVIDIA_PROVIDER_ID,
    environment: fixtureEnvironment(),
    conversationDirectory: path.join(root, "conversations"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "fixture/nim-model" }, { id: "another/model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sseResponse();
    },
  });
  const events = [];
  provider.on("event", (event) => events.push(event));

  const checked = await provider.initialize({ projectPath: PROJECT, checkConnection: true });
  assert.equal(checked.modelAvailable, true);
  assert.deepEqual(checked.modelIds, ["fixture/nim-model", "another/model"]);
  const result = await provider.submitTask({ task: "Explain the local API contract.", projectPath: PROJECT });
  assert.equal(result.status, "completed");
  assert.equal(result.executedCommands, false);
  assert.equal(result.changedFiles, false);
  assert.match(provider.getState().conversationId, /^nim_/u);
  assert.equal(events.some((event) => event.type === "text-delta" && event.text === "Generated "), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://nim.example.test/v1/models");
  assert.equal(requests[1].url, "https://nim.example.test/v1/chat/completions");
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${API_KEY}`);
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.model, "fixture/nim-model");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(Object.hasOwn(body, "tools"), false);

  const conversationId = provider.getState().conversationId;
  provider.dispose();
  const resumed = createExecutionProvider({
    providerId: NVIDIA_PROVIDER_ID,
    environment: fixtureEnvironment(),
    conversationDirectory: path.join(root, "conversations"),
    fetchImpl: async () => assert.fail("Resuming a NIM transcript must not make an API request."),
  });
  await resumed.resumeConversation({ projectPath: PROJECT, conversationId });
  const history = await resumed.readConversationHistory();
  assert.equal(history.entries.length, 2);
  assert.match(history.entries[1].label, /NVIDIA NIM text response · not executed/u);
  assert.equal(history.entries[1].text, "Generated text.");
  await assert.rejects(resumed.resumeConversation({ projectPath: PROJECT, conversationId: "oai_00000000-0000-4000-8000-000000000000" }),
    (error) => error.code === "RESUME_FAILED");
  resumed.dispose();
});

test("CLI pins a selected provider model to a new Vesper session", async (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const output = capture();
  const errors = capture();
  const environment = fixtureEnvironment();
  assert.deepEqual(parseArgs(["--provider", NVIDIA_PROVIDER_ID, "--model", "chosen/model", "--new", project]), {
    command: "run", newSession: true, resumeId: null, help: false, projectDirectory: project,
    providerId: NVIDIA_PROVIDER_ID, modelId: "chosen/model",
  });
  const result = await runVesper(["--provider", NVIDIA_PROVIDER_ID, "--model", "chosen/model", "--new", project], {
    store,
    environment,
    output: output.stream,
    errorOutput: errors.stream,
    fetchImpl: async () => assert.fail("Starting an idle session must not make a network request."),
    lineIO: { async question() { return null; }, onInterrupt() {}, close() {} },
  });
  const saved = store.findLatestByCwd(fs.realpathSync(project));
  assert.equal(result, 0);
  assert.equal(errors.text(), "");
  assert.equal(saved.providerId, NVIDIA_PROVIDER_ID);
  assert.equal(saved.modelId, "chosen/model");
  assert.match(output.text(), /Execution provider: nvidia-nim · model chosen\/model/u);
});
