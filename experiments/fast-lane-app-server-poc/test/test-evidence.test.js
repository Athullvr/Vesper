"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SOURCE_FILES,
  TEST_RESULT_RECORDER,
  currentSourceDigest,
  readLatestTestRecord,
  writeLatestTestRecord,
} = require("../test-evidence");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-test-evidence-"));
  const sourceRoot = path.resolve(__dirname, "..");
  for (const relativePath of SOURCE_FILES) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relativePath), destination);
  }
  return root;
}

function validRecord(root) {
  return {
    schemaVersion: 1,
    recorder: TEST_RESULT_RECORDER,
    command: "npm test",
    startedAt: "2026-10-19T11:00:00.000Z",
    completedAt: "2026-10-19T11:01:00.000Z",
    exitCode: 0,
    summary: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
    sourceDigest: currentSourceDigest(root),
  };
}

test("missing test result record is distinguishable from a failure", () => {
  const root = makeFixture();
  try {
    assert.deepEqual(readLatestTestRecord(root), { state: "missing" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner record is accepted only when its source fingerprint matches", () => {
  const root = makeFixture();
  try {
    writeLatestTestRecord(root, validRecord(root));
    const loaded = readLatestTestRecord(root);
    assert.equal(loaded.state, "valid");
    assert.equal(loaded.sourceMatches, true);
    assert.equal(loaded.record.summary.passed, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("changed routing source makes the previous test result stale", () => {
  const root = makeFixture();
  try {
    writeLatestTestRecord(root, validRecord(root));
    fs.appendFileSync(path.join(root, "routing-core.js"), "\n// changed after the recorded run\n");
    const loaded = readLatestTestRecord(root);
    assert.equal(loaded.state, "valid");
    assert.equal(loaded.sourceMatches, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and symlinked evidence records are rejected without reading targets", (t) => {
  const root = makeFixture();
  try {
    const resultPath = path.join(root, ".fast-lane-test-result.json");
    fs.writeFileSync(resultPath, "not json");
    assert.deepEqual(readLatestTestRecord(root), { state: "invalid" });
    fs.unlinkSync(resultPath);

    const target = path.join(root, "do-not-read.json");
    fs.writeFileSync(target, JSON.stringify(validRecord(root)));
    try {
      fs.symlinkSync(target, resultPath);
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("symlinks are unavailable in this environment");
        return;
      }
      throw error;
    }
    assert.deepEqual(readLatestTestRecord(root), { state: "invalid" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
