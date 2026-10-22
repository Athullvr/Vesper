"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { inspectProjectPluginConfig, isSafePluginIdentity } = require("./plugin-project-config");

const MAX_DISCOVERY_ITEMS = 100;
const MAX_SCAN_ENTRIES = 2_000;
const MAX_SKILL_SCAN_DEPTH = 5;
const MAX_DISCOVERY_FILE_BYTES = 1_048_576;
const MAX_SKILL_FILE_BYTES = 32_768;

function discoverPlugins({ cwd, home = os.homedir(), codexHome = defaultCodexHome(home), filesystem = fs } = {}) {
  const marketplaceFiles = [
    { filePath: path.join(cwd, ".agents", "plugins", "marketplace.json"), source: "project .agents/plugins/marketplace.json", scope: "project" },
    { filePath: path.join(home, ".agents", "plugins", "marketplace.json"), source: "user ~/.agents/plugins/marketplace.json", scope: "user" },
  ];
  const uniqueFiles = new Map(marketplaceFiles.map((entry) => [path.resolve(entry.filePath), entry]));
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const cacheRead = readPluginCache(cacheRoot, filesystem);
  const projectConfig = inspectProjectPluginConfig(cwd, filesystem);
  const cachedPlugins = cacheRead.plugins;
  const entries = new Map();
  const notes = [];
  if (!cacheRead.complete) notes.push("CODEX_HOME plugin cache could not be completely inspected; cache-dependent installation state remains unknown.");
  if (projectConfig.status !== "ok") notes.push("Project plugin settings could not be read safely; project configuration state remains unknown.");

  for (const marketplace of uniqueFiles.values()) {
    const result = readJsonFile(marketplace.filePath, filesystem);
    if (result.status === "missing") continue;
    if (result.status !== "ok") {
      notes.push(`${marketplace.source}: status unknown (${result.reason}).`);
      continue;
    }
    const marketplaceName = safeName(result.value?.name);
    const plugins = result.value?.plugins;
    if (!marketplaceName || !Array.isArray(plugins)) {
      notes.push(`${marketplace.source}: status unknown (invalid marketplace catalog).`);
      continue;
    }

    for (const plugin of plugins.slice(0, MAX_SCAN_ENTRIES)) {
      const pluginName = safeName(plugin?.name);
      if (!pluginName) continue;
      const key = `${marketplaceName}\u0000${pluginName}`;
      const previous = entries.get(key);
      if (previous?.projectMarketplace && marketplace.scope !== "project") continue;
      const cached = cachedPlugins.get(key);
      const installed = Boolean(cached);
      const projectMarketplace = marketplace.scope === "project";
      const projectConfigIdentity = `${pluginName}@${marketplaceName}`;
      const configurationStatus = projectMarketplace && projectConfig.status === "ok"
        ? projectConfig.settings.get(projectConfigIdentity) || "unknown"
        : "unknown";
      const installation = plugin?.policy?.installation;
      let status = "unknown";
      let detail = "marketplace entry exists, but its availability policy is not known";
      if (installed) {
        status = "installed";
        detail = "cached plugin copy found; enabled or loaded state is unknown";
      } else if (!cacheRead.complete) {
        detail = "the plugin is listed, but cache state could not be fully checked";
      } else if (installation === "AVAILABLE") {
        status = "available";
        detail = "listed as available by this local marketplace";
      }
      if (configurationStatus === "enabled_project") detail = "the project Codex config enables this plugin; effective enablement and runtime loading remain unknown";
      if (configurationStatus === "disabled_project") detail = "the project Codex config disables this plugin; whether that project setting applies remains unknown";
      entries.set(key, {
        name: pluginName,
        displayName: safeName(plugin?.interface?.displayName) || safeName(plugin?.displayName) || pluginName,
        description: safeDescription(plugin?.description),
        marketplace: marketplaceName,
        projectMarketplace,
        projectConfigIdentity: projectMarketplace ? projectConfigIdentity : null,
        projectConfigPath: projectMarketplace ? projectConfig.configPath : null,
        projectConfigEditable: projectMarketplace && projectConfig.status === "ok" && projectConfig.safeToEdit &&
          !projectConfig.blockedIdentities?.has(projectConfigIdentity) && isSafePluginIdentity(projectConfigIdentity),
        configurationStatus,
        status,
        installationStatus: installed ? "installed" : cacheRead.complete ? "not_installed" : "unknown",
        source: installed ? `${marketplace.source}; CODEX_HOME plugin cache` : marketplace.source,
        location: installed ? [marketplace.filePath, cached.location] : [marketplace.filePath],
        detail,
      });
    }
    if (plugins.length > MAX_SCAN_ENTRIES) notes.push(`${marketplace.source}: catalog scan capped at ${MAX_SCAN_ENTRIES} entries.`);
  }

  for (const cached of cachedPlugins.values()) {
    const key = `${cached.marketplace}\u0000${cached.name}`;
    if (entries.has(key)) continue;
    entries.set(key, {
      name: cached.name,
      displayName: null,
      description: null,
      marketplace: cached.marketplace,
      projectMarketplace: false,
      projectConfigIdentity: null,
      projectConfigPath: null,
      projectConfigEditable: false,
      configurationStatus: "unknown",
      status: "installed",
      installationStatus: "installed",
      source: "CODEX_HOME/plugins/cache",
      location: [cached.location],
      detail: "cached plugin copy found; enabled or loaded state is unknown",
    });
  }

  const items = [...entries.values()].sort(compareDiscoveryItems).slice(0, MAX_DISCOVERY_ITEMS);
  if (!items.length) {
    notes.push("No local marketplace catalog or plugin cache entries were found; remote, universal, and managed plugin state is unknown.");
  }
  if (entries.size > MAX_DISCOVERY_ITEMS) notes.push(`Plugin output capped at ${MAX_DISCOVERY_ITEMS} entries.`);
  notes.push("Remote, universal, and managed marketplace state is unknown. Vesper reads only project .codex/config.toml for plugin overrides; user, cloud, system, trust, effective enablement, and runtime state remain unknown.");
  return { category: "plugins", items, notes };
}

async function discoverMcp({ cwd, codexHome = defaultCodexHome(), commandRunner = runCodexCommand } = {}) {
  const source = "codex mcp list --json (installed Codex CLI)";
  const location = path.join(codexHome, "config.toml");
  try {
    const result = await commandRunner("codex", ["mcp", "list", "--json"], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1_048_576,
      encoding: "utf8",
    });
    const raw = typeof result === "string" ? result : result?.stdout;
    let servers;
    try {
      servers = JSON.parse(raw);
    } catch {
      return {
        category: "mcp",
        items: [{ name: null, status: "unknown", source, location, detail: "Codex returned malformed JSON for MCP discovery; server state is unknown." }],
        notes: ["No server names or configuration values were printed."],
        failed: true,
      };
    }
    if (!Array.isArray(servers)) {
      return {
        category: "mcp",
        items: [{ name: null, status: "unknown", source, location, detail: "Codex returned an unexpected MCP list format; server state is unknown." }],
        notes: ["No server names or configuration values were printed."],
        failed: true,
      };
    }
    const items = [];
    for (const server of servers.slice(0, MAX_SCAN_ENTRIES)) {
      const name = safeName(server?.name);
      if (!name) continue;
      const status = server.enabled === true ? "installed" : server.enabled === false ? "available" : "unknown";
      const detail = server.enabled === true
        ? "configured and enabled in Codex"
        : server.enabled === false
          ? "configured but disabled in Codex"
          : "configured; enabled state was not reported";
      items.push({ name, displayName: safeName(server?.displayName), description: safeDescription(server?.description), status, source, location, detail });
    }
    items.sort(compareDiscoveryItems);
    const notes = [
      "For MCP, installed means configured and enabled; available means configured but disabled. Codex has no local catalogue of unconfigured servers.",
    ];
    if (!items.length) notes.unshift("No configured MCP servers were returned; whether other servers are available is unknown.");
    if (servers.length > MAX_SCAN_ENTRIES) notes.push(`MCP output capped at ${MAX_SCAN_ENTRIES} entries.`);
    return { category: "mcp", items: items.slice(0, MAX_DISCOVERY_ITEMS), notes };
  } catch (error) {
    const unavailable = error?.code === "ENOENT"
      ? "Codex CLI was not found on PATH; install it or correct PATH, then retry."
      : "Codex MCP discovery failed; check that the installed Codex CLI can run `codex mcp list --json`.";
    return {
      category: "mcp",
      items: [{ name: null, status: "unknown", source, location, detail: unavailable }],
      notes: ["No server names or configuration values were printed."],
      failed: true,
    };
  }
}

function discoverSkills({ cwd, home = os.homedir(), codexHome = defaultCodexHome(home), filesystem = fs } = {}) {
  const roots = [
    { directory: path.join(cwd, ".agents", "skills"), source: "project .agents/skills", scope: "project" },
    { directory: path.join(codexHome, "skills"), source: "user CODEX_HOME/skills", scope: "user" },
  ];
  const entries = [];
  const notes = [];

  for (const root of roots) {
    const scan = { directories: 0, capped: false, unreadable: false };
    scanSkillDirectory(root, root.directory, 0, filesystem, entries, scan);
    if (scan.capped) notes.push(`${root.source}: recursive scan capped at ${MAX_SCAN_ENTRIES} directories or depth ${MAX_SKILL_SCAN_DEPTH}.`);
    if (scan.unreadable) notes.push(`${root.source}: some nested directories could not be read; additional skill state is unknown.`);
  }

  entries.sort(compareDiscoveryItems);
  if (!entries.length) notes.push("No skill manifests were found in the documented project or user skill directories; other Codex skill sources and runtime-loaded state are unknown.");
  if (entries.length > MAX_DISCOVERY_ITEMS) notes.push(`Skill output capped at ${MAX_DISCOVERY_ITEMS} entries.`);
  notes.push("Codex exposes no separate installed or enabled skill state in these sources; Vesper reports valid SKILL.md files as available, while runtime loading or activation remains unknown.");
  return { category: "skills", items: entries.slice(0, MAX_DISCOVERY_ITEMS), notes };
}

function renderDiscovery(result) {
  const lines = [`Vesper ${result.category} discovery (read-only)`];
  if (result.items.length) {
    for (const item of result.items) {
      const label = item.name ? `${safeTerminalText(item.name)} · ${item.status}` : `${item.status}`;
      lines.push(`- ${label} — ${safeTerminalText(item.detail)} [source: ${safeTerminalText(item.source)}]`);
    }
  } else {
    lines.push(`- unknown — no ${result.category} entries could be confirmed from the sources checked.`);
  }
  for (const note of result.notes) lines.push(`Note: ${safeTerminalText(note)}`);
  return `${lines.join("\n")}\n`;
}

function readPluginCache(cacheRoot, filesystem) {
  const results = new Map();
  const marketplaceDirectories = readDirectory(cacheRoot, filesystem);
  if (marketplaceDirectories.status === "missing") return { plugins: results, complete: true };
  if (marketplaceDirectories.status !== "ok") return { plugins: results, complete: false };
  let scanned = 0;
  let complete = true;
  for (const marketplace of marketplaceDirectories.entries) {
    if (marketplace.isSymbolicLink()) {
      complete = false;
      continue;
    }
    if (!marketplace.isDirectory()) continue;
    if (scanned >= MAX_SCAN_ENTRIES) return { plugins: results, complete: false };
    scanned += 1;
    const pluginDirectories = readDirectory(path.join(cacheRoot, marketplace.name), filesystem);
    if (pluginDirectories.status !== "ok") {
      complete = false;
      continue;
    }
    for (const plugin of pluginDirectories.entries) {
      if (plugin.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (!plugin.isDirectory()) continue;
      if (scanned >= MAX_SCAN_ENTRIES) return { plugins: results, complete: false };
      scanned += 1;
      const versionDirectories = readDirectory(path.join(cacheRoot, marketplace.name, plugin.name), filesystem);
      if (versionDirectories.status !== "ok") {
        complete = false;
        continue;
      }
      if (!versionDirectories.entries.some((version) => version.isDirectory() && !version.isSymbolicLink())) continue;
      const marketplaceName = safeName(marketplace.name);
      const pluginName = safeName(plugin.name);
      if (!marketplaceName || !pluginName) continue;
      results.set(`${marketplaceName}\u0000${pluginName}`, {
        marketplace: marketplaceName,
        name: pluginName,
        location: path.join(cacheRoot, marketplace.name, plugin.name),
      });
    }
  }
  return { plugins: results, complete };
}

function readJsonFile(filePath, filesystem) {
  let stat;
  try {
    stat = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return { status: "error", reason: "file could not be inspected" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: "error", reason: "not a regular file" };
  if (stat.size > MAX_DISCOVERY_FILE_BYTES) return { status: "error", reason: "file exceeds the discovery size limit" };
  try {
    return { status: "ok", value: JSON.parse(filesystem.readFileSync(filePath, "utf8")) };
  } catch {
    return { status: "error", reason: "file is unreadable or invalid JSON" };
  }
}

function readSkillName(filePath, filesystem) {
  let stat;
  try {
    stat = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return { status: "error" };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return { status: "error" };
  try {
    const content = filesystem.readFileSync(filePath, "utf8");
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    const value = frontmatter?.match(/^\s*name\s*:\s*([^\r\n#]+?)\s*$/mu)?.[1]?.replace(/^["']|["']$/gu, "").trim();
    const rawDescription = frontmatter?.match(/^\s*description\s*:\s*([^\r\n]+?)\s*$/mu)?.[1]?.trim();
    const description = rawDescription && !["|", ">", "|-", ">-"].includes(rawDescription)
      ? safeDescription(rawDescription.replace(/^["']|["']$/gu, ""))
      : null;
    const name = safeName(value);
    return name ? { status: "ok", name, description } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

function scanSkillDirectory(root, directory, depth, filesystem, entries, scan) {
  if (depth > MAX_SKILL_SCAN_DEPTH || scan.directories >= MAX_SCAN_ENTRIES) {
    scan.capped = true;
    return;
  }
  const listing = readDirectory(directory, filesystem);
  if (listing.status === "missing") return;
  if (listing.status !== "ok") {
    scan.unreadable = true;
    return;
  }

  for (const child of listing.entries) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    if (scan.directories >= MAX_SCAN_ENTRIES) {
      scan.capped = true;
      return;
    }
    scan.directories += 1;
    const skillDirectory = path.join(directory, child.name);
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const skill = readSkillName(skillPath, filesystem);
    if (skill.status !== "missing") {
      const name = skill.status === "ok" ? skill.name : safeName(child.name);
      if (name) {
        const relativeSkillPath = path.relative(root.directory, skillPath).split(path.sep).join("/");
        entries.push({
          name,
          displayName: null,
          description: skill.description || null,
          status: skill.status === "ok" ? "available" : "unknown",
          source: `${root.source}/${relativeSkillPath}`,
          location: skillPath,
          sourceKey: `${root.scope}/${relativeSkillPath}`,
          detail: skill.status === "ok"
            ? "SKILL.md found; whether Codex loaded or activated it is unknown"
            : "skill file exists, but its metadata could not be verified",
        });
      }
      continue;
    }
    scanSkillDirectory(root, skillDirectory, depth + 1, filesystem, entries, scan);
    if (scan.capped) return;
  }
}

function readDirectory(directory, filesystem) {
  try {
    const stat = filesystem.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "error", reason: "not a regular directory" };
    return { status: "ok", entries: filesystem.readdirSync(directory, { withFileTypes: true }) };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return { status: "error", reason: "directory could not be read" };
  }
}

function safeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(name)) return null;
  return name;
}

function safeDescription(value) {
  if (typeof value !== "string") return null;
  const description = value.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim();
  return description ? description.slice(0, 1_000) : null;
}

function safeTerminalText(value) {
  return String(value ?? "").replace(/\u001b/gu, "\\x1b")
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").slice(0, 240);
}

function compareDiscoveryItems(left, right) {
  return left.name.localeCompare(right.name) || left.status.localeCompare(right.status);
}

function defaultCodexHome(home = os.homedir()) {
  return path.resolve(process.env.CODEX_HOME || path.join(home, ".codex"));
}

function runCodexCommand(command, args, { cwd, timeout = 10_000, maxBuffer = 1_048_576, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout, maxBuffer, encoding }, (error, stdout) => {
      if (error) {
        const safeError = new Error(error.code === "ENOENT" ? "Codex CLI was not found on PATH." : "Codex CLI command failed.");
        safeError.code = error.code;
        reject(safeError);
      } else {
        resolve(stdout);
      }
    });
  });
}

module.exports = {
  MAX_DISCOVERY_ITEMS,
  defaultCodexHome,
  discoverMcp,
  discoverPlugins,
  discoverSkills,
  renderDiscovery,
  runCodexCommand,
};
