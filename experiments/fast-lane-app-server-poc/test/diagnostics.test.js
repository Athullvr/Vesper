"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectDiagnostics, renderDiagnostics } = require("../diagnostics");
const { parseArgs, runVesper } = require("../cli");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-diagnostics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function commandRunner(overrides = {}) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (key === "git --version") return { code: 0, stdout: "git version 2.43.0\n" };
    if (key.startsWith("git -C ") && args.at(-1) === "--show-toplevel") return { code: 0, stdout: args[1] };
    if (key === "codex --version") return { code: 0, stdout: "codex-cli 0.162.1\n" };
    if (key === "codex app-server --help") return { code: 0, stdout: "Usage: codex app-server\n" };
    if (key === "code --version") return { code: 0, stdout: "1.135.0\n" };
    return { code: 1, stdout: "" };
  };
}

function capture() {
  let value = "";
  return { stream: { write: (chunk) => { value += String(chunk); } }, text: () => value };
}

test("diagnostics distinguish local availability from authentication and connectivity checks", (t) => {
  const project = fixture(t);
  const calls = [];
  const report = collectDiagnostics({ projectDirectory: project, environment: {},
    commandRunner: (command, args, options) => { calls.push([command, args, options]); return commandRunner()(command, args); } });
  const checks = Object.fromEntries(report.checks.map((entry) => [entry.id, entry]));

  assert.equal(checks.node.status, "available");
  assert.equal(checks["git-metadata"].status, "available");
  assert.equal(checks["codex-cli"].status, "available");
  assert.equal(checks["codex-app-server"].status, "available");
  assert.equal(checks["codex-auth"].status, "not tested");
  assert.equal(checks["selected-provider"].status, "available");
  assert.equal(checks.sandbox.status, "not applicable");
  assert.equal(report.blocking, true, "unknown Codex sign-in is not treated as verified readiness");
  assert.ok(calls.every(([command, args]) => !["fetch", "curl", "wget"].includes(command) && !args.some((arg) => /https?:\/\//u.test(arg))));
  assert.match(renderDiagnostics(report), /Network checks: not performed/u);
  assert.match(renderDiagnostics(report), /Authentication is not tested/u);
});

test("Codex login status is summarized locally without exposing its account text", (t) => {
  const project = fixture(t);
  const accountText = "Logged in using ChatGPT as person@example.invalid";
  const report = collectDiagnostics({ projectDirectory: project, environment: {},
    commandRunner: commandRunner({ "codex login status": { code: 0, stdout: `${accountText}\n` } }) });
  const checks = Object.fromEntries(report.checks.map((entry) => [entry.id, entry]));
  const output = renderDiagnostics(report);

  assert.equal(checks["codex-auth"].status, "available");
  assert.equal(report.blocking, false);
  assert.match(output, /Codex sign-in detected locally/u);
  assert.match(output, /connectivity not tested/u);
  assert.doesNotMatch(output, /person@example\.invalid/u);
});

test("a confirmed local Codex sign-out makes the selected provider actionable", (t) => {
  const project = fixture(t);
  const report = collectDiagnostics({ projectDirectory: project, environment: {},
    commandRunner: commandRunner({ "codex login status": { code: 1, stdout: "Not logged in\n" } }) });
  const checks = Object.fromEntries(report.checks.map((entry) => [entry.id, entry]));

  assert.equal(checks["codex-auth"].status, "unavailable");
  assert.equal(checks["selected-provider"].status, "misconfigured");
  assert.equal(report.blocking, true);
  assert.match(checks["selected-provider"].remediation, /codex login/u);
});

test("OpenAI diagnostics show a present key without printing it or validating it", (t) => {
  const project = fixture(t);
  const secret = "vesper-test-secret-value-should-stay-hidden";
  const report = collectDiagnostics({ projectDirectory: project,
    environment: { VESPER_PROVIDER: "openai-chat-completions", OPENAI_API_KEY: secret, VESPER_OPENAI_MODEL: "test-model",
      VESPER_OPENAI_BASE_URL: "https://provider.example/v1/secret-path-token" },
    commandRunner: commandRunner() });
  const output = renderDiagnostics(report);
  const checks = Object.fromEntries(report.checks.map((entry) => [entry.id, entry]));

  assert.equal(report.effectiveConfiguration.defaultProviderId, "openai-chat-completions");
  assert.equal(checks["selected-provider"].status, "available");
  assert.match(output, /API key present; not validated/u);
  assert.match(output, /endpoint https:\/\/provider\.example/u);
  assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.doesNotMatch(output, /secret-path-token/u);
  assert.doesNotMatch(output, /sk-[A-Za-z0-9_-]{12,}/u);
});

test("failed local command launch is not misreported as a missing installation", (t) => {
  const project = fixture(t);
  const report = collectDiagnostics({ projectDirectory: project, environment: {},
    commandRunner: commandRunner({ "code --version": { code: 0, errorCode: "EPERM", stdout: "" } }) });
  const codeCheck = report.checks.find((entry) => entry.id === "vscode-cli");

  assert.equal(codeCheck.status, "not tested");
  assert.match(codeCheck.summary, /could not run in this environment/u);
});

test("setup and doctor parsing accepts provider and project options without changing provider state", () => {
  assert.deepEqual(parseArgs(["setup", "--provider", "nvidia-nim"]), {
    command: "setup", providerId: "nvidia-nim", help: false,
  });
  assert.deepEqual(parseArgs(["doctor", "--project", "/workspace"]), {
    command: "doctor", projectDirectory: "/workspace", help: false,
  });
  assert.throws(() => parseArgs(["setup", "--provider", "unknown"]), /Unknown provider/u);
  assert.throws(() => parseArgs(["doctor", "--project"]), /Usage: vesper doctor/u);
});

test("non-interactive setup reports provider-specific remediation and redacts key values", async (t) => {
  const project = fixture(t);
  const secret = "vesper-test-secret-value-should-stay-hidden";
  const output = capture();
  const errors = capture();
  const status = await runVesper(["setup", "--provider", "openai-chat-completions"], {
    environment: { OPENAI_API_KEY: secret }, projectDirectory: project,
    diagnosticOptions: { commandRunner: commandRunner() },
    output: output.stream, errorOutput: errors.stream,
  });

  assert.equal(status, 1);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /VESPER_OPENAI_MODEL/u);
  assert.match(output.text(), /OPENAI_API_KEY/u);
  assert.match(output.text(), /Default provider for new sessions: codex-app-server/u);
  assert.match(output.text(), /- openai-chat-completions: misconfigured/u);
  assert.doesNotMatch(output.text(), new RegExp(secret, "u"));
  assert.match(output.text(), /edit shell files/u);
});

test("interactive setup reviews a chosen provider without persisting it as the default", async (t) => {
  const project = fixture(t);
  const environment = {};
  const output = { isTTY: true, write: (chunk) => { text += String(chunk); } };
  const errors = capture();
  let text = "";
  let closed = false;
  const status = await runVesper(["setup"], {
    environment, projectDirectory: project,
    input: { isTTY: true }, output, errorOutput: errors.stream,
    setupReadlineFactory: () => ({ question: async () => "2", close: () => { closed = true; } }),
    diagnosticOptions: { commandRunner: commandRunner() },
  });

  assert.equal(status, 1);
  assert.equal(closed, true);
  assert.equal(environment.VESPER_PROVIDER, undefined);
  assert.match(text, /Provider under review: openai-chat-completions/u);
  assert.match(text, /Default provider for new sessions: codex-app-server/u);
  assert.equal(errors.text(), "");
});

test("doctor returns nonzero for an unavailable selected provider and reports the check", async (t) => {
  const project = fixture(t);
  const output = capture();
  const errors = capture();
  const status = await runVesper(["doctor", "--project", project], {
    environment: {}, projectDirectory: project,
    diagnosticOptions: { commandRunner: commandRunner({
      "codex --version": { code: 1, stdout: "" },
    }) },
    output: output.stream, errorOutput: errors.stream,
  });

  assert.equal(status, 1);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /\[unavailable\] selected-provider: Codex app-server is unavailable/u);
  assert.match(output.text(), /Install the Codex CLI/u);
});
