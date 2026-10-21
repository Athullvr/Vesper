"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCAL_INTENTS,
  ROUTING_OUTCOMES,
  RouteMetrics,
  classifyRequest,
  createRoutingDecisionRecord,
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

test("shell text, live pushed state, repository inspection and bug analysis stay on Codex", async () => {
  for (const [prompt, reason] of [
    ["grep -nE 'freshness|stale|reflog|upstream|aheadCount' test tests 2>/dev/null", "local_ambiguous"],
    ["Has this branch been pushed?", "local_ambiguous"],
    ["Inspect the repository and explain its architecture.", "codex_fallback"],
    ["Review the code and analyze potential bugs.", "codex_fallback"],
    ["What is the current Git branch? Then push it.", "local_ambiguous"],
    ["git status && echo unsafe", "local_ambiguous"],
  ]) {
    let fallbacks = 0;
    const handlers = Object.fromEntries(Object.values(LOCAL_INTENTS).map((intent) =>
      [intent, async () => assert.fail("No local handler may execute shell text or answer a complex request")]
    ));
    const routed = await routeRequest(prompt, {
      handlers, fallback: async () => { fallbacks += 1; return { status: "completed" }; },
    });
    assert.deepEqual(routed.decision, { route: "codex", intent: null, reason }, prompt);
    assert.equal(fallbacks, 1);
    assert.equal(routed.result, undefined);
    assert.deepEqual(routed.fallbackResult, { status: "completed" });
  }
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

test("routing records preserve classifier reasons and distinguish local result states", async () => {
  const makeResult = (intent, status, summary = "Fixture result.") => ({
    kind: "local_result",
    intent,
    status,
    value: null,
    summary,
    evidence: ["Fixture evidence."],
    source: { kind: "test_fixture" },
    freshness: { state: "observed" },
  });
  const confirmed = await routeRequest("What Git branch am I on?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => makeResult(LOCAL_INTENTS.CURRENT_GIT_BRANCH, "confirmed", "API_KEY=record-secret") },
  });
  assert.equal(confirmed.routingDecision.outcome, "local_handled");
  assert.equal(confirmed.routingDecision.reasonCode, "local_exact_match");
  assert.equal(confirmed.routingDecision.outcomeReasonCode, "local_handler_returned");
  assert.equal(confirmed.routingDecision.handlerStatus, "confirmed");
  assert.match(confirmed.routingDecision.explanation, /does not independently validate its answer/u);
  assert.doesNotMatch(JSON.stringify(confirmed.routingDecision), /record-secret|API_KEY/u);

  const ruleMatch = await routeRequest("What branch is active?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => makeResult(LOCAL_INTENTS.CURRENT_GIT_BRANCH, "confirmed") },
  });
  assert.equal(ruleMatch.routingDecision.reasonCode, "local_rule_match");
  assert.match(ruleMatch.routingDecision.explanation, /constrained local intent rule/u);

  for (const [status, outcomeReasonCode] of [["unknown", "local_evidence_unknown"], ["stale", "local_evidence_stale"]]) {
    const routed = await routeRequest("What Git branch am I on?", {
      handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => makeResult(LOCAL_INTENTS.CURRENT_GIT_BRANCH, status) },
    });
    assert.equal(routed.routingDecision.outcome, "local_insufficient");
    assert.equal(routed.routingDecision.outcomeReasonCode, outcomeReasonCode);
    assert.equal(routed.routingDecision.handlerStatus, status);
  }

  let fallbackCalls = 0;
  const unavailable = await routeRequest("What Git branch am I on?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => { throw new Error("private failure detail"); } },
    fallback: async () => { fallbackCalls += 1; },
  });
  assert.equal(unavailable.routingDecision.outcome, "local_unavailable");
  assert.equal(unavailable.routingDecision.reasonCode, "local_exact_match");
  assert.equal(unavailable.routingDecision.outcomeReasonCode, "local_handler_unavailable");
  assert.equal(unavailable.routingDecision.fallbackStatus, "not_attempted");
  assert.doesNotMatch(JSON.stringify(unavailable.routingDecision), /private failure detail/u);
  assert.equal(fallbackCalls, 0, "local handler failure remains fail-closed and does not fall back");
});

test("Codex routing records distinguish actual fallback dispatch from an unconfigured fallback", async () => {
  const notifications = [];
  const ambiguous = await routeRequest("Is this branch pushed?", {
    fallback: async (decision) => ({ status: "completed", reason: decision.reason }),
    onRoutingDecision: (record) => notifications.push(record),
  });
  assert.equal(ambiguous.routingDecision.outcome, "codex_delegated");
  assert.equal(ambiguous.routingDecision.reasonCode, "local_ambiguous");
  assert.equal(ambiguous.routingDecision.outcomeReasonCode, "fallback_requested");
  assert.equal(ambiguous.routingDecision.fallbackStatus, "requested");
  assert.match(ambiguous.routingDecision.explanation, /no single supported intent matched/u);
  assert.deepEqual(notifications, [ambiguous.routingDecision]);

  const unsupported = await routeRequest("Build a website");
  assert.equal(unsupported.routingDecision.outcome, "codex_not_dispatched");
  assert.equal(unsupported.routingDecision.reasonCode, "codex_fallback");
  assert.equal(unsupported.routingDecision.outcomeReasonCode, "fallback_not_configured");
  assert.equal(unsupported.fallbackResult, undefined);
});

test("a failed fallback retains its dispatch record and observer failures cannot change routing", async () => {
  let dispatched;
  await assert.rejects(routeRequest("Build a website", {
    fallback: async () => { throw new Error("mock fallback failed"); },
    onRoutingDecision: (record) => { dispatched = record; },
  }), /mock fallback failed/u);
  assert.equal(dispatched.outcome, "codex_delegated");
  assert.equal(dispatched.fallbackStatus, "requested");

  const routed = await routeRequest("What Git branch am I on?", {
    handlers: { [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => ({
      kind: "local_result", intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH, status: "unknown", summary: "No branch.",
      evidence: [], source: { kind: "git" }, freshness: { state: "unknown" },
    }) },
    onRoutingDecision: () => { throw new Error("observer failed"); },
  });
  assert.equal(routed.result.status, "unknown");
  assert.equal(routed.routingDecision.outcome, "local_insufficient");
});

test("routing explanations match the actual decision reason and records stay bounded", async () => {
  const cases = [
    ["What Git branch am I on?", "local_exact_match", /explicit local intent phrase/u],
    ["What branch is active?", "local_rule_match", /constrained local intent rule/u],
    ["Is this branch pushed?", "local_ambiguous", /local topic was detected/u],
    ["Build a website", "codex_fallback", /No supported local intent matched/u],
  ];
  for (const [prompt, reasonCode, explanation] of cases) {
    const decision = classifyRequest(prompt);
    const record = createRoutingDecisionRecord(decision, decision.route === "local"
      ? { kind: "local_result", intent: decision.intent, status: "confirmed", summary: "ok", evidence: [], source: {}, freshness: {} }
      : null, { fallbackAvailable: decision.route === "codex" });
    assert.equal(record.reasonCode, reasonCode);
    assert.match(record.explanation, explanation);
    assert.ok(record.explanation.length <= 220);
    assert.ok(ROUTING_OUTCOMES.includes(record.outcome));
    assert.equal(JSON.stringify(record).includes(prompt), false);
  }
  assert.equal(createRoutingDecisionRecord({ route: "codex", intent: null, reason: "codex_fallback" }).route, "codex");
});

test("route metrics count local routes, fallbacks, latency, and handler failures without prompt data", () => {
  const metrics = new RouteMetrics();
  metrics.record({ route: "local" }, 8, { handlerFailed: true, routingDecision: { outcome: "local_unavailable" } });
  const snapshot = metrics.record({ route: "codex" }, 13, { routingDecision: { outcome: "codex_delegated" } });

  assert.deepEqual(snapshot, {
    localRouteCount: 1,
    fallbackCount: 1,
    routeLatencyMs: 13,
    handlerFailureCount: 1,
    routingOutcomes: {
      local_selected: 0,
      local_handled: 0,
      local_insufficient: 0,
      local_unavailable: 1,
      codex_delegated: 1,
      codex_not_dispatched: 0,
    },
  });
  assert.equal(JSON.stringify(snapshot).includes("prompt"), false);
});
