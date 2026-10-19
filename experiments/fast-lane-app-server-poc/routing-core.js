"use strict";

const LOCAL_INTENTS = Object.freeze({
  CURRENT_GIT_BRANCH: "current_git_branch",
  WORKING_TREE_STATUS: "working_tree_status",
  BRANCH_UPSTREAM: "branch_upstream",
  AHEAD_OF_UPSTREAM: "ahead_of_upstream",
  MOST_RECENT_TEST_RESULT: "most_recent_test_result",
});

const INTENT_PHRASES = new Map([
  [LOCAL_INTENTS.CURRENT_GIT_BRANCH, new Set([
    "what git branch am i on",
    "what branch am i on",
    "which git branch am i on",
    "which branch am i on",
    "what is my current branch",
    "what is the current branch",
    "what is the current git branch",
    "current branch",
    "current git branch",
    "what is the current branch name",
    "what branch is checked out",
    "which branch is checked out",
    "tell me the name of the checked out branch",
  ])],
  [LOCAL_INTENTS.WORKING_TREE_STATUS, new Set([
    "what is the working tree status",
    "whats the working tree status",
    "show working tree status",
    "show git status",
    "git status",
    "working tree status",
    "what is the git status",
    "whats the git status",
    "is my working tree clean",
    "is the working tree clean",
    "is my git working tree clean",
    "is the worktree clean",
    "do i have uncommitted changes",
    "are there uncommitted changes",
    "are there any uncommitted changes",
    "have i made any local edits",
  ])],
  [LOCAL_INTENTS.BRANCH_UPSTREAM, new Set([
    "does this branch have an upstream",
    "does my branch have an upstream",
    "does my current branch have an upstream",
    "is this branch tracking an upstream",
    "does this branch track an upstream",
    "does this branch track a remote branch",
    "is this branch tracking a remote",
    "is my branch tracking a remote branch",
    "what upstream does this branch track",
    "which upstream does this branch track",
    "what is the upstream branch",
    "is there an upstream for this branch",
    "is there an upstream configured for the current branch",
    "what remote branch does this branch track",
  ])],
  [LOCAL_INTENTS.AHEAD_OF_UPSTREAM, new Set([
    "am i ahead of upstream",
    "am i ahead of my upstream",
    "am i ahead of the last fetched upstream",
    "is my branch ahead of upstream",
    "is this branch ahead of upstream",
    "how many commits am i ahead of upstream",
    "how many commits ahead of upstream am i",
    "do i have commits ahead of upstream",
    "are there local commits ahead of upstream",
    "are my local commits ahead of upstream",
    "how many local commits are ahead of upstream",
  ])],
  [LOCAL_INTENTS.MOST_RECENT_TEST_RESULT, new Set([
    "what was the most recent test result",
    "what is the most recent test result",
    "most recent test result",
    "latest test result",
    "what was the last test result",
    "what was the result of the last test run",
    "what was the most recent test run result",
    "did the last test run pass",
    "did my last test pass",
    "did the last tests pass",
    "were the latest test results successful",
  ])],
]);

// These constrained patterns recognize common grammatical variants while
// requiring each request to ask for one specific, locally evidenced fact.
const INTENT_PATTERNS = new Map([
  [LOCAL_INTENTS.CURRENT_GIT_BRANCH, [
    /^(?:name|tell me the name of|give me the name of|what is the name of) (?:the )?(?:checked out|current|active) (?:git )?branch$/u,
    /^(?:which|what) branch is (?:currently )?(?:active|checked out)(?: in this checkout)?$/u,
  ]],
  [LOCAL_INTENTS.WORKING_TREE_STATUS, [
    /^(?:do i have|are there) (?:any )?(?:uncommitted (?:file )?(?:changes|edits)|(?:local|working tree|worktree) edits|edits in (?:my )?(?:working tree|worktree))$/u,
  ]],
  [LOCAL_INTENTS.MOST_RECENT_TEST_RESULT, [
    /^(?:did|has|have|was|were) (?:the|my) (?:latest|most recent|last) (?:test run|test results|tests?) (?:pass|passed|succeed|succeeded|successful)$/u,
  ]],
]);

const RESULT_STATUSES = new Set(["confirmed", "unknown", "stale", "unavailable"]);

function normalizeRequest(request) {
  return String(request ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function classifyRequest(request) {
  const normalized = normalizeRequest(request);
  const matches = new Set();
  let exactMatch = false;
  for (const [intent, phrases] of INTENT_PHRASES) {
    if (phrases.has(normalized)) {
      matches.add(intent);
      exactMatch = true;
    }
  }
  for (const [intent, patterns] of INTENT_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(normalized))) matches.add(intent);
  }

  if (matches.size === 1) {
    return { route: "local", intent: [...matches][0], reason: exactMatch ? "local_exact_match" : "local_rule_match" };
  }
  if (matches.size > 1 || isAmbiguousLocalRequest(normalized)) {
    return { route: "codex", intent: null, reason: "local_ambiguous" };
  }
  return { route: "codex", intent: null, reason: "codex_fallback" };
}

function isAmbiguousLocalRequest(normalized) {
  if (!normalized) return false;
  return /\b(branch|upstream|remote|pushed|push|working tree|worktree|uncommitted|git status|test run|test result|tests?)\b/u.test(normalized);
}

/**
 * @typedef {Object} LocalResult
 * @property {"local_result"} kind
 * @property {string} intent
 * @property {"confirmed"|"unknown"|"stale"|"unavailable"} status
 * @property {unknown} value
 * @property {string} summary
 * @property {string[]} evidence
 * @property {{kind:string, command?:string, scope?:string}} source
 * @property {{state:string, observedAt?:string, lastUpdatedAt?:string, caveat?:string}} freshness
 */

function createLocalResult({ intent, status, value = null, summary, evidence = [], source, freshness }) {
  if (!Object.values(LOCAL_INTENTS).includes(intent)) throw new TypeError("Unknown local intent.");
  if (!RESULT_STATUSES.has(status)) throw new TypeError("Unknown local result status.");
  return {
    kind: "local_result",
    intent,
    status,
    value,
    summary: String(summary),
    evidence: [...evidence],
    source: { ...source },
    freshness: { ...freshness },
  };
}

function createUnavailableResult(intent, summary = "Local check unavailable; no answer was produced.") {
  return createLocalResult({
    intent,
    status: "unavailable",
    value: null,
    summary,
    evidence: ["The local handler did not produce a result."],
    source: { kind: "local_handler" },
    freshness: { state: "unknown" },
  });
}

function isLocalResult(result, intent) {
  return Boolean(
    result &&
    result.kind === "local_result" &&
    result.intent === intent &&
    RESULT_STATUSES.has(result.status) &&
    typeof result.summary === "string" &&
    Array.isArray(result.evidence) &&
    result.source && typeof result.source === "object" &&
    result.freshness && typeof result.freshness === "object"
  );
}

async function routeRequest(request, { decision: suppliedDecision, handlers = {}, context = {}, fallback } = {}) {
  const decision = suppliedDecision || classifyRequest(request);
  if (decision.route === "codex") {
    return {
      decision,
      ...(typeof fallback === "function" ? { fallbackResult: await fallback(decision) } : {}),
    };
  }

  const handler = handlers[decision.intent];
  if (typeof handler !== "function") {
    return { decision, result: createUnavailableResult(decision.intent, "No local handler is registered; no answer was produced.") };
  }

  try {
    const result = await handler(context);
    return {
      decision,
      result: isLocalResult(result, decision.intent)
        ? result
        : createUnavailableResult(decision.intent, "The local handler returned no trustworthy result."),
    };
  } catch {
    return { decision, result: createUnavailableResult(decision.intent) };
  }
}

class RouteMetrics {
  constructor() {
    this.localRouteCount = 0;
    this.fallbackCount = 0;
    this.handlerFailureCount = 0;
    this.lastRouteLatencyMs = 0;
  }

  record(decision, latencyMs, { handlerFailed = false } = {}) {
    if (decision.route === "local") this.localRouteCount += 1;
    else this.fallbackCount += 1;
    if (handlerFailed) this.handlerFailureCount += 1;
    this.lastRouteLatencyMs = Math.max(0, Math.round(latencyMs));
    return this.snapshot();
  }

  snapshot() {
    return {
      localRouteCount: this.localRouteCount,
      fallbackCount: this.fallbackCount,
      routeLatencyMs: this.lastRouteLatencyMs,
      handlerFailureCount: this.handlerFailureCount,
    };
  }
}

module.exports = {
  LOCAL_INTENTS,
  RouteMetrics,
  classifyRequest,
  createLocalResult,
  createUnavailableResult,
  normalizeRequest,
  routeRequest,
};
