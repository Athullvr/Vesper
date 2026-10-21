"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalHandlers } = require("../local-handlers");
const {
  LOCAL_INTENTS,
  RouteMetrics,
  classifyRequest,
  routeRequest,
} = require("../routing-core");

const HELDOUT_PATH = path.join(__dirname, "fixtures", "routing-quality-heldout-cases.json");
const DIAGNOSED_IDS = [
  "heldout_branch_right_now",
  "heldout_branch_conversational",
  "heldout_upstream_remote_branch_paraphrase",
  "heldout_upstream_configured_branch_paraphrase",
  "heldout_ahead_count_current_branch_paraphrase",
];
const FIXED_NOW = new Date("2026-10-21T12:00:00.000Z");
const PROJECT = "/synthetic/vesper-project";
const heldoutCases = JSON.parse(fs.readFileSync(HELDOUT_PATH, "utf8"));

test("the five diagnosed paraphrases reach their intended local Git handlers", async () => {
  const cases = DIAGNOSED_IDS.map((id) => {
    const entry = heldoutCases.find((candidate) => candidate.id === id);
    assert.ok(entry, `missing previously evaluated case ${id}`);
    assert.equal(entry.expectedRoute, "local");
    assert.equal(entry.expectedEvidenceStatus, "confirmed");
    return entry;
  });
  assert.deepEqual(cases.map(({ id }) => id), DIAGNOSED_IDS);

  for (const entry of cases) {
    const gitCalls = [];
    let fallbackCalls = 0;
    const handlers = createLocalHandlers({
      runGit: createSyntheticGit({ gitCalls }),
      now: () => FIXED_NOW,
    });
    const routed = await routeRequest(entry.prompt, {
      context: { cwd: PROJECT },
      handlers,
      fallback: async () => { fallbackCalls += 1; return "should not dispatch"; },
    });

    assert.deepEqual(routed.decision, {
      route: "local",
      intent: entry.expectedIntent,
      reason: "local_rule_match",
    }, entry.id);
    assert.equal(routed.result.kind, "local_result", entry.id);
    assert.equal(routed.result.intent, entry.expectedIntent, entry.id);
    assert.equal(routed.result.status, entry.expectedEvidenceStatus, entry.id);
    assert.equal(routed.routingDecision.outcome, "local_handled", entry.id);
    assert.equal(routed.routingDecision.reasonCode, "local_rule_match", entry.id);
    assert.ok(gitCalls.length > 0, `${entry.id} invoked its local handler`);
    assert.ok(gitCalls.every(({ cwd }) => cwd === PROJECT), `${entry.id} stayed in the active project`);
    assert.equal(fallbackCalls, 0, `${entry.id} must not dispatch to Codex`);

    if (entry.expectedIntent === LOCAL_INTENTS.CURRENT_GIT_BRANCH) {
      assert.ok(gitCalls.some(({ args }) => args[0] === "branch"), entry.id);
    } else if (entry.expectedIntent === LOCAL_INTENTS.BRANCH_UPSTREAM) {
      assert.ok(gitCalls.some(({ args }) => args[0] === "symbolic-ref"), entry.id);
      assert.ok(gitCalls.some(({ args }) => args[0] === "for-each-ref"), entry.id);
      assert.match(routed.result.summary, /remote was not checked/u);
    } else {
      assert.equal(entry.expectedIntent, LOCAL_INTENTS.AHEAD_OF_UPSTREAM);
      assert.ok(gitCalls.some(({ args }) => args[0] === "rev-list"), entry.id);
      assert.ok(gitCalls.some(({ args }) => args[0] === "reflog"), entry.id);
      assert.equal(routed.result.value.aheadCount, 2);
      assert.equal(routed.result.freshness.state, "recent");
      assert.match(routed.result.summary, /remote was not contacted/u);
    }
  }
});

test("current-checkout variants and a branch-specific possessive normalize narrowly", () => {
  for (const prompt of [
    "Which branch am I on right now?",
    "What Git branch am I currently on?",
    "I'm on which branch?",
    "I am on which branch?",
  ]) {
    assert.deepEqual(classifyRequest(prompt), {
      route: "local", intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH, reason: "local_rule_match",
    }, prompt);
  }

  assert.equal(
    require("../routing-core").normalizeRequest("Which branch is configured as this branch’s upstream?"),
    "which branch is configured as this branch upstream",
  );
  assert.equal(require("../routing-core").normalizeRequest("what’s the git status"), "whats the git status");
  assert.deepEqual(classifyRequest("Which branch is configured as this branch’s upstream?"), {
    route: "local", intent: LOCAL_INTENTS.BRANCH_UPSTREAM, reason: "local_rule_match",
  });
});

test("other-branch, live-remote, and mixed requests remain delegated", async () => {
  const requests = [
    "Which upstream is configured for branch feature/login?",
    "How many commits ahead of upstream is branch feature/login?",
    "What is the current remote branch?",
    "Has the remote branch received new commits?",
    "What branch am I on, and has the remote moved?",
  ];

  for (const prompt of requests) {
    assert.deepEqual(classifyRequest(prompt), {
      route: "codex", intent: null, reason: "local_ambiguous",
    }, prompt);
    let handlerCalls = 0;
    let fallbackCalls = 0;
    const handlers = Object.fromEntries(Object.values(LOCAL_INTENTS).map((intent) => [intent, async () => {
      handlerCalls += 1;
      assert.fail(`unsafe local handling for: ${prompt}`);
    }]));
    const routed = await routeRequest(prompt, {
      handlers,
      fallback: async () => { fallbackCalls += 1; return "mock dispatch"; },
    });

    assert.equal(routed.routingDecision.outcome, "codex_delegated", prompt);
    assert.equal(handlerCalls, 0, prompt);
    assert.equal(fallbackCalls, 1, prompt);
  }
});

test("recognized local intents preserve detached, missing, stale, and unavailable evidence outcomes", async () => {
  const cases = [
    {
      prompt: "Which branch am I on right now?",
      intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
      status: "unknown",
      outcome: "local_insufficient",
      git: createSyntheticGit({ detached: true }),
    },
    {
      prompt: "Which branch is configured as this branch’s upstream?",
      intent: LOCAL_INTENTS.BRANCH_UPSTREAM,
      status: "unknown",
      outcome: "local_insufficient",
      git: createSyntheticGit({ detached: true }),
    },
    {
      prompt: "How many commits ahead of upstream is the current branch?",
      intent: LOCAL_INTENTS.AHEAD_OF_UPSTREAM,
      status: "unavailable",
      outcome: "local_unavailable",
      git: createSyntheticGit({ noUpstream: true }),
    },
    {
      prompt: "How many commits ahead of upstream is the current branch?",
      intent: LOCAL_INTENTS.AHEAD_OF_UPSTREAM,
      status: "stale",
      outcome: "local_insufficient",
      git: createSyntheticGit({ reflogAgeDays: 9 }),
    },
    {
      prompt: "Which branch am I on right now?",
      intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
      status: "unavailable",
      outcome: "local_unavailable",
      git: async () => { const error = new Error("private Git path"); error.code = 128; throw error; },
    },
  ];

  for (const item of cases) {
    let fallbackCalls = 0;
    const routed = await routeRequest(item.prompt, {
      context: { cwd: PROJECT },
      handlers: createLocalHandlers({ runGit: item.git, now: () => FIXED_NOW }),
      fallback: async () => { fallbackCalls += 1; },
    });
    assert.equal(routed.decision.route, "local");
    assert.equal(routed.decision.intent, item.intent);
    assert.equal(routed.result.status, item.status);
    assert.equal(routed.routingDecision.outcome, item.outcome);
    assert.equal(fallbackCalls, 0);
  }
});

test("a thrown repaired-intent handler remains unavailable, sanitized, and fail-closed", async () => {
  let fallbackCalls = 0;
  const prompt = "What remote branch is this checkout tracking?";
  const routed = await routeRequest(prompt, {
    handlers: {
      [LOCAL_INTENTS.BRANCH_UPSTREAM]: async () => { throw new Error("API_KEY=private-handler-error"); },
    },
    fallback: async () => { fallbackCalls += 1; },
  });

  assert.equal(routed.result.status, "unavailable");
  assert.equal(routed.result.value, null);
  assert.doesNotMatch(routed.result.summary, /private-handler-error|API_KEY/u);
  assert.equal(routed.routingDecision.outcome, "local_unavailable");
  assert.equal(routed.routingDecision.fallbackStatus, "not_attempted");
  assert.doesNotMatch(JSON.stringify(routed.routingDecision), /private-handler-error|API_KEY|checkout tracking/u);
  assert.equal(fallbackCalls, 0);
});

test("repaired-route metrics deduplicate and diagnostics omit prompts and handler payloads", async () => {
  const prompt = "Which branch am I on right now?";
  const routed = await routeRequest(prompt, {
    handlers: {
      [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async () => ({
        kind: "local_result",
        intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
        status: "confirmed",
        value: { branch: "main" },
        summary: "API_KEY=diagnostic-secret",
        evidence: ["private evidence payload"],
        source: { kind: "test_fixture" },
        freshness: { state: "observed" },
      }),
    },
  });
  const metrics = new RouteMetrics();
  metrics.record(routed.decision, 4, { routingDecision: routed.routingDecision });
  metrics.record(routed.decision, 8, { routingDecision: routed.routingDecision });
  const diagnostic = JSON.stringify(routed.routingDecision);

  assert.equal(metrics.snapshot().routingDecisionCount, 1);
  assert.equal(metrics.snapshot().routingOutcomes.local_handled, 1);
  assert.equal(metrics.snapshot().routingReasons.local_rule_match, 1);
  assert.doesNotMatch(diagnostic, /diagnostic-secret|private evidence payload|API_KEY|Which branch/u);
});

function createSyntheticGit({
  gitCalls = [],
  branch = "main",
  upstream = "origin/main",
  aheadCount = 2,
  reflogAgeDays = 2,
  detached = false,
  noUpstream = false,
} = {}) {
  const updatedSeconds = Math.floor((FIXED_NOW.getTime() - reflogAgeDays * 24 * 60 * 60 * 1_000) / 1_000);
  return async (args, cwd) => {
    gitCalls.push({ args: [...args], cwd });
    if (args[0] === "branch") return detached ? "" : `${branch}\n`;
    if (args[0] === "symbolic-ref") {
      if (detached) { const error = new Error("detached"); error.code = 1; throw error; }
      return `${branch}\n`;
    }
    if (args[0] === "for-each-ref") return noUpstream ? "\n" : `${upstream}\n`;
    if (args[0] === "rev-list") return `${aheadCount}\n`;
    if (args[0] === "reflog") return `refs/remotes/origin/main@{${updatedSeconds} +0000}\n`;
    throw new Error(`unexpected synthetic Git command: ${args[0]}`);
  };
}
