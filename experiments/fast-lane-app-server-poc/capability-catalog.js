"use strict";

const { discoverMcp, discoverPlugins, discoverSkills } = require("./integration-discovery");

const CAPABILITY_TYPES = Object.freeze(["plugin", "mcp", "skill"]);
const UNKNOWN = "unknown";

function encodeIdPart(value) {
  return encodeURIComponent(String(value)).replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

function pluginCapability(item) {
  const marketplace = typeof item.marketplace === "string" ? item.marketplace : null;
  const id = marketplace
    ? `plugin:${encodeIdPart(marketplace)}/${encodeIdPart(item.name)}`
    : `plugin:${encodeIdPart(item.name)}`;
  const cached = item.status === "installed";
  const availableForInstall = item.status === "available";
  return {
    id,
    type: "plugin",
    name: item.name,
    displayName: item.name,
    description: typeof item.description === "string" ? item.description : null,
    source: { name: item.source, location: normalizeLocations(item.location) },
    discoveryStatus: "discovered",
    installationStatus: cached ? "installed" : availableForInstall ? "not_installed" : UNKNOWN,
    configurationStatus: UNKNOWN,
    availabilityStatus: availableForInstall ? "available_for_install" : UNKNOWN,
    operationalStatus: UNKNOWN,
    requirementsStatus: UNKNOWN,
    requiredPermissions: { status: UNKNOWN, items: [] },
    declaredCapabilities: { status: UNKNOWN, items: [] },
    actions: cached ? ["show", "remove"] : availableForInstall ? ["show", "install"] : ["show"],
    detail: String(item.detail || "Capability metadata is unavailable."),
    marketplace,
    codexName: item.name,
  };
}

function mcpCapability(item) {
  const configured = item.status === "installed" || item.status === "available";
  const enabled = item.status === "installed" ? true : item.status === "available" ? false : null;
  return {
    id: `mcp:${encodeIdPart(item.name)}`,
    type: "mcp",
    name: item.name,
    displayName: item.name,
    description: typeof item.description === "string" ? item.description : null,
    source: { name: item.source, location: normalizeLocations(item.location) },
    discoveryStatus: "discovered",
    installationStatus: "not_applicable",
    configurationStatus: configured ? (enabled ? "enabled" : "disabled") : UNKNOWN,
    availabilityStatus: enabled === true ? "available_for_use" : enabled === false ? "unavailable" : UNKNOWN,
    operationalStatus: UNKNOWN,
    requirementsStatus: UNKNOWN,
    requiredPermissions: { status: UNKNOWN, items: [] },
    declaredCapabilities: { status: UNKNOWN, items: [] },
    actions: configured ? ["show", "remove"] : ["show"],
    detail: String(item.detail || "MCP configuration metadata is unavailable."),
    codexName: item.name,
  };
}

function skillCapability(item) {
  const sourceKey = typeof item.sourceKey === "string" ? item.sourceKey : item.source;
  return {
    id: `skill:${String(sourceKey).split("/").map(encodeIdPart).join("/")}`,
    type: "skill",
    name: item.name,
    displayName: item.name,
    description: typeof item.description === "string" ? item.description : null,
    source: { name: item.source, location: normalizeLocations(item.location) },
    discoveryStatus: "discovered",
    installationStatus: "not_applicable",
    configurationStatus: item.status === "available" ? "present" : UNKNOWN,
    availabilityStatus: UNKNOWN,
    operationalStatus: UNKNOWN,
    requirementsStatus: UNKNOWN,
    requiredPermissions: { status: UNKNOWN, items: [] },
    declaredCapabilities: { status: UNKNOWN, items: [] },
    actions: ["show"],
    detail: String(item.detail || "Skill metadata is unavailable."),
  };
}

const defaultMappers = new Map([
  ["plugin", pluginCapability],
  ["mcp", mcpCapability],
  ["skill", skillCapability],
]);

function registerCapabilityType(type, mapper, registry = defaultMappers) {
  if (typeof type !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(type)) {
    throw new TypeError("Capability types must be short lowercase identifiers.");
  }
  if (typeof mapper !== "function") throw new TypeError("A capability mapper function is required.");
  registry.set(type, mapper);
  return registry;
}

async function buildCapabilityCatalog({
  cwd,
  discoveryOptions = {},
  commandRunner,
  mapperRegistry = defaultMappers,
} = {}) {
  if (typeof cwd !== "string" || !cwd) throw new TypeError("A project directory is required for capability discovery.");
  const [plugins, mcp, skills] = await Promise.all([
    Promise.resolve(discoverPlugins({ cwd, ...discoveryOptions })),
    discoverMcp({
      cwd,
      codexHome: discoveryOptions.codexHome,
      commandRunner,
    }),
    Promise.resolve(discoverSkills({ cwd, ...discoveryOptions })),
  ]);
  const sources = [plugins, mcp, skills];
  const capabilities = [];
  const diagnostics = [];

  for (const result of sources) {
    for (const note of result.notes || []) {
      diagnostics.push({ type: result.category, message: String(note) });
    }
    for (const item of result.items || []) {
      if (!item.name) {
        if (item.detail) diagnostics.push({ type: result.category, message: String(item.detail) });
        continue;
      }
      const type = result.category === "plugins" ? "plugin" : result.category === "mcp" ? "mcp" : "skill";
      const mapper = mapperRegistry.get(type);
      if (!mapper) {
        diagnostics.push({ type, message: "No capability adapter is registered for this type." });
        continue;
      }
      capabilities.push(mapper(item));
    }
    if (result.failed) diagnostics.push({ type: result.category, message: "Discovery did not complete; related status remains unknown." });
  }

  capabilities.sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    projectDirectory: cwd,
    capabilities,
    diagnostics,
    discovery: {
      plugins: { failed: Boolean(plugins.failed), count: plugins.items.filter((item) => item.name).length },
      mcp: { failed: Boolean(mcp.failed), count: mcp.items.filter((item) => item.name).length },
      skills: { failed: Boolean(skills.failed), count: skills.items.filter((item) => item.name).length },
    },
  };
}

function createCapabilityProvider(options) {
  let snapshotPromise;
  const load = () => {
    if (!snapshotPromise) snapshotPromise = buildCapabilityCatalog(options).catch((error) => {
      snapshotPromise = null;
      throw error;
    });
    return snapshotPromise;
  };
  return Object.freeze({
    async getCatalog({ refresh = false } = {}) {
      if (refresh) snapshotPromise = null;
      return load();
    },
    async getRouterContext() {
      const catalog = await load();
      return {
        schemaVersion: 1,
        items: catalog.capabilities.map((capability) => ({
          id: capability.id,
          type: capability.type,
          name: capability.name,
          discovered: true,
          configured: capability.configurationStatus === "enabled" || capability.configurationStatus === "disabled"
            ? "yes"
            : capability.configurationStatus === "present" ? "unknown" : capability.configurationStatus === "unknown" ? "unknown" : "no",
          availableForUse: capability.availabilityStatus === "available_for_use"
            ? "yes"
            : capability.availabilityStatus === "unavailable" || capability.availabilityStatus === "available_for_install"
              ? "no"
              : "unknown",
          requirements: capability.requirementsStatus,
          operational: capability.operationalStatus,
        })),
      };
    },
  });
}

function findCapability(catalog, id) {
  return catalog.capabilities.find((capability) => capability.id === id) || null;
}

function searchCapabilities(catalog, query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return [...catalog.capabilities];
  return catalog.capabilities.filter((capability) => normalizeSearch([
    capability.id,
    capability.type,
    capability.name,
    capability.displayName,
    capability.description || "",
    capability.source.name,
    capability.detail,
  ].join(" ")).includes(normalized));
}

function summarizeCatalog(catalog) {
  const summary = {
    total: catalog.capabilities.length,
    discovered: catalog.capabilities.length,
    configured: 0,
    disabled: 0,
    availableForInstall: 0,
    availableForUse: 0,
    unknown: 0,
    byType: {},
  };
  for (const type of CAPABILITY_TYPES) {
    const entries = catalog.capabilities.filter((capability) => capability.type === type);
    summary.byType[type] = entries.length;
    for (const capability of entries) {
      if (capability.configurationStatus === "enabled" || capability.configurationStatus === "disabled") summary.configured += 1;
      if (capability.configurationStatus === "disabled") summary.disabled += 1;
      if (capability.availabilityStatus === "available_for_install") summary.availableForInstall += 1;
      if (capability.availabilityStatus === "available_for_use") summary.availableForUse += 1;
      if (capability.availabilityStatus === UNKNOWN) summary.unknown += 1;
    }
  }
  return summary;
}

function renderCapabilityList(capabilities, title = "Vesper capabilities · local discovery") {
  const lines = [title];
  if (!capabilities.length) {
    lines.push("No capabilities were confirmed from the local sources checked.");
    return `${lines.join("\n")}\n`;
  }
  for (const capability of capabilities) {
    lines.push(`${safeText(capability.id)} · ${safeText(capability.type)} · ${safeText(capability.displayName)} · configuration ${safeText(capability.configurationStatus)} · use ${safeText(capability.availabilityStatus)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderCapability(capability) {
  const lines = [
    `Capability ${safeText(capability.id)}`,
    `Type: ${safeText(capability.type)}`,
    `Name: ${safeText(capability.displayName)}`,
    `Description: ${capability.description ? safeText(capability.description) : "unknown (not provided or unavailable)"}`,
    `Discovered: yes`,
    `Discovery source: ${safeText(capability.source.name)}`,
    `Installation: ${safeText(capability.installationStatus)}`,
    `Configuration: ${safeText(capability.configurationStatus)}`,
    `Available for use: ${safeText(capability.availabilityStatus)}`,
    `Operational: ${safeText(capability.operationalStatus)} (Vesper does not perform a live health check)`,
    `Requirements: ${safeText(capability.requirementsStatus)}`,
    `Required permissions: ${capability.requiredPermissions.status === "unknown" ? "unknown (not declared by the inspected source)" : safeText(capability.requiredPermissions.items.join(", "))}`,
    `Declared capabilities: ${capability.declaredCapabilities.status === "unknown" ? "unknown (not declared by the inspected source)" : safeText(capability.declaredCapabilities.items.join(", "))}`,
    `Vesper actions: ${safeText(capability.actions.join(", ") || "show")}`,
    `Discovery detail: ${safeText(capability.detail)}`,
  ];
  const locations = capability.source.location || [];
  if (locations.length) {
    lines.push(`Location${locations.length === 1 ? "" : "s"}:`);
    for (const location of locations) lines.push(`  - ${safeText(location)}`);
  } else {
    lines.push("Location: unknown");
  }
  return `${lines.join("\n")}\n`;
}

function renderCatalogStatus(catalog) {
  const summary = summarizeCatalog(catalog);
  const lines = [
    "Vesper capability status · local discovery",
    `Discovered: ${summary.discovered}`,
    `Configured: ${summary.configured}`,
    `Disabled: ${summary.disabled}`,
    `Available to install: ${summary.availableForInstall}`,
    `Configured for use: ${summary.availableForUse} (operational state remains unknown)`,
    `Unknown availability: ${summary.unknown}`,
    `By type: plugin ${summary.byType.plugin}, MCP ${summary.byType.mcp}, skill ${summary.byType.skill}`,
  ];
  if (catalog.diagnostics.length) {
    lines.push("Discovery notes:");
    for (const diagnostic of catalog.diagnostics.slice(0, 30)) {
      lines.push(`- ${safeText(diagnostic.type)}: ${safeText(diagnostic.message)}`);
    }
    if (catalog.diagnostics.length > 30) lines.push(`- Additional notes omitted: ${catalog.diagnostics.length - 30}.`);
  }
  return `${lines.join("\n")}\n`;
}

function normalizeLocations(location) {
  if (Array.isArray(location)) return location.filter((entry) => typeof entry === "string");
  return typeof location === "string" ? [location] : [];
}

function normalizeSearch(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().trim().replace(/\s+/gu, " ");
}

function safeText(value) {
  return String(value ?? "").replace(/\u001b/gu, "\\x1b")
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").slice(0, 1_024);
}

module.exports = {
  CAPABILITY_TYPES,
  UNKNOWN,
  buildCapabilityCatalog,
  createCapabilityProvider,
  findCapability,
  normalizeLocations,
  registerCapabilityType,
  renderCapability,
  renderCapabilityList,
  renderCatalogStatus,
  searchCapabilities,
  summarizeCatalog,
};
