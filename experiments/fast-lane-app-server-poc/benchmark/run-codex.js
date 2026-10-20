Vesper Phase 1D — Authenticated VS Code Integration Validation

Goal

Validate the existing Phase 1A–1C implementation against the actual installed Codex app - server in an isolated, disposable project.This is an integration - validation milestone, not a feature - development milestone.

  Repository:
"experiments/fast-lane-app-server-poc"

Safety requirements

  - Inspect the existing smoke - test procedures and reliability audit first.
- Use a disposable Git project with no remote and a separate Vesper home and Codex home.
- Never reset, overwrite, or modify the user's normal Codex configuration or Vesper sessions.
  - Do not test file - write approvals or permit changes to the disposable project's files in this milestone.
    - Do not print or record credentials, authentication tokens, full prompts, or private model output in diagnostic logs.
- Do not claim a live test passed unless it actually ran and its observable evidence supports the claim.
- If authentication, network access, or the Extension Development Host is unavailable, report the limitation and stop at that boundary.

Validation sequence

1. Environment and isolation

Confirm the installed Codex CLI version and locate the existing VS Code extension test entry point.

Create or reuse an isolated disposable project containing one known text file.Verify that it has no Git remote and that its initial working tree is clean.

Set dedicated "CODEX_HOME" and "VESPER_HOME" directories for the test.Confirm that the existing session store and credentials outside those directories will not be modified.

Use the repository's existing isolation conventions rather than inventing a second setup procedure.

2. Extension startup

Launch the VS Code Extension Development Host if the environment supports it.

Verify that the Vesper panel opens, lists the disposable workspace, and handles an invalid or unavailable workspace cleanly.

If automated UI interaction is unavailable, document the exact manual steps required instead of substituting mocked UI tests for a real run.

3. Read - only task execution

Submit a task asking Vesper to read the known text file without modifying any files.

Verify observable evidence for:

  - Task submission through the extension.
- Correct workspace and project identity.
- Actual app - server turn creation.
- Streaming or final completion.
- Expected file contents in the response, where safe to inspect.

Do not accept a response that merely claims the command ran.Confirm actual runtime events or tool activity.

4. Persistence and history restoration

Close and reopen the panel.Then restart the Extension Development Host if feasible.

Verify that:

- The same saved Vesper session is selected for the same workspace.
- The app - server confirms the same Codex thread ID.
- History restoration returns real persisted turn data.
- Restored messages appear in chronological order.
- Partial or unavailable history is represented honestly.
- Switching to another workspace does not leak the first workspace's messages.

If any check fails, capture sanitized event metadata and the relevant error, without exposing private content.

5. Interruption and recovery

Run a sufficiently long, read - only task and interrupt it using Vesper's Stop control.

Verify that the active turn is interrupted and that the panel remains usable.Resume the saved conversation and submit another read - only task.Confirm whether the same thread continues.

If a genuine disconnect can be induced safely, test reconnect recovery.Do not simulate a successful reconnect solely by emitting mocked success events.

6. Integrity checks

After testing, verify that the disposable project's tracked files are unchanged, the working tree is clean, and the expected fixture still exists.

Run the full test suite, extension - routing tests, JavaScript syntax checks, and "git diff --check".

  Deliverables

Report:

1. Which tests were genuinely live and which remained mocked.
2. Codex CLI version and the tested extension / runtime versions.
3. Whether thread identity survived panel reopening and host restart.
4. Whether real history was restored and in the correct order.
5. Whether interruption and subsequent continuation worked.
6. Filesystem integrity results.
7. Failures, limitations, and the smallest justified next task.

Do not implement pagination, a session picker, or unrelated UI features in this phase.Fix only issues that block safe validation, and keep every change small and test - covered."use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const prototypeRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(prototypeRoot, "../..");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8"));

function makePrompt() {
  const numberedCases = cases.map((entry) => `${entry.id}: ${JSON.stringify(entry.prompt)}`).join("\n");
  return [
    "Answer each numbered question independently using the current project workspace where needed.",
    "Return exactly one JSON object with a `answers` array. Each entry must have `id` and a concise `answer` string.",
    "Use read-only inspection only. Do not edit files or run builds/tests. For coding tasks, provide a short implementation approach without making changes.",
    "For uncertain or ambiguous claims, state what the available evidence cannot establish.",
    "Questions:",
    numberedCases,
  ].join("\n\n");
}

function invokeCodex(trial) {
  const startedAt = performance.now();
  const prompt = makePrompt();
  const command = process.env.CODEX_BIN || "codex";
  const args = [
    "exec", "--sandbox", "read-only", "--ephemeral", "--json", "-C", projectRoot, prompt,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start Codex: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Direct Codex trial ${trial} failed (code=${code}, signal=${signal || "none"}). ${sanitizeError(stderr)}`));
        return;
      }
      try {
        const parsed = parseOutput(stdout);
        resolve({
          trial,
          answer: parsed.answers,
          codexTurnsStarted: parsed.codexTurnsStarted,
          wallTimeMs: Number((performance.now() - startedAt).toFixed(1)),
        });
      } catch (error) {
        reject(new Error(`Direct Codex trial ${trial} returned no parseable answer. ${error.message}`));
      }
    });
  });
}

function parseOutput(output) {
  const messages = [];
  let codexTurnsStarted = 0;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "turn.started") codexTurnsStarted += 1;
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      messages.push(item.text);
    }
  }
  if (!messages.length) throw new Error("No completed agent message was emitted.");
  let text = messages.at(-1).trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced) text = fenced[1];
  const result = JSON.parse(text);
  if (!Array.isArray(result.answers)) throw new Error("The response has no answers array.");
  const answers = new Map(result.answers.map((entry) => [entry.id, entry.answer]));
  const missing = cases.filter((entry) => typeof answers.get(entry.id) !== "string");
  if (missing.length) throw new Error(`Missing answers for ${missing.map((entry) => entry.id).join(", ")}.`);
  return {
    answers: Object.fromEntries(cases.map((entry) => [entry.id, answers.get(entry.id)])),
    codexTurnsStarted,
  };
}

function sanitizeError(errorText) {
  return String(errorText || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ").slice(0, 600);
}

async function main() {
  const trialCount = Number(process.argv[2] || 2);
  if (!Number.isInteger(trialCount) || trialCount < 1 || trialCount > 5) {
    throw new Error("Usage: node benchmark/run-codex.js [trials 1..5]");
  }
  const trials = [];
  for (let trial = 1; trial <= trialCount; trial += 1) {
    trials.push(await invokeCodex(trial));
  }
  const command = process.env.CODEX_BIN || "codex";
  const codexVersion = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  process.stdout.write(`${JSON.stringify({
    benchmark: "direct Codex batched read-only comparison",
    codexVersion,
    casesPerTurn: cases.length,
    trials,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
