"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPermissionedToolRuntime } = require("../permissioned-tool-runtime");
const { createRepositoryIntelligence } = require("../repository-intelligence");
const { createSystemModel, isComplexInvestigation, isModelAssistedEnabled, renderSystemModelReport } = require("../system-model");
const { createTaskEvidence } = require("../task-evidence");
const { createExecutionProvider } = require("../execution-provider");
const { runVesper } = require("../cli");

const COMPLEX_TASK = "Trace checkout from its route through the service and validation layers, then compare how related tests exercise error handling and explain which evidence is missing across the request path.";
const SESSION_A = "6c4182e0-46f5-4d74-95db-2e687b62aa47";
const SESSION_B = "7d5293f1-57a6-4e85-a6ec-3f798c73bb58";

function plannerResponse({ action = null, sufficientEvidence = false, reason = "Inspect the next candidate to resolve the open question.", unresolvedQuestions = [], hypotheses = [] } = {}, usage) {
  return { text: JSON.stringify({ sufficientEvidence, action, reason, unresolvedQuestions, hypotheses }), ...(usage ? { usage } : {}) };
}

function baseFindings() {
  return [
    { type: "symbol-definition", description: "Observed route declaration for checkout.", path: "src/route.js", lineStart: 4,
      source: "read_file", confidence: "high", observation: "observed", status: "confirmed", sourceContextRead: true },
    { type: "import-edge", description: "The route imports a local service module.", path: "src/route.js", relatedPath: "src/service.js", lineStart: 2,
      source: "read_file", confidence: "medium", observation: "inferred", status: "unknown", sourceContextRead: true, depth: 1 },
  ];
}

function baseCandidates() {
  return [
    { path: "src/service.js", sizeBytes: 200, score: 10, changed: false, entryPoint: false, searchMatch: true },
    { path: "src/validation.js", sizeBytes: 200, score: 7, changed: false, entryPoint: false, searchMatch: false },
    { path: "src/zeta.js", sizeBytes: 200, score: 4, changed: false, entryPoint: false, searchMatch: false },
  ];
}

function makeFakeRepository({ root = "/workspace-a", sessionId = SESSION_A, findings = baseFindings(), candidates = baseCandidates(), remainingBudget = {} } = {}) {
  const observedReads = [];
  const snapshots = [];
  let activeController = null;
  const repositoryIntelligence = {
    projectRoot: root,
    sessionId,
    async inspect({ task, intent, selectNextStep, signal }) {
      const controller = new AbortController();
      activeController = controller;
      const onAbort = () => controller.abort(signal?.reason || "cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const collected = findings.map((item) => ({ ...item }));
      const readPaths = [];
      const steps = [];
      let stopReason = "no-justified-next-step";
      let status = "complete";
      const incomplete = [];
      try {
        for (let index = 0; index < 6; index += 1) {
          const snapshot = Object.freeze({
            task,
            intent,
            findings: Object.freeze(collected.map((item) => Object.freeze({ ...item }))),
            candidateFiles: Object.freeze(candidates.map((item) => Object.freeze({ ...item }))),
            readPaths: Object.freeze([...readPaths]),
            pathDepths: Object.freeze({}),
            steps: Object.freeze([...steps]),
            unresolved: Object.freeze([]),
            remainingBudget: Object.freeze({
              operations: remainingBudget.operations ?? Math.max(0, 20 - index),
              targetedReads: remainingBudget.targetedReads ?? Math.max(0, 5 - readPaths.length),
              milliseconds: remainingBudget.milliseconds ?? Math.max(0, 8_000 - index * 250),
              sourceBytes: remainingBudget.sourceBytes ?? 48 * 1024,
            }),
            taskTerms: Object.freeze(["checkout"]),
            referenceCandidates: Object.freeze([]),
          });
          snapshots.push(snapshot);
          const proposal = await selectNextStep(snapshot, controller.signal);
          if (!proposal || proposal.stop === true) {
            stopReason = proposal?.reason || "sufficient-evidence";
            if (stopReason === "model-followup-budget") {
              status = "partial";
              incomplete.push("Adaptive follow-up budget reached.");
            }
            break;
          }
          const filePath = proposal.operation?.input?.path;
          observedReads.push(filePath);
          readPaths.push(filePath);
          steps.push({ index: steps.length + 1, operation: proposal.operation, purpose: proposal.purpose,
            requiredInputs: proposal.requiredInputs, expectedEvidence: proposal.expectedEvidence, state: "verified",
            result: { state: "verified", verified: true, summary: `Read ${filePath}.`, evidenceRefs: [{ type: "source-section", path: filePath, lineStart: 1 }] } });
          collected.push({ type: "source-section", description: `Read a bounded source section in ${filePath}.`, path: filePath, lineStart: 1,
            source: "read_file", confidence: "medium", observation: "observed", status: "confirmed", sourceContextRead: true });
        }
        if (controller.signal.aborted) {
          status = "cancelled";
          stopReason = "cancelled";
          incomplete.push("Repository investigation was cancelled.");
        }
        const evidence = createTaskEvidence({ sessionId, projectRoot: root });
        evidence.findings.push(...collected);
        evidence.investigation = {
          status,
          intent,
          steps,
          unresolved: [],
          remainingBudget: { operations: Math.max(0, 20 - steps.length), targetedReads: Math.max(0, 5 - steps.length), milliseconds: 8_000, sourceBytes: 48 * 1024 },
          stopReason,
          candidateDiscovery: { status: "complete", candidateFiles: candidates.length, searchedFiles: candidates.length, scannedFiles: candidates.length, scannedBytes: 120, matches: 1, queryCount: 1 },
        };
        const project = { fileCount: candidates.length, directoryCount: 1, languages: [], frameworks: [], dependencies: [], manifests: [], entryPoints: [], commands: [],
          structure: candidates.map((item) => item.path), candidateFiles: candidates, readPaths, truncated: Boolean(incomplete.length) };
        const git = { available: false, status: "", history: "", diff: "", coverage: "Git unavailable in fixture." };
        return { status, observedAt: new Date().toISOString(), project, git, findings: collected, referenceIndex: null,
          candidateDiscovery: evidence.investigation.candidateDiscovery, incomplete, evidence };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (activeController === controller) activeController = null;
      }
    },
    async interrupt() { activeController?.abort("interrupted"); return Boolean(activeController); },
  };
  return { repositoryIntelligence, observedReads, snapshots };
}

function createCoordinator(repository, planner, options = {}) {
  return createSystemModel({ repositoryIntelligence: repository.repositoryIntelligence, planner,
    modelAssistedEnabled: options.enabled ?? true, clock: options.clock || (() => Date.now()) });
}

test("deterministic fast path skips the planner for a simple trace and when assistance is disabled", async () => {
  assert.equal(isModelAssistedEnabled({}), false);
  assert.equal(isModelAssistedEnabled({ VESPER_SYSTEM_MODEL_ASSISTED: "1", VESPER_LOCAL_ONLY: "true" }), false);
  assert.equal(isComplexInvestigation("Trace checkoutRoute", "trace"), false);
  assert.equal(isComplexInvestigation(COMPLEX_TASK, "trace"), true);
  let calls = 0;
  const planner = { async planInvestigation() { calls += 1; return plannerResponse({ sufficientEvidence: true }); } };
  const repository = makeFakeRepository();
  const result = await createCoordinator(repository, planner).investigate({ task: "Trace checkoutRoute", intent: "trace" });
  assert.equal(calls, 0);
  assert.equal(result.modelPlanning.mode, "deterministic");
  assert.equal(result.modelPlanning.reason, "deterministic-fast-path");
  assert.equal(repository.observedReads[0], "src/service.js");

  const disabledRepo = makeFakeRepository();
  const disabled = await createCoordinator(disabledRepo, planner, { enabled: false }).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(calls, 0);
  assert.equal(disabled.modelPlanning.reason, "model-assisted-planning-disabled");

  const codexRepository = makeFakeRepository();
  const codexWithoutPlanning = await createCoordinator(codexRepository, null).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(codexWithoutPlanning.modelPlanning.calls, 0);
  assert.equal(codexWithoutPlanning.modelPlanning.reason, "selected-provider-has-no-planning-interface");
});

test("complex investigation adapts the next read and keeps hypotheses cited and explicitly unverified", async () => {
  const repository = makeFakeRepository();
  const requests = [];
  const planner = {
    id: "openai-chat-completions",
    getState: () => ({ model: "fixture-model" }),
    async planInvestigation(request) {
      requests.push(request);
      if (requests.length === 1) return plannerResponse({
        action: { toolId: "read_file", path: "src/validation.js", depth: 1 },
        reason: "Check the unread validation candidate against the route evidence.",
        unresolvedQuestions: ["Does validation happen before the service call?"],
        hypotheses: [{ text: "The route may validate input before dispatch.", evidenceIds: [0] }],
      }, { inputTokens: 300, outputTokens: 40, totalTokens: 340 });
      return plannerResponse({ sufficientEvidence: true, reason: "The remaining local evidence is sufficient for this bounded question." },
        { inputTokens: 310, outputTokens: 25, totalTokens: 335 });
    },
  };
  const result = await createCoordinator(repository, planner).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.deepEqual(repository.observedReads, ["src/validation.js"]);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].userPrompt.includes("unreadCandidateFiles"));
  assert.ok(requests[0].userPrompt.includes("lineStart"));
  assert.equal(result.modelPlanning.mode, "model-assisted");
  assert.equal(result.modelPlanning.followupSteps, 1);
  assert.equal(result.modelPlanning.tokenUsage.totalTokens, 675);
  assert.equal(result.modelPlanning.sourceBytesSent, 0);
  assert.equal(result.stopReason, "model-sufficient-evidence");
  assert.match(result.modelPlanning.hypotheses[0].label, /unverified/u);
  assert.equal(result.modelPlanning.hypotheses[0].provenance, "model-generated");
  assert.deepEqual(result.modelPlanning.hypotheses[0].evidenceRefs[0], {
    type: "symbol-definition", path: "src/route.js", lineStart: 4, lineEnd: null, confidence: "high", observation: "observed", sourceContextRead: true,
  });
  assert.ok(result.providerContext.includes("Unverified model hypothesis"));
  const report = renderSystemModelReport(result);
  assert.match(report, /Model hypothesis \(unverified\)/u);
  assert.match(report, /symbol-definition src\/route\.js:4/u);
  assert.match(report, /Unresolved questions/u);
});

test("malformed, unsupported, and out-of-scope proposals are rejected before deterministic fallback", async (t) => {
  const rejected = [
    "not-json",
    plannerResponse({ action: { toolId: "run_command", path: "src/service.js", depth: 1 } }).text,
    plannerResponse({ action: { toolId: "read_file", path: "../outside.js", depth: 1 } }).text,
  ];
  for (const text of rejected) {
    const repository = makeFakeRepository();
    let calls = 0;
    const planner = { async planInvestigation() { calls += 1; return { text }; } };
    const result = await createCoordinator(repository, planner).investigate({ task: COMPLEX_TASK, intent: "trace" });
    assert.equal(calls, 1);
    assert.equal(repository.observedReads[0], "src/service.js");
    assert.equal(result.modelPlanning.mode, "deterministic-fallback");
    assert.equal(result.modelPlanning.rejectedProposals, 1);
  }
  const overBudgetRepo = makeFakeRepository({ remainingBudget: { targetedReads: 0 } });
  let overBudgetCalls = 0;
  const overBudgetPlanner = { async planInvestigation() {
    overBudgetCalls += 1;
    return plannerResponse({ action: { toolId: "read_file", path: "src/validation.js", depth: 1 } });
  } };
  const overBudget = await createCoordinator(overBudgetRepo, overBudgetPlanner).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(overBudgetCalls, 1);
  assert.equal(overBudgetRepo.observedReads[0], "src/service.js");
  assert.equal(overBudget.modelPlanning.reason, "out-of-scope-or-over-budget-model-action");
});

test("model timeout, malformed output, token exhaustion, and planning-call exhaustion fall back safely", async () => {
  const timeoutRepository = makeFakeRepository();
  const timeoutPlanner = { async planInvestigation() { const error = new Error("timeout"); error.code = "PROVIDER_UNAVAILABLE"; throw error; } };
  const timeout = await createCoordinator(timeoutRepository, timeoutPlanner).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(timeout.modelPlanning.mode, "deterministic-fallback");
  assert.equal(timeoutRepository.observedReads[0], "src/service.js");

  const malformedRepository = makeFakeRepository();
  const malformed = await createCoordinator(malformedRepository, { async planInvestigation() { return { text: "{}" }; } })
    .investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(malformed.modelPlanning.reason, "invalid-model-schema");
  assert.equal(malformedRepository.observedReads[0], "src/service.js");

  const tokenRepository = makeFakeRepository();
  const tokenBudget = await createCoordinator(tokenRepository, { async planInvestigation() {
    return plannerResponse({ action: { toolId: "read_file", path: "src/validation.js", depth: 1 } },
      { inputTokens: 7_900, outputTokens: 101, totalTokens: 8_001 });
  } }).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(tokenBudget.modelPlanning.reason, "model-token-budget");
  assert.equal(tokenRepository.observedReads[0], "src/service.js");

  const callsRepository = makeFakeRepository();
  let calls = 0;
  const callBudget = await createCoordinator(callsRepository, { async planInvestigation(request) {
    calls += 1;
    const payload = JSON.parse(request.userPrompt);
    const path = calls === 1 ? "src/validation.js" : "src/zeta.js";
    assert.ok(payload.unreadCandidateFiles.some((item) => item.path === path));
    return plannerResponse({ action: { toolId: "read_file", path, depth: 1 } });
  } }).investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.equal(calls, 2);
  assert.deepEqual(callsRepository.observedReads.slice(0, 2), ["src/validation.js", "src/zeta.js"]);
  assert.equal(callBudget.modelPlanning.mode, "deterministic-fallback");
  assert.equal(callBudget.modelPlanning.reason, "model-planning-call-budget");
});

test("planning cancellation stops before a follow-up read", async () => {
  const repository = makeFakeRepository();
  const external = new AbortController();
  let called = false;
  const planner = { async planInvestigation({ signal }) {
    called = true;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    });
  } };
  const model = createCoordinator(repository, planner);
  const investigation = model.investigate({ task: COMPLEX_TASK, intent: "trace", signal: external.signal });
  await new Promise((resolve) => setImmediate(resolve));
  external.abort("test-cancel");
  const result = await investigation;
  assert.equal(called, true);
  assert.equal(repository.observedReads.length, 0);
  assert.equal(result.status, "cancelled");
  assert.equal(result.modelPlanning.mode, "cancelled");
  assert.equal(result.stopReason, "cancelled");
});

test("OpenAI and NVIDIA planning use the selected provider model without tools or conversation persistence", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-planner-provider-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const scenarios = [
    { providerId: "openai-chat-completions", env: { OPENAI_API_KEY: "openai-fixture-key", VESPER_OPENAI_MODEL: "fixture-openai", VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1" }, model: "fixture-openai", baseUrl: "https://api.fixture.test/v1", key: "openai-fixture-key" },
    { providerId: "nvidia-nim", env: { NVIDIA_API_KEY: "nvidia-fixture-key", VESPER_NVIDIA_MODEL: "fixture/nim", VESPER_NVIDIA_BASE_URL: "https://nim.fixture.test/v1" }, model: "fixture/nim", baseUrl: "https://nim.fixture.test/v1", key: "nvidia-fixture-key" },
  ];
  for (const scenario of scenarios) {
    let request;
    const provider = createExecutionProvider({
      providerId: scenario.providerId,
      environment: scenario.env,
      conversationDirectory: path.join(parent, scenario.providerId),
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const response = await provider.planInvestigation({ systemPrompt: "Planner instructions.", userPrompt: "Bounded project evidence.", timeoutMs: 1_000, maxOutputTokens: 80, maxOutputBytes: 2_000 });
    assert.equal(request.url, `${scenario.baseUrl}/chat/completions`);
    assert.equal(request.options.headers.Authorization, `Bearer ${scenario.key}`);
    assert.equal(request.body.model, scenario.model);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.store, false);
    assert.equal(Object.hasOwn(request.body, "tools"), false);
    assert.equal(response.providerId, scenario.providerId);
    assert.equal(response.modelId, scenario.model);
    assert.equal(response.usage.totalTokens, 16);
    assert.equal(provider.getState().conversationId, null);
    assert.equal(provider.getState().state, "configured");
    provider.dispose();
  }
});

test("the compatible provider rejects tool-directed planning responses", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-planner-reject-tools-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const provider = createExecutionProvider({
    providerId: "openai-chat-completions",
    environment: { OPENAI_API_KEY: "fixture-key", VESPER_OPENAI_MODEL: "fixture-model", VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1" },
    conversationDirectory: path.join(parent, "conversations"),
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{
      message: { content: "", tool_calls: [{ id: "call_command", type: "function", function: { name: "run_command", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(provider.planInvestigation({ systemPrompt: "Planner instructions.", userPrompt: "Bounded project evidence." }),
    (error) => /tool-directed investigation planning output/u.test(error.message));
  assert.equal(provider.getState().conversationId, null);
  provider.dispose();
});

test("provider cancellation aborts a planning request without creating conversation state", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-planner-cancel-provider-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const provider = createExecutionProvider({
    providerId: "openai-chat-completions",
    environment: { OPENAI_API_KEY: "fixture-key", VESPER_OPENAI_MODEL: "fixture-model", VESPER_OPENAI_BASE_URL: "https://api.fixture.test/v1" },
    conversationDirectory: path.join(parent, "conversations"),
    fetchImpl: async (_url, options) => new Promise((_, reject) => {
      requestStarted();
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    }),
  });
  const controller = new AbortController();
  const planning = provider.planInvestigation({ systemPrompt: "Planner instructions.", userPrompt: "Bounded project evidence.", signal: controller.signal, timeoutMs: 2_000 });
  await started;
  controller.abort("test-cancel");
  await assert.rejects(planning, (error) => error.name === "AbortError");
  assert.equal(provider.getState().conversationId, null);
  provider.dispose();
});

test("CLI inspection falls back to the deterministic System Model when planner setup fails", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-planner-cli-fallback-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "route.js"), "export function checkoutRoute() {}\n");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let outputText = "";
  let errorText = "";
  const code = await runVesper(["inspect", COMPLEX_TASK, "--project", root], {
    environment: { VESPER_PROVIDER: "openai-chat-completions", VESPER_SYSTEM_MODEL_ASSISTED: "1" },
    investigationPlannerFactory: async () => { throw new Error("fixture planner setup failure"); },
    repositoryToolRuntimeFactory: ({ projectRoot, sessionId }) => createPermissionedToolRuntime({ projectRoot, sessionId,
      commandExecutionEnabled: false, commandWorkspaceWriteEnabled: false }),
    output: { write(value) { outputText += String(value); } },
    errorOutput: { write(value) { errorText += String(value); } },
  });
  assert.equal(code, 0);
  assert.equal(errorText, "");
  assert.match(outputText, /Adaptive planning: deterministic · 0 model calls · 0 model-selected reads · selected-provider-setup-unavailable/u);
  assert.match(outputText, /src\/route\.js/u);
});

test("planner input is bounded, redacted, and isolated to the current task evidence", async () => {
  const hugeCandidates = Array.from({ length: 100 }, (_, index) => ({ path: `src/candidate-${index}.js`, sizeBytes: 100, score: 5, changed: false, entryPoint: false, searchMatch: false }));
  const sensitiveFindings = [...baseFindings(), { type: "reference", description: "Authorization: Bearer local-secret-token-123456", path: "src/route.js", lineStart: 9,
    source: "search_files", confidence: "medium", observation: "observed", status: "confirmed" }];
  const repositoryA = makeFakeRepository({ root: "/project-a", sessionId: SESSION_A, findings: sensitiveFindings, candidates: hugeCandidates });
  const prompts = [];
  const planner = { async planInvestigation(request) { prompts.push(request.userPrompt); return plannerResponse({ sufficientEvidence: true }); } };
  const modelA = createCoordinator(repositoryA, planner);
  const taskA = `${COMPLEX_TASK} password=private-value-98765`;
  const resultA = await modelA.investigate({ task: taskA, intent: "trace" });
  assert.ok(Buffer.byteLength(prompts[0], "utf8") < 12 * 1024);
  assert.doesNotMatch(prompts[0], /private-value-98765|local-secret-token-123456/u);
  assert.equal(resultA.evidence.context.projectRoot, "/project-a");
  assert.equal(resultA.evidence.context.sessionId, SESSION_A);

  const repositoryB = makeFakeRepository({ root: "/project-b", sessionId: SESSION_B,
    findings: [{ ...baseFindings()[0], path: "lib/payment.js", description: "Observed payment handler." }],
    candidates: [{ path: "lib/payment.js", sizeBytes: 100, score: 10, entryPoint: true }] });
  await createCoordinator(repositoryB, planner).investigate({ task: "Trace the payment route through authorization, ledger, and settlement components and summarize missing evidence across these layers.", intent: "trace" });
  assert.ok(prompts[0].includes("/project-a") === false);
  assert.ok(!prompts[0].includes("lib/payment.js"));
  assert.ok(prompts[1].includes("lib/payment.js"));
  assert.ok(!prompts[1].includes("src/candidate-"));
  assert.equal(repositoryB.repositoryIntelligence.sessionId, SESSION_B);
});

test("permissioned runtime executes only the model-selected in-scope read and never modifies files or runs commands", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-model-plan-runtime-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "src/route.js", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src", "route.js"), 'import { loadCheckout } from "./service.js";\nexport function checkoutRoute(input) { return loadCheckout(input); }\n');
  fs.writeFileSync(path.join(root, "src", "service.js"), 'export function loadCheckout(input) { return input; }\n');
  fs.writeFileSync(path.join(root, "src", "zeta.js"), 'export function unrelatedZeta(input) { return input; }\n');
  for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "omega"]) {
    fs.writeFileSync(path.join(root, "src", `${name}.js`), `export function ${name}(input) { return input; }\n`);
  }
  const targetPath = path.join(root, "src", "zeta.js");
  const originalHash = crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId, commandExecutionEnabled: false, commandWorkspaceWriteEnabled: false });
  t.after(() => runtime.dispose());
  const repositoryIntelligence = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });
  const planner = {
    id: "openai-chat-completions",
    async planInvestigation({ userPrompt }) {
      const payload = JSON.parse(userPrompt);
      const target = payload.unreadCandidateFiles.find((item) => item.path === "src/zeta.js") ||
        payload.unreadCandidateFiles.find((item) => item.path !== "src/service.js");
      assert.ok(target);
      return plannerResponse({ action: { toolId: "read_file", path: target.path, depth: 1 }, reason: "Inspect one unread candidate after the observed route evidence." });
    },
  };
  const model = createSystemModel({ repositoryIntelligence, planner, modelAssistedEnabled: true });
  const result = await model.investigate({ task: COMPLEX_TASK, intent: "trace" });
  assert.ok(result.steps.some((step) => step.purpose.includes("Model planner rationale (unverified)")));
  assert.ok(result.steps.some((step) => step.purpose.includes("Model planner rationale") && step.operation.toolId === "read_file" && step.operation.input.path !== "src/service.js"));
  assert.ok(runtime.getAuditEvents().every((event) => event.toolId !== "run_command" && event.toolId !== "apply_file_change" && event.toolId !== "propose_file_change"));
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex"), originalHash);
  assert.equal(result.evidence.context.sessionId, sessionId);
});
