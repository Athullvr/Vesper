"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { buildCapabilityCatalog, findCapability } = require("./capability-catalog");
const { defaultCodexHome, runCodexCommand } = require("./integration-discovery");

const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const defaultManagementAdapters = new Map();

function registerCapabilityManagementAdapter(type, adapter, registry = defaultManagementAdapters) {
  if (typeof type !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(type)) {
    throw new TypeError("Capability adapter types must be short lowercase identifiers.");
  }
  if (!adapter || typeof adapter !== "object") throw new TypeError("A capability management adapter is required.");
  const supported = {};
  for (const operation of ["install", "remove", "configure", "enable", "disable"]) {
    if (adapter[operation] !== undefined && typeof adapter[operation] !== "function") {
      throw new TypeError(`The ${operation} adapter must be a function.`);
    }
    if (typeof adapter[operation] === "function") supported[operation] = adapter[operation];
  }
  registry.set(type, Object.freeze(supported));
  return registry;
}

function parseMcpConfiguration(name, options) {
  if (!isSafeName(name)) throw new Error("MCP server names must be non-empty, at most 120 characters, and contain no control characters.");
  if (!options || typeof options !== "object") throw new Error("An MCP transport configuration is required.");
  if (options.transport === "stdio") {
    if (!isSafeArgument(options.command)) throw new Error("A non-empty MCP executable is required.");
    const args = Array.isArray(options.args) ? options.args.map(String) : [];
    if (args.some((arg) => arg.length > 4_096 || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(arg))) {
      throw new Error("MCP arguments must be at most 4,096 characters and contain no control characters.");
    }
    if (options.bearerTokenEnvVar) throw new Error("--bearer-token-env-var is only supported for HTTP MCP servers.");
    return { name, transport: "stdio", command: options.command, args, bearerTokenEnvVar: null };
  }
  if (options.transport === "url") {
    let url;
    try {
      url = new URL(options.url);
    } catch {
      throw new Error("The MCP URL must be a valid HTTPS URL, or HTTP on localhost.");
    }
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("MCP URLs must use HTTPS, or HTTP on localhost, and may not contain credentials, query parameters, or fragments.");
    }
    if (typeof options.bearerTokenEnvVar === "string" && !VALID_ENV_NAME.test(options.bearerTokenEnvVar)) {
      throw new Error("The bearer-token environment variable must be a valid variable name; Vesper does not accept secret values.");
    }
    return {
      name,
      transport: "url",
      url: url.toString(),
      args: [],
      bearerTokenEnvVar: options.bearerTokenEnvVar || null,
    };
  }
  throw new Error("Choose exactly one supported MCP transport: --stdio or --url.");
}

async function runCapabilityOperation({
  operation,
  capabilityId,
  capabilityType,
  mcpConfiguration,
  cwd,
  catalog,
  discoveryOptions = {},
  commandRunner = runCodexCommand,
  adapterRegistry = defaultManagementAdapters,
  confirm,
  output = process.stdout,
  errorOutput = process.stderr,
  filesystem = fs,
} = {}) {
  if (!catalog) {
    catalog = await buildCapabilityCatalog({ cwd, discoveryOptions, commandRunner });
  }

  let planned;
  if (operation === "enable" || operation === "disable") {
    const capability = capabilityId ? findCapability(catalog, capabilityId) : null;
    const target = capability ? `${capability.type} ${capability.id}` : `capability ${capabilityId || "(unspecified)"}`;
    const planner = capability && adapterRegistry.get(capability.type)?.[operation];
    if (!planner) {
      output.write(`Unsupported action: Vesper cannot ${operation} ${target} through a documented provider interface. No changes were made.\n`);
      output.write("Codex exposes no enable/disable operation for these discovered capability types. MCP can be removed and configured again; plugin and skill runtime activation remains unknown.\n");
      return 1;
    }
    planned = planner({ capability, catalog, discoveryOptions });
  } else {
    planned = planOperation({ operation, capabilityId, capabilityType, mcpConfiguration, catalog, discoveryOptions, adapterRegistry });
  }

  if (!planned.supported) {
    errorOutput.write(`[Vesper capability error] ${planned.reason}\n`);
    return 1;
  }

  const codexHome = discoveryOptions.codexHome || defaultCodexHome(discoveryOptions.home);
  let backupPlan;
  try {
    backupPlan = planConfigBackup(codexHome, filesystem);
  } catch (error) {
    errorOutput.write(`[Vesper capability error] Cannot safely prepare a Codex configuration backup: ${safeError(error)} No changes were made.\n`);
    return 1;
  }

  output.write(renderOperationPlan(planned, backupPlan));
  const expectedConfirmation = planned.id;
  let approved = false;
  try {
    approved = typeof confirm === "function" && await confirm({
      operation,
      id: expectedConfirmation,
      summary: planned.summary,
      backupPath: backupPlan.path,
    }) === true;
  } catch {
    approved = false;
  }
  if (!approved) {
    output.write(`No changes made. To confirm, type the exact identifier: ${expectedConfirmation}\n`);
    return 1;
  }

  let backup;
  try {
    backup = createConfigBackup(backupPlan, filesystem);
  } catch (error) {
    const partialBackup = backupPlan.path
      ? ` Planned backup path: ${backupPlan.path}; verify it before using it for recovery.`
      : "";
    errorOutput.write(`[Vesper capability error] Could not create the planned configuration backup: ${safeError(error)} No Codex command was run.${partialBackup}\n`);
    return 1;
  }

  try {
    await commandRunner("codex", planned.args, {
      cwd,
      timeout: planned.timeout,
      maxBuffer: 1_048_576,
      encoding: "utf8",
    });
  } catch (error) {
    const reason = error?.code === "ENOENT"
      ? "Codex CLI was not found on PATH."
      : "The Codex command failed; its raw output was suppressed to avoid exposing configuration values.";
    errorOutput.write(`[Vesper capability error] ${reason}${backup?.path ? ` Configuration backup: ${backup.path}` : ""}\n`);
    return 1;
  }

  let after;
  try {
    after = await buildCapabilityCatalog({ cwd, discoveryOptions, commandRunner });
  } catch {
    errorOutput.write(`[Vesper capability error] Codex returned success, but Vesper could not verify the resulting state. No success is reported.${backup?.path ? ` Configuration backup: ${backup.path}` : ""}\n`);
    return 1;
  }
  const verified = typeof planned.verify === "function"
    ? await planned.verify(after)
    : verifyOperation(planned, after);
  if (!verified) {
    errorOutput.write(`[Vesper capability error] Codex returned success, but discovery did not confirm the requested state. No success is reported.${backup?.path ? ` Configuration backup: ${backup.path}` : ""}\n`);
    return 1;
  }

  output.write(`Completed and verified: ${planned.summary}\n`);
  if (backup?.path) output.write(`Configuration backup: ${backup.path}\n`);
  output.write(`Recovery: ${planned.recovery}\n`);
  return 0;
}

function planOperation({ operation, capabilityId, capabilityType = "mcp", mcpConfiguration, catalog, discoveryOptions, adapterRegistry = defaultManagementAdapters }) {
  if (operation === "configure") {
    const planner = adapterRegistry.get(capabilityType)?.configure;
    if (!planner) return { supported: false, reason: `No ${safeTerminalText(capabilityType)} configuration adapter is registered. No changes were made.` };
    return planner({ mcpConfiguration, catalog, discoveryOptions });
  }

  if (!new Set(["install", "remove"]).has(operation)) {
    return { supported: false, reason: `Unsupported capability action: ${safeTerminalText(operation)}. No changes were made.` };
  }
  const capability = findCapability(catalog, capabilityId);
  if (!capability) return { supported: false, reason: `Capability ${safeTerminalText(capabilityId)} was not found in the current local catalog. No changes were made.` };
  const planner = adapterRegistry.get(capability.type)?.[operation];
  if (!planner) return { supported: false, reason: `No ${safeTerminalText(operation)} adapter is registered for ${capability.type}; no changes were made.` };
  return planner({ capability, catalog, discoveryOptions });
}

function planMcpConfiguration({ mcpConfiguration, catalog }) {
  let configuration;
  try {
    configuration = parseMcpConfiguration(mcpConfiguration?.name, mcpConfiguration);
  } catch (error) {
    return { supported: false, reason: safeError(error) };
  }
  if (catalog.discovery.mcp.failed) {
    return { supported: false, reason: "MCP discovery failed, so Vesper cannot confirm that this server name is unused. No changes were made." };
  }
  const existing = catalog.capabilities.find((capability) => capability.type === "mcp" && capability.codexName === configuration.name);
  if (existing) return { supported: false, reason: `MCP server ${existing.id} is already configured. Vesper will not overwrite an existing configuration; remove it explicitly, then configure it again.` };
  const id = `mcp:${encodeURIComponent(configuration.name)}`;
  const transportSummary = configuration.transport === "stdio"
    ? `stdio transport with the supplied executable and ${configuration.args.length} argument(s) (values omitted)`
    : `HTTP transport at ${new URL(configuration.url).origin}${configuration.bearerTokenEnvVar ? ` using the environment variable name ${configuration.bearerTokenEnvVar}` : ""}`;
  return {
    supported: true,
    operation: "configure",
    id,
    summary: `Add MCP server ${configuration.name} as ${transportSummary}. Codex will store an enabled server configuration in CODEX_HOME/config.toml. Vesper will not launch the server or read environment-variable values.`,
    args: configuration.transport === "stdio"
      ? ["mcp", "add", configuration.name, "--", configuration.command, ...configuration.args]
      : ["mcp", "add", configuration.name, "--url", configuration.url, ...(configuration.bearerTokenEnvVar ? ["--bearer-token-env-var", configuration.bearerTokenEnvVar] : [])],
    timeout: 30_000,
    recovery: `Remove this MCP configuration with "vesper capabilities remove ${id}".`,
    expectedState: "configured",
  };
}

function planPluginInstall({ capability }) {
  if (!capability.actions.includes("install") || !capability.marketplace) {
    return { supported: false, reason: `Install is not supported for ${capability.id}; Vesper cannot identify a documented provider source for it. No changes were made.` };
  }
  return {
    supported: true,
    operation: "install",
    id: capability.id,
    summary: `Install plugin ${capability.name} from marketplace ${capability.marketplace}. Codex may download remote plugin content and update its configuration/cache. Treat that content as untrusted; Vesper will not execute it.`,
    args: ["plugin", "add", capability.codexName, "--marketplace", capability.marketplace, "--json"],
    timeout: 120_000,
    recovery: `Remove this plugin with "vesper capabilities remove ${capability.id}".`,
    expectedState: "installed",
  };
}

function planPluginRemoval({ capability }) {
  if (!capability.actions.includes("remove")) return { supported: false, reason: `Remove is not supported for ${capability.id}. No changes were made.` };
  return {
    supported: true,
    operation: "remove",
    id: capability.id,
    summary: `Remove the cached Codex plugin ${capability.name} from marketplace ${capability.marketplace || "(marketplace unknown)"} using the Codex plugin command. This removes its cached copy; runtime-loaded state is unknown.`,
    args: ["plugin", "remove", capability.marketplace ? `${capability.codexName}@${capability.marketplace}` : capability.codexName, "--json"],
    timeout: 30_000,
    recovery: `Reinstall it with "vesper capabilities install ${capability.id}" if the marketplace still provides it.`,
    expectedState: "not_installed",
  };
}

function planMcpRemoval({ capability }) {
  if (!capability.actions.includes("remove")) return { supported: false, reason: `Remove is not supported for ${capability.id}. No changes were made.` };
  return {
    supported: true,
    operation: "remove",
    id: capability.id,
    summary: `Remove MCP server ${capability.name} from Codex configuration. Its server definition and related configuration may be removed by Codex.`,
    args: ["mcp", "remove", capability.codexName],
    timeout: 30_000,
    recovery: "Restore the displayed CODEX_HOME/config.toml backup, or configure the server again with " + `"vesper capabilities configure mcp ${capability.codexName} ...".`,
    expectedState: "absent",
  };
}

function verifyOperation(planned, catalog) {
  if (planned.id.startsWith("mcp:") && catalog.discovery.mcp.failed) return false;
  const matching = catalog.capabilities.find((capability) => capability.id === planned.id);
  if (planned.expectedState === "installed") return matching?.installationStatus === "installed";
  if (planned.expectedState === "configured") return matching?.type === "mcp" && matching.configurationStatus === "enabled";
  if (planned.expectedState === "not_installed") return !matching || matching.installationStatus === "not_installed";
  if (planned.expectedState === "absent") return !matching;
  return false;
}

function planConfigBackup(codexHome, filesystem) {
  const configPath = path.join(codexHome, "config.toml");
  let stat;
  try {
    stat = filesystem.lstatSync(configPath);
  } catch (error) {
    if (error.code === "ENOENT") return { configPath, path: null, missing: true };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("config.toml is not a regular file.");
  if (stat.size > MAX_BACKUP_BYTES) throw new Error(`config.toml exceeds the ${MAX_BACKUP_BYTES} byte backup limit.`);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return {
    configPath,
    path: path.join(codexHome, `config.toml.vesper-backup-${stamp}-${randomBytes(4).toString("hex")}.bak`),
    missing: false,
  };
}

function createConfigBackup(plan, filesystem) {
  if (plan.missing) return { path: null, missing: true };
  const noFollow = filesystem.constants?.O_NOFOLLOW || 0;
  const sourceFd = filesystem.openSync(plan.configPath, filesystem.constants.O_RDONLY | noFollow);
  let backupFd;
  try {
    const stat = filesystem.fstatSync(sourceFd);
    if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) throw new Error("config.toml changed or is no longer a regular file.");
    const content = filesystem.readFileSync(sourceFd);
    backupFd = filesystem.openSync(plan.path, "wx", 0o600);
    filesystem.writeFileSync(backupFd, content);
    filesystem.fchmodSync(backupFd, 0o600);
  } finally {
    filesystem.closeSync(sourceFd);
    if (backupFd !== undefined) filesystem.closeSync(backupFd);
  }
  return { path: plan.path, missing: false };
}

function renderOperationPlan(planned, backupPlan) {
  const lines = [
    "Vesper capability operation",
    `Target: ${safeTerminalText(planned.id)}`,
    `Operation: ${planned.operation}`,
    `Changes: ${safeTerminalText(planned.summary)}`,
  ];
  if (backupPlan.path) lines.push(`Backup: copy the existing CODEX_HOME/config.toml to ${safeTerminalText(backupPlan.path)} with mode 0600.`);
  else lines.push("Backup: no existing CODEX_HOME/config.toml is present; Vesper will use the inverse Codex command for recovery.");
  lines.push(`Recovery: ${safeTerminalText(planned.recovery)}`);
  lines.push(`Confirmation required: type the exact identifier ${safeTerminalText(planned.id)}.`);
  return `${lines.join("\n")}\n`;
}

function isSafeName(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function isSafeArgument(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function safeTerminalText(value) {
  return String(value ?? "").replace(/\u001b/gu, "\\x1b")
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").slice(0, 400);
}

function safeError(error) {
  return safeTerminalText(error?.message || error || "unknown error");
}

registerCapabilityManagementAdapter("plugin", {
  install: planPluginInstall,
  remove: planPluginRemoval,
});
registerCapabilityManagementAdapter("mcp", {
  configure: planMcpConfiguration,
  remove: planMcpRemoval,
});

module.exports = {
  createConfigBackup,
  parseMcpConfiguration,
  planConfigBackup,
  planOperation,
  registerCapabilityManagementAdapter,
  renderOperationPlan,
  runCapabilityOperation,
};
