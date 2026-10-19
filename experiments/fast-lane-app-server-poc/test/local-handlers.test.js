"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LOCAL_INTENTS } = require("../routing-core");
const { createLocalHandlers, countWorkingTreeEntries } = require("../local-handlers");

const fixedNow = new Date("2026-10-19T12:00:00.000Z");

test("current branch handler returns confirmed Git evidence", async () => {
  const handlers = createLocalHandlers({
    runGit: async (args) => {
      assert.deepEqual(args, ["branch", "--show-current"]);
      return "feature/routing\n";
    },
    now: () => fixedNow,
  });

  const result = await handlers[LOCAL_INTENTS.CURRENT_GIT_BRANCH]({ cwd: "/workspace" });
  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.value, { branch: "feature/routing" });
  assert.equal(result.source.kind, "git");
  assert.equal(result.freshness.observedAt, fixedNow.toISOString());
});

test("detached checkout returns unknown rather than inventing a branch", async () => {
  const handlers = createLocalHandlers({ runGit: async () => "\n", now: () => fixedNow });
  const result = await handlers[LOCAL_INTENTS.CURRENT_GIT_BRANCH]({ cwd: "/workspace" });

  assert.equal(result.status, "unknown");
  assert.equal(result.value, null);
  assert.match(result.summary, /detached/u);
});

test("Git command failure returns unavailable with no fabricated data or raw diagnostics", async () => {
  const handlers = createLocalHandlers({
    runGit: async () => { const error = new Error("secret path diagnostic"); error.code = 128; throw error; },
    now: () => fixedNow,
  });
  const result = await handlers[LOCAL_INTENTS.CURRENT_GIT_BRANCH]({ cwd: "/workspace" });

  assert.equal(result.status, "unavailable");
  assert.equal(result.value, null);
  assert.equal(result.summary.includes("secret path diagnostic"), false);
});

test("working-tree handler reports status counts without retaining paths", async () => {
  const porcelain = " M secret-modified-path\0A  secret-added-path\0?? secret-untracked-path\0 D secret-deleted-path\0R  secret-renamed-path\0old-name\0";
  const handlers = createLocalHandlers({ runGit: async () => porcelain, now: () => fixedNow });
  const result = await handlers[LOCAL_INTENTS.WORKING_TREE_STATUS]({ cwd: "/workspace" });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.value, { clean: false, changed: 5, modified: 1, added: 1, deleted: 1, renamed: 1, untracked: 1 });
  assert.equal(JSON.stringify(result).includes("secret-"), false);
  assert.match(result.summary, /5 changed paths/u);
});

test("clean working tree is reported as confirmed", async () => {
  const handlers = createLocalHandlers({ runGit: async () => "", now: () => fixedNow });
  const result = await handlers[LOCAL_INTENTS.WORKING_TREE_STATUS]({ cwd: "/workspace" });
  assert.equal(result.status, "confirmed");
  assert.equal(result.value.clean, true);
  assert.equal(result.value.changed, 0);
});

test("upstream handler distinguishes configured and absent upstreams", async () => {
  const withUpstream = createLocalHandlers({
    runGit: async (args) => {
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      throw new Error("unexpected git call");
    },
    now: () => fixedNow,
  });
  const configured = await withUpstream[LOCAL_INTENTS.BRANCH_UPSTREAM]({ cwd: "/workspace" });
  assert.equal(configured.status, "confirmed");
  assert.deepEqual(configured.value, { branch: "main", configured: true, upstream: "origin/main" });
  assert.match(configured.summary, /remote was not checked/u);

  const withoutUpstream = createLocalHandlers({
    runGit: async (args) => args[0] === "symbolic-ref" ? "main\n" : "\n",
    now: () => fixedNow,
  });
  const absent = await withoutUpstream[LOCAL_INTENTS.BRANCH_UPSTREAM]({ cwd: "/workspace" });
  assert.equal(absent.status, "confirmed");
  assert.deepEqual(absent.value, { branch: "main", configured: false, upstream: null });
});

test("upstream handler returns unknown on detached HEAD and unavailable on repository failure", async () => {
  const detached = createLocalHandlers({ runGit: async () => { const error = new Error(); error.code = 1; throw error; }, now: () => fixedNow });
  assert.equal((await detached[LOCAL_INTENTS.BRANCH_UPSTREAM]({ cwd: "/workspace" })).status, "unknown");

  const outsideRepo = createLocalHandlers({ runGit: async () => { const error = new Error(); error.code = 128; throw error; }, now: () => fixedNow });
  assert.equal((await outsideRepo[LOCAL_INTENTS.BRANCH_UPSTREAM]({ cwd: "/workspace" })).status, "unavailable");
});

test("ahead count is tied to last-fetched local ref and includes the stale-remote caveat", async () => {
  const updatedSeconds = Math.floor((fixedNow.getTime() - 2 * 24 * 60 * 60 * 1_000) / 1_000);
  const calls = [];
  const handlers = createLocalHandlers({
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      if (args[0] === "rev-list") return "2\n";
      if (args[0] === "reflog") return `${updatedSeconds}\n`;
      throw new Error("unexpected git call");
    },
    now: () => fixedNow,
  });
  const result = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd: "/workspace" });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.value, { branch: "main", upstream: "origin/main", aheadCount: 2 });
  assert.equal(result.freshness.state, "recent");
  assert.match(result.summary, /last fetched upstream reference/u);
  assert.match(result.summary, /remote was not contacted/u);
  assert.equal(calls.some((args) => args[0] === "fetch"), false);
});

test("ahead count is marked stale when its local tracking ref is older than the freshness window", async () => {
  const oldSeconds = Math.floor((fixedNow.getTime() - 9 * 24 * 60 * 60 * 1_000) / 1_000);
  const handlers = createLocalHandlers({
    runGit: async (args) => {
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      if (args[0] === "rev-list") return "0\n";
      if (args[0] === "reflog") return `${oldSeconds}\n`;
      throw new Error("unexpected git call");
    },
    now: () => fixedNow,
  });
  const result = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd: "/workspace" });

  assert.equal(result.status, "stale");
  assert.equal(result.value.aheadCount, 0);
  assert.equal(result.freshness.state, "stale");
  assert.match(result.summary, /9 days ago/u);
  assert.match(result.summary, /remote was not contacted/u);
});

test("ahead count preserves a confirmed local count with unknown reflog freshness", async () => {
  const handlers = createLocalHandlers({
    runGit: async (args) => {
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      if (args[0] === "rev-list") return "3\n";
      if (args[0] === "reflog") throw new Error("reflog unavailable");
      throw new Error("unexpected git call");
    },
    now: () => fixedNow,
  });
  const result = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd: "/workspace" });

  assert.equal(result.status, "confirmed");
  assert.equal(result.value.aheadCount, 3);
  assert.equal(result.freshness.state, "unknown");
  assert.match(result.summary, /age .* could not be established/u);
  assert.match(result.summary, /remote was not contacted/u);
});

test("ahead count is unavailable without upstream or usable commit evidence", async () => {
  const noUpstream = createLocalHandlers({
    runGit: async (args) => args[0] === "symbolic-ref" ? "main\n" : "",
    now: () => fixedNow,
  });
  const absent = await noUpstream[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd: "/workspace" });
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.value, null);

  const badCount = createLocalHandlers({
    runGit: async (args) => {
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      if (args[0] === "rev-list") return "not-a-count";
      throw new Error("unexpected git call");
    },
    now: () => fixedNow,
  });
  const invalid = await badCount[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd: "/workspace" });
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.value, null);
});

test("test-result handler reports unknown when no trusted runner record exists", async () => {
  const handlers = createLocalHandlers({ runGit: async () => "", testResultReader: () => ({ state: "missing" }), now: () => fixedNow });
  const result = await handlers[LOCAL_INTENTS.MOST_RECENT_TEST_RESULT]();
  assert.equal(result.status, "unknown");
  assert.match(result.summary, /No trustworthy .* test record/u);
  assert.equal(result.value, null);
});

test("test-result handler confirms only a matching source snapshot and never turns failure into pass", async () => {
  const record = {
    exitCode: 0,
    completedAt: "2026-10-19T11:00:00.000Z",
    summary: { tests: 12, passed: 12, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
  };
  const current = createLocalHandlers({ runGit: async () => "", testResultReader: () => ({ state: "valid", record, sourceMatches: true }), now: () => fixedNow });
  const passed = await current[LOCAL_INTENTS.MOST_RECENT_TEST_RESULT]();
  assert.equal(passed.status, "confirmed");
  assert.equal(passed.value.passed, true);
  assert.equal(passed.source.scope, "Fast Lane routing-core tests");

  const failedRecord = { ...record, exitCode: 1, summary: { ...record.summary, failed: 1, passed: 11 } };
  const failedHandler = createLocalHandlers({ runGit: async () => "", testResultReader: () => ({ state: "valid", record: failedRecord, sourceMatches: true }), now: () => fixedNow });
  const failed = await failedHandler[LOCAL_INTENTS.MOST_RECENT_TEST_RESULT]();
  assert.equal(failed.status, "confirmed");
  assert.equal(failed.value.passed, false);
  assert.match(failed.summary, /test run failed/u);
});

test("test-result handler labels a different source snapshot stale", async () => {
  const record = {
    exitCode: 0,
    completedAt: "2026-10-19T11:00:00.000Z",
    summary: { tests: 4, passed: 4, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
  };
  const handlers = createLocalHandlers({ runGit: async () => "", testResultReader: () => ({ state: "valid", record, sourceMatches: false }), now: () => fixedNow });
  const result = await handlers[LOCAL_INTENTS.MOST_RECENT_TEST_RESULT]();
  assert.equal(result.status, "stale");
  assert.equal(result.value.passed, true);
  assert.match(result.summary, /does not verify the current/u);
});

test("working-tree count helper handles an empty result", () => {
  assert.deepEqual(countWorkingTreeEntries(""), { changed: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 });
});
