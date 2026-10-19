"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCAL_INTENTS,
  RouteMetrics,
  classifyRequest,
  normalizeRequest,
  routeRequest,
} = require("../routing-core");

test("normalization folds case, punctuation, Unicode compatibility forms, and spacing", () => {
  assert.equal(normalizeRequest("  WHAT Git Branch am I on?!  "), "what git branch am i on");
  assert.equal(normalizeRequest("what’s the git status"), "whats the git status");
  assert.equal(normalizeRequest("Ｃｕｒｒｅｎｔ   Branch"), "current branch");
});

test("each explicit deterministic intent has a local exact-match rule", () => {
  const examples = [
    ["What Git branch am I on?", LOCAL_INTENTS.CURRENT_GIT_BRANCH],
    ["Tell me the name of the checked-out branch.", LOCAL_INTENTS.CURRENT_GIT_BRANCH],
    ["Is my working tree clean?", LOCAL_INTENTS.WORKING_TREE_STATUS],
    ["Have I made any local edits?", LOCAL_INTENTS.WORKING_TREE_STATUS],
    ["Does this branch have an upstream?", LOCAL_INTENTS.BRANCH_UPSTREAM],
    ["How many local commits are ahead of upstream?", LOCAL_INTENTS.AHEAD_OF_UPSTREAM],
    ["Did the last test run pass?", LOCAL_INTENTS.MOST_RECENT_TEST_RESULT],
    ["Were the latest test results successful?", LOCAL_INTENTS.MOST_RECENT_TEST_RESULT],
  ];

  for (const [request, intent] of examples) {
    assert.deepEqual(classifyRequest(request), { route: "local", intent, reason: "local_exact_match" });
  }
});

test("ambiguous local topics go to Codex with an explicit ambiguity reason", () => {
  for (const request of [
    "Is this branch pushed?",
    "What is my branch status?",
    "Am I behind upstream?",
    "Did the tests pass in CI?",
    "Did the tests pass?",
    "Do I have any local commits that are not pushed?",
    "Implement a branch-aware retry feature in this project.",
  ]) {
    assert.deepEqual(classifyRequest(request), { route: "codex", intent: null, reason: "local_ambiguous" });
  }
});

test("unsupported commit-state questions do not become working-tree answers", () => {
  assert.deepEqual(classifyRequest("Have I made any local commits?"), {
    route: "codex",
    intent: null,
    reason: "codex_fallback",
  });
});

test("unrelated and empty requests use the Codex fallback reason", () => {
  assert.deepEqual(classifyRequest("Build a website"), { route: "codex", intent: null, reason: "codex_fallback" });
  assert.deepEqual(classifyRequest(""), { route: "codex", intent: null, reason: "codex_fallback" });
});

test("a local route executes its handler and never invokes the fallback", async () => {
  let fallbackCalls = 0;
  const handlerResult = {
    kind: "local_result",
    intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
    status: "confirmed",
    value: { branch: "main" },
    summary: "Current Git branch: main",
    evidence: ["git branch --show-current returned the branch name."],
    source: { kind: "git" },
    freshness: { state: "observed" },
  };

  const routed = await routeRequest("What Git branch am I on?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => handlerResult },
    fallback: async () => { fallbackCalls += 1; },
  });

  assert.equal(routed.result, handlerResult);
  assert.equal(routed.decision.route, "local");
  assert.equal(fallbackCalls, 0);
});

test("the three added local phrasings select the intended evidence source and never start a Codex turn", async () => {
  const requests = [
    ["Tell me the name of the checked-out branch.", LOCAL_INTENTS.CURRENT_GIT_BRANCH],
    ["Have I made any local edits?", LOCAL_INTENTS.WORKING_TREE_STATUS],
    ["Were the latest test results successful?", LOCAL_INTENTS.MOST_RECENT_TEST_RESULT],
  ];
  let fallbackCalls = 0;

  for (const [request, intent] of requests) {
    const routed = await routeRequest(request, {
      handlers: { [intent]: async () => ({
        kind: "local_result",
        intent,
        status: "unknown",
        value: null,
        summary: "No trustworthy result is available.",
        evidence: ["The handler had no confirmed evidence."],
        source: { kind: "test_fixture" },
        freshness: { state: "unknown" },
      }) },
      fallback: async () => { fallbackCalls += 1; },
    });

    assert.equal(routed.decision.route, "local");
    assert.equal(routed.decision.intent, intent);
    assert.equal(routed.result.status, "unknown");
  }

  assert.equal(fallbackCalls, 0);
});

test("ambiguous and unsupported requests call only the fallback", async () => {
  const calls = [];
  const fallback = async (decision) => { calls.push(decision.reason); return "fallback result"; };
  const ambiguous = await routeRequest("Is this branch pushed?", { fallback });
  const unsupported = await routeRequest("Build a website", { fallback });

  assert.equal(ambiguous.fallbackResult, "fallback result");
  assert.equal(unsupported.fallbackResult, "fallback result");
  assert.deepEqual(calls, ["local_ambiguous", "codex_fallback"]);
});

test("a failed local handler returns unavailable without fabricating a value or falling back", async () => {
  let fallbackCalls = 0;
  const routed = await routeRequest("What Git branch am I on?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => { throw new Error("private diagnostic"); } },
    fallback: async () => { fallbackCalls += 1; },
  });

  assert.equal(routed.result.status, "unavailable");
  assert.equal(routed.result.value, null);
  assert.equal(routed.result.summary.includes("private diagnostic"), false);
  assert.equal(fallbackCalls, 0);
});

test("invalid handler output becomes unavailable instead of an answer", async () => {
  const routed = await routeRequest("What Git branch am I on?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => ({ summary: "made up" }) },
  });

  assert.equal(routed.result.status, "unavailable");
  assert.equal(routed.result.value, null);
});

test("route metrics count local routes, fallbacks, latency, and handler failures without prompt data", () => {
  const metrics = new RouteMetrics();
  metrics.record({ route: "local" }, 8, { handlerFailed: true });
  const snapshot = metrics.record({ route: "codex" }, 13);

  assert.deepEqual(snapshot, {
    localRouteCount: 1,
    fallbackCount: 1,
    routeLatencyMs: 13,
    handlerFailureCount: 1,
  });
  assert.equal(JSON.stringify(snapshot).includes("prompt"), false);
});
