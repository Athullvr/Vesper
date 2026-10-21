"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalHandlers } = require("../local-handlers");
const { ROUTING_OUTCOMES, ROUTING_REASON_COUNT_CODES, RouteMetrics, routeRequest } = require("../routing-core");

const FIXTURE_DIRECTORY = path.join(__dirname, "fixtures");
const BASELINE_FIXTURE_PATH = path.join(FIXTURE_DIRECTORY, "routing-quality-cases.json");
const HELDOUT_FIXTURE_PATH = path.join(FIXTURE_DIRECTORY, "routing-quality-heldout-cases.json");
const GENERALIZATION_FIXTURE_PATH = path.join(FIXTURE_DIRECTORY, "routing-quality-generalization-cases.json");
const FINGERPRINT_PATH = path.join(FIXTURE_DIRECTORY, "routing-quality-fingerprints.json");
const BASELINE_CASES = JSON.parse(fs.readFileSync(BASELINE_FIXTURE_PATH, "utf8"));
const HELDOUT_CASES = JSON.parse(fs.readFileSync(HELDOUT_FIXTURE_PATH, "utf8"));
const GENERALIZATION_CASES = JSON.parse(fs.readFileSync(GENERALIZATION_FIXTURE_PATH, "utf8"));
const FINGERPRINTS = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf8"));
const EXPECTED_FINGERPRINTS = Object.freeze({
  baseline: "00d9ec3db031dfc54fb1325fd649163a86d54d10cab02f936ac3c6988720b22a",
  heldout: "14e4df137fd8e4306f5989c2cc1d23cb770956d112d7bae0df447a646c522970",
  generalization: "efad9827a96e276c93b51d8f7b361b0d707f8becd9708bc943409c55bdd628a2",
});
const EVALUATION_CWD = "/offline-routing-evaluation/project";
const FIXED_NOW = new Date("2026-10-21T12:00:00.000Z");
const STALE_UPSTREAM_EPOCH = Math.floor(Date.parse("2026-10-01T12:00:00.000Z") / 1_000);
const EXPECTED_LOCAL_STATUSES = new Set(["confirmed", "unknown", "stale", "unavailable"]);
const ABSTENTION_STATUSES = new Set(["unknown", "stale", "unavailable"]);

test("baseline, prior regression, and new generalization fixture labels are static and fingerprint-pinned", () => {
  assertFixtureFingerprints();
  validateFixtures(BASELINE_CASES);
  validateFixtures(HELDOUT_CASES, { requireExpectedOutcome: true });
  validateFixtures(GENERALIZATION_CASES, { requireExpectedOutcome: true });
  assert.equal(BASELINE_CASES.length, 12);
  assert.equal(HELDOUT_CASES.length, 40);
  assert.equal(GENERALIZATION_CASES.length, 55);
  const allIds = [...BASELINE_CASES, ...HELDOUT_CASES, ...GENERALIZATION_CASES].map(({ id }) => id);
  assert.equal(new Set(allIds).size, allIds.length);
});

test("original offline routing baseline remains unchanged", async (t) => {
  assertFixtureFingerprints();
  const { evaluations, metricsSnapshot, report } = await evaluateFixtureSet(BASELINE_CASES);
  writeEvaluationDiagnostic(t, report, "baseline", EXPECTED_FINGERPRINTS.baseline);

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
  assertReportDoesNotExposePromptsOrEvidence(report, BASELINE_CASES, metricsSnapshot);
});

test("the previously evaluated held-out set remains a routing regression diagnostic", async (t) => {
  assertFixtureFingerprints();
  const { metricsSnapshot, report } = await evaluateFixtureSet(HELDOUT_CASES);
  writeEvaluationDiagnostic(t, report, "previously evaluated held-out regression", EXPECTED_FINGERPRINTS.heldout);

  assert.equal(report.casesEvaluated, 40);
  assert.equal(report.correctRouteDecisions, 40);
  assert.equal(report.incorrectRouteDecisions, 0);
  assert.equal(report.expectedBehaviorMatches, 40);
  assert.equal(report.unnecessaryDelegations, 0);
  assert.equal(report.correctRouteDecisions + report.incorrectRouteDecisions, 40);
  assert.equal(report.expectedBehaviorMatches + report.expectedBehaviorMismatches, 40);
  assert.equal(metricsSnapshot.routingDecisionCount, 40);
  assert.equal(report.mockFallbackRequests, metricsSnapshot.routingOutcomes.codex_delegated);
  assert.equal(report.liveCodexTurns, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(report.byCategory).map(([category, value]) => [category, value.cases])), {
    ambiguous_request: 5,
    complex_task: 3,
    informal_underspecified: 4,
    local_handler_failure: 4,
    missing_evidence: 3,
    stale_evidence: 2,
    supported_local_paraphrase: 12,
    unavailable_evidence: 2,
    unsupported_local_intent: 5,
  });
  assertReportDoesNotExposePromptsOrEvidence(report, HELDOUT_CASES, metricsSnapshot);
});

test("new independently reviewed generalization cases report behavior without tuning labels", async (t) => {
  assertFixtureFingerprints();
  const { metricsSnapshot, report } = await evaluateFixtureSet(GENERALIZATION_CASES);
  writeEvaluationDiagnostic(t, report, "new independently reviewed generalization set", EXPECTED_FINGERPRINTS.generalization);

  assert.equal(report.casesEvaluated, 55);
  assert.equal(report.correctRouteDecisions + report.incorrectRouteDecisions, 55);
  assert.equal(report.expectedBehaviorMatches + report.expectedBehaviorMismatches, 55);
  assert.equal(metricsSnapshot.routingDecisionCount, 55);
  assert.equal(report.mockFallbackRequests, metricsSnapshot.routingOutcomes.codex_delegated);
  assert.equal(report.liveCodexTurns, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(report.byCategory).map(([category, value]) => [category, value.cases])), {
    configured_upstream_vs_live_remote: 6,
    complex_task: 4,
    current_vs_other_branch_scope: 6,
    informal_underspecified: 5,
    local_handler_failure: 4,
    missing_evidence: 5,
    stale_evidence: 4,
    unavailable_evidence: 3,
    unseen_supported_paraphrase: 14,
    unsupported_local_intent: 4,
  });
  assertReportDoesNotExposePromptsOrEvidence(report, GENERALIZATION_CASES, metricsSnapshot);
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

async function evaluateFixtureSet(fixtures) {
  validateFixtures(fixtures, { requireExpectedOutcome: fixtures.some((entry) => Object.hasOwn(entry, "expectedOutcome")) });
  const metrics = new RouteMetrics();
  const evaluations = [];

  for (const entry of fixtures) {
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
      handlerFailed: entry.handlerFixture === "git_command_failure" && routed.decision.route === "local" &&
        routed.result?.status === "unavailable",
      routingDecision: routed.routingDecision,
    });
  }

  const metricsSnapshot = metrics.snapshot();
  return { evaluations, metricsSnapshot, report: buildReport(evaluations, metricsSnapshot) };
}

function assertFixtureFingerprints() {
  assert.equal(FINGERPRINTS.baseline.file, path.basename(BASELINE_FIXTURE_PATH));
  assert.equal(FINGERPRINTS.heldout.file, path.basename(HELDOUT_FIXTURE_PATH));
  assert.equal(FINGERPRINTS.baseline.sha256, EXPECTED_FINGERPRINTS.baseline);
  assert.equal(FINGERPRINTS.heldout.sha256, EXPECTED_FINGERPRINTS.heldout);
  assert.equal(FINGERPRINTS.generalization.file, path.basename(GENERALIZATION_FIXTURE_PATH));
  assert.equal(FINGERPRINTS.generalization.sha256, EXPECTED_FINGERPRINTS.generalization);
  assert.match(FINGERPRINTS.heldoutLabelingProvenance, /^Developer-authored held-out set;/u);
  assert.match(FINGERPRINTS.generalizationLabelingProvenance, /^Developer-authored generalization set; independently reviewed before evaluation by a reviewer who did not inspect router implementation or run evaluation\.$/u);
  for (const [name, fixturePath] of [
    ["baseline", BASELINE_FIXTURE_PATH],
    ["heldout", HELDOUT_FIXTURE_PATH],
    ["generalization", GENERALIZATION_FIXTURE_PATH],
  ]) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex");
    assert.equal(actual, EXPECTED_FINGERPRINTS[name], `${name} routing fixture fingerprint changed`);
  }
}

function assertReportDoesNotExposePromptsOrEvidence(report, fixtures, metricsSnapshot) {
  const reportText = JSON.stringify(report);
  assert.equal(reportText.includes("prompt"), false);
  for (const entry of fixtures) assert.equal(reportText.includes(entry.prompt), false);
  assert.doesNotMatch(reportText, /offline evaluation Git failure sentinel|evaluation-branch|origin\/main/u);
  assert.equal(JSON.stringify(metricsSnapshot).includes("evidence"), false);
}

function makeFixtureHandlers(fixtureName) {
  const runGit = async (args) => {
    if (fixtureName === "git_command_failure") {
      const error = new Error("offline evaluation Git failure sentinel");
      error.code = "EIO";
      throw error;
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return fixtureName === "branch_detached" ? "\n" : "evaluation-branch\n";
    }
    if (args[0] === "status" && args[1] === "--porcelain=v1" && args[2] === "-z") {
      return fixtureName === "working_tree_dirty" ? " M src/example.js\0?? new-file.txt\0" : "";
    }
    if (args[0] === "symbolic-ref") {
      return fixtureName === "upstream_detached" ? "\n" : "main\n";
    }
    if (args[0] === "for-each-ref") {
      return fixtureName === "ahead_no_upstream" ? "\n" : "origin/main\n";
    }
    if (args[0] === "rev-list") return fixtureName === "ahead_invalid_count" ? "not-a-count\n" : "2\n";
    if (args[0] === "reflog") {
      const epoch = fixtureName === "stale_upstream" || fixtureName === "ahead_stale"
        ? STALE_UPSTREAM_EPOCH
        : Math.floor(FIXED_NOW.getTime() / 1_000);
      return `refs/remotes/origin/main@{${epoch} +0000}\n`;
    }
    throw new Error("Unexpected Git call in the offline routing fixture.");
  };
  const testResultReader = () => {
    if (fixtureName === "test_record_missing") return { state: "missing" };
    if (fixtureName === "test_record_invalid") return { state: "invalid" };
    if (fixtureName === "test_record_unavailable") return { state: "unavailable" };
    if (fixtureName === "test_record_current" || fixtureName === "test_record_stale") {
      return {
        state: "valid",
        record: {
          exitCode: 0,
          summary: { tests: 20, passed: 20, failed: 0, skipped: 0, cancelled: 0 },
          completedAt: FIXED_NOW.toISOString(),
        },
        sourceMatches: fixtureName === "test_record_current",
      };
    }
    return { state: "unavailable" };
  };
  return createLocalHandlers({ runGit, testResultReader, now: () => new Date(FIXED_NOW) });
}

function scoreEvaluationCase(entry, actual) {
  const routeDecisionCorrect = actual.actualRoute === entry.expectedRoute &&
    (entry.expectedIntent === null || actual.actualIntent === entry.expectedIntent);
  const expectedRoutingOutcome = expectedOutcomeFor(entry);
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
    expectedOutcomeMatch: actual.routingOutcome === expectedRoutingOutcome && dispatchBehaviorMatches,
    expectedBehaviorMatch,
    appropriateAbstention,
    unsafeLocalAnswerDecision,
    unnecessaryDelegation,
  };
}

function writeEvaluationDiagnostic(t, report, setName, fingerprint) {
  t.diagnostic(`Routing evaluation (${setName}, sha256 ${fingerprint}): ${report.casesEvaluated} cases.`);
  t.diagnostic(`Correct route decisions: ${report.correctRouteDecisions}/${report.casesEvaluated}; incorrect routes: ${report.incorrectRouteDecisions}. Expected behavior matches: ${report.expectedBehaviorMatches}/${report.casesEvaluated} (${formatPercent(report.expectedBehaviorMatchRate)}); mismatches: ${report.expectedBehaviorMismatches}.`);
  t.diagnostic(`Appropriate abstentions: ${report.appropriateAbstentions}; unsafe local answers: ${report.unsafeLocalAnswerDecisions}; unnecessary delegations: ${report.unnecessaryDelegations}; mock fallback requests: ${report.mockFallbackRequests}; live Codex turns: ${report.liveCodexTurns}.`);
  t.diagnostic(`RouteMetrics outcomes: ${JSON.stringify(report.routeMetrics.routingOutcomes)}`);
  t.diagnostic("By category:");
  for (const [key, value] of Object.entries(report.byCategory)) {
    t.diagnostic(`  ${key}: ${value.cases} ${value.cases === 1 ? "case" : "cases"}; routes ${value.correctRouteDecisions} correct/${value.incorrectRouteDecisions} incorrect; expected behavior ${value.expectedBehaviorMatches}/${value.cases}; abstentions ${value.appropriateAbstentions}; unsafe ${value.unsafeLocalAnswerDecisions}; unnecessary delegations ${value.unnecessaryDelegations}; outcomes ${JSON.stringify(value.routingOutcomes)}; failed IDs ${value.failureCaseIds.length ? value.failureCaseIds.join(", ") : "none"}`);
  }
  t.diagnostic("By reason code:");
  for (const [key, value] of Object.entries(report.byReasonCode)) {
    t.diagnostic(`  ${key}: ${value.cases} cases; routes ${value.correctRouteDecisions} correct/${value.incorrectRouteDecisions} incorrect; expected behavior ${value.expectedBehaviorMatches}/${value.cases}; abstentions ${value.appropriateAbstentions}; unsafe ${value.unsafeLocalAnswerDecisions}; unnecessary delegations ${value.unnecessaryDelegations}; outcomes ${JSON.stringify(value.routingOutcomes)}`);
  }
  t.diagnostic(`Failure examples: ${report.failures.length ? JSON.stringify(report.failures) : "none"}`);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
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
        expectedBehaviorMismatches: group.filter(({ score }) => !score.expectedBehaviorMatch).length,
        appropriateAbstentions: group.filter(({ score }) => score.appropriateAbstention).length,
        unsafeLocalAnswerDecisions: group.filter(({ score }) => score.unsafeLocalAnswerDecision).length,
        unnecessaryDelegations: group.filter(({ score }) => score.unnecessaryDelegation).length,
        failureCaseIds: group.filter(({ score }) => !score.expectedBehaviorMatch).map(({ entry }) => entry.id),
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
      expectedBehaviorMismatches: group.filter(({ score }) => !score.expectedBehaviorMatch).length,
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
    expectedBehaviorMatchRate: evaluations.length ? count(({ score }) => score.expectedBehaviorMatch) / evaluations.length : 0,
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
        outcome: expectedOutcomeFor(entry),
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

function expectedOutcomeFor(entry) {
  if (typeof entry.expectedOutcome === "string") return entry.expectedOutcome;
  if (entry.expectedRoute === "codex") return "codex_delegated";
  if (entry.expectedEvidenceStatus === "confirmed") return "local_handled";
  if (["unknown", "stale"].includes(entry.expectedEvidenceStatus)) return "local_insufficient";
  return "local_unavailable";
}

function validateFixtures(fixtures, { requireExpectedOutcome = false } = {}) {
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
    assert.equal(typeof entry.handlerFixture, "string");
    if (requireExpectedOutcome || Object.hasOwn(entry, "expectedOutcome")) {
      assert.ok(ROUTING_OUTCOMES.includes(entry.expectedOutcome));
      assert.equal(entry.expectedOutcome, expectedOutcomeFor(entry), `inconsistent expected outcome for ${entry.id}`);
    }
  }
}
