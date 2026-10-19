"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  TEST_RESULT_RECORDER,
  currentSourceDigest,
  writeLatestTestRecord,
} = require("../test-evidence");

const root = path.resolve(__dirname, "..");
const testFiles = fs.readdirSync(__dirname)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join("test", file));

const startedAt = new Date().toISOString();
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
const completedAt = new Date().toISOString();
const stdout = run.stdout || "";
const stderr = run.stderr || "";
const exitCode = Number.isInteger(run.status) ? run.status : 1;
const record = {
  schemaVersion: 1,
  recorder: TEST_RESULT_RECORDER,
  command: "npm test",
  startedAt,
  completedAt,
  exitCode,
  summary: parseTapSummary(`${stdout}\n${stderr}`),
  sourceDigest: currentSourceDigest(root),
};

try {
  writeLatestTestRecord(root, record);
} catch (error) {
  process.stderr.write(`Could not record the test result (${error.code || "write error"}).\n`);
  process.exitCode = 1;
}

process.stdout.write(stdout);
process.stderr.write(stderr);
if (run.error) {
  process.stderr.write(`Test runner failed to start (${run.error.code || "spawn error"}).\n`);
  process.exitCode = 1;
} else if (exitCode !== 0 && process.exitCode === undefined) {
  process.exitCode = exitCode;
}

function parseTapSummary(output) {
  const summary = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    const name = key === "pass" ? "passed" : key === "fail" ? "failed" : key;
    summary[name] = match ? Number(match[1]) : 0;
  }
  return summary;
}
