"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline/promises");
const {
  DEFAULT_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  createExecutionProvider,
  getProviderStatus,
  listProviders,
  resolveDefaultProviderId,
} = require("./execution-provider");
const { createLocalHandlers } = require("./local-handlers");
const { MAX_SESSION_LIST_ENTRIES, SessionStore, defaultSessionDirectory } = require("./session-store");
const { discoverMcp, discoverPlugins, discoverSkills, renderDiscovery, runCodexCommand } = require("./integration-discovery");
const {
  buildCapabilityCatalog,
  createCapabilityProvider,
  findCapability,
  renderCapability,
  renderCapabilityList,
  renderCatalogStatus,
  searchCapabilities,
} = require("./capability-catalog");
const { runCapabilityOperation } = require("./capability-management");
const { createCodexRuntimeStatusAdapter } = require("./codex-runtime-status");
const { createCapabilityPlan, renderCapabilityPlan } = require("./capability-planner");
const { classifyRequest } = require("./routing-core");
const { TerminalFrontend, safeTerminalText } = require("./terminal-frontend");
const { escapeTerminalOutput, redactSensitiveText } = require("./command-activity");
const { createPermissionedToolRuntime, renderToolApproval, renderToolDefinitions } = require("./permissioned-tool-runtime");

const USAGE = `Vesper terminal frontend

Usage:
  vesper [run] [PROJECT_DIRECTORY]
  vesper [run] --new [PROJECT_DIRECTORY]
  vesper [run] --resume SESSION_ID [PROJECT_DIRECTORY]
  vesper sessions list [PROJECT_DIRECTORY]
  vesper sessions resume SESSION_ID [PROJECT_DIRECTORY]
  vesper sessions new [PROJECT_DIRECTORY]
  vesper providers
  vesper providers status [--provider PROVIDER_ID] [--check]
  vesper --provider PROVIDER_ID [--new] [PROJECT_DIRECTORY]
  vesper plugins [PROJECT_DIRECTORY]
  vesper mcp [PROJECT_DIRECTORY]
  vesper skills [PROJECT_DIRECTORY]
  vesper capabilities [list] [PROJECT_DIRECTORY]
  vesper capabilities show <ID> [PROJECT_DIRECTORY]
  vesper capabilities search <QUERY> [--project PROJECT_DIRECTORY]
  vesper capabilities status [PROJECT_DIRECTORY]
  vesper capabilities install <ID> [PROJECT_DIRECTORY]
  vesper capabilities remove <ID> [PROJECT_DIRECTORY]
  vesper capabilities configure mcp <NAME> (--stdio <COMMAND> [--arg <ARG> ...] | --url <HTTPS_URL> [--bearer-token-env-var <NAME>])
  vesper capabilities enable|disable <ID> [PROJECT_DIRECTORY]
  vesper plan <TASK> [--project PROJECT_DIRECTORY]
  vesper tools [list]
  vesper tools preview <TOOL_ID> '<JSON>' [--project PROJECT_DIRECTORY]
  vesper tools run <TOOL_ID> '<JSON>' [--project PROJECT_DIRECTORY] [--apply]
  vesper --help

Without --new or --resume, Vesper resumes the most recently updated session for the selected project,
or creates one when no session exists. The default project is the current working directory.
Session listings are project-scoped and show at most ${MAX_SESSION_LIST_ENTRIES} recent metadata records.
Inside Vesper, use :sessions to list this project's sessions, :switch SESSION_ID to resume one,
:new to start another session, :capabilities status|show ID to inspect local capability state,
:plan TASK to preview an advisory plan, :routing to inspect current-session routing counts, and :quit to exit.
Ctrl+C interrupts an active turn and returns to the prompt when the turn ends.

The tools command inspects or manually invokes the permissioned Vesper tool runtime. It never reads
provider output as a tool request. Shell execution is disabled by default; tool file changes are
proposed first and require a separate one-time approval before application.

Codex remains the default provider. OpenAI Chat Completions sends task text and its locally stored
conversation only; it does not read project files, run commands, apply code, or verify changes.

The plugins, mcp, and skills commands are read-only. Capabilities combines their local discovery
results and can use documented Codex CLI commands for confirmed plugin and MCP changes. Vesper never
downloads or executes code without an explicit operation and confirmation. Capability discovery does
not prove that Codex loaded a capability or that it is operational.
`;

const SESSIONS_USAGE = `Vesper session management

Usage:
  vesper sessions list [PROJECT_DIRECTORY]
  vesper sessions resume SESSION_ID [PROJECT_DIRECTORY]
  vesper sessions new [PROJECT_DIRECTORY]

The default project is the current working directory. Session resume requires the selected project to
match the saved session's canonical project path.
`;

const CAPABILITIES_USAGE = `Vesper capability catalog and management

Usage:
  vesper capabilities [list] [PROJECT_DIRECTORY]
  vesper capabilities show ID [PROJECT_DIRECTORY]
  vesper capabilities search QUERY [--project PROJECT_DIRECTORY]
  vesper capabilities status [PROJECT_DIRECTORY]
  vesper capabilities install PLUGIN_ID [PROJECT_DIRECTORY]
  vesper capabilities remove PLUGIN_OR_MCP_ID [PROJECT_DIRECTORY]
  vesper capabilities configure mcp NAME --stdio COMMAND [--arg ARG ...]
  vesper capabilities configure mcp NAME --url HTTPS_URL [--bearer-token-env-var NAME]
  vesper capabilities enable|disable ID [PROJECT_DIRECTORY]

Management operations show their target, intended change, backup/recovery guidance, and require
typing the exact capability ID. Vesper uses documented Codex CLI commands and the documented
project plugin setting. Project enable/disable is supported for installed plugins from this project's
local marketplace; standalone MCP and skill toggles remain unsupported. Vesper does not accept
environment-variable values. Discovery never proves that Codex loaded or can operate a capability.
Standalone status inspection does not start or resume Codex; use :capabilities status|show ID inside
an existing Vesper session to view passive MCP startup notifications from its current thread.
`;

const TOOLS_USAGE = `Vesper permissioned tool runtime

Usage:
  vesper tools [list]
  vesper tools preview TOOL_ID '<JSON>' [--project PROJECT_DIRECTORY]
  vesper tools run TOOL_ID '<JSON>' [--project PROJECT_DIRECTORY] [--apply]

Preview validates a request without executing it. Manual run executes only the named registered tool.
The request JSON must match that tool's schema. Paths are project-relative. File changes are
proposals first; --apply requests one fresh approval and applies the proposal in this process only.
Command execution is disabled by default. No provider output is interpreted as a tool call.
`;

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "providers") return parseProvidersArgs(args.slice(1));
  if (args[0] === "sessions") return parseSessionsArgs(args.slice(1));
  if (args[0] === "capabilities") return parseCapabilityArgs(args.slice(1));
  if (args[0] === "plan") return parsePlanArgs(args.slice(1));
  if (args[0] === "tools") return parseToolsArgs(args.slice(1));
  if (["plugins", "mcp", "skills"].includes(args[0])) return parseDiscoveryArgs(args[0], args.slice(1));
  if (args[0] === "modules") throw new Error("The vesper modules command is not implemented. Run vesper --help for supported commands.");
  return parseRunArgs(args);
}

function parseToolsArgs(args) {
  if (!args.length) return { command: "tools", action: "list", help: false };
  if (["--help", "-h"].includes(args[0])) {
    if (args.length !== 1) throw new Error("Usage: vesper tools --help.");
    return { command: "tools", action: "list", help: true };
  }
  if (args[0] === "list") {
    if (args.length !== 1) throw new Error("Usage: vesper tools [list].");
    return { command: "tools", action: "list", help: false };
  }
  const action = args[0];
  if (!(["preview", "run"].includes(action))) throw new Error("Usage: vesper tools [list] | tools preview|run TOOL_ID '<JSON>' [--project PROJECT_DIRECTORY] [--apply].");
  const toolId = args[1];
  const json = args[2];
  if (!toolId || !/^[a-z][a-z0-9_]{0,63}$/u.test(toolId) || typeof json !== "string") {
    throw new Error(`Usage: vesper tools ${action} TOOL_ID '<JSON>' [--project PROJECT_DIRECTORY]${action === "run" ? " [--apply]" : ""}.`);
  }
  if (Buffer.byteLength(json, "utf8") > 64 * 1024) throw new Error("Tool JSON input exceeds the 64 KiB command limit.");
  let input;
  try { input = JSON.parse(json); } catch { throw new Error("Tool input must be valid JSON. No operation was run."); }
  let projectDirectory = null;
  let apply = false;
  for (let index = 3; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--project") {
      if (projectDirectory || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--project requires one project directory.");
      projectDirectory = args[index + 1];
      index += 1;
    } else if (option === "--apply") {
      if (action !== "run" || apply) throw new Error("--apply is supported once with tools run propose_file_change.");
      apply = true;
    } else {
      throw new Error(`Unknown tools option: ${safeTerminalText(option)}.`);
    }
  }
  if (apply && toolId !== "propose_file_change") throw new Error("--apply can only follow a propose_file_change request.");
  return { command: "tools", action, toolId, input, projectDirectory, apply, help: false };
}

function parseProvidersArgs(args) {
  if (!args.length) return { command: "providers", action: "list", help: false };
  if (args[0] === "--help" || args[0] === "-h") return { command: "providers", help: true };
  if (args[0] !== "status") throw new Error("Usage: vesper providers [status [--provider PROVIDER_ID] [--check]].");
  let providerId = null;
  let check = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--check") {
      if (check) throw new Error("Use --check only once.");
      check = true;
    } else if (args[index] === "--provider") {
      if (providerId) throw new Error("Use --provider only once.");
      providerId = args[index + 1];
      if (!providerId || !/^[a-z][a-z0-9-]{0,79}$/u.test(providerId)) throw new Error("--provider requires a provider id.");
      index += 1;
    } else {
      throw new Error(`Unknown providers option: ${safeTerminalText(args[index])}.`);
    }
  }
  return { command: "providers", action: "status", providerId, check, help: false };
}

function parsePlanArgs(args) {
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return { command: "plan", help: true };
  }
  const rest = [...args];
  let projectDirectory = null;
  const projectOption = rest.indexOf("--project");
  if (projectOption >= 0) {
    if (projectOption !== rest.length - 2 || !rest[projectOption + 1]) {
      throw new Error("Usage: vesper plan TASK [--project PROJECT_DIRECTORY].");
    }
    projectDirectory = rest[projectOption + 1];
    rest.splice(projectOption, 2);
  }
  const task = rest.join(" ").trim();
  if (!task || task === "--help" || task === "-h" || task.startsWith("--")) {
    throw new Error("Usage: vesper plan TASK [--project PROJECT_DIRECTORY].");
  }
  return { command: "plan", task, projectDirectory, help: false };
}

function parseCapabilityArgs(args) {
  if (!args.length) return { command: "capabilities", action: "list", projectDirectory: null, help: false };
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "capabilities", help: true };
  let [action, ...rest] = args;
  if (action === "--help" || action === "-h") return { command: "capabilities", help: true };
  const knownActions = ["list", "show", "search", "status", "install", "remove", "configure", "enable", "disable"];
  if (!knownActions.includes(action)) {
    if (args.length === 1 && !action.startsWith("-")) {
      return { command: "capabilities", action: "list", projectDirectory: action, help: false };
    }
    throw new Error(`Unknown capabilities command: ${safeTerminalText(action)}. Run vesper capabilities --help.`);
  }
  if (rest.length === 1 && ["--help", "-h"].includes(rest[0])) return { command: "capabilities", action, help: true };

  if (action === "search") {
    let projectDirectory = null;
    const projectOption = rest.indexOf("--project");
    if (projectOption >= 0) {
      if (projectOption !== rest.length - 2 || !rest[projectOption + 1]) {
        throw new Error("Usage: vesper capabilities search QUERY [--project PROJECT_DIRECTORY].");
      }
      projectDirectory = rest[projectOption + 1];
      rest = rest.slice(0, projectOption);
    }
    const query = rest.join(" ").trim();
    if (!query || query.startsWith("-")) throw new Error("Usage: vesper capabilities search QUERY [--project PROJECT_DIRECTORY].");
    return { command: "capabilities", action, query, projectDirectory, help: false };
  }

  if (action === "configure") return parseCapabilityConfigureArgs(rest);
  if (action === "show" || action === "install" || action === "remove" || action === "enable" || action === "disable") {
    if (rest.some((arg) => arg.startsWith("-"))) throw new Error(`Unexpected option for vesper capabilities ${action}.`);
    if (rest.length < 1 || rest.length > 2) throw new Error(`Usage: vesper capabilities ${action} ID [PROJECT_DIRECTORY].`);
    return { command: "capabilities", action, capabilityId: rest[0], projectDirectory: rest[1] || null, help: false };
  }
  if (rest.some((arg) => arg.startsWith("-"))) throw new Error(`Unexpected option for vesper capabilities ${action}.`);
  if (rest.length > 1) throw new Error(`Usage: vesper capabilities ${action} [PROJECT_DIRECTORY].`);
  return { command: "capabilities", action, projectDirectory: rest[0] || null, help: false };
}

function parseCapabilityConfigureArgs(args) {
  if (args[0] !== "mcp" || !args[1] || args[1].startsWith("-")) {
    throw new Error("Usage: vesper capabilities configure mcp NAME (--stdio COMMAND [--arg ARG ...] | --url HTTPS_URL [--bearer-token-env-var NAME]).");
  }
  const name = args[1];
  let transport = null;
  let command = null;
  let url = null;
  let bearerTokenEnvVar = null;
  const mcpArgs = [];
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--stdio" || option === "--url") {
      if (transport) throw new Error("Choose exactly one of --stdio or --url.");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
      transport = option === "--stdio" ? "stdio" : "url";
      if (transport === "stdio") command = value;
      else url = value;
      index += 1;
    } else if (option === "--arg") {
      if (!transport || transport !== "stdio") throw new Error("--arg can only be used after --stdio.");
      const value = args[index + 1];
      if (value === undefined) throw new Error("--arg requires a value.");
      mcpArgs.push(value);
      index += 1;
    } else if (option === "--bearer-token-env-var") {
      if (bearerTokenEnvVar) throw new Error("Use --bearer-token-env-var only once.");
      bearerTokenEnvVar = args[index + 1];
      if (!bearerTokenEnvVar || bearerTokenEnvVar.startsWith("--")) throw new Error("--bearer-token-env-var requires an environment variable name, not a value.");
      index += 1;
    } else {
      throw new Error(`Unknown MCP configuration option: ${safeTerminalText(option)}. Vesper does not accept environment-variable values.`);
    }
  }
  if (!transport) throw new Error("Choose one MCP transport with --stdio or --url.");
  return {
    command: "capabilities",
    action: "configure",
    capabilityType: "mcp",
    projectDirectory: null,
    mcpConfiguration: { name, transport, command, url, args: mcpArgs, bearerTokenEnvVar },
    help: false,
  };
}

function parseRunArgs(argv) {
  const args = [...argv];
  if (args[0] === "run") args.shift();

  let newSession = false;
  let resumeId = null;
  let providerId = null;
  let help = false;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--new") newSession = true;
    else if (arg === "--resume") {
      if (resumeId !== null) throw new Error("Use --resume only once.");
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--resume requires a Vesper session id.");
      resumeId = value;
      index += 1;
    } else if (arg === "--provider") {
      if (providerId !== null) throw new Error("Use --provider only once.");
      providerId = args[index + 1];
      if (!providerId || !/^[a-z][a-z0-9-]{0,79}$/u.test(providerId)) throw new Error("--provider requires a provider id.");
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${safeTerminalText(arg)}`);
    } else {
      positional.push(arg);
    }
  }

  if (newSession && resumeId) throw new Error("Use either --new or --resume, not both.");
  if (positional.length > 1) throw new Error("Provide at most one project directory.");
  return { command: "run", newSession, resumeId, help, projectDirectory: positional[0] || null, ...(providerId ? { providerId } : {}) };
}

function parseSessionsArgs(args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    return { command: "sessions", action: null, help: true };
  }
  const [action, ...rest] = args;
  if (!["list", "resume", "new"].includes(action)) {
    throw new Error(`Unknown sessions command: ${safeTerminalText(action)}. Run vesper sessions --help.`);
  }
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { command: "sessions", action, help: true };
  }
  if (rest.some((arg) => arg.startsWith("-"))) throw new Error(`Unexpected option for sessions ${action}.`);
  if (action === "resume") {
    if (rest.length < 1) throw new Error("vesper sessions resume requires a Vesper session id.");
    if (rest.length > 2) throw new Error("Usage: vesper sessions resume SESSION_ID [PROJECT_DIRECTORY].");
    return { command: "sessions", action, sessionId: rest[0], projectDirectory: rest[1] || null, help: false };
  }
  if (rest.length > 1) throw new Error(`Usage: vesper sessions ${action} [PROJECT_DIRECTORY].`);
  return { command: "sessions", action, projectDirectory: rest[0] || null, help: false };
}

function parseDiscoveryArgs(command, args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { command, help: true };
  }
  if (args.some((arg) => arg.startsWith("-"))) throw new Error(`Unknown option for vesper ${command}.`);
  if (args.length > 1) throw new Error(`Usage: vesper ${command} [PROJECT_DIRECTORY].`);
  return { command, projectDirectory: args[0] || null, help: false };
}

function resolveProjectDirectory(directory) {
  const requested = path.resolve(directory || process.cwd());
  let realPath;
  try {
    realPath = fs.realpathSync(requested);
  } catch {
    throw new Error(`Project directory does not exist: ${safeTerminalText(requested)}`);
  }
  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch {
    throw new Error(`Project directory is unavailable: ${safeTerminalText(realPath)}`);
  }
  if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${safeTerminalText(realPath)}`);
  return realPath;
}

async function runVesper(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error.message)}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    output.write(options.command === "sessions" ? SESSIONS_USAGE : options.command === "providers" ? `${USAGE}\nProvider configuration:\n  OPENAI_API_KEY (or VESPER_OPENAI_API_KEY) supplies the key.\n  VESPER_OPENAI_MODEL selects the model; VESPER_OPENAI_BASE_URL optionally selects an OpenAI-compatible endpoint.\n  VESPER_PROVIDER selects the default for new sessions.\n` : options.command === "capabilities" ? CAPABILITIES_USAGE : options.command === "tools" ? TOOLS_USAGE : options.command === "plan" ? "Vesper advisory planning preview\n\nUsage:\n  vesper plan TASK [--project PROJECT_DIRECTORY]\n\nThe task is classified deterministically. The existing route is preserved, and planning does not start Codex, activate capabilities, or execute tools.\n" : options.command === "run" ? USAGE : discoveryUsage(options.command));
    return 0;
  }

  if (options.command === "providers") return runProviders(options, dependencies, output, errorOutput);
  if (options.command === "plan") return runPlan(options, dependencies, output, errorOutput);
  if (options.command === "tools") return runTools(options, dependencies, output, errorOutput);

  if (options.command === "capabilities") {
    return runCapabilities(options, dependencies, output, errorOutput);
  }

  if (options.command === "sessions") {
    if (options.action === "list") return runSessionsList(options, dependencies, output, errorOutput);
    if (options.action === "new") {
      const projectDirectory = options.projectDirectory || process.cwd();
      return runInteractiveVesper({ command: "run", newSession: true, resumeId: null, projectDirectory }, dependencies, output, errorOutput);
    }
    if (options.action === "resume") {
      try {
        const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
        const store = dependencies.store || new SessionStore();
        const saved = store.load(options.sessionId);
        const savedCwd = resolveProjectDirectory(saved.cwd);
        if (cwd !== savedCwd) {
          throw new Error(`Vesper session ${saved.sessionId} belongs to ${savedCwd}; selected project is ${cwd}. Run the command from the saved project or pass its path.`);
        }
        return runInteractiveVesper({ command: "run", newSession: false, resumeId: saved.sessionId, projectDirectory: cwd }, { ...dependencies, store }, output, errorOutput);
      } catch (error) {
        errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
        return 1;
      }
    }
  }

  if (["plugins", "mcp", "skills"].includes(options.command)) {
    return runDiscovery(options, dependencies, output, errorOutput);
  }

  return runInteractiveVesper(options, dependencies, output, errorOutput);
}

async function runProviders(options, dependencies, output, errorOutput) {
  const environment = dependencies.environment || process.env;
  const selectedProviderId = resolveDefaultProviderId(environment);
  if (options.action === "list") {
    output.write(`Selected provider for new sessions: ${safeCliField(selectedProviderId)}\n`);
    output.write("Available providers:\n");
    for (const provider of listProviders()) {
      const marker = provider.id === selectedProviderId ? " · selected" : "";
      output.write(`- ${safeCliField(provider.id)} · ${safeCliField(provider.name)}${marker}\n`);
      output.write(`  ${safeCliField(provider.description)}\n`);
    }
    output.write("Listing providers does not contact any provider. Use vesper providers status --provider openai-chat-completions --check for an explicit GET /models connectivity check.\n");
    return 0;
  }

  const providerId = options.providerId || selectedProviderId;
  let provider;
  try {
    const status = getProviderStatus(providerId, environment);
    output.write(`Provider: ${safeCliField(status.name)} (${safeCliField(status.id)})\n`);
    output.write(`Selected for new sessions: ${status.id === selectedProviderId ? "yes" : "no"}\n`);
    output.write(`Configured: ${status.configured === null ? "unknown (Codex CLI status not checked)" : status.configured ? "yes" : "no"}\n`);
    if (status.model) output.write(`Model: ${safeCliField(status.model)}\n`);
    if (status.apiKeyEnvVar) output.write(`API key: ${status.apiKeyConfigured ? "present" : "missing"} (${safeCliField(status.apiKeyEnvVar)}; value hidden)\n`);
    output.write(`Reachability: ${options.check ? "check requested" : status.reachability}\n`);
    output.write("Operations:\n");
    for (const [operation, supported] of Object.entries(status.capabilities)) {
      output.write(`- ${safeCliField(operation)}: ${supported ? "supported" : "unsupported"}\n`);
    }
    for (const message of status.configurationMessages || []) output.write(`Configuration: ${safeCliField(message)}\n`);
    if (!options.check) {
      output.write("No network or app-server connectivity check was performed. Add --check to request one explicitly.\n");
      return status.configured === false ? 1 : 0;
    }
    const cwd = resolveProjectDirectory(dependencies.projectDirectory || process.cwd());
    const providerFactory = dependencies.executionProviderFactory || createExecutionProvider;
    provider = providerFactory({
      providerId,
      environment,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(dependencies.conversationDirectory ? { conversationDirectory: dependencies.conversationDirectory } : {}),
      ...(dependencies.clientFactory ? { clientFactory: dependencies.clientFactory } : {}),
      ...(dependencies.clientOptions ? { clientOptions: dependencies.clientOptions } : {}),
    });
    const check = await provider.initialize({ projectPath: cwd, checkConnection: true });
    output.write(`Reachability: yes · configured model ${check.modelAvailable ? "listed" : "not listed"}\n`);
    return check.modelAvailable ? 0 : 1;
  } catch (error) {
    const reachability = provider?.getState?.().reachability === "yes" ? "yes · API check failed" : "no";
    output.write(`Reachability: ${reachability} · ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  } finally {
    provider?.dispose?.();
  }
}

async function runPlan(options, dependencies, output, errorOutput) {
  try {
    const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    let catalog;
    if (dependencies.capabilityProvider && typeof dependencies.capabilityProvider.getCatalog === "function") {
      catalog = await dependencies.capabilityProvider.getCatalog({ refreshRuntime: true });
    } else {
      catalog = await buildCapabilityCatalog({
        cwd,
        discoveryOptions: dependencies.discoveryOptions || {},
        commandRunner: dependencies.codexCommandRunner || runCodexCommand,
        runtimeStatusAdapter: dependencies.runtimeStatusAdapter,
      });
    }
    const decision = classifyRequest(options.task);
    const plan = createCapabilityPlan({ task: options.task, catalog, routeDecision: decision, projectContext: { cwd }, now: dependencies.planningNow });
    output.write(renderCapabilityPlan(plan));
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper plan error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  }
}

function discoveryUsage(command) {
  return `Vesper ${command} discovery (read-only)\n\nUsage:\n  vesper ${command} [PROJECT_DIRECTORY]\n\nNo integration is installed, enabled, disabled, downloaded, or modified.\n`;
}

async function runTools(options, dependencies, output, errorOutput) {
  if (options.action === "list") {
    let runtime;
    try {
      const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
      runtime = await makeToolRuntime(cwd, { ...dependencies, output });
      output.write(renderToolDefinitions(runtime.getDefinitions()));
      return 0;
    } catch (error) {
      errorOutput.write(`[Vesper tools error] ${safeTerminalText(error?.message || error)}\n`);
      return 1;
    } finally { runtime?.dispose?.(); }
  }

  let runtime;
  try {
    const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    runtime = await makeToolRuntime(cwd, { ...dependencies, output });
    const context = Object.freeze({ projectRoot: cwd, sessionId: runtime.sessionId || crypto.randomUUID() });
    const request = Object.freeze({ toolId: options.toolId, input: options.input, context, requestId: crypto.randomUUID() });
    if (options.action === "preview") {
      const preview = await runtime.preview(request);
      output.write(`Tool preview · validated only · not executed\n${renderBoundedToolJson(preview)}\n`);
      return 0;
    }

    const result = await runtime.invoke(request);
    output.write(`Tool operation · ${renderToolState(result)}\n${renderBoundedToolJson(result)}\n`);
    if (result.state === "rejected" || result.state === "failed") return 1;

    if (options.apply && result.state === "proposed") {
      const applyRequest = Object.freeze({
        toolId: "apply_file_change",
        input: { proposalId: result.proposal.proposalId },
        context,
        requestId: crypto.randomUUID(),
      });
      const applied = await runtime.invoke(applyRequest);
      output.write(`File change operation · ${renderToolState(applied)}\n${renderBoundedToolJson(applied)}\n`);
      return applied.state === "rejected" || applied.state === "failed" ? 1 : 0;
    }
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper tools error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  } finally { runtime?.dispose?.(); }
}

async function makeToolRuntime(projectRoot, dependencies) {
  const runtimeOptions = {
    projectRoot,
    sessionId: dependencies.toolSessionId || crypto.randomUUID(),
    commandExecutionEnabled: dependencies.commandExecutionEnabled === true,
    auditSink: dependencies.toolAuditSink,
    approvalHandler: async (snapshot) => {
      outputForApproval(dependencies.toolOutput || dependencies.output || process.stdout, snapshot);
      if (typeof dependencies.confirmToolApproval === "function") return dependencies.confirmToolApproval(snapshot);
      return requestToolApproval(snapshot, dependencies);
    },
  };
  return typeof dependencies.toolRuntimeFactory === "function"
    ? dependencies.toolRuntimeFactory(runtimeOptions)
    : createPermissionedToolRuntime(runtimeOptions);
}

function outputForApproval(output, snapshot) {
  output.write(`Operation state: awaiting approval\n${renderToolApproval(snapshot)}\n`);
}

function renderToolState(result) {
  const states = [];
  if (result.approved) states.push("approved");
  if (result.executed) states.push("executed");
  if (result.verified) states.push("verified");
  if (["failed", "rejected"].includes(result.state)) states.push(result.state);
  if (!states.length) states.push(result.state);
  return states.map(safeTerminalText).join(" · ");
}

async function requestToolApproval(snapshot, dependencies) {
  const input = dependencies.confirmationInput || process.stdin;
  const output = dependencies.confirmationOutput || dependencies.output || process.stdout;
  if (!input?.isTTY) {
    output.write("This operation needs an interactive terminal for one-time approval; no change was made.\n");
    return "cancel";
  }
  const terminal = readline.createInterface({ input, output });
  try {
    const answer = (await terminal.question('Type "approve-once", "decline", or "cancel": ')).trim();
    return answer === "approve-once" || answer === "decline" || answer === "cancel" ? answer : "cancel";
  } finally { terminal.close(); }
}

function renderBoundedToolJson(value) {
  const maximum = 1024 * 1024 + 4_096;
  let text = escapeTerminalOutput(redactSensitiveText(JSON.stringify(value, null, 2)));
  if (text.length > maximum) text = `${text.slice(0, maximum)}\n[tool output omitted after the 1 MiB display limit]`;
  return text;
}

async function runCapabilities(options, dependencies, output, errorOutput) {
  let cwd;
  try {
    cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    const discoveryOptions = dependencies.discoveryOptions || {};
    const commandRunner = dependencies.codexCommandRunner || runCodexCommand;
    const catalog = await buildCapabilityCatalog({
      cwd,
      discoveryOptions,
      commandRunner,
      runtimeStatusAdapter: dependencies.runtimeStatusAdapter,
    });

    if (options.action === "list") {
      output.write(renderCapabilityList(catalog.capabilities));
      if (catalog.diagnostics.length) {
        output.write(`Discovery notes (${catalog.diagnostics.length}):\n`);
        for (const diagnostic of catalog.diagnostics.slice(0, 12)) {
          output.write(`- ${safeTerminalText(diagnostic.type)}: ${safeTerminalText(diagnostic.message)}\n`);
        }
        if (catalog.diagnostics.length > 12) output.write(`- Additional notes omitted: ${catalog.diagnostics.length - 12}.\n`);
      }
      return 0;
    }
    if (options.action === "show") {
      const capability = findCapability(catalog, options.capabilityId);
      if (!capability) {
        errorOutput.write(`[Vesper capability error] Capability ${safeTerminalText(options.capabilityId)} was not found in the local catalog. Run vesper capabilities status for discovery notes.\n`);
        return 1;
      }
      output.write(renderCapability(capability));
      return 0;
    }
    if (options.action === "search") {
      const results = searchCapabilities(catalog, options.query);
      output.write(renderCapabilityList(results, `Vesper capability search · ${safeTerminalText(options.query)}`));
      if (!results.length) output.write("No matching capability metadata was found in the local catalog.\n");
      return 0;
    }
    if (options.action === "status") {
      output.write(renderCatalogStatus(catalog));
      return 0;
    }

    return runCapabilityOperation({
      operation: options.action,
      capabilityId: options.capabilityId,
      capabilityType: options.capabilityType,
      mcpConfiguration: options.mcpConfiguration,
      cwd,
      catalog,
      discoveryOptions,
      commandRunner,
      confirm: (request) => requestCapabilityConfirmation(request, dependencies, output),
      output,
      errorOutput,
    });
  } catch (error) {
    errorOutput.write(`[Vesper capability error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  }
}

async function requestCapabilityConfirmation(request, dependencies, output) {
  if (typeof dependencies.confirmCapabilityAction === "function") {
    return dependencies.confirmCapabilityAction(request);
  }
  const input = dependencies.confirmationInput || process.stdin;
  if (!input?.isTTY) {
    output.write("Confirmation requires an interactive terminal; no changes were made.\n");
    return false;
  }
  const terminal = readline.createInterface({ input, output: dependencies.confirmationOutput || output });
  try {
    const answer = await terminal.question(`Type ${request.id} to confirm: `);
    return answer.trim() === request.id;
  } finally {
    terminal.close();
  }
}

async function runSessionsList(options, dependencies, output, errorOutput) {
  try {
    const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    const store = dependencies.store || new SessionStore();
    const sessions = store.listByCwd(cwd, MAX_SESSION_LIST_ENTRIES);
    output.write(`Vesper sessions for ${safeCliField(cwd)} (updated, newest first; maximum ${MAX_SESSION_LIST_ENTRIES})\n`);
    if (!sessions.length) {
      output.write("No Vesper sessions found for this project.\n");
      return 0;
    }
    output.write("SESSION ID                               UPDATED (UTC)\n");
    for (const session of sessions) {
      output.write(`${session.sessionId}  ${safeCliField(session.updatedAt)}\n`);
    }
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  }
}

async function runDiscovery(options, dependencies, output, errorOutput) {
  try {
    const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    let result;
    if (options.command === "plugins") {
      result = discoverPlugins({ cwd, ...(dependencies.discoveryOptions || {}) });
    } else if (options.command === "skills") {
      result = discoverSkills({ cwd, ...(dependencies.discoveryOptions || {}) });
    } else {
      result = await discoverMcp({
        cwd,
        codexHome: dependencies.discoveryOptions?.codexHome,
        commandRunner: dependencies.codexCommandRunner,
      });
    }
    output.write(renderDiscovery(result));
    if (result.failed) {
      errorOutput.write("[Vesper error] MCP discovery status is unknown. Check the Codex CLI installation and retry.\n");
      return 1;
    }
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  }
}

async function runInteractiveVesper(options, dependencies, output, errorOutput) {
  let executionProvider;
  try {
    const store = dependencies.store || new SessionStore();
    const environment = dependencies.environment || process.env;
    const environmentProvider = typeof environment.VESPER_PROVIDER === "string" ? environment.VESPER_PROVIDER.trim() : "";
    const requestedProviderId = options.providerId || dependencies.providerId || null;
    let session;
    let cwd;
    let resumed = false;
    if (options.resumeId) {
      session = store.load(options.resumeId);
      const storedCwd = resolveProjectDirectory(session.cwd);
      const selectedCwd = options.projectDirectory ? resolveProjectDirectory(options.projectDirectory) : storedCwd;
      if (selectedCwd !== storedCwd) throw new Error("The selected directory does not match this saved Vesper session.");
      cwd = storedCwd;
      if (requestedProviderId && requestedProviderId !== session.providerId) {
        throw new Error(`Session ${session.sessionId} belongs to provider ${session.providerId}; selected provider is ${requestedProviderId}. Resume with --provider ${session.providerId}, or use --new to create a separate session.`);
      }
      resumed = true;
    } else {
      cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
      session = options.newSession ? null : store.findLatestByCwd(cwd);
      if (session && requestedProviderId && requestedProviderId !== session.providerId) {
        throw new Error(`The latest session for this project belongs to provider ${session.providerId}; selected provider is ${requestedProviderId}. Use --new to create a separate session, or select the saved provider.`);
      }
      resumed = Boolean(session);
      if (!session) {
        const newProviderId = requestedProviderId || environmentProvider || DEFAULT_PROVIDER_ID;
        if (!listProviders().some((provider) => provider.id === newProviderId)) throw new Error(`Unsupported provider ${safeCliField(newProviderId)}. Run vesper providers to see supported providers.`);
        session = store.create(cwd, { providerId: newProviderId });
      }
    }

    output.write(`Vesper session: ${session.sessionId}\n`);
    const sessionStatus = resumed ? "resumed" : "new";
    const conversationStatus = providerConversationLabel(session);
    output.write(`Session status: ${sessionStatus} · ${conversationStatus}\n`);
    output.write(`Execution provider: ${safeCliField(session.providerId)}${session.providerId === OPENAI_PROVIDER_ID && environment.VESPER_OPENAI_MODEL ? ` · model ${safeCliField(environment.VESPER_OPENAI_MODEL)}` : ""}\n`);
    output.write(`Project: ${safeCliField(cwd)}\n`);

    let terminal;
    const providerFactory = dependencies.executionProviderFactory || createExecutionProvider;
    const createProvider = (selectedSession) => {
      const providerId = selectedSession.providerId || (Object.hasOwn(selectedSession, "threadId") ? "codex-app-server" : null);
      const conversationId = selectedSession.providerConversationId !== undefined
        ? selectedSession.providerConversationId
        : selectedSession.threadId || null;
      if (!listProviders().some((provider) => provider.id === providerId)) {
        throw new Error(`This Vesper session belongs to unsupported provider ${safeCliField(providerId || "unknown")}. Select a supported provider in a new session; Vesper will not change the saved session provider.`);
      }
      const providerOptions = {
        providerId,
        environment,
        onConversationId: async (conversationId) => {
          const updated = store.update(selectedSession.sessionId, {
            providerConversationId: conversationId,
            status: "active",
            recovery: null,
          });
          if (session.sessionId === selectedSession.sessionId) session = updated;
        },
      };
      if (providerId === OPENAI_PROVIDER_ID) {
        providerOptions.conversationDirectory = dependencies.conversationDirectory || path.join(store.directory || defaultSessionDirectory(), "provider-conversations");
        providerOptions.fetchImpl = dependencies.fetchImpl || globalThis.fetch;
      } else {
        if (dependencies.clientFactory) providerOptions.clientFactory = dependencies.clientFactory;
        providerOptions.clientOptions = {
          ...(dependencies.clientOptions || {}),
          initialThreadId: conversationId,
        };
      }
      return providerFactory(providerOptions);
    };
    executionProvider = createProvider(session);

    const activateSession = async (selectedSession, action) => {
      const nextClient = createProvider(selectedSession);
      const previousClient = executionProvider;
      try {
        terminal.replaceExecutionProvider(nextClient, {
          sessionId: selectedSession.sessionId,
          savedConversationId: selectedSession.providerConversationId,
        });
      } catch (error) {
        nextClient.dispose?.();
        throw error;
      }
      session = selectedSession;
      executionProvider = nextClient;
      previousClient?.dispose?.();
      output.write(`\n[Vesper] ${action}: ${safeCliField(session.sessionId)} · ${providerConversationLabel(session)} · ${safeCliField(session.providerId)}\n`);
      output.write(`Project: ${safeCliField(cwd)}\n`);
      if (session.providerConversationId) {
        try {
          await terminal.restoreSavedHistory();
        } catch (error) {
          output.write(`[Vesper reconnect error] ${safeTerminalText(error?.message || error)}. The session remains selected; retry with another prompt.\n`);
        }
      }
    };

    const handleWorkspaceCommand = async (command) => {
      const [name, ...args] = command.trim().split(/\s+/u);
      if (name === ":help" && args.length === 0) {
        output.write("Workspace commands: :sessions, :switch SESSION_ID, :new, :capabilities [list|status|show ID], :plan TASK, :routing, :quit\n");
        return true;
      }
      if (name === ":capabilities") {
        if (args.length > 2 || (args[0] === "show" && args.length !== 2) ||
            (args.length === 2 && args[0] !== "show") || ![undefined, "list", "status", "show"].includes(args[0])) {
          output.write("Usage: :capabilities [list|status|show ID]\n");
          return true;
        }
        if (!capabilityProvider || typeof capabilityProvider.getCatalog !== "function") {
          output.write("[Vesper] Capability catalog is unavailable in this session.\n");
          return true;
        }
        const catalog = await capabilityProvider.getCatalog({ refresh: true });
        if (args[0] === "status") {
          output.write(renderCatalogStatus(catalog));
          return true;
        }
        if (args[0] === "show") {
          const capability = findCapability(catalog, args[1]);
          if (!capability) {
            output.write(`[Vesper] Capability ${safeTerminalText(args[1])} was not found in the local catalog.\n`);
            return true;
          }
          output.write(renderCapability(capability));
          return true;
        }
        output.write(renderCapabilityList(catalog.capabilities));
        return true;
      }
      if (name === ":plan") {
        const task = command.slice(":plan".length).trim();
        if (!task) {
          output.write("Usage: :plan TASK\n");
          return true;
        }
        if (!capabilityProvider || typeof capabilityProvider.getCatalog !== "function") {
          output.write("[Vesper] Capability catalog is unavailable; no plan could be generated.\n");
          return true;
        }
        const catalog = await capabilityProvider.getCatalog({ refresh: true });
        const decision = classifyRequest(task);
        output.write(renderCapabilityPlan(createCapabilityPlan({ task, catalog, routeDecision: decision, projectContext: { cwd } })));
        return true;
      }
      if (name === ":sessions" && args.length === 0) {
        const sessions = store.listByCwd(cwd, MAX_SESSION_LIST_ENTRIES);
        output.write(`\n[Vesper sessions · ${safeCliField(cwd)} · newest first · maximum ${MAX_SESSION_LIST_ENTRIES}]\n`);
        if (!sessions.length) output.write("No Vesper sessions found for this project.\n");
        for (const item of sessions) {
          const current = item.sessionId === session.sessionId ? " · current" : "";
          const conversation = providerConversationLabel(item);
          output.write(`${safeCliField(item.sessionId)}  ${safeCliField(item.updatedAt)}  ${safeCliField(item.providerId)} · ${conversation}${current}\n`);
        }
        output.write("Use :switch SESSION_ID to resume one.\n");
        return true;
      }
      if (name === ":new" && args.length === 0) {
        const newProviderId = requestedProviderId || environmentProvider || DEFAULT_PROVIDER_ID;
        if (!listProviders().some((provider) => provider.id === newProviderId)) {
          output.write(`[Vesper] Unsupported provider ${safeCliField(newProviderId)}. Run vesper providers to see supported providers.\n`);
          return true;
        }
        await activateSession(store.create(cwd, { providerId: newProviderId }), "New session");
        return true;
      }
      if (name === ":switch" && args.length === 1) {
        const selected = store.load(args[0]);
        const savedCwd = resolveProjectDirectory(selected.cwd);
        if (savedCwd !== cwd) {
          throw new Error(`Vesper session ${selected.sessionId} belongs to ${savedCwd}; Vesper is running in ${cwd}. Choose a session listed by :sessions.`);
        }
        if (selected.sessionId === session.sessionId) {
          output.write(`[Vesper] ${safeCliField(selected.sessionId)} is already the current session.\n`);
          return true;
        }
        await activateSession(selected, "Session switched");
        return true;
      }
      output.write("Usage: :sessions | :switch SESSION_ID | :new | :capabilities [list|status|show ID] | :plan TASK | :routing | :help | :quit\n");
      return true;
    };

    const handlers = dependencies.handlers || createLocalHandlers({ runGit: dependencies.runGit || runGitCommand });
    const capabilityProvider = dependencies.capabilityProvider || createCapabilityProvider({
      cwd,
      discoveryOptions: dependencies.discoveryOptions || {},
      commandRunner: dependencies.codexCommandRunner,
      runtimeStatusAdapter: createCodexRuntimeStatusAdapter({ getRuntimeClient: () => executionProvider }),
    });
    terminal = new TerminalFrontend({
      cwd,
      handlers,
      executionProvider,
      input: dependencies.input || process.stdin,
      output,
      lineIO: dependencies.lineIO,
      metrics: dependencies.metrics,
      savedConversationId: session.providerConversationId,
      sessionId: session.sessionId,
      onWorkspaceCommand: handleWorkspaceCommand,
      capabilityProvider,
      onTask: () => {
        session = store.touch(session.sessionId);
      },
      onExecutionState: ({ status, recovery }) => {
        session = store.update(session.sessionId, { status, recovery });
      },
    });
    await terminal.run();
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  } finally {
    executionProvider?.dispose?.();
  }
}

function runGitCommand(args, cwd) {
  if (!cwd) return Promise.reject(new Error("No project directory is available for the Git check."));
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      timeout: 5_000,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function safeCliField(value) {
  return safeTerminalText(value);
}

function providerConversationLabel(session) {
  if (session.providerId === DEFAULT_PROVIDER_ID) return session.providerConversationId ? "saved Codex thread" : "no Codex thread yet";
  return session.providerConversationId ? "saved provider conversation" : "no provider conversation yet";
}

module.exports = {
  SESSIONS_USAGE,
  USAGE,
  parseArgs,
  resolveProjectDirectory,
  runGitCommand,
  parsePlanArgs,
  runVesper,
};
