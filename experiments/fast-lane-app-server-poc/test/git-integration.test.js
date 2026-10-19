"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalHandlers } = require("../local-handlers");
const { LOCAL_INTENTS } = require("../routing-core");
const { runVesper } = require("../cli");
const { SessionStore } = require("../session-store");

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

const observedAt = new Date("2026-10-19T12:00:00Z");

async function repository(t, { commitDate = "2001-01-01T00:00:00Z", updateDate = "2026-10-18T12:00:00Z", reflog = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-git-audit-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (args, date = commitDate) => new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd, encoding: "utf8", timeout: 5_000,
      env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Vesper fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Vesper fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  await git(["init", "--initial-branch=main"]);
  await git(["config", "core.logAllRefUpdates", String(reflog)]);
  await git(["commit", "--allow-empty", "-m", "fixture"]);
  // No remote exists or is contacted: only local configuration and refs are made.
  await git(["remote", "add", "origin", path.join(cwd, "unused-remote.git")]);
  await git(["config", "branch.main.remote", "origin"]);
  await git(["config", "branch.main.merge", "refs/heads/main"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], updateDate);
  return { cwd, git };
}

test("real tracking reflogs date the ref update, independently of the commit date", async (t) => {
  for (const scenario of [
    { commitDate: "2001-01-01T00:00:00Z", updateDate: "2026-10-18T12:00:00Z", state: "recent", status: "confirmed" },
    { commitDate: "2026-10-19T00:00:00Z", updateDate: "2026-10-01T12:00:00Z", state: "stale", status: "stale" },
  ]) {
    const { cwd, git } = await repository(t, scenario);
    const oldEvidence = (await git(["reflog", "show", "-1", "--format=%ct", "@{upstream}"])).trim();
    assert.equal(Number(oldEvidence) * 1_000, Date.parse(scenario.commitDate));
    const handlers = createLocalHandlers({ runGit, now: () => observedAt });
    const result = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd });
    assert.equal(result.status, scenario.status);
    assert.equal(result.freshness.state, scenario.state);
    assert.equal(result.freshness.lastUpdatedAt, new Date(scenario.updateDate).toISOString());
    assert.equal(result.value.aheadCount, 0);
    assert.match(result.summary, /remote was not contacted/u);
  }
});

test("real Git missing reflog, absent upstream and detached HEAD retain uncertainty", async (t) => {
  const { cwd, git } = await repository(t, { reflog: false });
  const handlers = createLocalHandlers({ runGit, now: () => observedAt });
  const noLog = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd });
  assert.equal(noLog.value.aheadCount, 0);
  assert.equal(noLog.freshness.state, "unknown");
  await git(["config", "--unset", "branch.main.remote"]);
  const noUpstream = await handlers[LOCAL_INTENTS.AHEAD_OF_UPSTREAM]({ cwd });
  assert.equal(noUpstream.status, "unavailable");
  assert.equal(noUpstream.value, null);
  await git(["checkout", "--detach"]);
  for (const intent of [LOCAL_INTENTS.CURRENT_GIT_BRANCH, LOCAL_INTENTS.BRANCH_UPSTREAM, LOCAL_INTENTS.AHEAD_OF_UPSTREAM]) {
    const result = await handlers[intent]({ cwd });
    assert.equal(result.status, "unknown");
    assert.equal(result.value, null);
  }
});

test("CLI local Git matrix answers from real evidence without spawning Codex or saving a thread", async (t) => {
  const { cwd, git } = await repository(t);
  await git(["commit", "--allow-empty", "-m", "local-only"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "fixture");
  const store = new SessionStore({ directory: path.join(cwd, ".vesper", "sessions") });
  const prompts = [
    "What is the current Git branch?", "Show working-tree status.",
    "What upstream does this branch track?", "How many commits am I ahead of upstream?", ":quit",
  ];
  let text = "";
  let spawns = 0;
  const code = await runVesper(["--new", cwd], {
    store, handlers: createLocalHandlers({ runGit, now: () => observedAt }),
    output: { write: (chunk) => { text += chunk; } },
    errorOutput: { write: (chunk) => assert.fail(chunk) },
    lineIO: { question: async () => prompts.shift(), close() {}, onInterrupt() {} },
    clientOptions: { spawnProcess: () => { spawns += 1; throw new Error("Unexpected Codex spawn"); } },
  });
  assert.equal(code, 0);
  assert.equal(spawns, 0);
  assert.equal((text.match(/no Codex turn · local_exact_match/g) || []).length, 4);
  assert.match(text, /Current Git branch: main/u);
  assert.match(text, /working tree has .* untracked/u);
  assert.match(text, /configured to track origin\/main locally/u);
  assert.match(text, /1 commit ahead of its local upstream reference/u);
  assert.match(text, /updated within the last seven days/u);
  assert.match(text, /remote was not contacted/u);
  const sessionId = text.match(/Vesper session: ([0-9a-f-]+)/u)[1];
  assert.equal(store.load(sessionId).threadId, null);
});
