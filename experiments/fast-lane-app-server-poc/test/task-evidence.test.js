"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTaskEvidence,
  hasSuccessfulInspection,
  hasEvidenceBackedPlan,
  recordTaskToolOutcome,
  renderTaskEvidenceReport,
  renderEvidenceInstructions,
} = require("../task-evidence");

test("read-only evidence reports only files and Git operations that actually completed", () => {
  const evidence = createTaskEvidence();
  assert.equal(hasSuccessfulInspection(evidence), false);
  recordTaskToolOutcome(evidence, { toolId: "read_file", input: { path: "src/main.js" }, result: {
    state: "verified", executed: true, verified: true, result: { path: "src/main.js", content: "secret file body omitted" },
  } });
  recordTaskToolOutcome(evidence, { toolId: "git_status", result: {
    state: "verified", executed: true, verified: true, result: { exitCode: 0, text: "M src/main.js" },
  } });
  const report = renderTaskEvidenceReport(evidence);
  assert.equal(hasSuccessfulInspection(evidence), true);
  assert.equal(hasEvidenceBackedPlan("Plan: update src/main.js based on the inspected file.", evidence), true);
  assert.equal(hasEvidenceBackedPlan("Plan: update src/other.js.", evidence), false);
  assert.match(report, /read_file: `src\/main\.js` \(verified\)/u);
  assert.match(report, /git_status \(verified\)/u);
  assert.match(report, /No file change was proposed or applied/u);
  assert.match(report, /Commands: none/u);
  assert.match(report, /Tests\/builds: not run by Vesper/u);
  assert.doesNotMatch(report, /secret file body omitted/u);
});

test("proposal and apply evidence distinguish a proposal from an approved verified write", () => {
  const evidence = createTaskEvidence();
  recordTaskToolOutcome(evidence, { toolId: "search_files", input: { query: "route" }, result: {
    state: "verified", executed: true, verified: true, result: { matches: [{ path: "src/router.js" }] },
  } });
  recordTaskToolOutcome(evidence, { toolId: "propose_file_change", input: { path: "src/router.js" }, result: {
    state: "proposed", executed: false, verified: false,
    proposal: { proposalId: "proposal-1", path: "src/router.js", approvalState: "pending" },
  } });
  const proposalReport = renderTaskEvidenceReport(evidence);
  assert.match(proposalReport, /`src\/router\.js`: proposed; not applied/u);
  assert.doesNotMatch(proposalReport, /Plan: a concise plan/u);
  assert.doesNotMatch(proposalReport, /Applied and verified/u);

  recordTaskToolOutcome(evidence, { toolId: "apply_file_change", input: { proposalId: "proposal-1" }, result: {
    state: "verified", executed: true, verified: true, approved: true, proposalState: "applied",
    result: { path: "src/router.js", sha256: "a".repeat(64) },
  } });
  const appliedReport = renderTaskEvidenceReport(evidence);
  assert.match(appliedReport, /`src\/router\.js`: applied/u);
  assert.match(appliedReport, /Applied and verified by Vesper read-back/u);
  assert.doesNotMatch(appliedReport, /sha256/u);
});

test("stale approval or failed verification is reported as unverified and never as applied", () => {
  const evidence = createTaskEvidence();
  recordTaskToolOutcome(evidence, { toolId: "read_file", result: {
    state: "verified", executed: true, verified: true, result: { path: "src/a.js" },
  } });
  recordTaskToolOutcome(evidence, { toolId: "propose_file_change", input: { path: "src/a.js" }, result: {
    state: "proposed", executed: false, proposal: { proposalId: "proposal-2", path: "src/a.js" },
  } });
  recordTaskToolOutcome(evidence, { toolId: "apply_file_change", input: { proposalId: "proposal-2" }, result: {
    state: "uncertain", executed: true, verified: false, proposalState: "uncertain",
    error: { code: "WRITE_VERIFICATION_FAILED" },
  } });
  const report = renderTaskEvidenceReport(evidence);
  assert.match(report, /not applied \(uncertain\)/u);
  assert.match(report, /apply_file_change: uncertain \(WRITE_VERIFICATION_FAILED\)/u);
  assert.doesNotMatch(report, /Applied and verified by Vesper read-back/u);
  assert.match(renderEvidenceInstructions(evidence), /Never claim tests or builds passed/u);
});
