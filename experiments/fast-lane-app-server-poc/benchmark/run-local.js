"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { createLocalHandlers } = require("../local-handlers");
const { readLatestTestRecord } = require("../test-evidence");
const { ROUTING_OUTCOMES, routeRequest } = require("../routing-core");

const prototypeRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(prototypeRoot, "../..");
const cases = [
  ...JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8"))
    .map((entry) => ({ ...entry, split: "development" })),
  ...JSON.parse(fs.readFileSync(path.join(__dirname, "heldout-cases.json"), "utf8"))
    .map((entry) => ({ ...entry, split: "heldout" })),
];

function git(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
}

function readOracle(kind) {
  switch (kind) {
    case "current_git_branch":
      return { branch: git(["branch", "--show-current"]).trim() };
    case "working_tree_status": {
      const raw = git(["status", "--porcelain=v1", "-z"]);
      const counts = independentlyCountStatusEntries(raw);
      return { clean: counts.changed === 0, ...counts };
    }
    case "branch_upstream": {
      try {
        const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim();
        return { configured: true, upstream };
      } catch {
        return { configured: false, upstream: null };
      }
    }
    case "ahead_of_upstream":
      try {
        return { aheadCount: Number(git(["rev-list", "--count", "@{upstream}..HEAD"]).trim()) };
      } catch {
        return { unavailable: true };
      }
    case "most_recent_test_result": {
      const evidence = readLatestTestRecord(prototypeRoot);
      if (evidence.state !== "valid") return { state: evidence.state };
      const { record, sourceMatches } = evidence;
      return {
        state: sourceMatches ? "confirmed" : "stale",
        passed: record.exitCode === 0 && record.summary.failed === 0 && record.summary.cancelled === 0,
        tests: record.summary.tests,
        failed: record.summary.failed,
        skipped: record.summary.skipped,
        exitCode: record.exitCode,
        completedAt: record.completedAt,
      };
    }
    case "workspace_root":
      return { path: projectRoot };
    case "workspace_files":
      return {
        names: fs.readdirSync(projectRoot, { withFileTypes: true })
          .map((entry) => entry.name)
          .sort(),
      };
    case "ambiguous_push_state":
      return { state: "not_confirmable_without_remote_check" };
    case "ambiguous_commit_state":
      return { state: "not_supported_by_a_deterministic_handler" };
    case "ambiguous_test_state":
      return { state: "not_confirmable_without_defined_test_scope" };
    case "complex_task_response":
      return { state: "requires_codex" };
    default:
      throw new Error(`Unknown benchmark oracle: ${kind}`);
  }
}

function localAnswerMatches(result, oracle) {
  if (!result || result.kind !== "local_result") return false;
  switch (result.intent) {
    case "current_git_branch":
      return result.status === (oracle.branch ? "confirmed" : "unknown") &&
        (oracle.branch ? result.value?.branch === oracle.branch : result.value === null);
    case "working_tree_status":
      return result.status === "confirmed" && result.value?.clean === oracle.clean &&
        ["changed", "modified", "added", "deleted", "renamed", "untracked"]
          .every((key) => result.value?.[key] === oracle[key]);
    case "branch_upstream":
      return result.status === "confirmed" && result.value?.configured === oracle.configured &&
        result.value?.upstream === oracle.upstream;
    case "ahead_of_upstream":
      if (oracle.unavailable) return result.status === "unavailable";
      return Number.isInteger(oracle.aheadCount)
        ? result.value?.aheadCount === oracle.aheadCount && ["confirmed", "stale"].includes(result.status)
        : result.status === "unavailable";
    case "most_recent_test_result":
      if (oracle.state === "missing") return result.status === "unknown";
      if (!["confirmed", "stale"].includes(oracle.state)) return result.status === "unavailable";
      return result.status === oracle.state &&
        result.value?.passed === oracle.passed && result.value?.tests === oracle.tests &&
        result.value?.failed === oracle.failed && result.value?.skipped === oracle.skipped &&
        result.value?.exitCode === oracle.exitCode && result.value?.completedAt === oracle.completedAt;
    default:
      return false;
  }
}

function evidenceQuality(result) {
  if (!result || !Array.isArray(result.evidence) || !result.evidence.length || !result.source?.kind) return "none";
  if (result.freshness?.state === "observed" || result.freshness?.state === "same_source_snapshot") return "strong";
  return "bounded";
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function independentlyCountStatusEntries(raw) {
  const counts = { changed: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 };
  const records = String(raw).split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const xy = record.slice(0, 2);
    counts.changed += 1;
    if (xy === "??") counts.untracked += 1;
    else if (xy.includes("R") || xy.includes("C")) {
      counts.renamed += 1;
      index += 1;
    } else if (xy.includes("D")) counts.deleted += 1;
    else if (xy.includes("A")) counts.added += 1;
    else counts.modified += 1;
  }
  return counts;
}

async function run(trialCount) {
  const handlers = createLocalHandlers({ runGit: async (args, cwd) => gitAt(args, cwd) });
  const rows = new Map(cases.map((entry) => [entry.id, {
    id: entry.id,
    split: entry.split,
    category: entry.category,
    expectedRoute: entry.expectedRoute,
    expectedIntent: entry.expectedIntent,
    trials: [],
  }]));

  for (let trial = 1; trial <= trialCount; trial += 1) {
    for (const entry of cases) {
      const oracle = readOracle(entry.oracle);
      let turnStartRequests = 0;
      const startedAt = performance.now();
      const routed = await routeRequest(entry.prompt, {
        handlers,
        context: { cwd: projectRoot },
        fallback: async () => {
          turnStartRequests += 1;
          return { status: "completed", harness: "mocked" };
        },
      });
      const latencyMs = performance.now() - startedAt;
      const result = routed.result || null;
      const routeCorrect = routed.decision.route === entry.expectedRoute &&
        (entry.expectedIntent === null || routed.decision.intent === entry.expectedIntent);
      const hasLocalAnswer = Boolean(result);
      const answerCorrect = hasLocalAnswer ? localAnswerMatches(result, oracle) : null;
      rows.get(entry.id).trials.push({
        trial,
        actualRoute: routed.decision.route,
        routeReason: routed.decision.reason,
        actualIntent: routed.decision.intent,
        routingOutcome: routed.routingDecision.outcome,
        routingReasonCode: routed.routingDecision.reasonCode,
        routingOutcomeReasonCode: routed.routingDecision.outcomeReasonCode,
        routeCorrect,
        localAnswerProduced: hasLocalAnswer,
        answerCorrect,
        evidenceQuality: hasLocalAnswer ? evidenceQuality(result) : "not_applicable",
        freshness: result?.freshness?.state || "not_applicable",
        localLatencyMs: Number(latencyMs.toFixed(3)),
        codexTurnRequested: turnStartRequests > 0,
        realCodexTurnStarted: false,
      });
    }
  }

  const summary = [...rows.values()].map((row) => {
    const trials = row.trials;
    const localAnswers = trials.filter((trial) => trial.localAnswerProduced);
    const incorrectLocalAnswers = localAnswers.filter((trial) => trial.answerCorrect === false).length;
    const latencies = trials.map((trial) => trial.localLatencyMs);
    return {
      id: row.id,
      split: row.split,
      category: row.category,
      expectedRoute: row.expectedRoute,
      expectedIntent: row.expectedIntent,
      actualRoute: trials[0].actualRoute,
      routeReason: trials[0].routeReason,
      routingOutcome: trials[0].routingOutcome,
      routingReasonCode: trials[0].routingReasonCode,
      routingOutcomeReasonCode: trials[0].routingOutcomeReasonCode,
      routeCorrectTrials: trials.filter((trial) => trial.routeCorrect).length,
      falseLocalRouteTrials: row.expectedRoute === "codex"
        ? trials.filter((trial) => trial.actualRoute === "local").length
        : 0,
      answerCorrectTrials: localAnswers.filter((trial) => trial.answerCorrect === true).length,
      localAnswerTrials: localAnswers.length,
      incorrectLocalAnswerTrials: incorrectLocalAnswers,
      incorrectLocalAnswerRate: localAnswers.length ? incorrectLocalAnswers / localAnswers.length : null,
      freshness: trials[0].freshness,
      evidenceQuality: trials[0].evidenceQuality,
      localLatencyMedianMs: Number(median(latencies).toFixed(3)),
      localLatencyMinMs: Number(Math.min(...latencies).toFixed(3)),
      localLatencyMaxMs: Number(Math.max(...latencies).toFixed(3)),
      codexTurnRequestedTrials: trials.filter((trial) => trial.codexTurnRequested).length,
      realCodexTurnStartedTrials: trials.filter((trial) => trial.realCodexTurnStarted).length,
    };
  });

  const trialCases = cases.length;
  const expectedLocal = cases.filter((entry) => entry.expectedRoute === "local").length;
  const routeCorrectTrials = summary.reduce((total, row) => total + row.routeCorrectTrials, 0);
  const localAnswerCount = summary.reduce((total, row) => total + row.localAnswerTrials, 0);
  const incorrectLocalAnswerCount = summary.reduce((total, row) => total + row.incorrectLocalAnswerTrials, 0);
  const fallbackRequests = summary.reduce((total, row) => total + row.codexTurnRequestedTrials, 0);
  const falseLocalRouteCount = summary.reduce((total, row) => total + row.falseLocalRouteTrials, 0);
  const allTrials = [...rows.values()].flatMap((row) => row.trials);
  const routingOutcomeCounts = Object.fromEntries(ROUTING_OUTCOMES.map((outcome) => [
    outcome,
    allTrials.filter((trial) => trial.routingOutcome === outcome).length,
  ]));
  const latencySamples = allTrials.map((trial) => trial.localLatencyMs);
  const localAnswerLatencySamples = allTrials
    .filter((trial) => trial.localAnswerProduced)
    .map((trial) => trial.localLatencyMs);
  const fallbackLatencySamples = allTrials
    .filter((trial) => trial.codexTurnRequested)
    .map((trial) => trial.localLatencyMs);
  const splitMetrics = Object.fromEntries([...new Set(cases.map((entry) => entry.split))].map((split) => {
    const splitCases = cases.filter((entry) => entry.split === split);
    const splitRows = summary.filter((row) => row.split === split);
    const expectedLocalOpportunities = splitCases.filter((entry) => entry.expectedRoute === "local").length * trialCount;
    const localAnswers = splitRows.reduce((total, row) => total + row.localAnswerTrials, 0);
    const incorrectLocalAnswers = splitRows.reduce((total, row) => total + row.incorrectLocalAnswerTrials, 0);
    const falseLocalRoutes = splitRows.reduce((total, row) => total + row.falseLocalRouteTrials, 0);
    const splitRouteCorrect = splitRows.reduce((total, row) => total + row.routeCorrectTrials, 0);
    return [split, {
      caseCount: splitCases.length,
      expectedLocalCases: splitCases.filter((entry) => entry.expectedRoute === "local").length,
      routeAccuracy: splitRouteCorrect / (splitCases.length * trialCount),
      localCoverage: expectedLocalOpportunities ? localAnswers / expectedLocalOpportunities : null,
      falseLocalRouteCount: falseLocalRoutes,
      incorrectLocalAnswerCount: incorrectLocalAnswers,
      incorrectLocalAnswerRate: localAnswers ? incorrectLocalAnswers / localAnswers : 0,
    }];
  }));
  const document = {
    benchmark: "Vesper deterministic routing evaluation",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    projectRoot,
    trialsPerCase: trialCount,
    caseCount: trialCases,
    expectedLocalCases: expectedLocal,
    routeAccuracy: routeCorrectTrials / (trialCases * trialCount),
    falseLocalRouteCount,
    fallbackFrequency: fallbackRequests / (trialCases * trialCount),
    incorrectLocalAnswerRate: localAnswerCount ? incorrectLocalAnswerCount / localAnswerCount : 0,
    medianLocalLatencyMs: Number(median(latencySamples).toFixed(3)),
    medianLocalAnswerLatencyMs: Number(median(localAnswerLatencySamples).toFixed(3)),
    medianFallbackDecisionLatencyMs: Number(median(fallbackLatencySamples).toFixed(3)),
    localAnswerCount,
    incorrectLocalAnswerCount,
    fallbackTurnRequests: fallbackRequests,
    liveCodexTurnsStarted: 0,
    routingOutcomeCounts,
    splitMetrics,
    cases: summary,
  };
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

function gitAt(args, cwd) {
  if (cwd !== projectRoot) throw new Error("Benchmark handler received an unexpected working directory.");
  return git(args);
}

const trialCount = Number(process.argv[2] || 5);
if (!Number.isInteger(trialCount) || trialCount < 1 || trialCount > 25) {
  process.stderr.write("Usage: node benchmark/run-local.js [trials 1..25]\n");
  process.exitCode = 2;
} else {
  run(trialCount).catch((error) => {
    process.stderr.write(`Benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
