"use strict";

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
