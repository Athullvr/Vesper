"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, runVesper } = require("../cli");
const { createCapabilityProvider } = require("../capability-catalog");
const { classifyRequest, routeRequest } = require("../routing-core");
const {
  MAX_RUNTIME_AGE_MS,
  createCapabilityPlan,
  evaluateCapabilityState,
  getPlanningMetadata,
  renderCapabilityPlan,
} = require("../capability-planner");

const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const SOURCE = "Codex app-server mcpServer/startupStatus/updated";

function mcp(overrides = {}) {
  return {
    id: "mcp:postgres",
    type: "mcp",
    name: "postgres",
    displayName: "PostgreSQL",
    description: "Read and query a configured database.",
    configurationStatus: "enabled",
    installationStatus: "not_applicable",
    enabledStatus: "yes",
    availabilityStatus: "available_for_use",
    runtimeLoadedStatus: "yes",
    operationalStatus: "unknown",
    requirementsStatus: "unknown",
    declaredCapabilities: { status: "unknown", items: [] },
    runtimeEvidence: {
      status: "observed",
      source: SOURCE,
      observedAt: new Date(NOW - 1_000).toISOString(),
      startupStatus: "ready",
    },
    ...overrides,
  };
}

function catalog(capabilities = [], runtimeInspection = {}) {
  return {
    schemaVersion: 1,
    capabilities,
    runtimeInspection: { checkedAt: new Date(NOW).toISOString(), ...runtimeInspection },
    diagnostics: [],
  };
}

function capture() {
  let value = "";
  return { stream: { write: (text) => { value += String(text); } }, text: () => value };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-plan-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

class FakeLineIO {
  constructor(answers) { this.answers = [...answers]; }
  async question() { return this.answers.length ? this.answers.shift() : null; }
  onInterrupt() {}
  close() {}
}

test("planner matches a database MCP by explainable metadata and keeps operational status unknown", () => {
  const plan = createCapabilityPlan({
    task: "Query the configured database for the latest migration state",
    catalog: catalog([mcp()]),
    routeDecision: { route: "codex", reason: "codex_fallback" },
    now: NOW,
  });

  assert.equal(plan.category, "database");
  assert.deepEqual(plan.recommendedCapabilityIds, ["mcp:postgres"]);
  assert.equal(plan.relevantCapabilities[0].eligibility, "usable");
  assert.equal(plan.relevantCapabilities[0].state.runtimeLoaded, "yes");
  assert.equal(plan.relevantCapabilities[0].state.operational, "unknown");
  assert.match(plan.relevantCapabilities[0].missingPrerequisites.join(" "), /health check|tool call/u);
  assert.match(renderCapabilityPlan(plan), /advisory only · not executed/u);
  assert.match(renderCapabilityPlan(plan), /Codex-reported MCP startup: ready/u);
  assert.match(renderCapabilityPlan(plan), /operational unknown/u);
});

test("failed and cancelled MCP startup states are not recommended as available", () => {
  for (const startupStatus of ["failed", "cancelled"]) {
    const capability = mcp({
      availabilityStatus: "unavailable",
      runtimeLoadedStatus: "no",
      operationalStatus: "no",
      runtimeEvidence: { status: "observed", source: SOURCE, observedAt: new Date(NOW - 1_000).toISOString(), startupStatus },
    });
    const evaluated = evaluateCapabilityState(capability, { catalog: catalog([capability]), now: NOW });
    const plan = createCapabilityPlan({ task: "Query the PostgreSQL database", catalog: catalog([capability]), routeDecision: { route: "codex", reason: "codex_fallback" }, now: NOW });
    assert.equal(evaluated.eligibility, "unavailable");
    assert.equal(evaluated.reasonCode, startupStatus === "failed" ? "capability_startup_failed" : "capability_startup_cancelled");
    assert.deepEqual(plan.recommendedCapabilityIds, []);
    assert.equal(plan.declinedCapabilities[0].reasonCode, evaluated.reasonCode);

    const contradictory = mcp({
      runtimeEvidence: { status: "observed", source: SOURCE, observedAt: new Date(NOW - 1_000).toISOString(), startupStatus },
    });
    const contradictoryResult = evaluateCapabilityState(contradictory, { catalog: catalog([contradictory]), now: NOW });
    assert.equal(contradictoryResult.eligibility, "unavailable");
    assert.equal(contradictoryResult.reasonCode, evaluated.reasonCode);
  }
});

test("in-progress startup and explicit disablement remain distinct from availability", () => {
  const starting = mcp({
    availabilityStatus: "unknown",
    runtimeLoadedStatus: "unknown",
    runtimeEvidence: { status: "observed", source: SOURCE, observedAt: new Date(NOW - 1_000).toISOString(), startupStatus: "starting" },
  });
  const startingResult = evaluateCapabilityState(starting, { catalog: catalog([starting]), now: NOW });
  assert.equal(startingResult.eligibility, "uncertain");
  assert.equal(startingResult.reasonCode, "runtime_startup_in_progress");

  const disabled = mcp({
    configurationStatus: "disabled",
    enabledStatus: "no",
    availabilityStatus: "unavailable",
    runtimeLoadedStatus: "no",
    runtimeEvidence: { status: "observed", source: SOURCE, observedAt: new Date(NOW - 1_000).toISOString(), startupStatus: "ready" },
  });
  const disabledResult = evaluateCapabilityState(disabled, { catalog: catalog([disabled]), now: NOW });
  assert.equal(disabledResult.eligibility, "unavailable");
  assert.equal(disabledResult.reasonCode, "capability_disabled");
});

test("stale runtime observations remain uncertain and report their original timestamp", () => {
  const capability = mcp({
    runtimeEvidence: { status: "observed", source: SOURCE, observedAt: new Date(NOW - MAX_RUNTIME_AGE_MS - 1).toISOString(), startupStatus: "ready" },
  });
  const evaluated = evaluateCapabilityState(capability, { catalog: catalog([capability]), now: NOW });
  assert.equal(evaluated.eligibility, "uncertain");
  assert.equal(evaluated.reasonCode, "runtime_evidence_stale");
  assert.equal(evaluated.freshness, "stale");
  assert.ok(evaluated.observedAt);

  const oldFailure = mcp({
    availabilityStatus: "unavailable",
    runtimeLoadedStatus: "no",
    operationalStatus: "no",
    runtimeEvidence: { status: "observed", source: SOURCE, observedAt: new Date(NOW - MAX_RUNTIME_AGE_MS - 1).toISOString(), startupStatus: "failed" },
  });
  const oldFailureEvaluation = evaluateCapabilityState(oldFailure, { catalog: catalog([oldFailure]), now: NOW });
  assert.equal(oldFailureEvaluation.eligibility, "uncertain");
  assert.equal(oldFailureEvaluation.reasonCode, "runtime_evidence_stale");
});

test("missing and unsupported runtime evidence never imply availability", () => {
  const missing = mcp({ runtimeEvidence: { status: "unknown", source: SOURCE, observedAt: null }, availabilityStatus: "unknown", runtimeLoadedStatus: "unknown" });
  const unsupported = {
    id: "skill:project/db-query/SKILL.md",
    type: "skill",
    name: "database-query",
    displayName: "Database query workflow",
    description: "Guides querying a configured database.",
    configurationStatus: "present",
    installationStatus: "not_applicable",
    enabledStatus: "unknown",
    availabilityStatus: "unknown",
    runtimeLoadedStatus: "unknown",
    operationalStatus: "unknown",
    requirementsStatus: "unknown",
    runtimeEvidence: { status: "unsupported", source: SOURCE, observedAt: null },
  };
  const plan = createCapabilityPlan({
    task: "Query the database",
    catalog: catalog([missing, unsupported]),
    routeDecision: { route: "codex", reason: "codex_fallback" },
    now: NOW,
  });
  assert.equal(plan.relevantCapabilities.length, 2);
  assert.ok(plan.relevantCapabilities.every((candidate) => candidate.eligibility === "uncertain"));
  assert.equal(plan.relevantCapabilities.find((candidate) => candidate.id === unsupported.id).reasonCode, "runtime_inspection_unsupported");
  assert.deepEqual(plan.recommendedCapabilityIds, []);
});

test("matching uses supported command metadata, skips malformed entries, and allows a no-capability plan", () => {
  const commandCapability = {
    id: "mcp:warehouse",
    type: "mcp",
    name: "warehouse",
    supportedCommands: ["query database records"],
    runtimeEvidence: { status: "unknown", observedAt: null },
  };
  const plan = createCapabilityPlan({
    task: "Query the database",
    catalog: catalog([null, { id: "", type: "plugin", name: "broken" }, commandCapability]),
    routeDecision: { route: "codex", reason: "codex_fallback" },
    now: NOW,
  });
  assert.equal(plan.malformedCatalogEntries, 2);
  assert.equal(plan.relevantCapabilities[0].id, "mcp:warehouse");
  assert.equal(plan.relevantCapabilities[0].matchReasonCode, "capability_topic_match");

  const noMatch = createCapabilityPlan({
    task: "Draft a short release announcement",
    catalog: catalog([mcp()]),
    routeDecision: { route: "codex", reason: "codex_fallback" },
    now: NOW,
  });
  assert.equal(noMatch.relevantCapabilities.length, 0);
  assert.equal(noMatch.executionPath.kind, "codex_fallback");
  assert.match(renderCapabilityPlan(noMatch), /Relevant capabilities: none/u);
});

test("a deterministic local route remains local and does not attract capability suggestions", () => {
  const decision = classifyRequest("What Git branch am I on?");
  const gitCapability = mcp({ id: "mcp:git-helper", name: "git-helper", displayName: "Git branch helper", description: "Check Git branch and repository status." });
  const plan = createCapabilityPlan({ task: "What Git branch am I on?", catalog: catalog([gitCapability]), routeDecision: decision, now: NOW });
  assert.equal(decision.route, "local");
  assert.equal(plan.executionPath.kind, "local_handler");
  assert.equal(plan.relevantCapabilities.length, 1);
  assert.equal(plan.relevantCapabilities[0].eligibility, "usable");
  assert.deepEqual(plan.recommendedCapabilityIds, []);
  assert.equal(plan.declinedCapabilities[0].reasonCode, "local_route_sufficient");
});

test("bounded routing metadata contains only categories, ids, states, and reason codes", async () => {
  const task = "Query the database for issue sk-proj-1234567890abcdef and preserve it";
  const plan = createCapabilityPlan({ task, catalog: catalog([mcp()]), routeDecision: classifyRequest(task), now: NOW });
  const serialized = JSON.stringify(plan.routingMetadata);
  assert.doesNotMatch(serialized, /Query the database|sk-proj-1234567890abcdef|preserve it/u);
  assert.equal(plan.routingMetadata.advisoryOnly, true);
  assert.ok(plan.routingMetadata.relevantCapabilityIds.length <= 6);

  const provider = { getCatalog: async () => catalog([mcp()]) };
  const metadata = await getPlanningMetadata({ task, capabilityProvider: provider, routeDecision: classifyRequest(task), now: NOW });
  const routed = await routeRequest(task, {
    decision: classifyRequest(task),
    context: { planning: metadata },
    fallback: async (decision, context) => ({ route: decision.route, planning: context.planning }),
  });
  assert.equal(routed.decision.route, "codex");
  assert.equal(routed.fallbackResult.route, "codex");
  assert.deepEqual(routed.fallbackResult.planning, metadata);
  assert.doesNotMatch(JSON.stringify(routed.fallbackResult.planning), /sk-proj-1234567890abcdef/u);
});

test("secret-like capability metadata is neither matched on nor copied into plan metadata", () => {
  const capability = mcp({
    name: "postgres sk-proj-1234567890abcdef",
    displayName: "PostgreSQL",
    description: "password=local-only-secret database access",
  });
  const plan = createCapabilityPlan({
    task: "Query the database using password=local-only-secret",
    catalog: catalog([capability]),
    routeDecision: { route: "codex", reason: "codex_fallback" },
    now: NOW,
  });
  const serializedPlan = JSON.stringify(plan);
  assert.doesNotMatch(serializedPlan, /sk-proj-1234567890abcdef|local-only-secret/u);
  assert.doesNotMatch(JSON.stringify(plan.routingMetadata), /postgres sk-proj|password/u);
});

test("planning can refresh only passive runtime evidence while retaining the cached catalog", async () => {
  let discoveries = 0;
  let inspections = 0;
  const mapperRegistry = new Map([[
    "mcp",
    (item) => ({
      id: `mcp:${item.name}`,
      type: "mcp",
      name: item.name,
      displayName: "PostgreSQL database",
      description: "Query the database.",
      configurationStatus: "enabled",
      installationStatus: "not_applicable",
      enabledStatus: "yes",
      availabilityStatus: "unknown",
      runtimeLoadedStatus: "unknown",
      operationalStatus: "unknown",
      requirementsStatus: "unknown",
      runtimeEvidence: { status: "unknown", source: SOURCE, observedAt: null },
      actions: ["show"],
      source: { name: "fixture", location: [] },
    }),
  ]]);
  const provider = createCapabilityProvider({
    cwd: "/workspace",
    mapperRegistry,
    sourceAdapters: new Map([[
      "mcp",
      { type: "mcp", discover: async () => { discoveries += 1; return { items: [{ name: "postgres" }], notes: [] }; } },
    ]]),
    runtimeStatusAdapter: {
      provider: "fixture",
      inspect: async () => {
        inspections += 1;
        if (inspections === 1) return { status: "available", provider: "fixture", source: SOURCE, items: [] };
        return {
          status: "observed",
          provider: "fixture",
          source: SOURCE,
          items: [{
            type: "mcp", name: "postgres", availabilityStatus: "available_for_use", runtimeLoadedStatus: "yes",
            operationalStatus: "unknown", observedAt: new Date(NOW - 1_000).toISOString(), startupStatus: "ready",
          }],
        };
      },
    },
  });

  const first = await provider.getCatalog();
  const refreshed = await provider.getCatalog({ refreshRuntime: true });
  assert.equal(first.capabilities[0].availabilityStatus, "unknown");
  assert.equal(refreshed.capabilities[0].availabilityStatus, "available_for_use");
  assert.equal(refreshed.capabilities[0].runtimeEvidence.startupStatus, "ready");
  assert.equal(discoveries, 1);
  assert.equal(inspections, 2);
});

test("vesper plan parses and renders a preview without creating a Vesper session", async (t) => {
  const project = fixture(t);
  const task = "Query the configured database";
  assert.deepEqual(parseArgs(["plan", "Query", "the", "configured", "database", "--project", project]), {
    command: "plan", task, projectDirectory: project, help: false,
  });
  const output = capture();
  const errors = capture();
  const provider = { getCatalog: async () => catalog([mcp()]) };
  const status = await runVesper(["plan", task, "--project", project], {
    output: output.stream,
    errorOutput: errors.stream,
    capabilityProvider: provider,
    planningNow: NOW,
  });
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /Vesper plan · advisory only · not executed/u);
  assert.match(output.text(), /mcp:postgres/u);
  assert.doesNotMatch(output.text(), /configured database/u);
});

test("interactive :plan previews the task without dispatching a Codex turn", async (t) => {
  const project = fixture(t);
  const output = capture();
  const errors = capture();
  let catalogReads = 0;
  const provider = { getCatalog: async (options) => { assert.equal(options.refresh, true); catalogReads += 1; return catalog([mcp()]); } };
  const clientFactory = (options) => {
    const client = new EventEmitter();
    client.runTurn = async () => assert.fail("A plan preview must not dispatch a Codex turn.");
    client.interrupt = async () => false;
    client.dispose = () => {};
    client.initialThreadId = options.initialThreadId;
    return client;
  };
  const status = await runVesper(["--new", project], {
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO([":plan Query the PostgreSQL database", ":quit"]),
    capabilityProvider: provider,
    clientFactory,
    store: new (require("../session-store").SessionStore)({ directory: path.join(project, ".sessions") }),
  });
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.equal(catalogReads, 1);
  assert.match(output.text(), /Vesper plan · advisory only · not executed/u);
  assert.match(output.text(), /mcp:postgres/u);
});
