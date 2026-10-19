"use strict";

const { LOCAL_INTENTS, createLocalResult } = require("./routing-core");
const { readLatestTestRecord } = require("./test-evidence");

const UPSTREAM_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const REMOTE_UNCHECKED_CAVEAT = "Only local Git references were inspected; the remote was not contacted and may have changed since the last fetch.";

function createLocalHandlers({ runGit, testResultReader, now = () => new Date() }) {
  if (typeof runGit !== "function") throw new TypeError("runGit must be a function.");
  const readTestResult = testResultReader || (() => readLatestTestRecord(__dirname));

  return {
    [LOCAL_INTENTS.CURRENT_GIT_BRANCH]: async ({ cwd } = {}) => {
      const observedAt = now().toISOString();
      try {
        const branch = (await runGit(["branch", "--show-current"], cwd)).trim();
        if (!branch) {
          return createLocalResult({
            intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
            status: "unknown",
            summary: "The current checkout does not have a named branch (it may be detached).",
            evidence: ["git branch --show-current returned no branch name."],
            source: { kind: "git", command: "git branch --show-current", scope: "active workspace" },
            freshness: { state: "observed", observedAt },
          });
        }

        return createLocalResult({
          intent: LOCAL_INTENTS.CURRENT_GIT_BRANCH,
          status: "confirmed",
          value: { branch },
          summary: `Current Git branch: ${branch}`,
          evidence: ["git branch --show-current returned the branch name."],
          source: { kind: "git", command: "git branch --show-current", scope: "active workspace" },
          freshness: { state: "observed", observedAt },
        });
      } catch (error) {
        return unavailableGitResult(LOCAL_INTENTS.CURRENT_GIT_BRANCH, "Current branch could not be read.", error, now);
      }
    },

    [LOCAL_INTENTS.WORKING_TREE_STATUS]: async ({ cwd } = {}) => {
      const observedAt = now().toISOString();
      try {
        const output = await runGit(["status", "--porcelain=v1", "-z"], cwd);
        const counts = countWorkingTreeEntries(output);
        const clean = counts.changed === 0;
        return createLocalResult({
          intent: LOCAL_INTENTS.WORKING_TREE_STATUS,
          status: "confirmed",
          value: { clean, ...counts },
          summary: clean
            ? "The Git working tree is clean."
            : `The Git working tree has ${counts.changed} changed path${counts.changed === 1 ? "" : "s"} (${counts.modified} modified, ${counts.added} added, ${counts.deleted} deleted, ${counts.renamed} renamed, ${counts.untracked} untracked).`,
          evidence: ["Counts were derived from git status --porcelain=v1 -z; path names were not retained."],
          source: { kind: "git", command: "git status --porcelain=v1 -z", scope: "active workspace" },
          freshness: { state: "observed", observedAt },
        });
      } catch (error) {
        return unavailableGitResult(LOCAL_INTENTS.WORKING_TREE_STATUS, "Working-tree status could not be read.", error, now);
      }
    },

    [LOCAL_INTENTS.BRANCH_UPSTREAM]: async ({ cwd } = {}) => {
      const observedAt = now().toISOString();
      try {
        const { branch, upstream } = await readCurrentUpstream(runGit, cwd);
        if (!branch) {
          return createLocalResult({
            intent: LOCAL_INTENTS.BRANCH_UPSTREAM,
            status: "unknown",
            summary: "There is no current branch whose upstream can be checked (the checkout may be detached).",
            evidence: ["git symbolic-ref --quiet --short HEAD returned no branch."],
            source: { kind: "git", command: "git symbolic-ref and git for-each-ref", scope: "active workspace" },
            freshness: { state: "local_configuration", observedAt, caveat: "No remote was contacted." },
          });
        }

        if (!upstream) {
          return createLocalResult({
            intent: LOCAL_INTENTS.BRANCH_UPSTREAM,
            status: "confirmed",
            value: { branch, configured: false, upstream: null },
            summary: `Branch ${branch} has no upstream configured locally.`,
            evidence: ["git for-each-ref returned an empty upstream for the current local branch."],
            source: { kind: "git", command: "git for-each-ref --format=%(upstream:short)", scope: "local branch configuration" },
            freshness: { state: "local_configuration", observedAt, caveat: "No remote was contacted." },
          });
        }

        return createLocalResult({
          intent: LOCAL_INTENTS.BRANCH_UPSTREAM,
          status: "confirmed",
          value: { branch, configured: true, upstream },
          summary: `Branch ${branch} is configured to track ${upstream} locally. The remote was not checked.`,
          evidence: ["git for-each-ref returned the configured upstream for the current local branch."],
          source: { kind: "git", command: "git for-each-ref --format=%(upstream:short)", scope: "local branch configuration" },
          freshness: { state: "local_configuration", observedAt, caveat: "The remote was not contacted." },
        });
      } catch (error) {
        return unavailableGitResult(LOCAL_INTENTS.BRANCH_UPSTREAM, "The local upstream configuration could not be read.", error, now);
      }
    },

    [LOCAL_INTENTS.AHEAD_OF_UPSTREAM]: async ({ cwd } = {}) => {
      const observedAt = now();
      try {
        const { branch, upstream } = await readCurrentUpstream(runGit, cwd);
        if (!branch) {
          return createLocalResult({
            intent: LOCAL_INTENTS.AHEAD_OF_UPSTREAM,
            status: "unknown",
            summary: "There is no current branch to compare with an upstream reference.",
            evidence: ["The current checkout has no symbolic local branch."],
            source: { kind: "git", command: "git symbolic-ref and git rev-list", scope: "local repository" },
            freshness: { state: "unknown", observedAt: observedAt.toISOString(), caveat: REMOTE_UNCHECKED_CAVEAT },
          });
        }
        if (!upstream) {
          return createLocalResult({
            intent: LOCAL_INTENTS.AHEAD_OF_UPSTREAM,
            status: "unavailable",
            summary: `Branch ${branch} has no upstream configured, so an ahead count is unavailable.`,
            evidence: ["No local upstream tracking reference is configured."],
            source: { kind: "git", command: "git for-each-ref and git rev-list", scope: "local repository" },
            freshness: { state: "unknown", observedAt: observedAt.toISOString(), caveat: REMOTE_UNCHECKED_CAVEAT },
          });
        }

        const countText = (await runGit(["rev-list", "--count", "@{upstream}..HEAD"], cwd)).trim();
        if (!/^\d+$/u.test(countText)) throw new Error("invalid rev-list count");
        const aheadCount = Number(countText);
        if (!Number.isSafeInteger(aheadCount)) throw new Error("invalid rev-list count");

        const freshness = await getUpstreamFreshness(runGit, cwd, observedAt);
        const status = freshness.state === "stale" ? "stale" : "confirmed";
        const ageDescription = freshness.state === "stale"
          ? ` The local tracking reference was last updated ${formatAge(observedAt.getTime() - Date.parse(freshness.lastUpdatedAt))} ago.`
          : freshness.state === "unknown"
            ? " The age of the local tracking reference could not be established."
            : " The local tracking reference was updated within the last seven days.";
        const summary = `This branch is ${aheadCount} commit${aheadCount === 1 ? "" : "s"} ahead of its local upstream reference.${ageDescription} ${REMOTE_UNCHECKED_CAVEAT}`;

        return createLocalResult({
          intent: LOCAL_INTENTS.AHEAD_OF_UPSTREAM,
          status,
          value: { branch, upstream, aheadCount },
          summary,
          evidence: [
            "The ahead count came from git rev-list --count @{upstream}..HEAD.",
            freshness.state === "unknown"
              ? "No usable upstream reflog entry timestamp was available."
              : "The local ref update time came from git reflog show -1 --format=%gD --date=raw @{upstream}.",
          ],
          source: { kind: "git", command: "git rev-list --count @{upstream}..HEAD", scope: "local refs only" },
          freshness: { ...freshness, observedAt: observedAt.toISOString(), caveat: REMOTE_UNCHECKED_CAVEAT },
        });
      } catch (error) {
        return unavailableGitResult(LOCAL_INTENTS.AHEAD_OF_UPSTREAM, "The local ahead count could not be computed.", error, now);
      }
    },

    [LOCAL_INTENTS.MOST_RECENT_TEST_RESULT]: async () => {
      const observedAt = now().toISOString();
      let evidence;
      try {
        evidence = readTestResult();
      } catch {
        evidence = { state: "unavailable" };
      }

      if (evidence?.state === "missing") {
        return createLocalResult({
          intent: LOCAL_INTENTS.MOST_RECENT_TEST_RESULT,
          status: "unknown",
          summary: "No trustworthy Fast Lane routing-core test record is available.",
          evidence: ["The local Node test runner has not recorded a result for this prototype."],
          source: { kind: "test_runner", command: "npm test", scope: "Fast Lane prototype tests" },
          freshness: { state: "unknown", observedAt },
        });
      }
      if (evidence?.state !== "valid") {
        return createLocalResult({
          intent: LOCAL_INTENTS.MOST_RECENT_TEST_RESULT,
          status: "unavailable",
          summary: "The recorded test result could not be verified.",
          evidence: ["The test record was unreadable, malformed, or incomplete."],
          source: { kind: "test_runner", command: "npm test", scope: "Fast Lane prototype tests" },
          freshness: { state: "unknown", observedAt },
        });
      }

      const { record, sourceMatches } = evidence;
      const passed = record.exitCode === 0 && record.summary.failed === 0 && record.summary.cancelled === 0;
      const outcome = passed ? "passed" : "failed";
      const status = sourceMatches ? "confirmed" : "stale";
      const sourceNote = sourceMatches
        ? "The recorded source fingerprint matches the current Fast Lane prototype and test files."
        : "The recorded test run used a different source fingerprint and does not verify the current Fast Lane prototype files.";
      return createLocalResult({
        intent: LOCAL_INTENTS.MOST_RECENT_TEST_RESULT,
        status,
        value: {
          passed,
          tests: record.summary.tests,
          failed: record.summary.failed,
          skipped: record.summary.skipped,
          exitCode: record.exitCode,
          completedAt: record.completedAt,
        },
        summary: `Most recent recorded Fast Lane prototype test run ${outcome}: ${record.summary.passed} passed, ${record.summary.failed} failed, ${record.summary.skipped} skipped (exit code ${record.exitCode}) at ${record.completedAt}. ${sourceNote}`,
        evidence: ["The result was recorded by the prototype's Node test runner.", sourceNote],
        source: { kind: "test_runner", command: "npm test", scope: "Fast Lane prototype tests" },
        freshness: {
          state: sourceMatches ? "same_source_snapshot" : "stale",
          observedAt,
          lastUpdatedAt: record.completedAt,
        },
      });
    },
  };
}

async function readCurrentUpstream(runGit, cwd) {
  let branch;
  try {
    branch = (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)).trim();
  } catch (error) {
    if (error.code === 1) return { branch: "", upstream: "" };
    throw error;
  }
  if (!branch) return { branch: "", upstream: "" };
  const upstream = (await runGit(["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`], cwd)).trim();
  return { branch, upstream };
}

async function getUpstreamFreshness(runGit, cwd, observedAt) {
  try {
    // %ct dates the commit, not the ref update. %gD is the reflog selector;
    // an explicit --date=raw makes its suffix @{<entry epoch> <timezone>}.
    // Ask Git rather than reading .git/logs (worktrees and ref backends vary).
    const selector = (await runGit(["reflog", "show", "-1", "--format=%gD", "--date=raw", "@{upstream}"], cwd)).trim();
    const match = /^refs\/[^\s{}]+@\{(\d+) [+-]\d{4}\}$/u.exec(selector);
    if (!match) return { state: "unknown" };
    const timestamp = Number(match[1]) * 1_000;
    if (!Number.isSafeInteger(timestamp) || timestamp > observedAt.getTime() + 60 * 60 * 1_000) return { state: "unknown" };
    const lastUpdatedAt = new Date(timestamp).toISOString();
    return {
      state: observedAt.getTime() - timestamp > UPSTREAM_FRESHNESS_WINDOW_MS ? "stale" : "recent",
      lastUpdatedAt,
    };
  } catch {
    return { state: "unknown" };
  }
}

function countWorkingTreeEntries(output) {
  const entries = String(output || "").split("\0");
  const counts = { changed: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    counts.changed += 1;
    if (status === "??") counts.untracked += 1;
    else if (status.includes("R") || status.includes("C")) counts.renamed += 1;
    else if (status.includes("D")) counts.deleted += 1;
    else if (status.includes("A")) counts.added += 1;
    else counts.modified += 1;

    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return counts;
}

function unavailableGitResult(intent, summary, error, now) {
  const reason = error?.code === "ENOENT"
    ? "Git is unavailable."
    : error?.killed
      ? "The Git command timed out."
      : "The Git command failed; no local answer was produced.";
  return createLocalResult({
    intent,
    status: "unavailable",
    value: null,
    summary: `${summary} ${reason}`,
    evidence: ["The local Git command did not return usable evidence."],
    source: { kind: "git", scope: "active workspace" },
    freshness: { state: "unknown", observedAt: now().toISOString() },
  });
}

function formatAge(ageMs) {
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1_000));
  if (days === 0) return "less than one day";
  return `${days} day${days === 1 ? "" : "s"}`;
}

module.exports = {
  UPSTREAM_FRESHNESS_WINDOW_MS,
  createLocalHandlers,
  countWorkingTreeEntries,
  readCurrentUpstream,
};
