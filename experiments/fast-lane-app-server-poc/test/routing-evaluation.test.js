"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalHandlers } = require("../local-handlers");
const { ROUTING_OUTCOMES, ROUTING_REASON_COUNT_CODES, RouteMetrics, routeRequest } = require("../routing-core");

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "routing-quality-cases.json"), "utf8"));
const EVALUATION_CWD = "/offline-routing-evaluation/project";
const FIXED_NOW = new Date("2026-10-21T12:00:00.000Z");
const STALE_UPSTREAM_EPOCH = Math.floor(Date.parse("2026-10-01T12:00:00.000Z") / 1_000);
const EXPECTED_LOCAL_STATUSES = new Set(["confirmed", "unknown", "stale", "unavailable"]);
const ABSTENTION_STATUSES = new Set(["unknown", "stale", "unavailable"]);

test("controlled offline evaluation matches route and evidence expectations", async (t) => {
  validateFixtures(CASES);
  const metrics = new RouteMetrics();
  const evaluations = [];

  for (const entry of CASES) {
    const handlers = makeFixtureHandlers(entry.handlerFixture);
    let fallbackCalls = 0;
    const routed = await routeRequest(entry.prompt, {
      handlers,
      context: { cwd: EVALUATION_CWD },
      fallback: async () => {
        fallbackCalls += 1;
        return { kind: "mock_fallback_request", taskCompleted: false };
      },
    });
    const actual = {
      actualRoute: routed.decision.route,
      actualIntent: routed.decision.intent,
      actualEvidenceStatus: routed.result?.status ?? null,
      routingOutcome: routed.routingDecision.outcome,
      reasonCode: routed.routingDecision.reasonCode,
      fallbackCalls,
    };
    const score = scoreEvaluationCase(entry, actual);
    evaluations.push({ entry, actual, score });
    metrics.record(routed.decision, 0, {
      handlerFailed: routed.result?.status === "unavailable",
      routingDecision: routed.routingDecision,
    });
  }

  const metricsSnapshot = metrics.snapshot();
  const report = buildReport(evaluations, metricsSnapshot);
  writeEvaluationDiagnostic(t, report);

  assert.equal(report.casesEvaluated, 12);
  assert.equal(report.correctRouteDecisions, 12);
  assert.equal(report.incorrectRouteDecisions, 0);
  assert.equal(report.expectedBehaviorMatches, 12);
  assert.equal(report.appropriateAbstentions, 3);
  assert.equal(report.unsafeLocalAnswerDecisions, 0);
  assert.equal(report.unnecessaryDelegations, 0);
  assert.equal(report.mockFallbackRequests, 5);
  assert.equal(report.liveCodexTurns, 0);
  const categoryCounts = Object.entries(report.byCategory).map(([category, value]) => [category, value.cases]);
  assert.deepEqual(categoryCounts, [
    ["ambiguous_question", 2],
    ["complex_task", 2],
    ["exact_local_match", 2],
    ["local_handler_failure", 1],
    ["missing_evidence", 1],
    ["stale_evidence", 1],
    ["supported_local_rule", 2],
    ["unsupported_local_intent", 1],
  ]);
  const failedHandler = evaluations.find(({ entry }) => entry.id === "local_handler_failure");
  assert.equal(failedHandler.actual.routingOutcome, "local_unavailable");
  assert.equal(failedHandler.actual.fallbackCalls, 0);
  assert.equal(metricsSnapshot.routingDecisionCount, report.casesEvaluated);
  assert.deepEqual(metricsSnapshot.routingOutcomes, {
    local_selected: 0,
    local_handled: 4,
    local_insufficient: 2,
    local_unavailable: 1,
    codex_delegated: 5,
    codex_not_dispatched: 0,
  });
  assert.deepEqual(metricsSnapshot.routingReasons, {
    codex_fallback: 3,
    local_ambiguous: 2,
    local_exact_match: 5,
    local_rule_match: 2,
    unknown_route_reason: 0,
  });
  assert.deepEqual(report.failures, []);
  assert.equal(JSON.stringify(report).includes("prompt"), false);
  for (const entry of CASES) assert.equal(JSON.stringify(report).includes(entry.prompt), false);
  assert.doesNotMatch(JSON.stringify(report), /offline evaluation Git failure sentinel|evaluation-branch/u);
  assert.equal(JSON.stringify(metricsSnapshot).includes("evidence"), false);
});

test("evaluation scoring rejects mismatched abstentions and flags unsafe answers and unnecessary delegation", () => {
  const expectedMissing = {
    expectedRoute: "local", expectedIntent: "most_recent_test_result", expectedEvidenceStatus: "unknown",
  };
  const unavailableInstead = scoreEvaluationCase(expectedMissing, {
    actualRoute: "local", actualIntent: "most_recent_test_result", actualEvidenceStatus: "unavailable",
    routingOutcome: "local_unavailable", fallbackCalls: 0,
  });
  assert.equal(unavailableInstead.routeDecisionCorrect, true);
  assert.equal(unavailableInstead.expectedBehaviorMatch, false);
  assert.equal(unavailableInstead.appropriateAbstention, false);

  const unsafeLocal = scoreEvaluationCase({
    expectedRoute: "codex", expectedIntent: null, expectedEvidenceStatus: null,
  }, {
    actualRoute: "local", actualIntent: "current_git_branch", actualEvidenceStatus: "confirmed",
    routingOutcome: "local_handled", fallbackCalls: 0,
  });
  assert.equal(unsafeLocal.routeDecisionCorrect, false);
  assert.equal(unsafeLocal.unsafeLocalAnswerDecision, true);

  const unnecessaryDelegation = scoreEvaluationCase({
    expectedRoute: "local", expectedIntent: "current_git_branch", expectedEvidenceStatus: "confirmed",
  }, {
    actualRoute: "codex", actualIntent: null, actualEvidenceStatus: null,
    routingOutcome: "codex_delegated", fallbackCalls: 1,
  });
  assert.equal(unnecessaryDelegation.routeDecisionCorrect, false);
  assert.equal(unnecessaryDelegation.expectedBehaviorMatch, false);
  assert.equal(unnecessaryDelegation.unnecessaryDelegation, true);
});

function makeFixtureHandlers(fixtureName) {
  const runGit = async (args) => {
    if (fixtureName === "git_command_failure") {
      const error = new Error("offline evaluation Git failure sentinel");
      error.code = "EIO";
      throw error;
    }
    if (args[0] === "branch" && args[1] === "--show-current") return "evaluation-branch\n";
    if (args[0] === "status" && args[1] === "--porcelain=v1") return "";
    if (fixtureName === "stale_upstream") {
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      if (args[0] === "rev-list") return "2\n";
      if (args[0] === "reflog") return `refs/remotes/origin/main@{${STALE_UPSTREAM_EPOCH} +0000}\n`;
    }
    throw new Error("Unexpected Git call in the offline routing fixture.");
  };
  const testResultReader = fixtureName === "test_record_missing"
    ? () => ({ state: "missing" })
    : () => ({ state: "unavailable" });
  return createLocalHandlers({ runGit, testResultReader, now: () => new Date(FIXED_NOW) });
}

function scoreEvaluationCase(entry, actual) {
  const routeDecisionCorrect = actual.actualRoute === entry.expectedRoute &&
    (entry.expectedIntent === null || actual.actualIntent === entry.expectedIntent);
  const expectedRoutingOutcome = entry.expectedRoute === "codex"
    ? "codex_delegated"
    : entry.expectedEvidenceStatus === "confirmed"
      ? "local_handled"
      : ["unknown", "stale"].includes(entry.expectedEvidenceStatus)
        ? "local_insufficient"
        : "local_unavailable";
  const evidenceStatusMatches = entry.expectedEvidenceStatus === null ||
    actual.actualEvidenceStatus === entry.expectedEvidenceStatus;
  const dispatchBehaviorMatches = entry.expectedRoute === "codex"
    ? actual.fallbackCalls === 1
    : actual.fallbackCalls === 0;
  const expectedBehaviorMatch = routeDecisionCorrect && evidenceStatusMatches &&
    actual.routingOutcome === expectedRoutingOutcome && dispatchBehaviorMatches;
  const appropriateAbstention = routeDecisionCorrect && entry.expectedRoute === "local" &&
    ABSTENTION_STATUSES.has(entry.expectedEvidenceStatus) &&
    actual.actualEvidenceStatus === entry.expectedEvidenceStatus &&
    actual.routingOutcome === expectedRoutingOutcome && actual.fallbackCalls === 0;
  const unsafeLocalAnswerDecision = actual.actualRoute === "local" && actual.actualEvidenceStatus === "confirmed" &&
    (entry.expectedRoute !== "local" || entry.expectedIntent !== actual.actualIntent || entry.expectedEvidenceStatus !== "confirmed");
  const unnecessaryDelegation = actual.actualRoute === "codex" && entry.expectedRoute === "local";

  return {
    routeDecisionCorrect,
    expectedBehaviorMatch,
    appropriateAbstention,
    unsafeLocalAnswerDecision,
    unnecessaryDelegation,
  };
}

function writeEvaluationDiagnostic(t, report) {
  t.diagnostic(`Offline routing evaluation: ${report.casesEvaluated} cases; ${report.correctRouteDecisions} correct routes; ${report.incorrectRouteDecisions} incorrect routes; ${report.expectedBehaviorMatches} expected behavior matches; ${report.expectedBehaviorMismatches} mismatches.`);
  t.diagnostic(`Appropriate abstentions: ${report.appropriateAbstentions}; unsafe local answers: ${report.unsafeLocalAnswerDecisions}; unnecessary delegations: ${report.unnecessaryDelegations}; mock fallback requests: ${report.mockFallbackRequests}; live Codex turns: ${report.liveCodexTurns}.`);
  t.diagnostic(`RouteMetrics outcomes: ${JSON.stringify(report.routeMetrics.routingOutcomes)}`);
  t.diagnostic("By category:");
  for (const [key, value] of Object.entries(report.byCategory)) {
    t.diagnostic(`  ${key}: ${value.cases} ${value.cases === 1 ? "case" : "cases"}; routes ${value.correctRouteDecisions} correct/${value.incorrectRouteDecisions} incorrect; expected behavior ${value.expectedBehaviorMatches}/${value.cases}; abstentions ${value.appropriateAbstentions}; unsafe ${value.unsafeLocalAnswerDecisions}; unnecessary delegations ${value.unnecessaryDelegations}; outcomes ${JSON.stringify(value.routingOutcomes)}`);
  }
  t.diagnostic("By reason code:");
  for (const [key, value] of Object.entries(report.byReasonCode)) {
    t.diagnostic(`  ${key}: ${value.cases} ${value.cases === 1 ? "case" : "cases"}; routes ${value.correctRouteDecisions} correct/${value.incorrectRouteDecisions} incorrect; expected behavior ${value.expectedBehaviorMatches}/${value.cases}; abstentions ${value.appropriateAbstentions}; unsafe ${value.unsafeLocalAnswerDecisions}; unnecessary delegations ${value.unnecessaryDelegations}; outcomes ${JSON.stringify(value.routingOutcomes)}`);
  }
  t.diagnostic(`Failure examples: ${report.failures.length ? JSON.stringify(report.failures) : "none"}`);
}

function buildReport(evaluations, metrics) {
  const count = (predicate) => evaluations.filter(predicate).length;
  const groupBy = (keyFor) => {
    const keys = [...new Set(evaluations.map(keyFor))].sort();
    return Object.fromEntries(keys.map((key) => {
      const group = evaluations.filter((evaluation) => keyFor(evaluation) === key);
      return [key, {
        cases: group.length,
        correctRouteDecisions: group.filter(({ score }) => score.routeDecisionCorrect).length,
        incorrectRouteDecisions: group.filter(({ score }) => !score.routeDecisionCorrect).length,
        expectedBehaviorMatches: group.filter(({ score }) => score.expectedBehaviorMatch).length,
        appropriateAbstentions: group.filter(({ score }) => score.appropriateAbstention).length,
        unsafeLocalAnswerDecisions: group.filter(({ score }) => score.unsafeLocalAnswerDecision).length,
        unnecessaryDelegations: group.filter(({ score }) => score.unnecessaryDelegation).length,
        routingOutcomes: Object.fromEntries(ROUTING_OUTCOMES.map((outcome) => [
          outcome,
          group.filter(({ actual }) => actual.routingOutcome === outcome).length,
        ])),
      }];
    }));
  };
  const byReasonCode = Object.fromEntries(ROUTING_REASON_COUNT_CODES.map((reasonCode) => {
    const group = evaluations.filter(({ actual }) => actual.reasonCode === reasonCode);
    return [reasonCode, {
      cases: group.length,
      correctRouteDecisions: group.filter(({ score }) => score.routeDecisionCorrect).length,
      incorrectRouteDecisions: group.filter(({ score }) => !score.routeDecisionCorrect).length,
      expectedBehaviorMatches: group.filter(({ score }) => score.expectedBehaviorMatch).length,
      appropriateAbstentions: group.filter(({ score }) => score.appropriateAbstention).length,
      unsafeLocalAnswerDecisions: group.filter(({ score }) => score.unsafeLocalAnswerDecision).length,
      unnecessaryDelegations: group.filter(({ score }) => score.unnecessaryDelegation).length,
      routingOutcomes: Object.fromEntries(ROUTING_OUTCOMES.map((outcome) => [
        outcome,
        group.filter(({ actual }) => actual.routingOutcome === outcome).length,
      ])),
    }];
  }));
  return {
    evaluation: "Vesper controlled offline routing quality",
    casesEvaluated: evaluations.length,
    correctRouteDecisions: count(({ score }) => score.routeDecisionCorrect),
    incorrectRouteDecisions: count(({ score }) => !score.routeDecisionCorrect),
    expectedBehaviorMatches: count(({ score }) => score.expectedBehaviorMatch),
    expectedBehaviorMismatches: count(({ score }) => !score.expectedBehaviorMatch),
    appropriateAbstentions: count(({ score }) => score.appropriateAbstention),
    unsafeLocalAnswerDecisions: count(({ score }) => score.unsafeLocalAnswerDecision),
    unnecessaryDelegations: count(({ score }) => score.unnecessaryDelegation),
    mockFallbackRequests: evaluations.reduce((sum, { actual }) => sum + actual.fallbackCalls, 0),
    liveCodexTurns: 0,
    routeMetrics: metrics,
    byCategory: groupBy(({ entry }) => entry.category),
    byReasonCode,
    failures: evaluations.filter(({ score }) => !score.expectedBehaviorMatch).map(({ entry, actual }) => ({
      caseId: entry.id,
      category: entry.category,
      reasonCode: actual.reasonCode,
      expected: {
        route: entry.expectedRoute,
        intent: entry.expectedIntent,
        evidenceStatus: entry.expectedEvidenceStatus,
      },
      actual: {
        route: actual.actualRoute,
        intent: actual.actualIntent,
        evidenceStatus: actual.actualEvidenceStatus,
        routingOutcome: actual.routingOutcome,
        fallbackCalls: actual.fallbackCalls,
      },
    })),
  };
}

function validateFixtures(fixtures) {
  const ids = new Set();
  for (const entry of fixtures) {
    assert.equal(typeof entry.id, "string");
    assert.equal(ids.has(entry.id), false, `duplicate evaluation id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(typeof entry.prompt, "string");
    assert.equal(typeof entry.category, "string");
    assert.ok(["local", "codex"].includes(entry.expectedRoute));
    assert.equal(entry.expectedRoute === "local", typeof entry.expectedIntent === "string");
    assert.ok(entry.expectedEvidenceStatus === null || EXPECTED_LOCAL_STATUSES.has(entry.expectedEvidenceStatus));
    assert.equal(entry.expectedRoute === "local", entry.expectedEvidenceStatus !== null);
    assert.equal(typeof entry.rationale, "string");
  }
}
