"use strict";

const { renderRepositoryContext } = require("./repository-intelligence");
const { escapeTerminalOutput, redactSensitiveText } = require("./command-activity");

const MAX_RENDERED_FINDINGS = 20;
const MAX_RENDERED_OUTPUT = 20_000;

class SystemModelCoordinator {
  constructor({ repositoryIntelligence } = {}) {
    if (!repositoryIntelligence || typeof repositoryIntelligence.inspect !== "function" || typeof repositoryIntelligence.interrupt !== "function") {
      throw new TypeError("A repository-intelligence service is required.");
    }
    this.repositoryIntelligence = repositoryIntelligence;
    this.active = false;
  }

  async investigate({ task = "", signal, intent: requestedIntent, routeDecision = null } = {}) {
    if (this.active) throw new Error("A repository investigation is already active for this session.");
    this.active = true;
    const intent = normalizeIntent(requestedIntent) || interpretTask(task);
    try {
      const evidence = await this.repositoryIntelligence.inspect({
        task,
        intent,
        includeHistory: intent !== "overview" || Boolean(task),
        includeDiff: ["bug", "feature", "change-plan"].includes(intent),
        selectNextStep: (snapshot) => this.selectNextStep(snapshot),
        signal,
      });
      const findings = evidence.findings || [];
      const steps = evidence.evidence?.investigation?.steps || [];
      const unresolved = [...(evidence.evidence?.investigation?.unresolved || [])];
      const dependencyTrace = buildDependencyTrace(findings);
      const referenceTrace = buildReferenceTrace(findings);
      const referenceIndex = evidence.referenceIndex || evidence.evidence?.investigation?.referenceIndex || null;
      const observedPaths = [...new Set(findings.filter((item) => item.path).map((item) => item.path))].slice(0, 12);
      const inferred = findings.filter((item) => item.observation === "inferred");
      const assumptions = [];
      if (evidence.status !== "complete") assumptions.push(...(evidence.incomplete || []).slice(0, 5));
      if (inferred.length || intent === "trace") assumptions.push("Entry-point and import-path conclusions are heuristic; import evidence does not establish runtime call order.");
      if (findings.some((item) => item.type === "likely-call-site" || item.type === "route-handler")) assumptions.push("Likely call sites and route-handler matches are syntactic candidates; aliasing, dynamic dispatch, and framework behavior are not resolved.");
      if (referenceIndex?.status === "partial") assumptions.push("The JS/TS symbol/reference index is partial; unread files were not searched and prior cached line references were discarded.");
      if (findings.some((item) => item.status === "contradictory")) assumptions.push("At least one repository declaration points to missing or conflicting evidence; treat that reference as unresolved.");
      if (findings.some((item) => item.status === "stale")) assumptions.push("Some evidence is marked stale and should be refreshed before relying on it.");
      if (!evidence.git?.available) assumptions.push("Git status, history, and diff could not be established for this project root.");
      if (!findings.length) assumptions.push("No evidence-backed source findings were produced; inspect the project manually or narrow the task to a symbol or path.");
      const plan = createGroundedPlan(intent, findings, evidence);
      const verificationRequirements = [...new Set((evidence.project?.commands || [])
        .filter((item) => /^(?:test|test:|build)$/u.test(item.name))
        .map((item) => `${item.name}: ${item.command} (identified from ${item.path}; not run)`))].slice(0, 8);
      if (!verificationRequirements.length) verificationRequirements.push("Choose and run the appropriate project verification explicitly; Vesper did not execute commands during inspection.");
      const hasTaskMatch = findings.some((item) => ["symbol", "reference", "symbol-definition", "identifier-reference", "likely-call-site", "route-handler", "test-reference", "path-match", "import-edge"].includes(item.type));
      if (["trace", "bug", "change-plan"].includes(intent) && !hasTaskMatch) unresolved.push("No task-matched symbol, textual reference, or local import edge was confirmed.");
      const stopReason = evidence.evidence?.investigation?.stopReason || "investigation-status-unknown";
      const additionalInspectionRecommended = evidence.status !== "complete" || unresolved.length > 0;
      return Object.freeze({
        contractVersion: 1,
        question: typeof task === "string" ? task.slice(0, 8_192) : "",
        intent,
        status: evidence.status,
        observedAt: evidence.observedAt || null,
        steps,
        dependencyTrace: Object.freeze(dependencyTrace),
        referenceTrace: Object.freeze(referenceTrace),
        referenceIndex,
        unresolved: Object.freeze([...new Set(unresolved)].slice(0, 12)),
        stopReason,
        remainingBudget: evidence.evidence?.investigation?.remainingBudget || Object.freeze({ operations: 0, targetedReads: 0, milliseconds: 0, sourceBytes: 0 }),
        routeDecision: routeDecision ? normalizeRouteDecision(routeDecision) : null,
        coordination: Object.freeze({
          additionalInspectionRecommended,
          providerReasoningRecommended: Boolean(normalizeText(task)),
          reason: "Investigation stopped because " + stopReason.replaceAll("-", " ") + (additionalInspectionRecommended
            ? "; coverage limits or task-specific questions remain unresolved."
            : "; no justified local read remains within the current evidence."),
        }),
        project: evidence.project,
        git: evidence.git,
        findings,
        evidence: evidence.evidence,
        inspectedPaths: Object.freeze(observedPaths),
        plan: Object.freeze(plan),
        assumptions: Object.freeze([...new Set(assumptions)].slice(0, 8)),
        verificationRequirements: Object.freeze(verificationRequirements),
        incomplete: evidence.incomplete,
        providerContext: renderRepositoryContext(evidence),
      });
    } finally {
      this.active = false;
    }
  }

  selectNextStep(snapshot) {
    if (!["trace", "bug", "change-plan", "investigate"].includes(snapshot.intent)) return { stop: true, reason: "sufficient-evidence" };
    const readPaths = new Set(snapshot.readPaths);
    const edges = snapshot.findings
      .filter((item) => item.type === "import-edge" && item.relatedPath && !readPaths.has(item.relatedPath) && item.depth <= 2)
      .sort((a, b) => a.depth - b.depth || rankImportEdge(b, snapshot.taskTerms) - rankImportEdge(a, snapshot.taskTerms) ||
        String(a.relatedPath).localeCompare(String(b.relatedPath)));
    if (edges.length) {
      const edge = edges[0];
      return readOperation(edge.relatedPath, edge.depth,
        "Inspect the local module imported at " + edge.path + ":" + edge.lineStart + "; this may clarify the neighboring layer.");
    }
    const indexedCandidate = (snapshot.referenceCandidates || []).find((item) => !readPaths.has(item.path));
    if (indexedCandidate) {
      return readOperation(indexedCandidate.path, 1,
        `Read ${indexedCandidate.path} because it is a ${indexedCandidate.reason} for ${indexedCandidate.symbol} defined in ${indexedCandidate.definitionPath}.`);
    }
    const candidate = snapshot.candidateFiles.find((item) => !readPaths.has(item.path) &&
      (item.changed || item.entryPoint || item.score >= 9));
    if (candidate && snapshot.findings.some((item) => ["symbol", "reference", "path-match", "git-diff"].includes(item.type))) {
      return readOperation(candidate.path, 1, "Inspect the task-matched entry point or Git-changed source candidate " + candidate.path + ".");
    }
    return { stop: true, reason: snapshot.findings.some((item) => ["symbol", "reference", "symbol-definition", "identifier-reference", "likely-call-site", "import-edge"].includes(item.type)) ? "no-justified-next-step" : "no-targeted-evidence" };
  }

  interrupt() { return this.repositoryIntelligence.interrupt(); }
}

function rankImportEdge(edge, taskTerms) {
  const text = (edge.relatedPath + " " + edge.path).toLowerCase();
  return (taskTerms || []).reduce((score, term) => score + (text.includes(String(term).toLowerCase()) ? 1 : 0), 0);
}

function buildDependencyTrace(findings) {
  return findings.filter((item) => item.type === "import-edge" && item.path && item.relatedPath)
    .sort((a, b) => (a.depth || 0) - (b.depth || 0) || a.path.localeCompare(b.path) || (a.lineStart || 0) - (b.lineStart || 0))
    .slice(0, 16)
    .map((item) => Object.freeze({ from: item.path, line: item.lineStart || null, to: item.relatedPath, depth: item.depth || 1,
      evidence: "observed local import declaration; not proof of a runtime call" }));
}

function buildReferenceTrace(findings) {
  return findings.filter((item) => ["likely-call-site", "route-handler", "test-reference", "symbol-import"].includes(item.type) && item.path && item.symbol)
    .sort((a, b) => a.path.localeCompare(b.path) || (a.lineStart || 0) - (b.lineStart || 0) || a.type.localeCompare(b.type))
    .slice(0, 24)
    .map((item) => Object.freeze({ type: item.type, path: item.path, line: item.lineStart || null, symbol: item.symbol,
      ...(item.moduleSpecifier ? { moduleSpecifier: item.moduleSpecifier } : {}),
      ...(item.importedName ? { importedName: item.importedName } : {}),
      ...(item.relatedPath ? { relatedPath: item.relatedPath } : {}),
      ...(item.relatedLine ? { relatedLine: item.relatedLine } : {}),
      ...(item.route ? { route: item.route } : {}), confidence: item.confidence || "unknown", observation: item.observation || "observed",
      confirmedByRead: item.sourceContextRead === true,
      evidence: item.type === "likely-call-site" ? "identifier followed by call parentheses; any linked definition is only the unique definition in the indexed sample" : item.type === "route-handler"
        ? "framework-like route declaration; framework semantics unconfirmed" : item.type === "test-reference"
          ? "test-path source mentions the symbol; test coverage or execution unconfirmed" : "parsed import binding; not proof of a call" }));
}

function readOperation(filePath, depth, purpose) {
  return {
    operation: { toolId: "read_file", input: { path: filePath } },
    purpose: purpose.slice(0, 180),
    requiredInputs: ["path"],
    expectedEvidence: "Source declarations, references, and local imports with exact line numbers.",
    depth,
  };
}

function createSystemModel(options) {
  const coordinator = new SystemModelCoordinator(options);
  return Object.freeze({
    investigate: (request) => coordinator.investigate(request),
    interrupt: () => coordinator.interrupt(),
  });
}

function interpretTask(task) {
  const text = normalizeText(task);
  if (!text) return "overview";
  if (/\b(?:bug|defect|debug|root cause|failing|failure|regression|broken|error)\b/u.test(text)) return "bug";
  if (/\b(?:trace|follow|execution path|call path|data flow|request flow|how .* works|where .* (?:called|handled|routed))\b/u.test(text)) return "trace";
  if (/\b(?:plan|implement|add|create|change|refactor|extend|build|feature|fix)\b/u.test(text)) return "change-plan";
  if (/\b(?:architecture|structure|framework|dependency|dependencies|entry point|entrypoint|codebase|repository|project layout)\b/u.test(text)) return "overview";
  return "investigate";
}

function shouldInvestigateTask(task) {
  const text = normalizeText(task);
  if (!text) return false;
  return /\b(?:repository|repo|codebase|project architecture|architecture|project structure|entry point|entrypoint|framework|dependency|dependencies|trace|execution path|call path|data flow|bug|defect|debug|root cause|regression|implement|implementation|add|create|refactor|extend|feature|fix|change|symbol|function|class|route|startup path)\b/u.test(text);
}

function createGroundedPlan(intent, findings, evidence) {
  const sourceFindings = findings.filter((item) => ["symbol", "reference", "symbol-definition", "symbol-import", "symbol-export", "identifier-reference", "likely-call-site", "route-handler", "test-reference", "textual-reference", "import-edge", "source-section", "git-diff", "git-diff-hunk"].includes(item.type));
  const paths = [...new Set(sourceFindings.filter((item) => item.path).map((item) => item.path))].slice(0, 5);
  const commands = evidence.project?.commands || [];
  if (intent === "overview") {
    return [
      "Summarize the observed repository structure, manifests, language and declared frameworks.",
      "Describe manifest-declared startup entries separately from conventional entry-point inferences.",
      "Cite the inspected paths and call out missing Git or metadata evidence.",
    ];
  }
  if (intent === "trace") {
    return [
      sourceFindings.length ? `Start from the observed symbol/reference findings${paths.length ? ` in ${paths.join(", ")}` : ""}.` : "No matching source symbol was confirmed; identify a narrower symbol or inspect likely entry points.",
      "Use the ordered import trace and parsed call-site candidates as evidence pointers; neither establishes a complete runtime call graph or execution order.",
      "Request additional reads for unresolved branches before presenting a complete path.",
    ];
  }
  if (intent === "bug") {
    return [
      evidence.git?.diff ? "Compare the current working-tree diff and recent local history with the task-relevant symbol matches." : "Use the task-relevant symbol matches and available recent Git history to identify candidate code paths.",
      "Present candidate causes with file and line evidence; do not claim a root cause until behavior is verified.",
      "Propose a focused change only after the affected path is inspected; tests remain unrun until explicitly requested.",
    ];
  }
  if (["change-plan", "feature"].includes(intent)) {
    const pathNote = paths.length ? `Relevant inspected files include ${paths.join(", ")}.` : "No task-relevant source file was confirmed in the bounded sample.";
    const verify = commands.length ? `Review declared project scripts such as ${commands.slice(0, 3).map((item) => item.name).join(", ")}; do not assume they ran.` : "Identify a verification command from project documentation or manifests before claiming a result.";
    return [
      pathNote,
      "Confirm each proposed file against the observed entry points and symbol references; treat heuristic dependencies as candidates.",
      "Use Vesper's existing file proposal and one-time approval workflow for writes.",
      verify,
    ];
  }
  return [
    paths.length ? `Use the observed evidence in ${paths.join(", ")}.` : "Start from the repository structure and declared manifests.",
    "Inspect additional files before asserting cross-file behavior; the current dependency trace is bounded and approximate.",
    "Separate facts from assumptions in the explanation.",
  ];
}

function renderSystemModelReport(result) {
  if (!result || typeof result !== "object") return "Vesper repository investigation unavailable.\n";
  const lines = ["Vesper repository investigation · deterministic and read-only", `Intent: ${result.intent || "unknown"} · status: ${result.status || "unknown"}${result.observedAt ? ` · observed ${result.observedAt}` : ""}`,
    `Project files discovered: ${result.project?.fileCount ?? 0} · directories inspected: ${result.project?.directoryCount ?? 0}`];
  if (result.routeDecision) lines.push(`Existing route: ${result.routeDecision.route} · ${result.routeDecision.reason}. The investigation did not change the route.`);
  if (result.coordination) lines.push(`Next analysis: ${result.coordination.additionalInspectionRecommended ? "additional evidence recommended" : "no additional local inspection selected"}${result.coordination.providerReasoningRecommended ? "; selected-provider reasoning may continue" : ""}.`);
  if (result.project?.languages?.length) lines.push(`Languages: ${result.project.languages.slice(0, 6).map((item) => `${item.name} (${item.files})`).join(", ")}`);
  if (result.project?.frameworks?.length) lines.push(`Framework indicators: ${result.project.frameworks.slice(0, 8).map((item) => `${item.name} via ${item.dependency}`).join(", ")}`);
  if (result.steps?.length) {
    lines.push("Ordered investigation steps:");
    for (const step of result.steps.slice(0, 16)) {
      lines.push(String(step.index) + ". " + (step.state || "unknown") + " · " + (step.operation?.toolId || "unknown operation") + " · " + (step.purpose || "Purpose unavailable."));
      if (step.result?.summary) lines.push("   Result: " + step.result.summary);
      for (const reference of (step.result?.evidenceRefs || []).slice(0, 4)) {
        const location = reference.path ? reference.path + (reference.lineStart ? ":" + reference.lineStart + (reference.lineEnd && reference.lineEnd !== reference.lineStart ? "-" + reference.lineEnd : "") : "") : "project-wide";
        lines.push("   Evidence: " + reference.type + " · " + location);
      }
    }
  }
  if (result.dependencyTrace?.length) {
    lines.push("Ordered local dependency trace (imports do not prove calls or runtime order):");
    for (const edge of result.dependencyTrace.slice(0, 12)) lines.push(`- ${edge.from}${edge.line ? ":" + edge.line : ""} → ${edge.to} (hop ${edge.depth}).`);
  }
  if (result.referenceIndex) {
    lines.push(`JS/TS reference index: ${result.referenceIndex.status || "unknown"} · ${result.referenceIndex.indexedFiles || 0}/${result.referenceIndex.eligibleFiles || 0} eligible files · ${result.referenceIndex.relationships || 0} relationships · ${result.referenceIndex.parseTimeMs || 0} ms parsing · ${result.referenceIndex.excludedFiles || 0} excluded or unsupported.`);
    if (result.referenceIndex.unsupportedExtensions?.length) lines.push("No symbol parser for: " + result.referenceIndex.unsupportedExtensions.join(", ") + ".");
    if (result.referenceIndex.freshness) lines.push("Index freshness: " + result.referenceIndex.freshness);
    const changes = result.referenceIndex.changes;
    if (changes && (changes.changed?.length || changes.removed?.length || changes.renamed?.length)) {
      lines.push(`Index refresh observed ${changes.changed?.length || 0} changed, ${changes.removed?.length || 0} removed, and ${changes.renamed?.length || 0} same-content renamed files.`);
    }
  }
  if (result.referenceTrace?.length) {
    lines.push("Symbol references and candidate relationships (not a complete call graph):");
    for (const relation of result.referenceTrace.slice(0, 16)) lines.push(`- ${relation.type} · ${relation.path}${relation.line ? ":" + relation.line : ""} → ${relation.symbol}${relation.relatedPath ? ` at ${relation.relatedPath}${relation.relatedLine ? ":" + relation.relatedLine : ""}` : ""}${relation.route ? ` (${relation.route})` : ""} [${relation.confidence}; ${relation.confirmedByRead ? "source read" : "unconfirmed"}].`);
  }
  if (result.stopReason) lines.push("Stopped: " + result.stopReason.replaceAll("-", " ") + " · remaining budget " +
    (result.remainingBudget?.operations ?? 0) + " operations, " + (result.remainingBudget?.targetedReads ?? 0) + " targeted reads, " +
    (result.remainingBudget?.milliseconds ?? 0) + " ms, " + (result.remainingBudget?.sourceBytes ?? 0) + " source bytes.");
  if (result.unresolved?.length) {
    lines.push("Unresolved questions:");
    for (const item of result.unresolved.slice(0, 8)) lines.push("- " + item);
  }
  if (result.git?.available) {
    const branch = result.git.status.match(/^## (.+)$/mu)?.[1];
    lines.push(`Git: available${branch ? ` · branch ${branch}` : ""}`);
    if (result.git.history.trim()) lines.push(`Recent history:\n${result.git.history.trim().split("\n").slice(0, 5).map((line) => `  ${line}`).join("\n")}`);
  } else lines.push("Git: metadata unavailable; structure inspection continues without Git facts.");
  if (result.git?.coverage) lines.push(`Git evidence coverage: ${result.git.coverage}`);
  if (result.project?.manifests?.length) lines.push(`Manifests: ${result.project.manifests.slice(0, 8).map((item) => `${item.path} (${item.ecosystem}${item.valid ? "" : ", parse incomplete"})`).join(", ")}`);
  if (result.project?.dependencies?.length) lines.push(`Dependencies: ${result.project.dependencies.slice(0, 12).map((item) => `${item.name}${item.version ? `@${item.version}` : ""}`).join(", ")}`);
  if (result.project?.entryPoints?.length) {
    lines.push("Likely entry points:");
    for (const item of result.project.entryPoints.slice(0, 8)) lines.push(`- ${item.path} (${item.confidence} confidence; ${item.reason}; ${item.source}).`);
  }
  if (result.project?.structure?.length) lines.push(`Structure sample (${result.project.truncated ? "bounded/incomplete" : "observed"}): ${result.project.structure.slice(0, 24).join(", ")}`);
  if (result.findings?.length) {
    lines.push("Evidence-backed findings:");
    for (const finding of result.findings.slice(0, MAX_RENDERED_FINDINGS)) {
      const location = finding.path ? `${finding.path}${finding.lineStart ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}` : ""}` : "project-wide";
      lines.push(`- ${finding.observation === "inferred" ? "Inferred" : "Observed"} ${finding.type} · ${location}: ${finding.description} [${finding.confidence} confidence; ${finding.status}; ${finding.source}${finding.commit ? `; commit ${finding.commit}` : ""}].`);
    }
  }
  if (result.project?.commands?.length) {
    lines.push("Likely project commands (identified from manifests; not run):");
    for (const item of result.project.commands.slice(0, 10)) lines.push(`- ${item.name}: ${item.command} (${item.path}; automatic execution disabled).`);
  }
  if (result.plan?.length) lines.push(`Grounded next steps:\n${result.plan.map((item) => `- ${item}`).join("\n")}`);
  if (result.assumptions?.length) lines.push(`Assumptions and unresolved evidence:\n${result.assumptions.map((item) => `- ${item}`).join("\n")}`);
  if (result.verificationRequirements?.length) lines.push(`Verification requirements (not executed):\n${result.verificationRequirements.map((item) => `- ${item}`).join("\n")}`);
  if (result.incomplete?.length) lines.push(`Incomplete analysis:\n${result.incomplete.map((item) => `- ${item}`).join("\n")}`);
  let output = lines.join("\n");
  if (output.length > MAX_RENDERED_OUTPUT) output = `${output.slice(0, MAX_RENDERED_OUTPUT - 30)}\n[report truncated by Vesper]`;
  return `${escapeTerminalOutput(redactSensitiveText(output))}\n`;
}

function normalizeRouteDecision(value) {
  if (!value || typeof value !== "object") return Object.freeze({ route: "unknown", intent: null, reason: "not-provided" });
  const route = value.route === "local" || value.route === "codex" ? value.route : "unknown";
  const intent = typeof value.intent === "string" && /^[a-z][a-z0-9_-]{0,79}$/u.test(value.intent) ? value.intent : null;
  const reason = typeof value.reason === "string" && /^[a-z][a-z0-9_-]{0,79}$/u.test(value.reason) ? value.reason : "unknown";
  return Object.freeze({ route, intent, reason });
}

function normalizeIntent(value) { return ["overview", "trace", "bug", "change-plan", "feature", "investigate"].includes(value) ? value : null; }
function normalizeText(value) { return typeof value === "string" ? value.slice(0, 8_192).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, " ").trim().replace(/\s+/gu, " ") : ""; }

module.exports = {
  SystemModelCoordinator,
  createGroundedPlan,
  createSystemModel,
  interpretTask,
  renderSystemModelReport,
  shouldInvestigateTask,
};
