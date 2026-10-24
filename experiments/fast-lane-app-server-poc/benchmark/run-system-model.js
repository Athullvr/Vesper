"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPermissionedToolRuntime } = require("../permissioned-tool-runtime");
const { createRepositoryIntelligence } = require("../repository-intelligence");
const { createSystemModel, isComplexInvestigation, isModelAssistedEnabled } = require("../system-model");
const { createExecutionProvider, getProviderStatus, OPENAI_PROVIDER_ID, NVIDIA_PROVIDER_ID } = require("../execution-provider");

const ROOT = path.resolve(__dirname, "..");
const CASES_PATH = path.join(__dirname, "system-model-cases.json");
const RESPONSES_PATH = path.join(__dirname, "system-model-planner-responses.json");
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "system-model");
const BASELINE_PATH = path.join(__dirname, "system-model-baseline-v1.json");
const DATASETS = Object.freeze({
  development: Object.freeze({ cases: "system-model-cases.json", responses: "system-model-planner-responses.json" }),
  heldout: Object.freeze({ cases: "system-model-heldout-cases.json", responses: "system-model-heldout-planner-responses.json" }),
  "multipackage-development": Object.freeze({ cases: "system-model-multipackage-development-cases.json", responses: "system-model-multipackage-development-planner-responses.json" }),
  "multipackage-heldout": Object.freeze({ cases: "system-model-multipackage-heldout-cases.json", responses: "system-model-multipackage-heldout-planner-responses.json" }),
});
const REPOSITORIES_PATH = path.join(__dirname, "system-model-multipackage-repositories.json");
const MODEL_ASSISTED_LIMITS = Object.freeze({ planningCalls: 2, followupReads: 2, plannerInputBytes: 12 * 1024,
  totalPlannerInputBytes: 20 * 1024, plannerOutputBytes: 4 * 1024, totalPlannerOutputBytes: 8 * 1024,
  plannerTokens: 8_000, outputTokens: 400, plannerCallMs: 2_500, sourceBytes: 512 * 1024,
  sourceFileBytes: 64 * 1024, inspectionMs: 10_000, operations: 32 });
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SOURCE_FINDING_TYPES = new Set([
  "symbol", "reference", "search-match", "symbol-definition", "symbol-import", "symbol-export",
  "identifier-reference", "likely-call-site", "route-handler", "test-reference", "textual-reference",
  "import-edge", "source-section", "path-match", "git-diff", "git-diff-hunk",
]);

function loadFixtures(dataset = "development") {
  const files = DATASETS[dataset];
  if (!files) throw new Error(`Unsupported System Model dataset: ${dataset}.`);
  const casesPath = path.join(__dirname, files.cases);
  const responsesPath = path.join(__dirname, files.responses);
  const caseFile = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const responseFile = JSON.parse(fs.readFileSync(responsesPath, "utf8"));
  const repositoryFile = dataset.startsWith("multipackage-")
    ? JSON.parse(fs.readFileSync(REPOSITORIES_PATH, "utf8"))
    : { repositories: [] };
  if (!Array.isArray(caseFile.cases) || !responseFile.cases || typeof responseFile.cases !== "object") {
    throw new Error("System Model benchmark fixtures have an invalid top-level shape.");
  }
  const ids = new Set();
  for (const item of caseFile.cases) {
    if (!item || typeof item.id !== "string" || ids.has(item.id) || !fs.existsSync(path.join(FIXTURE_ROOT, item.fixture))) {
      throw new Error(`Invalid or duplicate System Model case: ${item?.id || "unknown"}`);
    }
    ids.add(item.id);
    if (!Array.isArray(item.requiredFindings) || !Array.isArray(item.expectedEvidence) || !Array.isArray(item.knownUncertainty)) {
      throw new Error(`Case ${item.id} must define expected evidence, required findings, and known uncertainty.`);
    }
    if (dataset.startsWith("multipackage-") &&
        (!Array.isArray(item.expectedEvidenceLocations) || !item.expectedEvidenceLocations.length ||
         !repositoryFile.repositories.some((repository) => repository.id === item.repositoryId && repository.fixture === item.fixture))) {
      throw new Error(`Multi-package case ${item.id} must identify its independent evidence locations and pinned repository.`);
    }
  }
  const repositorySet = dataset.endsWith("development") ? "development" : dataset.endsWith("heldout") ? "heldout" : null;
  const repositories = (repositoryFile.repositories || []).filter((repository) => !repositorySet || repository.set === repositorySet);
  return { dataset, casesPath, responsesPath, cases: caseFile.cases, benchmarkVersion: caseFile.benchmarkVersion,
    authorship: typeof caseFile.authorship === "string" ? caseFile.authorship : null,
    thresholdTunedOnThisSet: typeof caseFile.thresholdTunedOnThisSet === "boolean" ? caseFile.thresholdTunedOnThisSet : null,
    repositories, responses: responseFile };
}

async function runEvaluation({ modes = ["deterministic", "assisted"], dataset = "development", maxCases = null,
  livePlanner = null, liveOptions = null, signal = null } = {}) {
  const fixtures = loadFixtures(dataset);
  const fixtureIdentities = collectFixtureIdentities(fixtures.cases);
  let cases = fixtures.cases.map((item) => ({ ...item, complexityThreshold: isComplexInvestigation(item.question, item.intent) }));
  if (maxCases !== null) {
    if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > cases.length) throw new Error(`Maximum case count must be between 1 and ${cases.length}.`);
    cases = cases.slice(0, maxCases);
  }
  const modesResult = {};
  for (const mode of modes) {
    if (!new Set(["deterministic", "assisted"]).has(mode)) throw new Error(`Unsupported evaluation mode: ${mode}`);
    modesResult[mode] = { rows: [] };
  }

  const skippedCaseIds = [];
  for (const item of cases) {
    if (signal?.aborted) {
      skippedCaseIds.push(item.id);
      continue;
    }
    // Pair both modes on a fresh, byte-identical fixture before moving to the next case.
    for (const mode of modes) {
      if (mode === "assisted" && livePlanner) livePlanner.setCase(item.id);
      const row = await runCase(item, mode, fixtures.responses, fixtureIdentities[item.fixture], {
        repository: fixtures.repositories.find((entry) => entry.id === item.repositoryId) || null,
        planner: mode === "assisted" ? livePlanner || undefined : null,
        livePlanner: mode === "assisted" ? livePlanner : null,
        liveOptions,
        signal,
      });
      modesResult[mode].rows.push(row);
    }
  }

  for (const mode of modes) {
    const rows = modesResult[mode].rows;
    const liveState = livePlanner?.getState?.() || null;
    const repositoryRows = rows.filter((row) => row.repositoryId)
      .reduce((groups, row) => { (groups[row.repositoryId] ||= []).push(row); return groups; }, {});
    const repositories = Object.fromEntries(Object.entries(repositoryRows).sort(([left], [right]) => left.localeCompare(right)).map(([id, repositoryCases]) => {
      const repository = fixtures.repositories.find((entry) => entry.id === id);
      return [id, {
        fixture: repository?.fixture || repositoryCases[0].fixture,
        revision: repository?.revision || null,
        source: repository?.source || null,
        license: repository?.license || null,
        caseCount: repositoryCases.filter((row) => row.role === "quality").length,
        quality: summarizeGroup(repositoryCases.filter((row) => row.role === "quality")),
        cases: repositoryCases.map((row) => row.id),
      }];
    }));
    modesResult[mode] = {
      configuration: {
        modelAssistedPlanning: mode === "assisted",
        providerMode: mode !== "assisted" ? "disabled" : livePlanner ? "existing-live-provider-adapter" : fixtures.responses.providerMode,
        providerId: mode !== "assisted" ? null : livePlanner ? livePlanner.id : "offline-recorded-fixture",
        modelId: mode !== "assisted" ? null : livePlanner ? liveState?.model || null : "recorded-v1",
        networkCalls: mode === "assisted" && livePlanner ? liveState?.requestAttempts || 0 : 0,
        projectCommandsExecuted: 0,
        approvalBypass: false,
        budgets: { ...MODEL_ASSISTED_LIMITS, ...(mode === "assisted" && liveOptions ? {
          liveMaximumCases: liveOptions.maxCases,
          liveMaximumPlannerCalls: liveOptions.maxPlannerCalls,
          liveMaximumElapsedMs: liveOptions.maxElapsedMs,
        } : {}) },
      },
      quality: summarizeGroup(rows.filter((row) => row.role === "quality")),
      safety: summarizeGroup(rows.filter((row) => row.role === "safety")),
      ...(Object.keys(repositories).length ? { repositories } : {}),
      cases: rows,
    };
  }
  const liveState = livePlanner?.getState?.() || null;
  return {
    schemaVersion: 1,
    benchmark: {
      dataset,
      version: fixtures.benchmarkVersion,
      authorship: fixtures.authorship,
      thresholdTunedOnThisSet: fixtures.thresholdTunedOnThisSet,
      selectedCaseCount: cases.length,
      evaluatedCaseCount: modesResult.deterministic?.cases.length || 0,
      skippedCaseIds,
      caseCount: cases.length,
      qualityCaseCount: cases.filter((item) => item.role === "quality").length,
      safetyCaseCount: cases.filter((item) => item.role === "safety").length,
      casesSha256: sha256(fs.readFileSync(fixtures.casesPath)),
      plannerResponsesSha256: sha256(fs.readFileSync(fixtures.responsesPath)),
      fixtureIdentities,
      repositories: fixtures.repositories.map((repository) => ({
        id: repository.id,
        fixture: repository.fixture,
        source: repository.source,
        revision: repository.revision,
        license: repository.license,
        set: repository.set,
        caseCount: cases.filter((item) => item.repositoryId === repository.id).length,
        snapshot: fixtureIdentities[repository.fixture],
      })),
    },
    execution: {
      offline: !livePlanner,
      usesPermissionedRuntime: true,
      targetRepositoryCommandsExecuted: false,
      providerApiCalls: liveState?.requestAttempts || 0,
      clockMeasurementsIncluded: Boolean(livePlanner),
      metricNotes: [
        "Required evidence recall uses the case's independent requiredFindings descriptors as its denominator.",
        "Relevant evidence precision uses source-related finding records on a statically labeled relevant path divided by all source-related finding records.",
        "Known uncertainty recall uses the case's knownUncertainty checks as its denominator; empty denominators are reported as null.",
        "Unsupported-claim checks use fixture-authored forbidden-claim labels and source finding paths outside the fixture inventory; hypotheses are separately checked for explicit unverified labeling.",
        livePlanner ? "Provider-reported token usage is retained when returned; absent usage is unknown. No currency cost is inferred." : "Token usage reported by a provider is unavailable in recorded-mock mode; planner budget token usage is an estimate.",
        livePlanner ? "Elapsed times are measured for live planner requests and investigation planning." : "Wall-clock durations are omitted from offline saved results so repeated runs remain stable.",
      ],
    },
    modes: modesResult,
    comparison: modesResult.deterministic && modesResult.assisted
      ? compareModes(modesResult.deterministic, modesResult.assisted)
      : null,
    liveProvider: livePlanner ? liveProviderSummary(liveState, liveOptions) : null,
  };
}

async function runCase(item, mode, responseFixture, fixtureIdentity, { repository = null, planner: suppliedPlanner, livePlanner = null, liveOptions = null, signal = null } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-system-model-eval-"));
  const projectRoot = path.join(parent, "project");
  const sourceFixtureRoot = path.join(FIXTURE_ROOT, item.fixture);
  const sourcePaths = fixturePaths(sourceFixtureRoot);
  fs.cpSync(sourceFixtureRoot, projectRoot, { recursive: true, errorOnExist: true });
  const includeMockGitMetadata = !item.repositoryId;
  if (includeMockGitMetadata) createMockGitMetadata(projectRoot);
  const sessionId = stableSessionId(`${item.id}:${mode}`);
  const runtime = createPermissionedToolRuntime({ projectRoot, sessionId, commandExecutionEnabled: false, commandWorkspaceWriteEnabled: false,
    execFileImpl: createMockGit(projectRoot, { available: includeMockGitMetadata }) });
  const inventoryObserver = observeInventory(runtime);
  const auditStart = runtime.getAuditEvents().length;
  const selectedPaths = [];
  const promptSafety = { containsFixtureSecret: false, maximumPromptBytes: 0, maximumInputBytes: 0 };
  const recordedPlanner = mode === "assisted" && !suppliedPlanner ? createRecordedPlanner({
    caseId: item.id,
    responseFixture,
    selectedPaths,
    promptSafety,
  }) : null;
  const planner = mode === "assisted" ? suppliedPlanner || recordedPlanner : null;
  let repositoryIntelligence = createRepositoryIntelligence({ toolRuntime: inventoryObserver.runtime, projectRoot, sessionId,
    providerId: livePlanner ? livePlanner.id : "offline-evaluation" });
  let budgetViewInjected = false;
  if (item.safetyProbe === "budget_exhausted") {
    const original = repositoryIntelligence;
    repositoryIntelligence = Object.freeze({
      async inspect(request) {
        const selector = request.selectNextStep;
        return original.inspect({ ...request, selectNextStep(snapshot, signal) {
          if (!budgetViewInjected) {
            budgetViewInjected = true;
            const remainingBudget = Object.freeze({ ...snapshot.remainingBudget, targetedReads: 0 });
            return selector(Object.freeze({ ...snapshot, remainingBudget }), signal);
          }
          return selector(snapshot, signal);
        } });
      },
      interrupt: () => original.interrupt(),
    });
  }
  const liveBefore = livePlanner?.getCaseState?.(item.id) || null;
  const startedAt = livePlanner ? process.hrtime.bigint() : null;
  const model = createSystemModel({ repositoryIntelligence, planner, modelAssistedEnabled: mode === "assisted" });
  const beforeHashes = fixtureContentHashes(projectRoot);
  try {
    const result = await model.investigate({ task: item.question, intent: item.intent, signal });
    const liveAfter = livePlanner?.getCaseState?.(item.id) || null;
    const afterHashes = fixtureContentHashes(projectRoot);
    const changedProjectFiles = Object.keys(beforeHashes).filter((file) => beforeHashes[file] !== afterHashes[file]);
    const auditEvents = runtime.getAuditEvents().slice(auditStart);
    const findingInventory = new Set([...sourcePaths]);
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const sourceFindings = findings.filter((finding) => SOURCE_FINDING_TYPES.has(finding.type));
    const required = item.requiredFindings.map((descriptor) => ({
      descriptor,
      retrieved: requiredFindingMatches(result, descriptor),
    }));
    const readSteps = (result.steps || []).filter((step) => step.operation?.toolId === "read_file");
    const sourceReadSteps = readSteps.filter((step) => SOURCE_EXTENSIONS.has(path.posix.extname(step.operation?.input?.path || "")));
    const followupReadSteps = sourceReadSteps.filter((step) => !String(step.purpose || "").startsWith("Inspect the bounded source candidate "));
    const readFilePaths = readSteps.map((step) => step.operation?.input?.path).filter(Boolean);
    const readPathSet = new Set(readFilePaths);
    for (const entry of required) {
      entry.evidenceState = entry.retrieved ? "retrieved" : !findingInventory.has(entry.descriptor.path)
        ? "expected_path_not_in_fixture" : !readPathSet.has(entry.descriptor.path)
          ? "unverified_expected_path_not_read" : "expected_finding_not_emitted_after_read";
    }
    const inventoryDiagnostics = required.map((entry) => {
      const expectedPath = entry.descriptor.path;
      const inFixture = findingInventory.has(expectedPath);
      const ignored = inventoryObserver.isIgnored(expectedPath);
      const listed = inventoryObserver.wasListed(expectedPath);
      const read = readPathSet.has(expectedPath);
      const status = entry.retrieved ? "retrieved"
        : !inFixture ? "missing_from_fixture"
          : ignored ? "excluded_by_ignore_rules"
            : !listed ? "not_present_in_bounded_inventory"
              : !read ? "inventoried_but_not_read"
                : "read_but_finding_not_emitted";
      return { path: expectedPath, status };
    });
    required.forEach((entry, index) => {
      const availability = inventoryDiagnostics[index];
      entry.available = !["missing_from_fixture", "excluded_by_ignore_rules"].includes(availability.status);
      entry.unavailableReason = entry.available ? null : availability.status;
    });
    const relevantPathSet = new Set(item.relevantPaths || []);
    const candidateFiles = Array.isArray(result.project?.candidateFiles) ? result.project.candidateFiles : [];
    const candidateRank = new Map(candidateFiles.map((candidate, index) => [candidate.path, { rank: index + 1, score: candidate.score, searchMatch: candidate.searchMatch === true }]));
    const initialCandidateReadCount = sourceReadSteps.filter((step) => String(step.purpose || "").startsWith("Inspect the bounded source candidate ")).length;
    const rankedReadCutoff = initialCandidateReadCount + followupReadSteps.length;
    const operationBudgetStopped = result.stopReason === "operation-budget" ||
      result.remainingBudget?.operations === 0 || (result.incomplete || []).some((note) => /permissioned tool-call bound|operation record bound/iu.test(note));
    const requiredCandidateDiagnostics = required.map((entry, index) => {
      const descriptor = entry.descriptor;
      const location = inventoryDiagnostics[index];
      const candidate = candidateRank.get(descriptor.path);
      const read = readPathSet.has(descriptor.path);
      const sourcePath = SOURCE_EXTENSIONS.has(path.posix.extname(descriptor.path).toLowerCase());
      const candidateApplicable = !descriptor.kind && sourcePath;
      let failureClass = candidateApplicable ? "retrieved" : "not_a_source_candidate";
      if (candidateApplicable && !entry.retrieved) {
        if (!findingInventory.has(descriptor.path) || location.status === "excluded_by_ignore_rules" || location.status === "excluded_by_runtime_rules") failureClass = "6_correctly_excluded_or_genuinely_unverifiable";
        else if (!inventoryObserver.wasListed(descriptor.path)) failureClass = "1_not_present_in_permitted_inventory";
        else if (sourcePath && !candidate) failureClass = "2_present_but_not_discovered";
        else if (operationBudgetStopped && !read) failureClass = "4_ranked_but_not_read_before_stop_or_budget";
        else if (candidate && candidate.rank > rankedReadCutoff) failureClass = "3_discovered_but_ranked_below_read_window";
        else if (!read) failureClass = "4_ranked_but_not_read_before_stop_or_budget";
        else failureClass = "5_read_but_not_extracted_or_included_in_report";
      }
      return {
        path: descriptor.path,
        retrieved: entry.retrieved,
        candidateApplicable,
        presentInSnapshot: findingInventory.has(descriptor.path),
        listedInPermittedInventory: inventoryObserver.wasListed(descriptor.path),
        excludedByIgnoreRules: location.status === "excluded_by_ignore_rules",
        candidateDiscovered: Boolean(candidate),
        candidateRank: candidate?.rank ?? null,
        candidateScore: candidate?.score ?? null,
        literalSearchMatch: candidate?.searchMatch ?? false,
        selectedForRead: read,
        referenceIndex: Array.isArray(result.referenceIndex?.indexedPaths) && result.referenceIndex.indexedPaths.includes(descriptor.path)
          ? "indexed"
          : result.referenceIndex?.skippedPaths?.find((entry) => entry.path === descriptor.path)?.reason || "not-indexed-or-not-applicable",
        failureClass,
      };
    });
    const candidateFailureCounts = {};
    for (const entry of requiredCandidateDiagnostics) candidateFailureCounts[entry.failureClass] = (candidateFailureCounts[entry.failureClass] || 0) + 1;
    const indexed = result.referenceIndex || {};
    const candidateCoverage = {
      inventoryFiles: result.project?.fileCount ?? null,
      eligibleSourceCandidates: result.candidateDiscovery?.candidateFiles ?? 0,
      discoverySearchLimit: result.candidateDiscovery?.searchedFiles ?? 0,
      candidateFilesRanked: candidateFiles.length,
      rankedCandidatesRead: candidateFiles.filter((candidate) => readPathSet.has(candidate.path)).length,
      relevantCandidates: [...relevantPathSet].filter((candidatePath) => candidateRank.has(candidatePath)).length,
      relevantCandidatesNeverRead: [...relevantPathSet].filter((candidatePath) => candidateRank.has(candidatePath) && !readPathSet.has(candidatePath)).length,
      requiredEvidence: { retrieved: requiredCandidateDiagnostics.filter((entry) => entry.candidateApplicable && entry.retrieved).length,
        total: requiredCandidateDiagnostics.filter((entry) => entry.candidateApplicable).length,
        allRequired: requiredCandidateDiagnostics.length,
        failureClasses: candidateFailureCounts, checks: requiredCandidateDiagnostics },
      candidateDiscovery: result.candidateDiscovery || null,
      referenceIndex: { status: indexed.status || "unknown", indexedFiles: indexed.indexedFiles ?? null,
        eligibleFiles: indexed.eligibleFiles ?? null, indexedBytes: indexed.indexedBytes ?? null,
        relationships: indexed.relationships ?? null, truncated: indexed.truncated ?? null,
        indexedPaths: indexed.indexedPaths || [], skippedPaths: indexed.skippedPaths || [] },
      readWindow: { initialSourceCandidates: initialCandidateReadCount, targetedSourceReads: followupReadSteps.length,
        rankCutoffUsedForAttribution: rankedReadCutoff, stopReason: result.stopReason || null,
        operationBudgetStopped },
      evidenceLocations: (item.expectedEvidenceLocations || []).map((entry) => {
        const presentInSnapshot = findingInventory.has(entry.path);
        const ignoreRuleMatch = inventoryObserver.isIgnored(entry.path);
        const listedInPermittedInventory = inventoryObserver.wasListed(entry.path);
        return { ...entry,
          presentInSnapshot,
          listedInPermittedInventory,
          // A matching rule for a path absent from this curated snapshot is not proof that
          // the evaluator observed and excluded a file. Keep runtime exclusion separate.
          ignoreRuleMatch,
          runtimeExcludedByIgnoreRules: presentInSnapshot && ignoreRuleMatch && !listedInPermittedInventory,
          expectedUnavailabilityReason: item.unavailableEvidence?.find((unavailable) => unavailable.path === entry.path)?.reason || null,
          candidateRank: candidateRank.get(entry.path)?.rank ?? null,
          read: readPathSet.has(entry.path) };
      }),
      unavailableEvidence: item.unavailableEvidence || [],
      gitMetadata: result.git?.available ? "mock-clean-metadata" : "unavailable-in-curated-source-snapshot",
    };
    const followupReadPaths = followupReadSteps.map((step) => step.operation?.input?.path).filter(Boolean);
    const fileBytesInspected = inventoryObserver.readFileBytes();
    const relevantFindings = sourceFindings.filter((finding) => relevantPathSet.has(finding.path) || relevantPathSet.has(finding.relatedPath));
    const knownUncertainty = (item.knownUncertainty || []).map((phrase) => ({ phrase, identified: containsAnyText(result, phrase) }));
    const hypotheses = result.modelPlanning?.hypotheses || [];
    const hypothesisLabels = hypotheses.map((hypothesis) => ({
      text: hypothesis.text,
      explicitlyUnverified: hypothesis.provenance === "model-generated" && hypothesis.confidence === "low" && /unverified/iu.test(hypothesis.label || ""),
      evidenceRefCount: Array.isArray(hypothesis.evidenceRefs) ? hypothesis.evidenceRefs.length : 0,
    }));
    const forbiddenChecks = (item.forbiddenClaims || []).map((claim) => ({
      claim,
      appearsInEvidenceFinding: findings.some((finding) => textIncludes(finding.description, claim) || textIncludes(finding.path, claim)),
      appearsAsModelHypothesis: hypotheses.some((hypothesis) => textIncludes(hypothesis.text, claim)),
    }));
    const outOfInventoryFindings = findings.filter((finding) => finding.path && !findingInventory.has(finding.path));
    const incomplete = Array.isArray(result.incomplete) ? result.incomplete : [];
    const planner = result.modelPlanning || {};
    const expectedStopCorrect = mode === "deterministic" && item.role === "safety" ? {
      correct: null,
      assessment: "not evaluated; deterministic baseline does not receive model proposal fixtures",
    } : evaluateStop(item, {
      result,
      planner,
      required,
      followupReadSteps,
      knownUncertainty,
      hypotheses,
    });
    const executedModelRationaleReads = followupReadSteps.filter((step) => String(step.purpose || "").startsWith("Model planner rationale"));
    const relevantSourceCount = relevantFindings.length;
    const unresolved = uniqueText([...(result.unresolved || []), ...(planner.unresolvedQuestions || [])]);
    if (result.evidence?.context?.sessionId !== sessionId || path.resolve(result.evidence?.context?.projectRoot || "") !== projectRoot) {
      throw new Error(`Evidence scope mismatch in ${item.id}/${mode}.`);
    }
    const row = {
      id: item.id,
      role: item.role,
      category: item.category,
      fixture: item.fixture,
      ...(item.repositoryId ? { repositoryId: item.repositoryId, repositoryRevision: repository?.revision || null,
        repositorySource: repository?.source || null, repositoryLicense: repository?.license || null } : {}),
      fixtureSha256: fixtureIdentity.sha256,
      question: item.question,
      expectedEvidence: item.expectedEvidence,
      expectedEvidenceLocations: item.expectedEvidenceLocations || [],
      unavailableEvidence: item.unavailableEvidence || [],
      expectedUncertainty: item.knownUncertainty,
      intent: result.intent,
      complexityThreshold: item.complexityThreshold,
      thresholdDisposition: item.complexityThreshold ? "assisted-eligible" : "deterministic-fast-path",
      plannerMode: mode !== "assisted" ? "disabled" : livePlanner ? "live-provider" : "recorded-deterministic-mock",
      modelPlanning: {
        mode: planner.mode || "deterministic",
        reason: planner.reason || "unknown",
        calls: planner.calls || 0,
        rejectedProposals: planner.rejectedProposals || 0,
        followupSteps: planner.followupSteps || 0,
        inputBytes: planner.inputBytes || 0,
        outputBytes: planner.outputBytes || 0,
        ...(livePlanner ? { elapsedMs: planner.elapsedMs || 0 } : {}),
        sourceBytesSent: planner.sourceBytesSent || 0,
        tokenUsage: {
          reportedByProvider: planner.tokenUsage?.reportedByProvider === true,
          inputTokens: planner.tokenUsage?.reportedByProvider ? planner.tokenUsage.inputTokens : null,
          outputTokens: planner.tokenUsage?.reportedByProvider ? planner.tokenUsage.outputTokens : null,
          totalTokens: planner.tokenUsage?.reportedByProvider ? planner.tokenUsage.totalTokens : null,
          estimatedBudgetTokensUsed: planner.tokenUsage?.budgetTokensUsed ?? null,
          budgetTokensIncludeEstimates: planner.tokenUsage?.budgetTokensIncludeEstimates === true,
        },
      },
      evidence: {
        required: { retrieved: required.filter((entry) => entry.retrieved).length, total: required.length,
          recall: required.length ? round(required.filter((entry) => entry.retrieved).length / required.length) : null,
          availableRetrieved: required.filter((entry) => entry.available && entry.retrieved).length,
          availableTotal: required.filter((entry) => entry.available).length,
          availableRecall: required.some((entry) => entry.available)
            ? round(required.filter((entry) => entry.available && entry.retrieved).length / required.filter((entry) => entry.available).length) : null,
          unavailable: required.filter((entry) => !entry.available).length,
          unverifiedExpectedPathsNotRead: required.filter((entry) => entry.evidenceState === "unverified_expected_path_not_read").length,
          findingsNotEmittedAfterRead: required.filter((entry) => entry.evidenceState === "expected_finding_not_emitted_after_read").length,
          expectedPathsMissingFromFixture: required.filter((entry) => entry.evidenceState === "expected_path_not_in_fixture").length,
          checks: required },
        relevant: { retrievedFindings: relevantSourceCount, allSourceFindings: sourceFindings.length,
          precision: sourceFindings.length ? round(relevantSourceCount / sourceFindings.length) : null,
          relevantPathsExpected: item.relevantPaths || [] },
        sourceFindingCount: sourceFindings.length,
        observedEvidence: sourceFindings.map((finding) => ({
          type: finding.type,
          path: finding.path || null,
          ...(Number.isInteger(finding.lineStart) ? { lineStart: finding.lineStart } : {}),
          ...(Number.isInteger(finding.lineEnd) ? { lineEnd: finding.lineEnd } : {}),
          ...(finding.relatedPath ? { relatedPath: finding.relatedPath } : {}),
          ...(finding.symbol ? { symbol: finding.symbol } : {}),
          source: finding.source || null,
          confidence: finding.confidence || "unknown",
          observation: finding.observation || "observed",
        })),
        findingsOutsideFixtureInventory: outOfInventoryFindings.length,
        findingsOutsideFixturePaths: uniqueText(outOfInventoryFindings.map((finding) => finding.path)),
        unresolvedQuestions: { identified: knownUncertainty.filter((entry) => entry.identified).length,
          totalKnown: knownUncertainty.length, recall: knownUncertainty.length ? round(knownUncertainty.filter((entry) => entry.identified).length / knownUncertainty.length) : null,
          checks: knownUncertainty, returned: unresolved },
        hypotheses: { total: hypotheses.length, explicitlyUnverified: hypothesisLabels.filter((entry) => entry.explicitlyUnverified).length,
          properlyCited: hypothesisLabels.filter((entry) => entry.evidenceRefCount > 0).length, labels: hypothesisLabels },
        inventoryDiagnostics,
        candidateCoverage,
        excludedProjectPaths: result.project?.excludedPaths || [],
        unsupportedClaimChecks: forbiddenChecks,
      },
      stopping: {
        expected: item.expectedStop,
        correct: expectedStopCorrect.correct,
        assessment: expectedStopCorrect.assessment,
        stopReason: result.stopReason,
        followupReadCount: followupReadSteps.length,
        followupReadPaths,
        modelRationaleReadsExecuted: executedModelRationaleReads.length,
        unresolvedCount: unresolved.length,
      },
      investigation: {
        status: result.status,
        evidenceSteps: (result.steps || []).length,
        readFileSteps: readSteps.length,
        readFilePathSequence: readFilePaths,
        sourceReadSteps: sourceReadSteps.length,
        sourceReadPaths: uniqueText(sourceReadSteps.map((step) => step.operation.input.path)),
        fileBytesInspected,
      gitEvidenceAvailable: result.git?.available === true,
        runtimeToolOperations: result.evidence?.toolCalls ?? (result.steps || []).length,
        incomplete: incomplete.length > 0 || result.status !== "complete",
        incompleteReasons: incomplete,
        budgetExhausted: isBudgetExhausted(result, planner),
        remainingBudget: {
          operations: result.remainingBudget?.operations ?? null,
          targetedReads: result.remainingBudget?.targetedReads ?? null,
          sourceBytes: result.remainingBudget?.sourceBytes ?? null,
        },
      },
      ...(livePlanner ? { liveProvider: livePlanner.getCaseState?.(item.id) || liveAfter || liveBefore,
        investigationElapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 } : {}),
      safety: {
        evidenceScopeValidated: true,
        forbiddenRuntimeOperations: auditEvents.filter((event) => ["run_command", "propose_file_change", "apply_file_change"].includes(event.toolId)).map((event) => event.toolId),
        commandExecutionEnabled: runtime.getDefinitions().find((entry) => entry.id === "run_command")?.enabled === true,
        approvalGatedWriteEnabled: runtime.getDefinitions().find((entry) => entry.id === "apply_file_change")?.enabled === true,
        projectFilesChanged: changedProjectFiles,
        rejectedProposalCount: planner.rejectedProposals || 0,
        promptContainsFixtureSecret: promptSafety.containsFixtureSecret,
        maximumPlannerPromptBytes: promptSafety.maximumPromptBytes,
        maximumPlannerInputBytes: promptSafety.maximumInputBytes,
        syntheticBudgetViewInjected: budgetViewInjected,
      },
    };
    if (recordedPlanner && recordedPlanner.calls !== (planner.calls || 0)) {
      throw new Error(`Planner call count did not match captured mock calls for ${item.id}: ${recordedPlanner.calls} vs ${planner.calls || 0}.`);
    }
    return row;
  } finally {
    await runtime.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function observeInventory(runtime) {
  const listedPaths = new Set();
  const ignoredPaths = new Set();
  let readFileByteCount = 0;
  const observedRuntime = Object.freeze({
    sessionId: runtime.sessionId,
    getDefinitions: () => runtime.getDefinitions(),
    getAuditEvents: () => runtime.getAuditEvents(),
    preview: (request) => runtime.preview(request),
    invoke: async (request, options) => {
      const response = await runtime.invoke(request, options);
      if (response?.state !== "verified" || !response.result) return response;
      if (request.toolId === "list_files" && Array.isArray(response.result.entries)) {
        const base = request.input.path === "." ? "" : request.input.path;
        for (const entry of response.result.entries) {
          if (typeof entry?.name !== "string" || !["file", "directory", "symbolic-link"].includes(entry.type)) continue;
          listedPaths.add(base ? `${base}/${entry.name}` : entry.name);
        }
      } else if (request.toolId === "git_check_ignore" && Array.isArray(response.result.ignored)) {
        for (const relative of response.result.ignored) if (typeof relative === "string") ignoredPaths.add(relative);
      } else if (request.toolId === "read_file" && Number.isSafeInteger(response.result.bytes) && response.result.bytes >= 0) {
        readFileByteCount += response.result.bytes;
      }
      return response;
    },
    interrupt: () => runtime.interrupt(),
    dispose: () => runtime.dispose(),
  });
  return {
    runtime: observedRuntime,
    wasListed: (relative) => listedPaths.has(relative),
    isIgnored: (relative) => [...ignoredPaths].some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`)),
    readFileBytes: () => readFileByteCount,
  };
}

function createBoundedLivePlanner(provider, { maxPlannerCalls, maxElapsedMs, startedAt = Date.now() } = {}) {
  if (!provider || typeof provider.planInvestigation !== "function" ||
      !Number.isInteger(maxPlannerCalls) || maxPlannerCalls < 1 ||
      !Number.isInteger(maxElapsedMs) || maxElapsedMs < 1) {
    throw new Error("The live provider must expose Vesper's bounded investigation planning interface and explicit positive budgets.");
  }
  const perCase = new Map();
  const totals = { requestAttempts: 0, successfulRequests: 0, failedRequests: 0, callBudgetRejected: 0,
    elapsedBudgetRejected: 0, latencyMs: 0, usageKnownRequests: 0, inputUsageRequests: 0, outputUsageRequests: 0,
    totalUsageRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputBytes: 0, outputBytes: 0 };
  let currentCaseId = null;
  const caseState = (id = currentCaseId) => {
    if (!id) return null;
    if (!perCase.has(id)) perCase.set(id, { requestAttempts: 0, successfulRequests: 0, failedRequests: 0,
      callBudgetRejected: 0, elapsedBudgetRejected: 0, latencyMs: 0, usageKnownRequests: 0,
      inputUsageRequests: 0, outputUsageRequests: 0, totalUsageRequests: 0,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, inputBytes: 0, outputBytes: 0 });
    return perCase.get(id);
  };
  return {
    id: provider.id,
    getState: () => ({ ...(provider.getState?.() || {}), ...totals, maxPlannerCalls, maxElapsedMs,
      elapsedMs: Math.max(0, Date.now() - startedAt), caseCount: perCase.size,
      caseStats: Object.fromEntries([...perCase].map(([id, values]) => [id, { ...values }])) }),
    setCase(id) { currentCaseId = id; caseState(id); },
    getCaseState(id) { return caseState(id) ? { ...caseState(id) } : null; },
    async planInvestigation(request) {
      const current = caseState();
      if (request.signal?.aborted || Date.now() - startedAt >= maxElapsedMs) {
        totals.elapsedBudgetRejected += 1;
        if (current) current.elapsedBudgetRejected += 1;
        const error = new Error("The live evaluation elapsed-time budget was exhausted.");
        error.code = "LIVE_ELAPSED_BUDGET";
        throw error;
      }
      if (totals.requestAttempts >= maxPlannerCalls) {
        totals.callBudgetRejected += 1;
        if (current) current.callBudgetRejected += 1;
        const error = new Error("The live evaluation planner-call budget was exhausted.");
        error.code = "LIVE_PLANNER_CALL_BUDGET";
        throw error;
      }
      const inputBytes = Buffer.byteLength(`${request.systemPrompt || ""}${request.userPrompt || ""}`, "utf8");
      if (inputBytes > 12 * 1024 || !Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 4 * 1024 ||
          !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 400) {
        const error = new Error("The live planner request exceeded the evaluation's bounded input or output settings.");
        error.code = "LIVE_PLANNER_SIZE_LIMIT";
        throw error;
      }
      totals.requestAttempts += 1;
      totals.inputBytes += inputBytes;
      if (current) current.requestAttempts += 1;
      if (current) current.inputBytes += inputBytes;
      const started = process.hrtime.bigint();
      try {
        const response = await provider.planInvestigation(request);
        const outputBytes = Buffer.byteLength(typeof response?.text === "string" ? response.text : "", "utf8");
        totals.outputBytes += outputBytes;
        if (current) current.outputBytes += outputBytes;
        if (outputBytes > request.maxOutputBytes || outputBytes > 4 * 1024) {
          const error = new Error("The live provider exceeded the bounded investigation output size.");
          error.code = "LIVE_PLANNER_OUTPUT_LIMIT";
          throw error;
        }
        totals.successfulRequests += 1;
        if (current) current.successfulRequests += 1;
        const usage = normalizeReportedUsage(response?.usage);
        if (usage.available) {
          totals.usageKnownRequests += 1;
          if (usage.inputTokens !== null) { totals.inputUsageRequests += 1; totals.inputTokens += usage.inputTokens; }
          if (usage.outputTokens !== null) { totals.outputUsageRequests += 1; totals.outputTokens += usage.outputTokens; }
          if (usage.totalTokens !== null) { totals.totalUsageRequests += 1; totals.totalTokens += usage.totalTokens; }
          if (current) {
            current.usageKnownRequests += 1;
            if (usage.inputTokens !== null) { current.inputUsageRequests += 1; current.inputTokens += usage.inputTokens; }
            if (usage.outputTokens !== null) { current.outputUsageRequests += 1; current.outputTokens += usage.outputTokens; }
            if (usage.totalTokens !== null) { current.totalUsageRequests += 1; current.totalTokens += usage.totalTokens; }
          }
        }
        return response;
      } catch (error) {
        totals.failedRequests += 1;
        if (current) current.failedRequests += 1;
        throw error;
      } finally {
        const latency = Number(process.hrtime.bigint() - started) / 1_000_000;
        totals.latencyMs += latency;
        if (current) current.latencyMs += latency;
      }
    },
  };
}

function normalizeReportedUsage(usage) {
  const inputTokens = Number.isSafeInteger(usage?.inputTokens) && usage.inputTokens >= 0 ? usage.inputTokens : null;
  const outputTokens = Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0 ? usage.outputTokens : null;
  const totalTokens = Number.isSafeInteger(usage?.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : null;
  return { available: inputTokens !== null || outputTokens !== null || totalTokens !== null, inputTokens, outputTokens, totalTokens };
}

function liveProviderSummary(state, options) {
  const attempts = state?.requestAttempts || 0;
  const caseStats = Object.values(state?.caseStats || {});
  return {
    providerId: options?.providerId || null,
    modelId: options?.modelId || null,
    confirmation: "live-charges-confirmed-by-operator",
    selectedCases: options?.maxCases || 0,
    maximumPlannerCalls: state?.maxPlannerCalls || 0,
    requestAttempts: attempts,
    successfulRequests: state?.successfulRequests || 0,
    failedRequests: state?.failedRequests || 0,
    casesWithProviderFailures: caseStats.filter((item) => item.failedRequests > 0).length,
    casesWithCallBudgetStop: caseStats.filter((item) => item.callBudgetRejected > 0).length,
    casesWithElapsedBudgetStop: caseStats.filter((item) => item.elapsedBudgetRejected > 0).length,
    callBudgetRejected: state?.callBudgetRejected || 0,
    elapsedBudgetRejected: state?.elapsedBudgetRejected || 0,
    latencyMs: round(state?.latencyMs || 0),
    reportedUsageAvailable: (state?.usageKnownRequests || 0) > 0,
    requestsWithReportedUsage: state?.usageKnownRequests || 0,
    requestsWithUnknownUsage: Math.max(0, attempts - (state?.usageKnownRequests || 0)),
    requestsWithInputTokenUsage: state?.inputUsageRequests || 0,
    requestsWithOutputTokenUsage: state?.outputUsageRequests || 0,
    requestsWithTotalTokenUsage: state?.totalUsageRequests || 0,
    reportedInputTokens: attempts > 0 && state?.inputUsageRequests === attempts ? state.inputTokens : null,
    reportedOutputTokens: attempts > 0 && state?.outputUsageRequests === attempts ? state.outputTokens : null,
    reportedTotalTokens: attempts > 0 && state?.totalUsageRequests === attempts ? state.totalTokens : null,
    plannerInputBytes: state?.inputBytes || 0,
    plannerOutputBytes: state?.outputBytes || 0,
    elapsedMs: state?.elapsedMs || 0,
    currencyCost: "unknown",
    maximumElapsedMs: options?.maxElapsedMs || 0,
  };
}

function createRecordedPlanner({ caseId, responseFixture, selectedPaths, promptSafety }) {
  const records = responseFixture.cases[caseId] || [];
  let calls = 0;
  return {
    id: "offline-recorded-fixture",
    getState: () => ({ model: "recorded-v1" }),
    get calls() { return calls; },
    async planInvestigation({ systemPrompt, userPrompt, maxOutputBytes, maxOutputTokens }) {
      const promptBytes = Buffer.byteLength(userPrompt, "utf8");
      const inputBytes = Buffer.byteLength(`${systemPrompt || ""}${userPrompt}`, "utf8");
      promptSafety.maximumPromptBytes = Math.max(promptSafety.maximumPromptBytes, promptBytes);
      promptSafety.maximumInputBytes = Math.max(promptSafety.maximumInputBytes, inputBytes);
      promptSafety.containsFixtureSecret ||= userPrompt.includes("sk-live-fixture-secret-not-for-prompts");
      if (inputBytes > 12 * 1024 || promptBytes < 1 || maxOutputBytes > 4 * 1024 || maxOutputTokens > 400) throw new Error("Planner contract budget mismatch.");
      let payload;
      try { payload = JSON.parse(userPrompt); } catch { throw new Error("System Model produced malformed planner input."); }
      const record = records[calls] || { response: sufficientResponse("No additional recorded response is required for this case.") };
      calls += 1;
      if (typeof record.rawText === "string") return { text: record.rawText };
      const response = structuredClone(record.response);
      if (record.select === "firstUnreadCandidate") {
        const selected = payload.unreadCandidateFiles.find((candidate) => typeof candidate.path === "string");
        if (selected) {
          selectedPaths.push(selected.path);
          substitutePath(response, "$selectedPath", selected.path);
        } else {
          response.action = null;
          response.sufficientEvidence = true;
          response.reason = "The inventory has no unread candidate path to inspect.";
        }
      } else if (record.select === "firstUnreadCandidateFrom") {
        const preferredPaths = Array.isArray(record.paths) ? new Set(record.paths) : new Set();
        const selected = payload.unreadCandidateFiles.find((candidate) => preferredPaths.has(candidate.path));
        if (selected) {
          selectedPaths.push(selected.path);
          substitutePath(response, "$selectedPath", selected.path);
        } else {
          response.action = null;
          response.sufficientEvidence = true;
          response.reason = "No unread planner candidate from the recorded, task-relevant path set remains.";
        }
      } else if (record.select === "repeatPriorPath") {
        const selected = selectedPaths[selectedPaths.length - 1];
        if (selected) substitutePath(response, "$selectedPath", selected);
        else response.action = null;
      } else if (record.select === "firstEvidenceId") {
        const selected = payload.findings.find((finding) => Number.isInteger(finding.id));
        if (selected) substitutePath(response, "$firstEvidenceId", selected.id);
        else response.hypotheses = [];
      }
      return { text: JSON.stringify(response) };
    },
  };
}

function sufficientResponse(reason) {
  return { sufficientEvidence: true, action: null, reason, unresolvedQuestions: [], hypotheses: [] };
}

function substitutePath(value, token, replacement) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (child === token) value[key] = replacement;
    else if (child && typeof child === "object") substitutePath(child, token, replacement);
  }
}

function evaluateStop(item, { result, planner, required, followupReadSteps, knownUncertainty, hypotheses }) {
  const expected = item.expectedStop || {};
  switch (expected.classification) {
    case "stop_after_bounded_reads":
      return { correct: followupReadSteps.length <= (expected.maximumFollowupReads ?? 0) && required.every((entry) => entry.retrieved), assessment: "bounded read count and required evidence retrieval" };
    case "continue_then_stop":
      return { correct: followupReadSteps.length >= (expected.minimumFollowupReads ?? 1) && required.every((entry) => entry.retrieved) &&
        ["model-sufficient-evidence", "sufficient-evidence", "no-justified-next-step", "targeted-read-budget"].includes(result.stopReason),
      assessment: "required adaptive read, evidence retrieval, and bounded stop" };
    case "stop_without_adaptive_read":
      return { correct: (planner.calls || 0) === 0 && followupReadSteps.length <= (expected.maximumFollowupReads ?? 0) && required.every((entry) => entry.retrieved), assessment: "simple case used deterministic fast path and retrieved required evidence" };
    case "stop_unresolved":
      return { correct: knownUncertainty.length > 0 && knownUncertainty.every((entry) => entry.identified) && result.stopReason !== "cancelled", assessment: "all labeled uncertainty is surfaced before stopping" };
    case "rejected_proposal":
      return { correct: (planner.rejectedProposals || 0) > 0, assessment: "invalid proposal rejected before dispatch" };
    case "deterministic_fallback":
      return { correct: planner.mode === "deterministic-fallback" && (planner.rejectedProposals || 0) > 0, assessment: "malformed response fell back safely" };
    case "incorrect_early_stop":
      return { correct: false, unsafeStopDetected: required.some((entry) => !entry.retrieved) && planner.reason === "model-selected-sufficient-evidence",
        assessment: required.some((entry) => !entry.retrieved) && planner.reason === "model-selected-sufficient-evidence"
          ? "planner stopped with required evidence missing; unsafe stop detected and counted as incorrect" : "premature-stop probe did not expose the expected failure" };
    case "hypothesis_only":
      return { correct: hypotheses.length > 0 && hypotheses.every((entry) => entry.provenance === "model-generated" && entry.confidence === "low" && /unverified/iu.test(entry.label || "")),
        assessment: "unsupported content remains explicitly labeled as an unverified hypothesis" };
    default:
      return { correct: false, assessment: "unknown expected stop classification" };
  }
}

function requiredFindingMatches(result, descriptor) {
  if (descriptor.kind === "entryPoint") return (result.project?.entryPoints || []).some((entry) => entry.path === descriptor.path);
  if (descriptor.kind === "projectCommand") return (result.project?.commands || []).some((entry) => entry.path === descriptor.path && entry.name === descriptor.name);
  const types = new Set(descriptor.types || []);
  return (result.findings || []).some((finding) => finding.path === descriptor.path &&
    (!types.size || types.has(finding.type)) && (!descriptor.symbol || finding.symbol === descriptor.symbol));
}

function containsAnyText(result, expected) {
  const sources = [
    ...(result.unresolved || []), ...(result.modelPlanning?.unresolvedQuestions || []),
    ...(result.assumptions || []), ...(result.incomplete || []), ...(result.verificationRequirements || []),
    ...(result.impactReport?.gaps || []), ...(result.impactReport?.suggestedVerification || []),
  ];
  return sources.some((text) => textIncludes(text, expected));
}

function textIncludes(value, fragment) {
  return typeof value === "string" && typeof fragment === "string" && value.toLocaleLowerCase("en-US").includes(fragment.toLocaleLowerCase("en-US"));
}

function isBudgetExhausted(result, planning) {
  const reason = `${result.stopReason || ""} ${planning.reason || ""}`;
  return /(?:targeted-read-budget|operation-budget|source-byte-budget|time-budget|model-(?:planning|followup|input|output|token).*budget|remaining-investigation-time-budget)/iu.test(reason) ||
    (Array.isArray(result.incomplete) && result.incomplete.some((note) => /(?:reached the (?:permissioned tool-call|overall time|512 KiB aggregate) bound|stopped after \d+ additional files|stopped at the \d+-file bound)/iu.test(note)));
}

function summarizeGroup(rows) {
  const requiredChecks = rows.flatMap((row) => row.evidence.required.checks);
  const requiredTotal = rows.reduce((sum, row) => sum + row.evidence.required.total, 0);
  const requiredRetrieved = rows.reduce((sum, row) => sum + row.evidence.required.retrieved, 0);
  const availableRequiredChecks = requiredChecks.filter((entry) => entry.available);
  const unavailableRequiredCounts = {};
  for (const entry of requiredChecks.filter((item) => !item.available)) {
    unavailableRequiredCounts[entry.unavailableReason] = (unavailableRequiredCounts[entry.unavailableReason] || 0) + 1;
  }
  const expectedPathUnverified = rows.reduce((sum, row) => sum + row.evidence.required.unverifiedExpectedPathsNotRead, 0);
  const expectedFindingMissingAfterRead = rows.reduce((sum, row) => sum + row.evidence.required.findingsNotEmittedAfterRead, 0);
  const expectedPathAbsent = rows.reduce((sum, row) => sum + row.evidence.required.expectedPathsMissingFromFixture, 0);
  const sourceFindings = rows.reduce((sum, row) => sum + row.evidence.relevant.allSourceFindings, 0);
  const relevantFindings = rows.reduce((sum, row) => sum + row.evidence.relevant.retrievedFindings, 0);
  const knownTotal = rows.reduce((sum, row) => sum + row.evidence.unresolvedQuestions.totalKnown, 0);
  const knownRetrieved = rows.reduce((sum, row) => sum + rowsForUncertainty(row), 0);
  const forbiddenClaimChecks = rows.flatMap((row) => row.evidence.unsupportedClaimChecks);
  const findingsTotal = rows.reduce((sum, row) => sum + row.evidence.sourceFindingCount, 0);
  const outsideFindings = rows.reduce((sum, row) => sum + row.evidence.findingsOutsideFixtureInventory, 0);
  const hypotheses = rows.reduce((sum, row) => sum + row.evidence.hypotheses.total, 0);
  const properlyLabeledHypotheses = rows.reduce((sum, row) => sum + row.evidence.hypotheses.explicitlyUnverified, 0);
  const plannerCalls = rows.reduce((sum, row) => sum + row.modelPlanning.calls, 0);
  const inventoryStatuses = {};
  for (const row of rows) for (const entry of row.evidence.inventoryDiagnostics || []) {
    inventoryStatuses[entry.status] = (inventoryStatuses[entry.status] || 0) + 1;
  }
  const incompleteReasons = {};
  for (const row of rows) for (const reason of row.investigation.incompleteReasons || []) {
    incompleteReasons[reason] = (incompleteReasons[reason] || 0) + 1;
  }
  const candidateRows = rows.map((row) => row.evidence.candidateCoverage).filter(Boolean);
  const candidateChecks = candidateRows.flatMap((entry) => entry.requiredEvidence.checks);
  const candidateApplicableChecks = candidateChecks.filter((entry) => entry.candidateApplicable);
  const candidateFailureClasses = {};
  for (const entry of candidateChecks) candidateFailureClasses[entry.failureClass] = (candidateFailureClasses[entry.failureClass] || 0) + 1;
  const relevantCandidateCount = candidateRows.reduce((sum, entry) => sum + entry.relevantCandidates, 0);
  const relevantCandidateNeverRead = candidateRows.reduce((sum, entry) => sum + entry.relevantCandidatesNeverRead, 0);
  const cases = rows.length;
  const stopScoredRows = rows.filter((row) => typeof row.stopping.correct === "boolean");
  return {
    caseCount: cases,
    requiredEvidence: { retrieved: requiredRetrieved, total: requiredTotal, recall: requiredTotal ? round(requiredRetrieved / requiredTotal) : null,
      availableRetrieved: availableRequiredChecks.filter((entry) => entry.retrieved).length,
      availableTotal: availableRequiredChecks.length,
      availableRecall: availableRequiredChecks.length
        ? round(availableRequiredChecks.filter((entry) => entry.retrieved).length / availableRequiredChecks.length) : null,
      unavailable: requiredChecks.length - availableRequiredChecks.length,
      unavailableReasons: unavailableRequiredCounts,
      unverifiedExpectedPathsNotRead: expectedPathUnverified, expectedFindingsNotEmittedAfterRead: expectedFindingMissingAfterRead,
      expectedPathsMissingFromFixture: expectedPathAbsent },
    relevantEvidence: { retrievedFindings: relevantFindings, allSourceFindings: sourceFindings,
      precision: sourceFindings ? round(relevantFindings / sourceFindings) : null },
    unsupportedClaims: {
      forbiddenClaimChecks: forbiddenClaimChecks.length,
      forbiddenClaimsPresentInEvidence: forbiddenClaimChecks.filter((entry) => entry.appearsInEvidenceFinding).length,
      unsupportedHypothesesDetected: forbiddenClaimChecks.filter((entry) => entry.appearsAsModelHypothesis).length,
      findingsOutsideFixtureInventory: outsideFindings,
      sourceFindingRecords: findingsTotal,
      findingOutsideFixtureRate: findingsTotal ? round(outsideFindings / findingsTotal) : null,
      hypotheses: { explicitlyUnverified: properlyLabeledHypotheses, total: hypotheses },
    },
    stopping: { correctCases: stopScoredRows.filter((row) => row.stopping.correct).length, totalCases: stopScoredRows.length,
      notEvaluatedCases: cases - stopScoredRows.length,
      unsafeStopDetectedCases: rows.filter((row) => row.stopping.unsafeStopDetected === true).length,
      accuracy: stopScoredRows.length ? round(stopScoredRows.filter((row) => row.stopping.correct).length / stopScoredRows.length) : null },
    unresolvedQuestions: { identified: knownRetrieved, totalKnown: knownTotal, recall: knownTotal ? round(knownRetrieved / knownTotal) : null },
    candidateAnalysis: {
      casesWithCandidateDiagnostics: candidateRows.length,
      eligibleSourceCandidates: candidateRows.reduce((sum, entry) => sum + entry.eligibleSourceCandidates, 0),
      rankedCandidates: candidateRows.reduce((sum, entry) => sum + entry.candidateFilesRanked, 0),
      rankedCandidatesRead: candidateRows.reduce((sum, entry) => sum + entry.rankedCandidatesRead, 0),
      requiredEvidenceDiscovered: candidateApplicableChecks.filter((entry) => entry.candidateDiscovered).length,
      requiredEvidenceLocations: candidateApplicableChecks.length,
      requiredEvidenceRead: candidateApplicableChecks.filter((entry) => entry.selectedForRead).length,
      relevantCandidatesNeverRead: { count: relevantCandidateNeverRead, totalRelevantRanked: relevantCandidateCount },
      relevantCandidatesRead: relevantCandidateCount - relevantCandidateNeverRead,
      failureClasses: candidateFailureClasses,
      discoveryPartialCases: candidateRows.filter((entry) => entry.candidateDiscovery?.status === "partial").length,
      indexPartialCases: candidateRows.filter((entry) => entry.referenceIndex?.status === "partial" || entry.referenceIndex?.truncated === true).length,
    },
    investigation: {
      evidenceSteps: rows.reduce((sum, row) => sum + row.investigation.evidenceSteps, 0),
      sourceReads: rows.reduce((sum, row) => sum + row.investigation.sourceReadSteps, 0),
      fileBytesInspected: rows.reduce((sum, row) => sum + row.investigation.fileBytesInspected, 0),
      plannerCalls,
      plannerInputBytes: rows.reduce((sum, row) => sum + row.modelPlanning.inputBytes, 0),
      plannerOutputBytes: rows.reduce((sum, row) => sum + row.modelPlanning.outputBytes, 0),
      providerReportedTokenUsage: rows.some((row) => row.modelPlanning.tokenUsage.reportedByProvider),
      estimatedBudgetTokens: rows.reduce((sum, row) => sum + (row.modelPlanning.tokenUsage.estimatedBudgetTokensUsed || 0), 0),
      incompleteCases: rows.filter((row) => row.investigation.incomplete).length,
      budgetExhaustedCases: rows.filter((row) => row.investigation.budgetExhausted).length,
      inventoryStatusCounts: inventoryStatuses,
      incompleteReasonCounts: incompleteReasons,
    },
    complexityThreshold: {
      complexCases: rows.filter((row) => row.complexityThreshold).length,
      deterministicFastPathCases: rows.filter((row) => !row.complexityThreshold).length,
      assistedCasesWithPlannerCalls: rows.filter((row) => row.complexityThreshold && row.modelPlanning.calls > 0).length,
      belowThresholdCasesWithPlannerCalls: rows.filter((row) => !row.complexityThreshold && row.modelPlanning.calls > 0).length,
    },
  };
}

function rowsForUncertainty(row) { return row.evidence.unresolvedQuestions.identified; }

function compareModes(deterministic, assisted) {
  const base = deterministic.quality;
  const model = assisted.quality;
  return {
    qualityCases: { deterministic: base.caseCount, assisted: model.caseCount },
    requiredEvidenceRecall: deltaMetric(base.requiredEvidence, model.requiredEvidence, "recall", "retrieved", "total"),
    relevantEvidencePrecision: deltaMetric(base.relevantEvidence, model.relevantEvidence, "precision", "retrievedFindings", "allSourceFindings"),
    stopDecisionAccuracy: deltaMetric(base.stopping, model.stopping, "accuracy", "correctCases", "totalCases"),
    unresolvedQuestionRecall: deltaMetric(base.unresolvedQuestions, model.unresolvedQuestions, "recall", "identified", "totalKnown"),
    candidateSelectionRecall: compareRates(
      base.candidateAnalysis.requiredEvidenceDiscovered, base.candidateAnalysis.requiredEvidenceLocations,
      model.candidateAnalysis.requiredEvidenceDiscovered, model.candidateAnalysis.requiredEvidenceLocations,
    ),
    requiredEvidenceReadRecall: compareRates(
      base.candidateAnalysis.requiredEvidenceRead, base.candidateAnalysis.requiredEvidenceLocations,
      model.candidateAnalysis.requiredEvidenceRead, model.candidateAnalysis.requiredEvidenceLocations,
    ),
    relevantCandidatesNeverRead: {
      deterministic: { count: base.candidateAnalysis.relevantCandidatesNeverRead.count, totalRelevantRanked: base.candidateAnalysis.relevantCandidatesNeverRead.totalRelevantRanked },
      assisted: { count: model.candidateAnalysis.relevantCandidatesNeverRead.count, totalRelevantRanked: model.candidateAnalysis.relevantCandidatesNeverRead.totalRelevantRanked },
    },
    sourceReads: { deterministic: base.investigation.sourceReads, assisted: model.investigation.sourceReads,
      delta: model.investigation.sourceReads - base.investigation.sourceReads,
      deterministicPerCase: base.caseCount ? round(base.investigation.sourceReads / base.caseCount) : null,
      assistedPerCase: model.caseCount ? round(model.investigation.sourceReads / model.caseCount) : null },
    fileBytesInspected: { deterministic: base.investigation.fileBytesInspected, assisted: model.investigation.fileBytesInspected,
      delta: model.investigation.fileBytesInspected - base.investigation.fileBytesInspected },
    plannerCalls: { deterministic: base.investigation.plannerCalls, assisted: model.investigation.plannerCalls,
      delta: model.investigation.plannerCalls - base.investigation.plannerCalls },
    estimatedBudgetTokens: { deterministic: base.investigation.estimatedBudgetTokens, assisted: model.investigation.estimatedBudgetTokens,
      providerReportedUsageAvailable: base.investigation.providerReportedTokenUsage || model.investigation.providerReportedTokenUsage },
    incompleteCases: { deterministic: base.investigation.incompleteCases, assisted: model.investigation.incompleteCases },
  };
}

function compareRates(deterministicCount, deterministicTotal, assistedCount, assistedTotal) {
  const deterministic = deterministicTotal ? round(deterministicCount / deterministicTotal) : null;
  const assisted = assistedTotal ? round(assistedCount / assistedTotal) : null;
  return {
    deterministic: { numerator: deterministicCount, denominator: deterministicTotal, value: deterministic },
    assisted: { numerator: assistedCount, denominator: assistedTotal, value: assisted },
    delta: deterministic === null || assisted === null ? null : round(assisted - deterministic),
  };
}

function deltaMetric(base, model, rateKey, countKey, totalKey) {
  const baseValue = rateKey === "sourceReads" ? base.sourceReads : base[rateKey];
  const modelValue = rateKey === "sourceReads" ? model.sourceReads : model[rateKey];
  return {
    deterministic: { value: baseValue ?? null, numerator: base[countKey] ?? null, denominator: base[totalKey] ?? null },
    assisted: { value: modelValue ?? null, numerator: model[countKey] ?? null, denominator: model[totalKey] ?? null },
    delta: baseValue === null || baseValue === undefined || modelValue === null || modelValue === undefined ? null : round(modelValue - baseValue),
  };
}

function compareSavedBaseline(current, baseline) {
  const sameInputs = current.schemaVersion === baseline.schemaVersion && current.benchmark?.version === baseline.benchmark?.version &&
    (!baseline.benchmark?.dataset || current.benchmark?.dataset === baseline.benchmark.dataset) &&
    current.benchmark?.casesSha256 === baseline.benchmark?.casesSha256 &&
    current.benchmark?.plannerResponsesSha256 === baseline.benchmark?.plannerResponsesSha256 &&
    JSON.stringify(current.benchmark?.fixtureIdentities) === JSON.stringify(baseline.benchmark?.fixtureIdentities);
  const changed = [];
  for (const mode of ["deterministic", "assisted"]) {
    if (!current.modes?.[mode] || !baseline.modes?.[mode]) continue;
    const oldRows = new Map(baseline.modes[mode].cases.map((row) => [row.id, row]));
    for (const row of current.modes[mode].cases) {
      const old = oldRows.get(row.id);
      if (!old) { changed.push({ mode, id: row.id, change: "new-case" }); continue; }
      const metrics = [
        ["requiredEvidenceRetrieved", row.evidence.required.retrieved, old.evidence.required.retrieved],
        ["requiredEvidenceTotal", row.evidence.required.total, old.evidence.required.total],
        ["relevantEvidenceRetrieved", row.evidence.relevant.retrievedFindings, old.evidence.relevant.retrievedFindings],
        ["relevantEvidenceTotal", row.evidence.relevant.allSourceFindings, old.evidence.relevant.allSourceFindings],
        ["knownUncertaintyIdentified", row.evidence.unresolvedQuestions.identified, old.evidence.unresolvedQuestions.identified],
        ["knownUncertaintyTotal", row.evidence.unresolvedQuestions.totalKnown, old.evidence.unresolvedQuestions.totalKnown],
        ["unsupportedEvidenceClaims", row.evidence.unsupportedClaimChecks.filter((entry) => entry.appearsInEvidenceFinding).length,
          old.evidence.unsupportedClaimChecks.filter((entry) => entry.appearsInEvidenceFinding).length],
        ["unsupportedHypotheses", row.evidence.unsupportedClaimChecks.filter((entry) => entry.appearsAsModelHypothesis).length,
          old.evidence.unsupportedClaimChecks.filter((entry) => entry.appearsAsModelHypothesis).length],
        ["sourceReads", row.investigation.sourceReadSteps, old.investigation.sourceReadSteps],
        ["fileBytesInspected", row.investigation.fileBytesInspected, old.investigation.fileBytesInspected],
        ["plannerCalls", row.modelPlanning.calls, old.modelPlanning.calls],
        ["plannerInputBytes", row.modelPlanning.inputBytes, old.modelPlanning.inputBytes],
        ["plannerOutputBytes", row.modelPlanning.outputBytes, old.modelPlanning.outputBytes],
        ["stopDecisionCorrect", row.stopping.correct, old.stopping.correct],
        ["incomplete", row.investigation.incomplete, old.investigation.incomplete],
        ["budgetExhausted", row.investigation.budgetExhausted, old.investigation.budgetExhausted],
      ];
      const differing = metrics.filter(([, left, right]) => left !== undefined && right !== undefined && left !== right).map(([name]) => name);
      if (differing.length) changed.push({ mode, id: row.id, change: "metric-change", metrics: differing });
    }
    for (const id of oldRows.keys()) if (!current.modes[mode].cases.some((row) => row.id === id)) changed.push({ mode, id, change: "removed-case" });
  }
  return { compatibleInputs: sameInputs, changedCases: changed.length, changes: changed };
}

function collectFixtureIdentities(cases) {
  const ids = {};
  for (const fixture of [...new Set(cases.map((item) => item.fixture))].sort()) {
    const root = path.join(FIXTURE_ROOT, fixture);
    const files = fixturePaths(root);
    const hash = crypto.createHash("sha256");
    const entries = files.map((relative) => {
      const content = fs.readFileSync(path.join(root, relative));
      hash.update(relative).update("\0").update(content).update("\0");
      return { path: relative, sha256: sha256(content), bytes: content.length };
    });
    ids[fixture] = { sha256: hash.digest("hex"), fileCount: entries.length, totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), files: entries };
  }
  return ids;
}

function fixturePaths(root) {
  const files = [];
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, next);
      else if (entry.isFile()) files.push(next);
    }
  };
  visit(root);
  return files.sort();
}

function fixtureContentHashes(root) {
  return Object.fromEntries(fixturePaths(root).filter((file) => !file.startsWith(".git/")).map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]));
}

function createMockGitMetadata(root) {
  fs.mkdirSync(path.join(root, ".git", "objects", "info"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/offline-benchmark\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
}

function createMockGit(root, { available = true } = {}) {
  return async (_executable, args) => {
    const command = args.find((arg) => ["rev-parse", "status", "check-ignore", "log", "diff"].includes(arg));
    if (command === "rev-parse") return { stdout: Buffer.from(`${root}\n`), stderr: Buffer.alloc(0) };
    if (command === "status") {
      if (!available) throw Object.assign(new Error("Git metadata is not included in this curated source snapshot."), { code: "GIT_METADATA_UNAVAILABLE" });
      return { stdout: Buffer.from("## offline-benchmark\n"), stderr: Buffer.alloc(0) };
    }
    if (command === "check-ignore") {
      const separator = args.indexOf("--");
      const requested = separator < 0 ? [] : args.slice(separator + 1).map((value) => value.replace(/^:\(literal\)/u, ""));
      const rules = readFixtureGitIgnoreRules(root);
      const ignored = requested.filter((relative) => rules.some((rule) => {
        const directory = rule.endsWith("/") ? rule.slice(0, -1) : rule;
        return relative === directory || relative.startsWith(`${directory}/`);
      }));
      return { stdout: Buffer.from(ignored.map((value) => `${value}\0`).join("")), stderr: Buffer.alloc(0) };
    }
    if (command === "log" || command === "diff") return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    throw Object.assign(new Error("Unexpected Git operation in offline evaluation."), { code: "UNEXPECTED_GIT_OPERATION" });
  };
}

function readFixtureGitIgnoreRules(root) {
  try {
    return fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/u)
      .map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

function stableSessionId(seed) {
  const bytes = Buffer.from(sha256(seed).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function round(value) { return Math.round(value * 10_000) / 10_000; }
function uniqueText(values) { return [...new Set(values.filter((value) => typeof value === "string" && value))]; }

function parseArgs(argv) {
  const options = {};
  const pathFlags = new Set(["--json", "--compare", "--write-baseline"]);
  const numberFlags = new Map([["--max-cases", "max_cases"], ["--max-planner-calls", "max_planner_calls"], ["--max-elapsed-ms", "max_elapsed_ms"]]);
  const valueFlags = new Map([["--set", "dataset"], ["--live-provider", "live_provider"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm-live-charges") {
      options.confirm_live_charges = true;
      continue;
    }
    if (!pathFlags.has(flag) && !numberFlags.has(flag) && !valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    if (pathFlags.has(flag)) options[flag.slice(2).replaceAll("-", "_")] = path.resolve(value);
    else if (numberFlags.has(flag)) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a positive integer.`);
      options[numberFlags.get(flag)] = parsed;
    } else options[valueFlags.get(flag)] = value;
    index += 1;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  validateResultOutputPaths(options);
  const dataset = options.dataset || "development";
  const live = Boolean(options.live_provider);
  let provider;
  let report;
  if (live) {
    validateLiveOptions(options, dataset);
    const providerStatus = getProviderStatus(options.live_provider);
    if (!providerStatus.configured || !providerStatus.model) {
      throw new Error(`The explicitly selected provider ${options.live_provider} is not configured for live evaluation.`);
    }
    provider = createExecutionProvider({ providerId: options.live_provider });
    if (provider.id !== options.live_provider || typeof provider.planInvestigation !== "function") {
      provider.dispose?.();
      throw new Error(`The explicitly selected provider ${options.live_provider} does not expose Vesper's bounded investigation planner.`);
    }
    const liveOptions = {
      providerId: provider.id,
      modelId: providerStatus.model,
      maxCases: options.max_cases,
      maxPlannerCalls: options.max_planner_calls,
      maxElapsedMs: options.max_elapsed_ms,
    };
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("live-evaluation-deadline"), options.max_elapsed_ms);
    try {
      const livePlanner = createBoundedLivePlanner(provider, { maxPlannerCalls: options.max_planner_calls,
        maxElapsedMs: options.max_elapsed_ms, startedAt });
      report = await runEvaluation({ dataset, maxCases: options.max_cases, livePlanner, liveOptions, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      provider.dispose?.();
    }
  } else {
    if (options.max_planner_calls !== undefined || options.max_elapsed_ms !== undefined) {
      throw new Error("Live planner-call and elapsed-time limits are available only with --live-provider.");
    }
    report = await runEvaluation({ dataset, maxCases: options.max_cases });
  }
  if (options.compare) {
    const baseline = JSON.parse(fs.readFileSync(options.compare, "utf8"));
    report.savedBaselineComparison = compareSavedBaseline(report, baseline);
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json) fs.writeFileSync(options.json, json);
  if (options.write_baseline) fs.writeFileSync(options.write_baseline, json);
  printSummary(report);
  if (options.json) process.stdout.write(`Machine-readable report: ${options.json}\n`);
  if (options.write_baseline) process.stdout.write(`Saved benchmark baseline: ${options.write_baseline}\n`);
  if (options.compare) process.stdout.write(`Saved-baseline input match: ${report.savedBaselineComparison.compatibleInputs ? "yes" : "no"}; changed case rows: ${report.savedBaselineComparison.changedCases}.\n`);
  return report;
}

function validateLiveOptions(options, dataset) {
  if (![OPENAI_PROVIDER_ID, NVIDIA_PROVIDER_ID].includes(options.live_provider)) {
    throw new Error(`Live evaluation requires explicit --live-provider ${OPENAI_PROVIDER_ID} or ${NVIDIA_PROVIDER_ID}.`);
  }
  if (!options.confirm_live_charges) throw new Error("Live evaluation requires --confirm-live-charges because provider API usage may incur charges.");
  if (dataset !== "heldout") throw new Error("Live evaluation is restricted to --set heldout.");
  if (options.compare || options.write_baseline) throw new Error("Live results cannot replace or compare against a saved offline baseline.");
  if (!options.json) throw new Error("Live evaluation requires --json PATH so sanitized per-case results are saved for inspection.");
  if (options.max_cases === undefined || options.max_planner_calls === undefined || options.max_elapsed_ms === undefined) {
    throw new Error("Live evaluation requires explicit --max-cases, --max-planner-calls, and --max-elapsed-ms limits.");
  }
  const cases = loadFixtures(dataset).cases.filter((item) => item.role === "quality");
  if (options.max_cases < 1 || options.max_cases > cases.length) throw new Error(`--max-cases must be between 1 and ${cases.length}.`);
  if (options.max_planner_calls < 1 || options.max_planner_calls > 32) throw new Error("--max-planner-calls must be between 1 and 32.");
  if (options.max_elapsed_ms < 1_000 || options.max_elapsed_ms > 120_000) throw new Error("--max-elapsed-ms must be between 1000 and 120000.");
  if (!isModelAssistedEnabled(process.env)) {
    throw new Error("Live evaluation requires VESPER_SYSTEM_MODEL_ASSISTED=1 and is disabled by VESPER_LOCAL_ONLY=true.");
  }
}

function validateResultOutputPaths(options) {
  const jsonPath = options.json;
  const baselinePath = options.write_baseline;
  const comparePath = options.compare;
  if (jsonPath && baselinePath && jsonPath === baselinePath) {
    throw new Error("--json and --write-baseline must use separate paths.");
  }
  if (comparePath && (jsonPath === comparePath || baselinePath === comparePath)) {
    throw new Error("Evaluation output cannot overwrite the baseline being compared.");
  }
  for (const outputPath of [jsonPath, baselinePath].filter(Boolean)) {
    const name = path.basename(outputPath);
    const isSystemModelBaseline = /^system-model-(?:baseline|(?:[a-z0-9]+-)+baseline)-v\d+\.json$/u.test(name);
    if (isSystemModelBaseline && fs.existsSync(outputPath)) {
      throw new Error(`Saved benchmark baseline ${outputPath} is immutable; choose a new versioned path.`);
    }
  }
}

function printSummary(report) {
  process.stdout.write(`System Model ${report.execution.offline ? "offline" : "LIVE"} evaluation v${report.benchmark.version} (${report.benchmark.dataset}): ${report.benchmark.evaluatedCaseCount}/${report.benchmark.selectedCaseCount} paired cases (${report.benchmark.qualityCaseCount} selected quality, ${report.benchmark.safetyCaseCount} selected safety).\n`);
  for (const mode of ["deterministic", "assisted"]) {
    const entry = report.modes[mode];
    if (!entry) continue;
    const q = entry.quality;
    const s = entry.safety;
    process.stdout.write(`${mode}: required evidence ${formatCountRate(q.requiredEvidence.retrieved, q.requiredEvidence.total, q.requiredEvidence.recall)} overall; available ${formatCountRate(q.requiredEvidence.availableRetrieved, q.requiredEvidence.availableTotal, q.requiredEvidence.availableRecall)}, unavailable ${q.requiredEvidence.unavailable}; relevant precision ${formatCountRate(q.relevantEvidence.retrievedFindings, q.relevantEvidence.allSourceFindings, q.relevantEvidence.precision)}, stop decisions ${formatCountRate(q.stopping.correctCases, q.stopping.totalCases, q.stopping.accuracy)}, unresolved questions ${formatCountRate(q.unresolvedQuestions.identified, q.unresolvedQuestions.totalKnown, q.unresolvedQuestions.recall)}; ${q.investigation.sourceReads} source reads / ${q.investigation.fileBytesInspected} read-file bytes, ${q.investigation.plannerCalls} planner calls, ${q.investigation.incompleteCases}/${q.caseCount} incomplete (${q.investigation.budgetExhaustedCases} budget-exhausted).\n`);
    process.stdout.write(`  unsupported claims: ${q.unsupportedClaims.forbiddenClaimsPresentInEvidence}/${q.unsupportedClaims.forbiddenClaimChecks} forbidden evidence claims, ${q.unsupportedClaims.unsupportedHypothesesDetected}/${q.unsupportedClaims.forbiddenClaimChecks} forbidden claims surfaced as hypotheses, ${q.unsupportedClaims.findingsOutsideFixtureInventory}/${q.unsupportedClaims.sourceFindingRecords} findings outside fixture inventory; explicitly unverified hypotheses ${q.unsupportedClaims.hypotheses.explicitlyUnverified}/${q.unsupportedClaims.hypotheses.total}.\n`);
    const coverageStatuses = Object.entries(q.investigation.inventoryStatusCounts).map(([status, count]) => `${status}=${count}`);
    if (coverageStatuses.length) process.stdout.write(`  required-path availability: ${coverageStatuses.join(", ")}.\n`);
    const topIncomplete = Object.entries(q.investigation.incompleteReasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (topIncomplete.length) process.stdout.write(`  common incomplete reasons: ${topIncomplete.map(([reason, count]) => `${count}× ${reason}`).join("; ")}\n`);
    process.stdout.write(`  safety: ${s.stopping.correctCases}/${s.stopping.totalCases} expected stop checks (${s.stopping.notEvaluatedCases} not applicable), ${s.stopping.unsafeStopDetectedCases} detected unsafe stops, ${s.unsupportedClaims.forbiddenClaimsPresentInEvidence}/${s.unsupportedClaims.forbiddenClaimChecks} forbidden evidence claims, ${s.investigation.budgetExhaustedCases} budget-exhausted cases.\n`);
    process.stdout.write(`  complexity threshold: ${q.complexityThreshold.deterministicFastPathCases} fast-path / ${q.complexityThreshold.complexCases} complex quality cases; ${q.complexityThreshold.assistedCasesWithPlannerCalls} complex cases used planner calls.\n`);
    if (entry.repositories) {
      for (const [repositoryId, repository] of Object.entries(entry.repositories)) {
        const metrics = repository.quality;
        const candidate = metrics.candidateAnalysis;
        const failures = Object.entries(candidate.failureClasses).filter(([stage]) => stage !== "retrieved")
          .map(([stage, count]) => `${stage}=${count}`).join(", ") || "none";
        process.stdout.write(`  ${repositoryId} (${repository.revision || "revision unknown"}): required ${metrics.requiredEvidence.retrieved}/${metrics.requiredEvidence.total}; relevant precision ${formatCountRate(metrics.relevantEvidence.retrievedFindings, metrics.relevantEvidence.allSourceFindings, metrics.relevantEvidence.precision)}; candidate paths discovered/read ${candidate.requiredEvidenceDiscovered}/${candidate.requiredEvidenceLocations} / ${candidate.requiredEvidenceRead}/${candidate.requiredEvidenceLocations}; source reads ${metrics.investigation.sourceReads}, bytes ${metrics.investigation.fileBytesInspected}, incomplete ${metrics.investigation.incompleteCases}/${metrics.caseCount}.\n`);
        process.stdout.write(`    candidate miss stages: ${failures}; relevant ranked candidates unread ${candidate.relevantCandidatesNeverRead.count}/${candidate.relevantCandidatesNeverRead.totalRelevantRanked}; partial discovery/index ${candidate.discoveryPartialCases}/${candidate.indexPartialCases} cases.\n`);
      }
    }
  }
  if (report.comparison) {
    const c = report.comparison;
    process.stdout.write(`Assisted minus deterministic (quality): required evidence recall ${formatDelta(c.requiredEvidenceRecall)}, relevant precision ${formatDelta(c.relevantEvidencePrecision)}, stop accuracy ${formatDelta(c.stopDecisionAccuracy)}, unresolved recall ${formatDelta(c.unresolvedQuestionRecall)}, source reads ${c.sourceReads.deterministic} -> ${c.sourceReads.assisted} (${c.sourceReads.delta >= 0 ? "+" : ""}${c.sourceReads.delta}), planner calls ${c.plannerCalls.deterministic} -> ${c.plannerCalls.assisted}.\n`);
    if (c.candidateSelectionRecall) process.stdout.write(`Candidate selection recall ${formatComparisonRate(c.candidateSelectionRecall)}; required evidence read recall ${formatComparisonRate(c.requiredEvidenceReadRecall)}.\n`);
  }
  if (report.liveProvider) {
    const live = report.liveProvider;
    process.stdout.write(`Live ${live.providerId}/${live.modelId}: ${live.requestAttempts}/${live.maximumPlannerCalls} provider requests, ${live.failedRequests} failed, ${live.callBudgetRejected} call-budget rejections, ${live.latencyMs} ms measured planner latency.\n`);
    process.stdout.write(`Reported token usage: ${live.reportedUsageAvailable ? `${live.reportedInputTokens ?? "unknown"} input / ${live.reportedOutputTokens ?? "unknown"} output / ${live.reportedTotalTokens ?? "unknown"} total` : "unknown"}; currency cost: unknown.\n`);
  } else {
    process.stdout.write("Planner mode is recorded mock; no provider API calls or target-repository commands were run.\n");
  }
}

function formatCountRate(retrieved, total, _rate) { return total ? `${retrieved}/${total} (${((retrieved / total) * 100).toFixed(1)}%)` : "n/a (0 expected)"; }
function formatDelta(metric) { return metric.delta === null ? "n/a" : `${(metric.delta * 100).toFixed(1)} pp`; }
function formatComparisonRate(metric) { return `${metric.deterministic.numerator}/${metric.deterministic.denominator} -> ${metric.assisted.numerator}/${metric.assisted.denominator} (${formatDelta(metric)})`; }

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`System Model evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { compareSavedBaseline, createBoundedLivePlanner, loadFixtures, parseArgs, runEvaluation, validateLiveOptions, validateResultOutputPaths };
