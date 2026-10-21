"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TEST_RESULT_FILE = ".fast-lane-test-result.json";
const TEST_RESULT_RECORDER = "vesper-fast-lane-routing-tests";
const SOURCE_FILES = Object.freeze([
  "package.json",
  "app-server-client.js",
  "file-change-approval.js",
  "cli.js",
  "extension.js",
  "routing-core.js",
  "local-handlers.js",
  "session-store.js",
  "terminal-frontend.js",
  "bin/vesper.js",
  "test-evidence.js",
  "test/run-tests.js",
  "test/extension-routing.test.js",
  "test/git-integration.test.js",
  "test/routing-core.test.js",
  "test/local-handlers.test.js",
  "test/test-evidence.test.js",
  "test/routing-evaluation.test.js",
  "test/app-server-client.test.js",
  "test/cli.test.js",
  "test/session-store.test.js",
  "test/terminal-frontend.test.js",
  "test/fixtures/routing-quality-cases.json",
  "test/fixtures/routing-quality-heldout-cases.json",
  "test/fixtures/routing-quality-fingerprints.json",
]);

function currentSourceDigest(root) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of SOURCE_FILES) {
    const sourcePath = path.join(root, relativePath);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) {
      throw new Error("A routing-core source file is not a regular file.");
    }
    const content = fs.readFileSync(sourcePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readLatestTestRecord(root) {
  const recordPath = path.join(root, TEST_RESULT_FILE);
  let stat;
  try {
    stat = fs.lstatSync(recordPath);
  } catch (error) {
    return error.code === "ENOENT" ? { state: "missing" } : { state: "unavailable" };
  }

  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_384) {
    return { state: "invalid" };
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    return { state: "invalid" };
  }

  if (!isValidRecord(record)) return { state: "invalid" };

  try {
    return {
      state: "valid",
      record,
      sourceMatches: record.sourceDigest === currentSourceDigest(root),
    };
  } catch {
    return { state: "unavailable" };
  }
}

function isValidRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.schemaVersion !== 1 || record.recorder !== TEST_RESULT_RECORDER || record.command !== "npm test") return false;
  if (!Number.isInteger(record.exitCode) || !/^[a-f0-9]{64}$/u.test(record.sourceDigest || "")) return false;
  if (!Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.completedAt))) return false;
  if (Date.parse(record.startedAt) > Date.parse(record.completedAt)) return false;

  const summary = record.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  return ["tests", "passed", "failed", "cancelled", "skipped", "todo"].every(
    (key) => Number.isInteger(summary[key]) && summary[key] >= 0
  ) && summary.tests > 0;
}

function writeLatestTestRecord(root, record) {
  const recordPath = path.join(root, TEST_RESULT_FILE);
  const temporaryPath = `${recordPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, recordPath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

module.exports = {
  SOURCE_FILES,
  TEST_RESULT_RECORDER,
  currentSourceDigest,
  readLatestTestRecord,
  writeLatestTestRecord,
};
