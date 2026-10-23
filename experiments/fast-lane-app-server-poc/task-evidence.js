"use strict";

const path = require("node:path");
const { redactSensitiveText } = require("./command-activity");

const MAX_EVIDENCE_ENTRIES = 32;
const MAX_EVIDENCE_PATHS = 8;
const MAX_REPORT_LENGTH = 8_192;
const INSPECTION_TOOLS = new Set(["read_file", "list_files", "search_files", "git_status", "git_diff", "git_log"]);
const SUCCESS_STATES = new Set(["executed", "verified"]);

function createTaskEvidence() {
  return {
    toolCalls: 0,
    inspections: [],
    proposals: [],
    appliedChanges: [],
    failures: [],
    planPresented: false,
  };
}

function hasSuccessfulInspection(evidence) {
  return Boolean(evidence && evidence.inspections && evidence.inspections.length);
}

function hasEvidenceBackedPlan(text, evidence) {
  if (typeof text !== "string" || text.length > 8_000 || !/\bplan\s*:/iu.test(text) || !hasSuccessfulInspection(evidence)) return false;
  const normalizedText = text.toLocaleLowerCase("en-US");
  return evidence.inspections.some((entry) => {
    const reference = entry.path && entry.path !== "." ? entry.path : entry.kind.replaceAll("_", " ");
    return typeof reference === "string" && reference.length > 0 && normalizedText.includes(reference.toLocaleLowerCase("en-US"));
  });
}

function recordTaskToolOutcome(evidence, { toolId, input = {}, result = {} } = {}) {
  if (!evidence || !Array.isArray(evidence.inspections) || evidence.toolCalls >= MAX_EVIDENCE_ENTRIES) return;
  evidence.toolCalls += 1;
  const state = safeToken(result.state, 40) || "unknown";
  const verified = result.verified === true;
  const succeeded = SUCCESS_STATES.has(state) && result.executed === true;
  const errorCode = safeToken(result.error?.code || result.errorCode, 80);

  if (INSPECTION_TOOLS.has(toolId)) {
    if (succeeded) recordInspection(evidence, toolId, result, input);
  } else if (toolId === "propose_file_change") {
    const proposal = result.proposal && typeof result.proposal === "object" ? result.proposal : null;
    const entry = {
      path: safeRelativePath(proposal?.path || input.path),
      proposalId: safeToken(proposal?.proposalId, 80),
      state: state === "proposed" ? "proposed" : state,
      approvalState: safeToken(proposal?.approvalState, 40),
    };
    addBoundedUnique(evidence.proposals, entry, (item) => item.proposalId || `${item.path}:${item.state}`);
  } else if (toolId === "apply_file_change") {
    const proposalId = safeToken(input.proposalId, 80);
    const proposal = evidence.proposals.find((entry) => entry.proposalId === proposalId);
    const resultPath = safeRelativePath(result.result?.path);
    const filePath = resultPath || proposal?.path || null;
    if (result.state === "verified" && verified && result.proposalState === "applied" && filePath) {
      addBoundedUnique(evidence.appliedChanges, { path: filePath, state: "verified" }, (item) => item.path);
      if (proposal) proposal.state = "applied";
    } else if (proposal) {
      proposal.state = safeToken(result.proposalState, 40) || state;
      if (result.approved === true) proposal.approvalState = "approved; result not verified";
    }
  } else if (toolId === "run_command") {
    // This branch is defensive. run_command is intentionally excluded from model definitions.
    evidence.failures.push({ toolId, state: "unsupported", errorCode: "UNSUPPORTED_TOOL" });
  }

  if ((!succeeded && state !== "proposed") || (state === "executed" && !verified) || errorCode) {
    const entry = { toolId: safeToken(toolId, 80) || "unknown", state,
      ...(errorCode ? { errorCode } : {}), ...(result.truncated ? { truncated: true } : {}) };
    addBoundedUnique(evidence.failures, entry, (item) => `${item.toolId}:${item.state}:${item.errorCode || ""}`);
  }
}

function recordRejectedTaskTool(evidence, { toolId, state = "rejected", errorCode } = {}) {
  if (!evidence || evidence.toolCalls >= MAX_EVIDENCE_ENTRIES) return;
  evidence.toolCalls += 1;
  const entry = { toolId: safeToken(toolId, 80) || "unsupported_tool", state: safeToken(state, 40) || "rejected",
    ...(safeToken(errorCode, 80) ? { errorCode: safeToken(errorCode, 80) } : {}) };
  addBoundedUnique(evidence.failures, entry, (item) => `${item.toolId}:${item.state}:${item.errorCode || ""}`);
}

function recordInspection(evidence, toolId, result, input) {
  const value = result.result && typeof result.result === "object" ? result.result : {};
  if (toolId === "read_file") {
    addInspection(evidence, { kind: "read_file", path: safeRelativePath(value.path || input.path), state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  } else if (toolId === "list_files") {
    addInspection(evidence, { kind: "list_files", path: safeRelativePath(value.path || input.path || "."), state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  } else if (toolId === "search_files") {
    const matches = Array.isArray(value.matches) ? value.matches : [];
    const paths = uniquePaths(matches.map((match) => match?.path));
    if (paths.length) {
      for (const filePath of paths) addInspection(evidence, { kind: "search_files match", path: filePath, state: result.truncated ? "partial" : "verified" });
    } else {
      addInspection(evidence, { kind: "search_files", path: null, state: result.truncated ? "partial; no returned match" : "verified; no match returned" });
    }
  } else {
    const scopedPath = toolId === "git_diff" || toolId === "git_log" ? safeRelativePath(input.path) : null;
    addInspection(evidence, { kind: toolId, path: scopedPath, state: result.truncated ? "partial" : result.verified ? "verified" : "not verified" });
  }
}

function addInspection(evidence, entry) {
  addBoundedUnique(evidence.inspections, entry, (item) => `${item.kind}:${item.path || ""}`);
  if (evidence.inspections.length > MAX_EVIDENCE_PATHS) evidence.inspections.length = MAX_EVIDENCE_PATHS;
}

function renderTaskEvidenceReport(evidence) {
  const lines = ["Vesper execution evidence"];
  const inspections = Array.isArray(evidence?.inspections) ? evidence.inspections.slice(0, MAX_EVIDENCE_PATHS) : [];
  lines.push("Inspected:");
  if (!inspections.length) lines.push("- No project files or Git state were verified by Vesper tools.");
  else for (const entry of inspections) lines.push(`- ${entry.kind}${entry.path ? `: ${formatPath(entry.path)}` : ""} (${entry.state}).`);
  if (evidence?.planPresented === true) lines.push("Plan: a concise plan referencing inspected project evidence was shown before proposing the file change.");
  else if (Array.isArray(evidence?.proposals) && evidence.proposals.length) lines.push("Plan: Vesper did not record an evidence-backed plan before the proposal; the proposal was not eligible to apply.");

  const proposals = Array.isArray(evidence?.proposals) ? evidence.proposals.slice(0, MAX_EVIDENCE_PATHS) : [];
  lines.push("File changes:");
  if (!proposals.length && !evidence?.appliedChanges?.length) lines.push("- No file change was proposed or applied.");
  for (const proposal of proposals) {
    const label = proposal.state === "applied" ? "applied" : proposal.state === "proposed" ? "proposed; not applied" : `not applied (${proposal.state})`;
    lines.push(`- ${formatPath(proposal.path)}: ${label}${proposal.state === "applied" ? "; see verified writes below" : "."}`);
  }
  const applied = Array.isArray(evidence?.appliedChanges) ? evidence.appliedChanges.slice(0, MAX_EVIDENCE_PATHS) : [];
  if (applied.length) {
    lines.push("Applied and verified by Vesper read-back:");
    for (const entry of applied) lines.push(`- ${formatPath(entry.path)}.`);
  }

  lines.push("Commands: none; command execution is not available to model tools.");
  lines.push("Tests/builds: not run by Vesper; their outcome is unverified.");
  const failures = Array.isArray(evidence?.failures) ? evidence.failures.slice(0, MAX_EVIDENCE_PATHS) : [];
  if (failures.length) {
    lines.push("Failed, rejected, partial, or unverified operations:");
    for (const entry of failures) {
      lines.push(`- ${entry.toolId}: ${entry.state}${entry.errorCode ? ` (${entry.errorCode})` : ""}${entry.truncated ? " (truncated)" : ""}.`);
    }
  }
  const report = lines.join("\n");
  return report.length <= MAX_REPORT_LENGTH ? report : `${report.slice(0, MAX_REPORT_LENGTH - 24)}\n[report truncated]`;
}

function renderEvidenceInstructions(evidence) {
  const report = renderTaskEvidenceReport(evidence);
  return `Vesper's observed workflow evidence so far (do not add unsupported claims):\n${report}\n\nFor coding changes, inspect relevant files and Git state first. After inspection, show a concise line beginning "Plan:" that references at least one inspected path or inspection type before proposing a change. Vesper will reject proposals without that evidence-backed plan. A proposal is not a write. Apply only after Vesper's fresh one-time approval; then verify using tool evidence. Never claim tests or builds passed: this workflow exposes no command or test execution tool. In the final response separate inspected facts, assumptions, applied changes, failures, and unverified steps.`;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || path.isAbsolute(value)) return null;
  if (redactSensitiveText(value) !== value) return null;
  const normalized = value.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (components.some((component) => component === ".." || component === "")) return null;
  return normalized === "." ? "." : normalized;
}

function uniquePaths(values) {
  return [...new Set(values.map(safeRelativePath).filter(Boolean))].slice(0, MAX_EVIDENCE_PATHS);
}

function addBoundedUnique(entries, value, keyFor) {
  if (!Array.isArray(entries) || entries.length >= MAX_EVIDENCE_ENTRIES) return;
  const key = keyFor(value);
  if (!entries.some((entry) => keyFor(entry) === key)) entries.push(value);
}

function formatPath(value) { return `\`${String(value || "[path unavailable]").replaceAll("`", "'")}\``; }
function safeToken(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/u.test(value) ? value : null;
}

module.exports = {
  createTaskEvidence,
  hasSuccessfulInspection,
  hasEvidenceBackedPlan,
  recordTaskToolOutcome,
  recordRejectedTaskTool,
  renderTaskEvidenceReport,
  renderEvidenceInstructions,
  MAX_EVIDENCE_ENTRIES,
  MAX_REPORT_LENGTH,
};
