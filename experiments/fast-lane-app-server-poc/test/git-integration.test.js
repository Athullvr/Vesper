"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createLocalHandlers } = require("../local-handlers");
const { LOCAL_INTENTS } = require("../routing-core");

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

test("local Git handlers execute read-only against the active repository without contacting a remote", async (t) => {
  const cwd = process.cwd();
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    t.skip("the prototype folder is not inside a Git worktree");
    return;
  }

  const handlers = createLocalHandlers({ runGit });
  const branch = await handlers[LOCAL_INTENTS.CURRENT_GIT_BRANCH]({ cwd });
  const status = await handlers[LOCAL_INTENTS.WORKING_TREE_STATUS]({ cwd });
  const upstream = await handlers[LOCAL_INTENTS.BRANCH_UPSTREAM]({ cwd });

  assert.ok(["confirmed", "unknown", "unavailable"].includes(branch.status));
  if (branch.status === "confirmed") assert.equal(typeof branch.value.branch, "string");
  assert.equal(status.status, "confirmed");
  assert.equal(Number.isInteger(status.value.changed), true);
  assert.equal(status.value.changed >= 0, true);
  assert.ok(["confirmed", "unknown", "unavailable"].includes(upstream.status));

  const ahead = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd });
  assert.ok(["confirmed", "stale", "unknown", "unavailable"].includes(ahead.status));
  if (ahead.status === "confirmed" || ahead.status === "stale") {
    assert.equal(Number.isSafeInteger(ahead.value.aheadCount), true);
    assert.match(ahead.summary, /remote was not contacted/u);
  }
});
