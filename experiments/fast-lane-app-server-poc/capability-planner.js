"use strict";

const MAX_TASK_LENGTH = 32_768;
const MAX_CAPABILITY_CANDIDATES = 8;
const MAX_CATALOG_ENTRIES = 500;
const MAX_CAPABILITY_ID_LENGTH = 240;
const MAX_EXPLANATION_LENGTH = 240;
const MAX_RENDERED_PLAN_LENGTH = 12_000;
const MAX_RUNTIME_AGE_MS = 15 * 60 * 1000;

const STOP_WORDS = new Set([
  "a", "about", "after", "all", "an", "and", "any", "are", "as", "at", "be", "before", "can", "could",
  "do", "for", "from", "get", "help", "i", "in", "into", "is", "it", "its", "me", "my", "of", "on",
  "or", "our", "please", "should", "the", "their", "this", "to", "use", "using", "vesper", "we", "what",
  "when", "where", "with", "would", "you", "your", "server", "servers", "plugin", "plugins", "skill", "skills",
  "capability", "capabilities", "mcp", "tool", "tools",
]);

const TOPIC_GROUPS = Object.freeze([
  { id: "database", terms: ["database", "databases", "db", "sql", "postgres", "postgresql", "mysql", "sqlite", "query", "queries", "schema", "migration"] },
  { id: "source_control", terms: ["repository", "repositories", "repo", "git", "github", "gitlab", "branch", "commit", "commits", "pullrequest", "merge", "diff", "worktree"] },
  { id: "code_review", terms: ["review", "reviewer", "reviews", "audit", "auditing", "inspect", "inspection"] },
  { id: "web_research", terms: ["web", "browser", "browse", "internet", "website", "url", "search", "research", "documentation", "docs"] },
  { id: "testing", terms: ["test", "tests", "testing", "validate", "validation", "coverage", "suite"] },
]);
const TOPIC_LABELS = Object.freeze({
  database: "database and SQL work",
  source_control: "source control workflows",
  code_review: "code review",
  web_research: "web research and documentation",
  testing: "testing and validation",
  implementation: "software implementation",
  general_development: "general developer work",
  local_git_inspection: "a local Git fact",
  local_test_result: "a local test result",
  unknown: "an unclassified task",
});
const LOCAL_INTENT_CATEGORIES = Object.freeze({
  current_git_branch: "local_git_inspection",
  working_tree_status: "local_git_inspection",
  branch_upstream: "local_git_inspection",
  ahead_of_upstream: "local_git_inspection",
  most_recent_test_result: "local_test_result",
});
const REASON_TEXT = Object.freeze({
  capability_disabled: "The catalog explicitly marks this capability disabled.",
  capability_not_installed: "The capability is not installed, so it cannot be used now.",
  availability_unavailable: "The latest available evidence marks this capability unavailable.",
  capability_startup_failed: "Codex reported that MCP startup failed; it is not recommended as available.",
  capability_startup_cancelled: "Codex reported that MCP startup was cancelled; it is not recommended as available.",
  runtime_not_loaded: "Runtime evidence explicitly reports that this capability was not loaded.",
  requirements_missing: "The catalog reports missing requirements.",
  runtime_evidence_stale: "The runtime observation is older than the freshness window; current availability is uncertain.",
  runtime_evidence_missing: "No timestamped runtime observation confirms current availability.",
  configuration_unknown: "Configuration state is unknown.",
  installation_unknown: "Installation state is unknown.",
  enabled_unknown: "The catalog does not establish that this capability is enabled.",
  availability_unknown: "The catalog does not establish that this capability is available for use.",
  runtime_loaded_unknown: "The runtime has not confirmed that this capability is loaded.",
  runtime_inspection_unsupported: "This runtime does not expose a supported status signal for this capability.",
  capability_state_uncertain: "Available evidence is insufficient to establish eligibility.",
  runtime_startup_in_progress: "Codex reported that MCP startup is still in progress.",
  eligible_to_try: "Fresh runtime evidence supports an attempt; individual operation remains unverified.",
  operational_unverified: "No supported health check or tool call confirms operation; this plan does not claim operational status.",
  eligibility_confirmed: "Fresh runtime evidence confirms the capability is enabled, loaded, and available to try.",
  local_route_sufficient: "The deterministic local handler already covers this request, so no capability is recommended.",
});

function createCapabilityPlan({ task, catalog, routeDecision, projectContext, now = Date.now(), maxRuntimeAgeMs = MAX_RUNTIME_AGE_MS } = {}) {
  const taskText = typeof task === "string" ? task.slice(0, MAX_TASK_LENGTH) : "";
  const decision = normalizeRouteDecision(routeDecision);
  const category = classifyTaskCategory(taskText, decision);
  const matches = matchCapabilities(taskText, catalog, category);
  const candidates = matches.slice(0, MAX_CAPABILITY_CANDIDATES).map((match) => {
    const evaluation = evaluateCapabilityState(match.capability, { catalog, now, maxRuntimeAgeMs });
    const recommendationReasonCode = decision.route === "local"
      ? "local_route_sufficient"
      : evaluation.eligibility === "usable" ? "eligible_to_try" : evaluation.reasonCode;
    return {
      id: match.id,
      type: match.type,
      name: safeLabel(match.capability.displayName || match.capability.name || match.id, 120),
      discoverySource: safeLabel(match.capability.source?.name || "local capability catalog", 120),
      relevance: match.relevance,
      matchReasonCode: match.reasonCode,
      matchReason: match.reason,
      eligibility: evaluation.eligibility,
      reasonCode: evaluation.reasonCode,
      reason: REASON_TEXT[evaluation.reasonCode] || REASON_TEXT.capability_state_uncertain,
      recommendationStatus: decision.route === "local" ? "declined" : evaluation.eligibility === "usable" ? "eligible_to_try" : "declined",
      recommendationReasonCode,
      recommendationReason: REASON_TEXT[recommendationReasonCode] || REASON_TEXT.capability_state_uncertain,
      state: evaluation.state,
      evidence: evaluation.evidence,
      missingPrerequisites: evaluation.missingPrerequisites,
      freshness: evaluation.freshness,
      observedAt: evaluation.observedAt,
      runtimeSource: evaluation.runtimeSource,
      startupStatus: evaluation.startupStatus,
    };
  });
  const omittedCandidates = Math.max(0, matches.length - candidates.length);
  const recommendedCapabilityIds = candidates.filter((candidate) => candidate.recommendationStatus === "eligible_to_try").slice(0, 4).map((candidate) => candidate.id);
  const declinedCapabilities = candidates.filter((candidate) => candidate.recommendationStatus === "declined").map((candidate) => ({
    id: candidate.id,
    reasonCode: candidate.recommendationReasonCode,
    reason: candidate.recommendationReason,
  }));
  const hasUncertainty = candidates.some((candidate) => candidate.eligibility === "uncertain");
  const routeName = decision.route === "local" ? "local_handler" : decision.route === "codex" ? "codex_fallback" : "route_unavailable";
  const plan = {
    schemaVersion: 1,
    category,
    categoryLabel: TOPIC_LABELS[category] || TOPIC_LABELS.unknown,
    routeDecision: decision,
    executionPath: {
      route: decision.route,
      kind: routeName,
      intent: decision.intent,
      reason: decision.reason,
    },
    catalogScope: typeof projectContext?.cwd === "string" && projectContext.cwd || typeof catalog?.projectDirectory === "string" && catalog.projectDirectory
      ? "selected_project"
      : "project_scope_unknown",
    relevantCapabilities: candidates,
    recommendedCapabilityIds,
    declinedCapabilities,
    omittedCandidates,
    omittedCatalogEntries: Array.isArray(catalog?.capabilities) ? Math.max(0, catalog.capabilities.length - MAX_CATALOG_ENTRIES) : 0,
    malformedCatalogEntries: matches.malformedCount || 0,
    hasUncertainty,
    advisoryOnly: true,
    explanation: makePlanExplanation(routeName, category, candidates, recommendedCapabilityIds),
  };
  plan.routingMetadata = createRoutingMetadata(plan);
  return plan;
}

function classifyTaskCategory(task, routeDecision = {}) {
  const taskText = typeof task === "string" ? task : String(task ?? "");
  if (routeDecision.route === "local" && LOCAL_INTENT_CATEGORIES[routeDecision.intent]) {
    return LOCAL_INTENT_CATEGORIES[routeDecision.intent];
  }
  const tokens = tokenize(taskText);
  const topics = topicsFromTokens(tokens);
  if (topics.has("database")) return "database";
  if (topics.has("source_control") && topics.has("code_review")) return "code_review";
  if (topics.has("source_control")) return "source_control";
  if (topics.has("code_review")) return "code_review";
  if (topics.has("web_research")) return "web_research";
  if (topics.has("testing")) return "testing";
  if (/\b(implement|implementation|build|fix|debug|refactor|develop|development|code)\b/u.test(taskText.toLowerCase())) return "implementation";
  return taskText.trim() ? "general_development" : "unknown";
}

function matchCapabilities(task, catalog, category = classifyTaskCategory(task)) {
  const result = [];
  let malformedCount = 0;
  const capabilities = Array.isArray(catalog?.capabilities) ? catalog.capabilities.slice(0, MAX_CATALOG_ENTRIES) : [];
  const taskTokens = tokenize(task);
  const taskTopics = topicsFromTokens(taskTokens);
  for (const capability of capabilities) {
    if (!capability || typeof capability !== "object" || !validId(capability.id) || typeof capability.type !== "string") {
      malformedCount += 1;
      continue;
    }
    const fields = capabilityMetadataFields(capability);
    if (!fields.length) continue;
    const metadataTokens = tokenize(fields.join(" "));
    const metadataTopics = topicsFromTokens(metadataTokens);
    const sharedTopics = [...taskTopics].filter((topic) => metadataTopics.has(topic));
    const sharedTokens = [...taskTokens].filter((token) => metadataTokens.has(token) && !STOP_WORDS.has(token));
    let score = sharedTokens.length * 2 + sharedTopics.length * 4;
    if (category === "database" && metadataTopics.has("database")) score += 1;
    if (category === "source_control" && metadataTopics.has("source_control")) score += 1;
    if (category === "code_review" && metadataTopics.has("code_review")) score += 1;
    if (category === "web_research" && metadataTopics.has("web_research")) score += 1;
    if (category === "testing" && metadataTopics.has("testing")) score += 1;
    if (score < 2) continue;
    const matchReasonCode = sharedTopics.length ? "capability_topic_match" : "capability_metadata_match";
    result.push({
      id: String(capability.id).slice(0, MAX_CAPABILITY_ID_LENGTH),
      type: safeIdentifier(capability.type),
      capability,
      score,
      relevance: Math.min(100, score * 10),
      reasonCode: matchReasonCode,
      reason: matchReasonCode === "capability_topic_match"
        ? `Metadata matches ${topicLabel(sharedTopics[0])}.`
        : "Capability identifiers or descriptive metadata share task terms.",
    });
  }
  result.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  Object.defineProperty(result, "malformedCount", { value: malformedCount, enumerable: false });
  return result;
}

function evaluateCapabilityState(capability, { catalog, now = Date.now(), maxRuntimeAgeMs = MAX_RUNTIME_AGE_MS } = {}) {
  const states = normalizeStates(capability);
  const freshness = getFreshness(capability?.runtimeEvidence, now, maxRuntimeAgeMs);
  const evidence = ["Discovered: yes (entry found in the normalized local catalog)."];
  if (typeof capability?.source?.name === "string") evidence.push(`Discovery source: ${safeLabel(capability.source.name, 120)}.`);
  if (states.installed !== "unknown") evidence.push(`Installed: ${states.installed}.`);
  if (states.configured !== "unknown") evidence.push(`Configured: ${states.configured}.`);
  if (states.enabled !== "unknown") evidence.push(`Enabled: ${states.enabled}.`);
  if (states.availableForUse !== "unknown") evidence.push(`Available for use: ${states.availableForUse}.`);
  if (states.runtimeLoaded !== "unknown") evidence.push(`Runtime loaded: ${states.runtimeLoaded}.`);
  if (states.operational !== "unknown") evidence.push(`Operational: ${states.operational}.`);
  if (states.requirements !== "unknown") evidence.push(`Requirements: ${states.requirements}.`);
  if (freshness.observedAt) evidence.push(`Runtime observation: ${freshness.freshness} at ${freshness.observedAt}${freshness.source ? ` via ${freshness.source}` : ""}.`);
  else if (freshness.freshness === "unsupported") evidence.push("Runtime observation: unsupported by the inspected runtime interface.");
  else evidence.push("Runtime observation: no timestamped status evidence is available.");

  const startup = oneOf(capability?.runtimeEvidence?.startupStatus, ["starting", "ready", "failed", "cancelled"]);
  if (startup) evidence.push(`Codex-reported MCP startup: ${startup}; this is not a tool health check.`);
  const missingPrerequisites = [];
  const configurationBlocks = [];
  if (states.installationStatus === "not_installed") {
    configurationBlocks.push("capability_not_installed");
    missingPrerequisites.push("Install the capability through its supported provider workflow.");
  }
  if (states.enabled === "no" || states.configurationStatus === "disabled" || states.configurationStatus === "disabled_project") {
    configurationBlocks.push("capability_disabled");
    missingPrerequisites.push("Enable the capability using its supported configuration interface.");
  }
  if (states.requirements === "missing") {
    configurationBlocks.push("requirements_missing");
    missingPrerequisites.push("Resolve the capability requirements reported by its source.");
  }
  if (configurationBlocks.length) {
    const reasonCode = preferredBlockReason(configurationBlocks);
    return resultForState("unavailable", reasonCode, states, freshness, evidence, unique(missingPrerequisites));
  }

  if (freshness.freshness === "stale") {
    return resultForState("uncertain", "runtime_evidence_stale", states, freshness, evidence, ["Refresh status through an already-running supported runtime before relying on it."]);
  }
  if (freshness.freshness === "unsupported") {
    return resultForState("uncertain", "runtime_inspection_unsupported", states, freshness, evidence, ["A supported runtime-loaded and availability signal is needed before recommending this capability."]);
  }
  if (freshness.freshness !== "fresh") {
    return resultForState("uncertain", "runtime_evidence_missing", states, freshness, evidence, ["A fresh, timestamped runtime observation is needed before recommending this capability."]);
  }

  const runtimeBlocks = [];
  if (startup === "failed") runtimeBlocks.push("capability_startup_failed");
  if (startup === "cancelled") runtimeBlocks.push("capability_startup_cancelled");
  if (states.availabilityStatus === "available_for_install") runtimeBlocks.push("capability_not_installed");
  else if (states.availabilityStatus === "unavailable") runtimeBlocks.push("availability_unavailable");
  if (states.runtimeLoaded === "no" && !runtimeBlocks.includes("capability_startup_failed") && !runtimeBlocks.includes("capability_startup_cancelled")) runtimeBlocks.push("runtime_not_loaded");
  if (states.operational === "no") runtimeBlocks.push("availability_unavailable");
  if (runtimeBlocks.length) {
    return resultForState("unavailable", preferredBlockReason(runtimeBlocks), states, freshness, evidence, missingPrerequisites);
  }
  if (startup === "starting") {
    return resultForState("uncertain", "runtime_startup_in_progress", states, freshness, evidence, ["Wait for Codex to report startup completion."]);
  }

  const unknownPrerequisites = [];
  if (states.configurationStatus === "unknown" || states.configured === "unknown") unknownPrerequisites.push("Configuration state is unknown.");
  if (states.enabled === "unknown") unknownPrerequisites.push("Enabled state is unknown.");
  if (states.installationStatus === "unknown") unknownPrerequisites.push("Installation state is unknown.");
  if (states.availableForUse !== "yes") unknownPrerequisites.push("Availability for use is not confirmed.");
  if (states.runtimeLoaded !== "yes") unknownPrerequisites.push("Runtime-loaded state is not confirmed.");
  if (unknownPrerequisites.length) {
    return resultForState("uncertain", chooseUnknownReason(states, capability), states, freshness, evidence, unique(unknownPrerequisites));
  }

  const reasonCode = states.operational === "yes" ? "eligibility_confirmed" : "operational_unverified";
  return resultForState("usable", reasonCode, states, freshness, evidence, []);
}

function normalizeStates(capability) {
  const configurationStatus = enumValue(capability?.configurationStatus, ["enabled", "disabled", "enabled_project", "disabled_project", "present", "not_applicable"]);
  let configured = ["enabled", "disabled", "enabled_project", "disabled_project"].includes(configurationStatus) ? "yes" : "unknown";
  if (configurationStatus === "not_applicable") configured = "not_applicable";
  let enabled = oneOf(capability?.enabledStatus, ["yes", "no"]) || "unknown";
  if (enabled === "unknown") {
    if (["enabled", "enabled_project"].includes(configurationStatus)) enabled = "yes";
    if (["disabled", "disabled_project"].includes(configurationStatus)) enabled = "no";
  }
  const installationStatus = enumValue(capability?.installationStatus, ["installed", "not_installed", "not_applicable"]);
  const availabilityStatus = enumValue(capability?.availabilityStatus, ["available_for_use", "unavailable", "available_for_install"]);
  return {
    discovered: "yes",
    installationStatus,
    installed: installationStatus === "installed" ? "yes" : installationStatus === "not_installed" ? "no" : installationStatus,
    configurationStatus,
    configured,
    enabled,
    availabilityStatus,
    availableForUse: availabilityStatus === "available_for_use" ? "yes" : ["unavailable", "available_for_install"].includes(availabilityStatus) ? "no" : "unknown",
    runtimeLoaded: oneOf(capability?.runtimeLoadedStatus, ["yes", "no"]) || "unknown",
    operational: oneOf(capability?.operationalStatus, ["yes", "no"]) || "unknown",
    requirements: oneOf(capability?.requirementsStatus, ["satisfied", "missing", "not_applicable"]) || "unknown",
  };
}

function getFreshness(runtimeEvidence, now, maxRuntimeAgeMs) {
  const status = oneOf(runtimeEvidence?.status, ["observed", "unsupported", "error", "unknown"]) || "unknown";
  const startupStatus = oneOf(runtimeEvidence?.startupStatus, ["starting", "ready", "failed", "cancelled"]);
  const observedAt = typeof runtimeEvidence?.observedAt === "string" && Number.isFinite(Date.parse(runtimeEvidence.observedAt))
    ? new Date(runtimeEvidence.observedAt).toISOString()
    : null;
  const source = safeLabel(runtimeEvidence?.source, 120);
  if (status === "unsupported") return { freshness: "unsupported", observedAt, source, startupStatus };
  if (status !== "observed" || !observedAt) return { freshness: "unknown", observedAt: null, source, startupStatus };
  const checkedAt = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(checkedAt)) return { freshness: "unknown", observedAt, source, startupStatus };
  const maxAge = Number.isFinite(maxRuntimeAgeMs) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, maxRuntimeAgeMs)) : MAX_RUNTIME_AGE_MS;
  const age = checkedAt - Date.parse(observedAt);
  if (age < 0) return { freshness: "unknown", observedAt, source, startupStatus };
  return { freshness: age > maxAge ? "stale" : "fresh", observedAt, source, startupStatus };
}

function resultForState(eligibility, reasonCode, states, freshness, evidence, missingPrerequisites) {
  const reason = REASON_TEXT[reasonCode] || REASON_TEXT.capability_state_uncertain;
  if (reasonCode === "operational_unverified" && !missingPrerequisites.includes(reason)) missingPrerequisites = [...missingPrerequisites, reason];
  return {
    eligibility,
    reasonCode,
    state: {
      discovered: states.discovered,
      installed: states.installed,
      configured: states.configured,
      configurationStatus: states.configurationStatus,
      enabled: states.enabled,
      availableForUse: states.availableForUse,
      runtimeLoaded: states.runtimeLoaded,
      operational: states.operational,
      requirements: states.requirements,
      freshness: freshness.freshness,
    },
    evidence: evidence.slice(0, 12).map((entry) => safeLabel(entry, 220)),
    missingPrerequisites: missingPrerequisites.slice(0, 6).map((entry) => safeLabel(entry, 220)),
    freshness: freshness.freshness,
    observedAt: freshness.observedAt,
    runtimeSource: freshness.source,
    startupStatus: freshness.startupStatus,
  };
}

function capabilityMetadataFields(capability) {
  const values = [capability.id, capability.name, capability.displayName, capability.description];
  const declarations = capability.declaredCapabilities;
  if (Array.isArray(declarations?.items)) values.push(...declarations.items.slice(0, 30));
  for (const key of ["commands", "supportedCommands"]) {
    if (Array.isArray(capability[key])) values.push(...capability[key].slice(0, 30));
    else if (typeof capability[key] === "string") values.push(capability[key]);
  }
  let budget = 6_000;
  const bounded = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || budget <= 0 || bounded.length >= 40) continue;
    const selected = sanitizeCapabilityText(value.slice(0, Math.min(1_200, budget)));
    bounded.push(selected);
    budget -= selected.length;
  }
  return bounded;
}

function tokenize(value) {
  const text = String(value ?? "").normalize("NFKC").toLowerCase().replace(/pull\s+requests?/gu, " pullrequest ");
  const words = text.match(/[\p{L}\p{N}]{2,40}/gu) || [];
  return new Set(words.map(normalizeToken).filter((word) => word && !STOP_WORDS.has(word)).slice(0, 400));
}

function normalizeToken(value) {
  return String(value ?? "").replace(/[^\p{L}\p{N}]/gu, "");
}

function topicsFromTokens(tokens) {
  const topics = new Set();
  for (const group of TOPIC_GROUPS) {
    if (group.terms.some((term) => tokens.has(term))) topics.add(group.id);
  }
  return topics;
}

function topicLabel(topic) {
  return TOPIC_LABELS[topic] || "the task topic";
}

function normalizeRouteDecision(decision) {
  const route = oneOf(decision?.route, ["local", "codex"]);
  return {
    route: route || "unknown",
    intent: typeof decision?.intent === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(decision.intent) ? decision.intent : null,
    reason: typeof decision?.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(decision.reason) ? decision.reason : "route_not_provided",
  };
}

function makePlanExplanation(routeName, category, candidates, recommendedIds) {
  const route = routeName === "local_handler" ? "the existing local handler" : routeName === "codex_fallback" ? "the existing Codex fallback" : "the route supplied by the caller";
  if (!candidates.length) return `No capability metadata matched ${topicLabel(category)}. The plan preserves ${route} and recommends no capability.`;
  const ready = recommendedIds.length;
  const unknown = candidates.filter((candidate) => candidate.eligibility === "uncertain").length;
  const capabilityNoun = candidates.length === 1 ? "capability" : "capabilities";
  if (routeName === "local_handler") return `${candidates.length} relevant ${capabilityNoun} found, but the local handler already covers this request. The plan preserves ${route} and recommends no capability.`;
  return `${candidates.length} relevant ${capabilityNoun} found; ${ready} eligible to try and ${unknown} uncertain. The plan preserves ${route}; no capability is activated or executed.`;
}

function createRoutingMetadata(plan) {
  return {
    schemaVersion: 1,
    category: safeIdentifier(plan.category),
    relevantCapabilityIds: plan.relevantCapabilities.slice(0, 6).map((candidate) => candidate.id),
    recommendedCapabilityIds: plan.recommendedCapabilityIds.slice(0, 4),
    eligibility: plan.relevantCapabilities.slice(0, 6).map((candidate) => ({
      id: candidate.id,
      status: candidate.eligibility,
      reasonCode: safeIdentifier(candidate.reasonCode),
      matchReasonCode: safeIdentifier(candidate.matchReasonCode),
      recommendation: safeIdentifier(candidate.recommendationStatus),
      recommendationReasonCode: safeIdentifier(candidate.recommendationReasonCode),
    })),
    reasonCodes: unique(plan.relevantCapabilities.flatMap((candidate) => [
      safeIdentifier(candidate.matchReasonCode),
      safeIdentifier(candidate.reasonCode),
      safeIdentifier(candidate.recommendationReasonCode),
    ])).slice(0, 12),
    hasUncertainty: Boolean(plan.hasUncertainty),
    advisoryOnly: true,
  };
}

function renderCapabilityPlan(plan) {
  const lines = [
    "Vesper plan · advisory only · not executed",
    `Task category: ${safeLabel(plan?.categoryLabel || TOPIC_LABELS.unknown, 100)}`,
    `Existing route: ${safeLabel(plan?.routeDecision?.route || "unknown", 40)} · ${safeLabel(plan?.routeDecision?.reason || "unknown", 64)}`,
    `Execution path: ${safeLabel(plan?.executionPath?.kind || "route_unavailable", 40)}${plan?.executionPath?.intent ? ` · ${safeLabel(plan.executionPath.intent, 64)}` : ""}`,
    `Catalog scope: ${plan?.catalogScope === "selected_project" ? "selected project" : "unknown"}`,
    `Plan uncertainty: ${plan?.hasUncertainty ? "present" : "none reported"}`,
    `Plan: ${safeLabel(plan?.explanation || "No plan explanation is available.", MAX_EXPLANATION_LENGTH)}`,
  ];
  const candidates = Array.isArray(plan?.relevantCapabilities) ? plan.relevantCapabilities.slice(0, MAX_CAPABILITY_CANDIDATES) : [];
  if (!candidates.length) lines.push("Relevant capabilities: none");
  else {
    lines.push("Relevant capabilities:");
    for (const candidate of candidates) {
      const eligibilityLabel = candidate.eligibility === "usable" ? "usable to try" : candidate.eligibility;
      lines.push(`- ${safeLabel(candidate.id, MAX_CAPABILITY_ID_LENGTH)} · ${safeLabel(candidate.type, 40)} · ${safeLabel(candidate.name, 120)} · ${safeLabel(eligibilityLabel, 20)}`);
      lines.push(`  Match: ${safeLabel(candidate.matchReason, MAX_EXPLANATION_LENGTH)}`);
      lines.push(`  Discovery source: ${safeLabel(candidate.discoverySource || "local capability catalog", 120)}`);
      const state = candidate.state || {};
      lines.push(`  State: discovered ${state.discovered || "unknown"}; installed ${state.installed || "unknown"}; configured ${state.configured || "unknown"} (${state.configurationStatus || "unknown"}); enabled ${state.enabled || "unknown"}; available ${state.availableForUse || "unknown"}; loaded ${state.runtimeLoaded || "unknown"}; operational ${state.operational || "unknown"}; requirements ${state.requirements || "unknown"}; runtime evidence ${candidate.freshness || "unknown"}`);
      if (candidate.startupStatus) lines.push(`  Codex-reported MCP startup: ${safeLabel(candidate.startupStatus, 20)}; this is not a tool health check.`);
      for (const item of (Array.isArray(candidate.evidence) ? candidate.evidence : []).slice(0, 4)) lines.push(`  Evidence: ${safeLabel(item, 220)}`);
      if (candidate.observedAt) lines.push(`  Runtime observation: ${safeLabel(candidate.observedAt, 40)}${candidate.runtimeSource ? ` via ${safeLabel(candidate.runtimeSource, 120)}` : ""} · ${safeLabel(candidate.freshness, 20)}`);
      for (const item of (Array.isArray(candidate.missingPrerequisites) ? candidate.missingPrerequisites : []).slice(0, 4)) lines.push(`  Missing or unverified: ${safeLabel(item, 220)}`);
      if (candidate.recommendationStatus === "declined") lines.push(`  Recommendation declined: ${safeLabel(candidate.recommendationReason, MAX_EXPLANATION_LENGTH)} Capability state: ${safeLabel(candidate.reason, MAX_EXPLANATION_LENGTH)}`);
    }
  }
  if ((plan?.omittedCandidates || 0) > 0) lines.push(`Additional relevant capabilities omitted: ${Math.min(10_000, plan.omittedCandidates)}.`);
  if ((plan?.omittedCatalogEntries || 0) > 0) lines.push(`Catalog entries beyond the planning scan limit: ${Math.min(10_000, plan.omittedCatalogEntries)}.`);
  if ((plan?.malformedCatalogEntries || 0) > 0) lines.push(`Malformed catalog entries skipped: ${Math.min(10_000, plan.malformedCatalogEntries)}.`);
  lines.push(`Eligible to try: ${Array.isArray(plan?.recommendedCapabilityIds) && plan.recommendedCapabilityIds.length ? plan.recommendedCapabilityIds.map((id) => safeLabel(id, MAX_CAPABILITY_ID_LENGTH)).join(", ") : "none"}`);
  lines.push("Vesper does not automatically select or execute capabilities from this advisory plan.");
  let rendered = `${lines.join("\n")}\n`;
  if (rendered.length > MAX_RENDERED_PLAN_LENGTH) rendered = `${rendered.slice(0, MAX_RENDERED_PLAN_LENGTH - 48)}\n[Plan output truncated at the display limit.]\n`;
  return rendered;
}

async function getPlanningMetadata({ task, capabilityProvider, routeDecision, projectContext, now } = {}) {
  if (!capabilityProvider || typeof capabilityProvider.getCatalog !== "function") return null;
  try {
    const catalog = await capabilityProvider.getCatalog({ refreshRuntime: true });
    return createCapabilityPlan({ task, catalog, routeDecision, projectContext, now }).routingMetadata;
  } catch {
    return null;
  }
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CAPABILITY_ID_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value) && safeLabel(value, MAX_CAPABILITY_ID_LENGTH) === value;
}

function sanitizeCapabilityText(value) {
  return safeLabel(value, 6_000).replace(/\[redacted[^\]]*\]/giu, " ");
}

function enumValue(value, options) {
  return oneOf(value, options) || "unknown";
}

function oneOf(value, options) {
  return options.includes(value) ? value : null;
}

function preferredBlockReason(reasons) {
  const priority = ["capability_startup_failed", "capability_startup_cancelled", "capability_disabled", "requirements_missing", "capability_not_installed", "availability_unavailable", "runtime_not_loaded"];
  return priority.find((reason) => reasons.includes(reason)) || "availability_unavailable";
}

function chooseUnknownReason(states, capability) {
  if (capability?.runtimeEvidence?.status === "unsupported") return "runtime_inspection_unsupported";
  if (states.configurationStatus === "unknown" || states.configured === "unknown") return "configuration_unknown";
  if (states.installationStatus === "unknown") return "installation_unknown";
  if (states.enabled === "unknown") return "enabled_unknown";
  if (states.availableForUse !== "yes") return "availability_unknown";
  if (states.runtimeLoaded !== "yes") return "runtime_loaded_unknown";
  return "capability_state_uncertain";
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value) ? value : "unknown";
}

function safeLabel(value, maxLength = 220) {
  return String(value ?? "unknown")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, "[redacted private key]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/giu, "[redacted private key]")
    .replace(/\b(https?:\/\/)[^/@\s:]+:[^/@\s]+@/giu, "$1[redacted]@")
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/giu, "[redacted secret]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\b(authorization|bearer|api[_-]?key|(?:access|refresh|auth)?[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ")
    .slice(0, maxLength);
}

function unique(values) {
  return [...new Set(values)];
}

module.exports = {
  MAX_CAPABILITY_CANDIDATES,
  MAX_CATALOG_ENTRIES,
  MAX_RENDERED_PLAN_LENGTH,
  MAX_RUNTIME_AGE_MS,
  classifyTaskCategory,
  createCapabilityPlan,
  evaluateCapabilityState,
  getPlanningMetadata,
  matchCapabilities,
  renderCapabilityPlan,
};
