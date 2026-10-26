"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DEFAULT_PROVIDER_ID, getProviderStatus, listProviders, resolveDefaultProviderId } = require("./execution-provider");
const { redactSensitiveText } = require("./command-activity");

const PACKAGE_ROOT = __dirname;
const MIN_NODE_MAJOR = 18;

function collectDiagnostics({
  projectDirectory = process.cwd(),
  providerId: providerOverride = null,
  environment = process.env,
  nodeVersion = process.versions.node,
  platform = process.platform,
  commandRunner = runLocalCommand,
  filesystem = fs,
} = {}) {
  const env = environment && typeof environment === "object" ? environment : {};
  const selectedProviderId = resolveDefaultProviderId(env);
  const providerId = providerOverride || selectedProviderId;
  const checks = [];
  const nodeMajor = Number(String(nodeVersion).split(".")[0]);
  const nodeAvailable = Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR;
  checks.push(check("node", nodeAvailable ? "available" : "unavailable",
    `Node.js ${cleanVersion(nodeVersion)}${nodeAvailable ? " meets" : " does not meet"} the required >=${MIN_NODE_MAJOR} runtime.`,
    nodeAvailable ? null : `Install Node.js ${MIN_NODE_MAJOR} or newer and retry.`));

  const gitVersion = commandVersion(commandRunner, "git", ["--version"]);
  checks.push(check("git-cli", gitVersion.state,
    gitVersion.state === "available" ? `${gitVersion.version} is available.` : gitVersion.state === "unavailable" ? "Git was not found on PATH." : "The Git version check could not run in this environment.",
    gitVersion.state === "unavailable" ? "Install Git and make sure git is on PATH." : gitVersion.state === "not tested" ? "Run `git --version` in a normal terminal and retry vesper doctor." : null));

  const project = inspectProject(projectDirectory, filesystem);
  checks.push(check("project", project.available ? "available" : "unavailable",
    project.available ? `Project directory is accessible: ${project.path}` : "Project directory is unavailable.",
    project.available ? null : "Pass an existing project directory with --project PATH."));

  let gitMetadata = { status: "not applicable", root: null };
  if (project.available && gitVersion.state === "available") {
    const result = runSafely(commandRunner, "git", ["-C", project.path, "rev-parse", "--show-toplevel"]);
    gitMetadata = result.code === 0
      ? { status: "available", root: cleanText(result.stdout.trim()).slice(0, 1_000) }
      : result.errorCode && result.errorCode !== "ENOENT" ? { status: "not tested", root: null } : { status: "unavailable", root: null };
  } else if (project.available && gitVersion.state === "not tested") {
    gitMetadata = { status: "not tested", root: null };
  }
  checks.push(check("git-metadata", gitMetadata.status,
    gitMetadata.status === "available" ? `Git metadata is available at ${gitMetadata.root}.`
      : gitMetadata.status === "unavailable" ? "This project has no accessible Git metadata; filesystem inspection can still run."
        : gitMetadata.status === "not tested" ? "Git metadata could not be checked in this environment."
          : "Git metadata was not checked because the project or Git CLI is unavailable.",
    gitMetadata.status === "unavailable" ? "Run git init in the project if you want Git status, history, and diff evidence." : null));

  const codexVersion = commandVersion(commandRunner, "codex", ["--version"]);
  checks.push(check("codex-cli", codexVersion.state,
    codexVersion.state === "available" ? `${codexVersion.version} is available.` : codexVersion.state === "unavailable" ? "Codex CLI was not found on PATH." : "The Codex CLI version check could not run in this environment.",
    codexVersion.state === "unavailable" ? "Install the Codex CLI and make sure codex is on PATH. Codex-backed tasks require it." : codexVersion.state === "not tested" ? "Run `codex --version` in a normal terminal and retry vesper doctor." : null));
  const codexAppServer = codexVersion.state === "available"
    ? runSafely(commandRunner, "codex", ["app-server", "--help"])
    : { code: null };
  const appServerState = codexVersion.state === "unavailable" ? "not applicable"
    : codexVersion.state === "not tested" ? "not tested"
      : codexAppServer.code === 0 && !codexAppServer.errorCode ? "available"
        : codexAppServer.errorCode && codexAppServer.errorCode !== "ENOENT" ? "not tested" : "unavailable";
  checks.push(check("codex-app-server", appServerState,
    appServerState === "available" ? "Codex app-server help completed locally; no thread or provider connection was started."
      : appServerState === "unavailable" ? "Codex CLI is present, but `codex app-server --help` did not complete successfully."
        : appServerState === "not tested" ? "The Codex app-server check could not run in this environment."
          : "Codex app-server is not applicable until the Codex CLI is installed.",
    appServerState === "unavailable" ? "Update or reinstall the Codex CLI, then retry vesper doctor."
      : appServerState === "not tested" ? "Run `codex app-server --help` in a normal terminal and retry vesper doctor." : null));
  const codexLoginResult = codexVersion.state === "available"
    ? runSafely(commandRunner, "codex", ["login", "status"])
    : { code: null };
  const codexAuth = detectCodexAuthentication(codexLoginResult, codexVersion.state);
  checks.push(check("codex-auth", codexAuth.state, codexAuth.summary, codexAuth.remediation));

  const providers = listProviders().map((provider) => {
    let status;
    try { status = getProviderStatus(provider.id, env); }
    catch (error) {
      return { id: provider.id, name: provider.name, state: "misconfigured", selected: provider.id === selectedProviderId,
        model: null, keyConfigured: false, messages: [cleanText(error?.message || "Provider configuration is invalid.")] };
    }
    if (provider.id === "codex-app-server") {
      const state = appServerState === "not applicable" ? "unavailable"
        : codexAuth.state === "unavailable" ? "misconfigured" : appServerState;
      return { id: provider.id, name: provider.name, selected: provider.id === selectedProviderId,
        state, model: null, keyConfigured: null, authState: codexAuth.state,
        messages: codexAuth.state === "unavailable" ? ["Run `codex login` to sign in; Codex does not require a separate API key."]
          : [] };
    }
    const hasAnySettings = Boolean(status.apiKeyConfigured || status.model);
    const state = status.configured ? "available"
      : provider.id === selectedProviderId || provider.id === providerId || hasAnySettings ? "misconfigured" : "not applicable";
    return { id: provider.id, name: provider.name, selected: provider.id === selectedProviderId,
      state, model: status.model || null, keyConfigured: status.apiKeyConfigured === true,
      endpoint: endpointOrigin(status.baseUrl), messages: state === "misconfigured" ? [...(status.configurationMessages || [])] : [] };
  });

  const selected = providers.find((provider) => provider.id === providerId);
  if (!selected) {
    checks.push(check("selected-provider", "misconfigured",
      `Provider ${cleanText(providerId)} is not supported by this Vesper build.`,
      `Choose one of: ${providers.map(({ id }) => id).join(", ")}.`));
  } else {
    const state = selected.state === "not applicable" ? "misconfigured" : selected.state;
    const authText = selected.id === "codex-app-server"
      ? codexAuth.state === "available" ? "Codex CLI reports a local sign-in; provider connectivity is not tested."
        : codexAuth.state === "unavailable" ? "Codex CLI reports that no sign-in is configured."
          : "Authentication is not tested."
      : selected.keyConfigured ? "API key is present; credential validity is not tested." : "API key is missing.";
    const details = selected.messages.length ? ` ${selected.messages.join("; ")}.` : "";
    const remediation = state === "misconfigured" && selected.id === "codex-app-server" && codexAuth.state === "unavailable" ? "Run `codex login` and retry vesper doctor."
      : state === "misconfigured" ? `Run vesper setup --provider ${selected.id} and follow its environment-variable guidance.`
      : state === "unavailable" ? selected.id === "codex-app-server" ? "Install the Codex CLI, then retry." : `Configure ${selected.id} and retry.` : null;
    checks.push(check("selected-provider", state,
      `${selected.name} is ${state}.${selected.id === "codex-app-server" ? " " : ` Model: ${selected.model || "not configured"}. `}${authText}${details}`,
      remediation));
  }

  const extensionPackage = readExtensionPackage(filesystem);
  const codeVersion = commandVersion(commandRunner, "code", ["--version"]);
  checks.push(check("vscode-package", extensionPackage.available ? "available" : "unavailable",
    extensionPackage.available ? `Extension entry point and VS Code engine declaration are present (requires VS Code ${extensionPackage.vscodeEngine}).`
      : "The extension entry point or VS Code engine declaration is missing.",
    extensionPackage.available ? null : "Restore package.json and extension.js from the Vesper distribution."));
  checks.push(check("vscode-cli", codeVersion.state,
    codeVersion.state === "available" ? `${codeVersion.version} is available; extension activation was not tested.`
      : codeVersion.state === "unavailable" ? "The VS Code CLI was not found; terminal use is unaffected."
        : "The VS Code CLI check could not run in this environment; extension activation was not tested.",
    codeVersion.state === "unavailable" ? "Install VS Code and make its `code` command available if you want to use the extension."
      : codeVersion.state === "not tested" ? "Run `code --version` in a normal terminal to check the optional VS Code CLI." : null));
  checks.push(check("vscode-activation", "not tested",
    "The extension host was not launched by diagnostics.",
    "Open the extension in a VS Code Extension Development Host to validate activation."));

  const commandExecutionEnabled = env.VESPER_ENABLE_ISOLATED_COMMANDS === "1";
  const sandboxImageConfigured = typeof env.VESPER_SANDBOX_IMAGE === "string" && Boolean(env.VESPER_SANDBOX_IMAGE.trim());
  checks.push(check("sandbox", commandExecutionEnabled ? "not tested" : "not applicable",
    commandExecutionEnabled
      ? `Sandbox command execution is opted in${sandboxImageConfigured ? " and an image is configured" : " without an image setting"}; Podman and container isolation were not checked.`
      : "Sandbox command execution is disabled. No sandbox was validated.",
    commandExecutionEnabled
      ? "Run `vesper tools status` to inspect local Podman and the configured image. This does not run a project command."
      : "Sandbox execution is optional and off by default. If you enable it, run `vesper tools status` before use."));

  const localOnly = env.VESPER_LOCAL_ONLY === "1";
  const modelAssisted = env.VESPER_SYSTEM_MODEL_ASSISTED === "1" && !localOnly;
  const effectiveConfiguration = Object.freeze({
    defaultProviderId: selectedProviderId,
    providerUnderReview: providerId,
    localOnly,
    modelAssistedInvestigation: modelAssisted,
    selectedProvider: selected || null,
    openai: providers.find((provider) => provider.id === "openai-chat-completions"),
    nvidia: providers.find((provider) => provider.id === "nvidia-nim"),
    commandExecutionEnabled,
    sandboxImageConfigured,
    env: Object.freeze({
      provider: String(env.VESPER_PROVIDER || "(default: codex-app-server)"),
      localOnly: localOnly ? "1" : "0",
      modelAssisted: env.VESPER_SYSTEM_MODEL_ASSISTED === "1" ? "1" : "0",
    }),
  });
  const blocking = checks.some((item) => item.status === "unavailable" && ["node", "git-cli", "project", "selected-provider"].includes(item.id) ||
    item.status === "misconfigured" && item.id === "selected-provider" ||
    item.status === "not tested" && ["git-cli", "selected-provider"].includes(item.id)) ||
    providerId === DEFAULT_PROVIDER_ID && codexAuth.state !== "available";

  return Object.freeze({
    checkedAt: new Date().toISOString(),
    platform,
    selectedProviderId,
    providerUnderReview: providerId,
    providers: Object.freeze(providers.map((provider) => Object.freeze(provider))),
    checks: Object.freeze(checks.map((item) => Object.freeze(item))),
    effectiveConfiguration,
    blocking,
  });
}

function renderDiagnostics(report) {
  const lines = ["Vesper diagnostics", `Platform: ${cleanText(report.platform)}`, "Network checks: not performed.", ""];
  for (const item of report.checks) {
    lines.push(`[${item.status}] ${item.id}: ${item.summary}`);
    if (item.remediation) lines.push(`  Remediation: ${item.remediation.replace(/\u001b\[[0-9;]*m/gu, "")}`);
  }
  lines.push("", "Provider configuration (secret values hidden):");
  for (const provider of report.providers) {
    const selected = provider.id === report.selectedProviderId ? " · default" : "";
    const model = provider.model ? ` · model ${cleanText(provider.model)}` : "";
    const endpoint = provider.endpoint ? ` · endpoint ${cleanText(provider.endpoint)}` : "";
    const key = provider.id === "codex-app-server"
      ? ` · Codex sign-in ${provider.authState === "available" ? "detected locally; connectivity not tested" : provider.authState === "unavailable" ? "not configured" : "not tested"}`
      : ` · API key ${provider.keyConfigured ? "present; not validated" : "missing"}`;
    lines.push(`- ${provider.id}: ${provider.state}${selected}${model}${endpoint}${key}`);
    for (const message of provider.messages) lines.push(`  Configuration: ${message}`);
  }
  const config = report.effectiveConfiguration;
  lines.push("", "Effective settings (secret values hidden):");
  lines.push(`- Default provider: ${cleanText(config.defaultProviderId)}`);
  lines.push(`- Local-only inspection mode: ${config.localOnly ? "enabled" : "disabled"}`);
  lines.push(`- Model-assisted repository planning: ${config.modelAssistedInvestigation ? "enabled where supported" : "disabled"}`);
  lines.push(`- Sandboxed command execution: ${config.commandExecutionEnabled ? "opted in; not validated" : "disabled"}`);
  lines.push("", "Use `vesper providers status --provider openai-chat-completions --check` or `--provider nvidia-nim --check` only when you explicitly want a network connectivity check.");
  return `${lines.join("\n")}\n`;
}

function check(id, status, summary, remediation = null) {
  return { id, status, summary: cleanText(summary), remediation: remediation ? cleanText(remediation) : null };
}

function inspectProject(requested, filesystem) {
  try {
    const realPath = filesystem.realpathSync(path.resolve(requested));
    if (!filesystem.statSync(realPath).isDirectory()) return { available: false, path: null };
    return { available: true, path: realPath };
  } catch { return { available: false, path: null }; }
}

function readExtensionPackage(filesystem) {
  try {
    const manifest = JSON.parse(filesystem.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    const mainPath = path.resolve(PACKAGE_ROOT, manifest.main || "");
    const engine = manifest.engines?.vscode;
    if (!engine || !manifest.main || !mainPath.startsWith(`${PACKAGE_ROOT}${path.sep}`) || !filesystem.statSync(mainPath).isFile()) {
      return { available: false, vscodeEngine: null };
    }
    return { available: true, vscodeEngine: cleanText(engine) };
  } catch { return { available: false, vscodeEngine: null }; }
}

function commandVersion(commandRunner, command, args) {
  const result = runSafely(commandRunner, command, args);
  if (result.code !== 0 || result.errorCode) {
    return { state: result.errorCode === "ENOENT" ? "unavailable" : result.errorCode ? "not tested" : "unavailable", version: null };
  }
  const first = String(result.stdout || "").trim().split(/\r?\n/u)[0] || "available";
  return { state: "available", version: cleanText(first).slice(0, 100) };
}

function endpointOrigin(value) {
  try { return new URL(value).origin; }
  catch { return value === "invalid" ? "invalid" : null; }
}

function detectCodexAuthentication(result, cliState) {
  if (cliState === "unavailable") return { state: "not applicable", summary: "Codex sign-in cannot be checked until the Codex CLI is installed.", remediation: "Install the Codex CLI before configuring the Codex provider." };
  if (cliState !== "available" || result.errorCode || result.code === null) {
    return { state: "not tested", summary: "Codex sign-in could not be checked locally. No provider connection was attempted.", remediation: "Run `codex login status`; if signed out, use `codex login`." };
  }
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  if (/not logged in|not authenticated|no authentication|not signed in/u.test(text)) {
    return { state: "unavailable", summary: "Codex CLI reports that no local sign-in is configured. No provider connection was attempted.", remediation: "Run `codex login`, then retry vesper doctor." };
  }
  if (/logged in|authenticated|signed in/u.test(text)) {
    return { state: "available", summary: "Codex CLI reports a local sign-in. This does not verify provider connectivity.", remediation: null };
  }
  return { state: "not tested", summary: "Codex login status returned an unrecognized response. No provider connection was attempted.", remediation: "Run `codex login status` manually; if signed out, use `codex login`." };
}

function runSafely(commandRunner, command, args) {
  try {
    const result = commandRunner(command, args, { timeout: 5_000, maxBuffer: 64 * 1024 });
    return result && typeof result === "object" ? result : { code: null, stdout: "" };
  } catch { return { code: null, stdout: "" }; }
}

function runLocalCommand(command, args, { timeout = 5_000, maxBuffer = 64 * 1024 } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer, windowsHide: true });
  return { code: Number.isInteger(result.status) ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    errorCode: result.error?.code || null };
}

function cleanVersion(value) {
  return cleanText(value).replace(/[^0-9A-Za-z.+_-]/gu, "").slice(0, 80) || "unknown";
}

function cleanText(value) {
  return redactSensitiveText(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").trim().slice(0, 2_048);
}

module.exports = { collectDiagnostics, renderDiagnostics, runLocalCommand };
