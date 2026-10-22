"use strict";

const { discoverMcp, discoverPlugins, discoverSkills } = require("./integration-discovery");
const { RUNTIME_SOURCE, createCodexRuntimeStatusAdapter } = require("./codex-runtime-status");

const CAPABILITY_TYPES = Object.freeze(["plugin", "mcp", "skill"]);
const UNKNOWN = "unknown";
const RUNTIME_INSPECTION_TIMEOUT_MS = 2_000;

function encodeIdPart(value) {
  return encodeURIComponent(String(value)).replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

function pluginCapability(item) {
  const marketplace = typeof item.marketplace === "string" ? item.marketplace : null;
  const id = marketplace
    ? `plugin:${encodeIdPart(marketplace)}/${encodeIdPart(item.name)}`
    : `plugin:${encodeIdPart(item.name)}`;
  const cached = item.installationStatus === "installed" || item.status === "installed";
  const availableForInstall = item.status === "available";
  const configurationStatus = item.configurationStatus === "enabled_project" || item.configurationStatus === "disabled_project"
    ? item.configurationStatus
    : UNKNOWN;
  const actions = cached ? ["show", "remove"] : availableForInstall ? ["show", "install"] : ["show"];
  if (cached && item.projectMarketplace && item.projectConfigEditable) {
    if (configurationStatus !== "enabled_project") actions.push("enable");
    if (configurationStatus !== "disabled_project") actions.push("disable");
  }
  return {
    id,
    type: "plugin",
    name: item.name,
    displayName: typeof item.displayName === "string" ? item.displayName : item.name,
    description: typeof item.description === "string" ? item.description : null,
    source: { name: item.source, location: normalizeLocations(item.location) },
    discoveryStatus: "discovered",
    installationStatus: item.installationStatus || (cached ? "installed" : availableForInstall ? "not_installed" : UNKNOWN),
    configurationStatus,
    enabledStatus: statusFromConfiguration(configurationStatus),
    availabilityStatus: availableForInstall ? "available_for_install" : UNKNOWN,
    runtimeLoadedStatus: UNKNOWN,
    operationalStatus: UNKNOWN,
    runtimeEvidence: unknownRuntimeEvidence(),
    requirementsStatus: UNKNOWN,
    requiredPermissions: { status: UNKNOWN, items: [] },
    declaredCapabilities: { status: UNKNOWN, items: [] },
    actions,
    detail: String(item.detail || "Capability metadata is unavailable."),
    marketplace,
    codexName: item.name,
    projectMarketplace: item.projectMarketplace === true,
    projectConfigIdentity: typeof item.projectConfigIdentity === "string" ? item.projectConfigIdentity : null,
    projectConfigPath: typeof item.projectConfigPath === "string" ? item.projectConfigPath : null,
    projectConfigEditable: item.projectConfigEditable === true,
  };
}

function mcpCapability(item) {
  const configured = item.status === "installed" || item.status === "available";
  const enabled = item.status === "installed" ? true : item.status === "available" ? false : null;
  return {
    id: `mcp:${encodeIdPart(item.name)}`,
    type: "mcp",
    name: item.name,
    displayName: typeof item.displayName === "string" ? item.displayName : item.name,
    description: typeof item.description === "string" ? item.description : null,
    source: { name: item.source, location: normalizeLocations(item.location) },
    discoveryStatus: "discovered",
    installationStatus: "not_applicable",
    configurationStatus: configured ? (enabled ? "enabled" : "disabled") : UNKNOWN,
    enabledStatus: enabled === true ? "yes" : enabled === false ? "no" : UNKNOWN,
    availabilityStatus: enabled === false ? "unavailable" : UNKNOWN,
    runtimeLoadedStatus: UNKNOWN,
    operationalStatus: UNKNOWN,
    runtimeEvidence: unknownRuntimeEvidence(),
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
    displayName: typeof item.displayName === "string" ? item.displayName : item.name,
    description: typeof item.description === "string" ? item.description : null,
    source: { name: item.source, location: normalizeLocations(item.location) },
    discoveryStatus: "discovered",
    installationStatus: "not_applicable",
    configurationStatus: item.status === "available" ? "present" : UNKNOWN,
    enabledStatus: UNKNOWN,
    availabilityStatus: UNKNOWN,
    runtimeLoadedStatus: UNKNOWN,
    operationalStatus: UNKNOWN,
    runtimeEvidence: unknownRuntimeEvidence(),
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
const defaultSourceAdapters = new Map([
  ["plugins", {
    type: "plugin",
    discover: ({ cwd, discoveryOptions }) => discoverPlugins({ cwd, ...discoveryOptions }),
  }],
  ["mcp", {
    type: "mcp",
    discover: ({ cwd, discoveryOptions, commandRunner }) => discoverMcp({
      cwd,
      codexHome: discoveryOptions.codexHome,
      commandRunner,
    }),
  }],
  ["skills", {
    type: "skill",
    discover: ({ cwd, discoveryOptions }) => discoverSkills({ cwd, ...discoveryOptions }),
  }],
]);

function registerCapabilityType(type, mapper, registry = defaultMappers) {
  if (typeof type !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(type)) {
    throw new TypeError("Capability types must be short lowercase identifiers.");
  }
  if (typeof mapper !== "function") throw new TypeError("A capability mapper function is required.");
  registry.set(type, mapper);
  return registry;
}

function registerCapabilitySourceAdapter(sourceName, adapter, registry = defaultSourceAdapters) {
  if (typeof sourceName !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(sourceName)) {
    throw new TypeError("Capability source names must be short lowercase identifiers.");
  }
  if (!adapter || typeof adapter !== "object" || typeof adapter.discover !== "function") {
    throw new TypeError("A capability source adapter needs a discover function.");
  }
  if (typeof adapter.type !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(adapter.type)) {
    throw new TypeError("Capability source adapters need a capability type.");
  }
  registry.set(sourceName, Object.freeze({ type: adapter.type, discover: adapter.discover }));
  return registry;
}

async function buildCapabilityCatalog({
  cwd,
  discoveryOptions = {},
  commandRunner,
  mapperRegistry = defaultMappers,
  sourceAdapters = defaultSourceAdapters,
  runtimeStatusAdapter = createCodexRuntimeStatusAdapter(),
} = {}) {
  if (typeof cwd !== "string" || !cwd) throw new TypeError("A project directory is required for capability discovery.");
  const sources = await Promise.all([...sourceAdapters.entries()].map(async ([sourceName, adapter]) => {
    let result;
    try {
      result = await adapter.discover({ cwd, discoveryOptions, commandRunner });
    } catch {
      result = { items: [], notes: ["Discovery source failed; related capability state is unknown."], failed: true };
    }
    return { sourceName, type: adapter.type, result };
  }));
  const capabilities = [];
  const diagnostics = [];

  for (const source of sources) {
    const result = source.result;
    for (const note of result.notes || []) {
      diagnostics.push({ type: source.type, message: String(note) });
    }
    for (const item of result.items || []) {
      if (!item.name) {
        if (item.detail) diagnostics.push({ type: source.type, message: String(item.detail) });
        continue;
      }
      const mapper = mapperRegistry.get(source.type);
      if (!mapper) {
        diagnostics.push({ type: source.type, message: "No capability adapter is registered for this type." });
        continue;
      }
      capabilities.push(mapper(item));
    }
    if (result.failed) diagnostics.push({ type: source.type, message: "Discovery did not complete; related status remains unknown." });
  }

  capabilities.sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  const runtimeInspection = await inspectRuntimeStatus(runtimeStatusAdapter, createRuntimeStatusContext(cwd, capabilities));
  applyRuntimeInspection(capabilities, runtimeInspection);
  const discovery = {};
  for (const source of sources) {
    discovery[source.type] = {
      failed: Boolean(source.result.failed),
      count: (source.result.items || []).filter((item) => item.name).length,
    };
  }
  return {
    schemaVersion: 1,
    projectDirectory: cwd,
    capabilities,
    runtimeInspection,
    diagnostics,
    discovery,
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
      let catalog = await load();
      if (options?.runtimeStatusAdapter) {
        const base = {
          ...catalog,
          capabilities: catalog.capabilities.map((capability) => ({
            ...capability,
            availabilityStatus: capability.type === "mcp"
              ? capability.configurationStatus === "disabled" ? "unavailable" : UNKNOWN
              : capability.type === "plugin" && capability.availabilityStatus === "available_for_install"
                ? "available_for_install"
                : UNKNOWN,
            runtimeLoadedStatus: UNKNOWN,
            operationalStatus: UNKNOWN,
            runtimeEvidence: unknownRuntimeEvidence("unknown", "No runtime evidence is available.", catalog.runtimeInspection.source),
          })),
        };
        const runtimeInspection = await inspectRuntimeStatus(
          options.runtimeStatusAdapter,
          createRuntimeStatusContext(base.projectDirectory, base.capabilities),
        );
        applyRuntimeInspection(base.capabilities, runtimeInspection);
        base.runtimeInspection = runtimeInspection;
        catalog = base;
      }
      return {
        schemaVersion: 1,
        runtimeInspection: catalog.runtimeInspection.status,
        items: catalog.capabilities.map((capability) => ({
          id: safeText(capability.id).slice(0, 240),
          type: safeText(capability.type).slice(0, 40),
          name: safeText(capability.name).slice(0, 120),
          discovered: true,
          enabled: normalizeYesNoUnknown(capability.enabledStatus),
          configured: normalizeConfiguredStatus(capability.configurationStatus),
          installation: ["installed", "not_installed", "not_applicable", UNKNOWN].includes(capability.installationStatus) ? capability.installationStatus : UNKNOWN,
          availableForUse: capability.availabilityStatus === "available_for_use"
            ? "yes"
            : capability.availabilityStatus === "unavailable" || capability.availabilityStatus === "available_for_install"
              ? "no"
              : "unknown",
          requirements: ["missing", "satisfied", "not_applicable", UNKNOWN].includes(capability.requirementsStatus) ? capability.requirementsStatus : UNKNOWN,
          runtimeLoaded: normalizeYesNoUnknown(capability.runtimeLoadedStatus),
          runtimeEvidence: ["observed", "unsupported", "error", "unknown"].includes(capability.runtimeEvidence.status) ? capability.runtimeEvidence.status : UNKNOWN,
          operational: normalizeYesNoUnknown(capability.operationalStatus),
        })),
      };
    },
  });
}

function statusFromConfiguration(configurationStatus) {
  if (configurationStatus === "enabled" || configurationStatus === "enabled_project") return "yes";
  if (configurationStatus === "disabled" || configurationStatus === "disabled_project") return "no";
  return UNKNOWN;
}

function normalizeYesNoUnknown(value) {
  return ["yes", "no", UNKNOWN].includes(value) ? value : UNKNOWN;
}

function normalizeConfiguredStatus(configurationStatus) {
  if (["enabled", "enabled_project"].includes(configurationStatus)) return "yes";
  if (["disabled", "disabled_project"].includes(configurationStatus)) return "no";
  return UNKNOWN;
}

function createRuntimeStatusContext(cwd, capabilities) {
  return {
    cwd: typeof cwd === "string" ? safeText(cwd).slice(0, 2_048) : "",
    capabilities: capabilities.slice(0, 100).map((capability) => ({
      id: safeText(capability.id).slice(0, 240),
      type: safeText(capability.type).slice(0, 40),
      name: safeText(capability.codexName || capability.name).slice(0, 120),
    })),
  };
}

function unknownRuntimeEvidence(status = "unknown", detail = "No runtime evidence is available.", source = RUNTIME_SOURCE) {
  return { status, source, observedAt: null, detail };
}

async function inspectRuntimeStatus(adapter, context) {
  const checkedAt = new Date().toISOString();
  if (!adapter || typeof adapter.inspect !== "function") {
    return makeRuntimeInspection("unsupported", checkedAt);
  }
  const adapterProvider = normalizeProvider(adapter.provider);

  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), RUNTIME_INSPECTION_TIMEOUT_MS);
    });
    const result = await Promise.race([Promise.resolve().then(() => adapter.inspect(context)), timeout]);
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.items)) {
      return makeRuntimeInspection("error", checkedAt, adapterProvider);
    }
    let status = ["unsupported", "available", "observed", "partial", "error"].includes(result.status) ? result.status : "error";
    const provider = normalizeProvider(result.provider || adapter.provider);
    const source = normalizeRuntimeSource(result.source) || (provider === "codex-app-server" ? RUNTIME_SOURCE : "runtime status adapter");
    const rawItems = result.items.slice(0, 100);
    const items = rawItems.map((item) => normalizeRuntimeItem(item, provider, source)).filter(Boolean);
    const malformedCount = Math.min(100, (Number.isSafeInteger(result.malformedCount) ? Math.max(0, result.malformedCount) : 0) + rawItems.length - items.length);
    if (malformedCount > 0 && ["observed", "available"].includes(status)) status = items.length ? "partial" : "error";
    if (status === "observed" && !items.length) return makeRuntimeInspection("error", checkedAt, provider);
    return {
      status,
      provider,
      source,
      checkedAt: normalizeTimestamp(result.checkedAt) || checkedAt,
      items,
      omittedItems: Math.min(100_000, (Number.isSafeInteger(result.omittedItems) ? Math.max(0, result.omittedItems) : 0) + Math.max(0, result.items.length - rawItems.length)),
      malformedCount,
      detail: runtimeInspectionDetail(status, provider, malformedCount),
    };
  } catch {
    return makeRuntimeInspection("error", checkedAt, adapterProvider);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRuntimeItem(item, provider, defaultSource) {
  if (!item || typeof item !== "object" ||
      typeof item.type !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(item.type) ||
      typeof item.name !== "string" || !item.name || item.name.length > 120 ||
      /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(item.name) ||
      !["yes", "no", UNKNOWN].includes(item.runtimeLoadedStatus) ||
      !["yes", "no", UNKNOWN].includes(item.operationalStatus) ||
      ![UNKNOWN, "available_for_use", "unavailable", "available_for_install"].includes(item.availabilityStatus)) return null;
  const startupStatus = ["starting", "ready", "failed", "cancelled"].includes(item.startupStatus) ? item.startupStatus : null;
  return {
    type: item.type,
    name: item.name,
    startupStatus,
    runtimeLoadedStatus: item.runtimeLoadedStatus,
    availabilityStatus: item.availabilityStatus,
    operationalStatus: item.operationalStatus,
    observedAt: normalizeTimestamp(item.observedAt),
    source: normalizeRuntimeSource(item.source) || defaultSource,
    detail: provider === "codex-app-server" && startupStatus ? runtimeItemDetail(startupStatus) : `Runtime status reported by ${provider}.`,
  };
}

function normalizeProvider(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,39}$/u.test(value) ? value : "unknown-provider";
}

function normalizeRuntimeSource(value) {
  return typeof value === "string" && value.length <= 120 && /^[a-zA-Z0-9 ._:/-]+$/u.test(value) ? value : null;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function makeRuntimeInspection(status, checkedAt, provider = "codex-app-server") {
  return {
    status,
    provider,
    source: provider === "codex-app-server" ? RUNTIME_SOURCE : "runtime status adapter",
    checkedAt,
    items: [],
    omittedItems: 0,
    malformedCount: 0,
    detail: runtimeInspectionDetail(status, provider),
  };
}

function runtimeInspectionDetail(status, provider = "codex-app-server", malformedCount = 0) {
  if (malformedCount > 0 && status === "partial") {
    return "Some MCP startup notifications were malformed and ignored. Valid observations remain visible; raw error text is withheld.";
  }
  if (provider !== "codex-app-server") return `Runtime inspection ${status} through the ${provider} adapter.`;
  switch (status) {
    case "observed": return "Read only MCP startup notifications already observed by this Codex app-server thread; no RPC, health probe, or server launch was performed.";
    case "partial": return "Some MCP startup notifications were malformed and ignored. Valid observations remain visible; raw error text is withheld.";
    case "available": return "Passive MCP startup status is supported by the existing runtime, but no notification was observed. Absence does not establish unavailability.";
    case "error": return "Codex runtime status could not be read safely; runtime state remains unknown.";
    default: return "No already-connected Codex app-server thread is available. Vesper does not start a runtime for status inspection.";
  }
}

function runtimeItemDetail(status) {
  switch (status) {
    case "ready": return "Codex reported MCP startup ready; Vesper did not run a health check or tool call.";
    case "failed": return "Codex reported MCP startup failure; raw runtime error text is withheld.";
    case "cancelled": return "Codex reported MCP startup cancellation.";
    default: return "Codex reported MCP startup in progress.";
  }
}

function applyRuntimeInspection(capabilities, inspection) {
  const runtimeItems = new Map((inspection.items || []).map((item) => [`${item.type}\u0000${item.name}`, item]));
  for (const capability of capabilities) {
    capability.enabledStatus ||= statusFromConfiguration(capability.configurationStatus);
    capability.availabilityStatus ||= UNKNOWN;
    capability.runtimeLoadedStatus ||= UNKNOWN;
    capability.operationalStatus ||= UNKNOWN;
    const runtimeItem = runtimeItems.get(`${capability.type}\u0000${capability.codexName || capability.name}`);
    if (runtimeItem) {
      if (runtimeItem.runtimeLoadedStatus !== UNKNOWN) capability.runtimeLoadedStatus = runtimeItem.runtimeLoadedStatus;
      if (runtimeItem.availabilityStatus !== UNKNOWN) capability.availabilityStatus = runtimeItem.availabilityStatus;
      if (runtimeItem.operationalStatus !== UNKNOWN) capability.operationalStatus = runtimeItem.operationalStatus;
      capability.runtimeEvidence = {
        status: "observed",
        source: runtimeItem.source,
        observedAt: runtimeItem.observedAt,
        detail: runtimeItem.detail,
      };
      continue;
    }
    if (inspection.provider === "codex-app-server" && ["plugin", "skill"].includes(capability.type)) {
      capability.runtimeEvidence = unknownRuntimeEvidence(
        "unsupported",
        "The inspected Codex app-server protocol has no passive runtime-loaded signal for this capability type.",
      );
      continue;
    }
    const evidenceStatus = inspection.status === "unsupported" ? "unsupported" : ["error", "partial"].includes(inspection.status) ? "error" : "unknown";
    capability.runtimeEvidence = unknownRuntimeEvidence(evidenceStatus, inspection.detail, inspection.source);
  }
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
    enabledConfiguration: 0,
    enabledYes: 0,
    enabledNo: 0,
    enabledUnknown: 0,
    installed: 0,
    installationUnknown: 0,
    availableForInstall: 0,
    availableForUse: 0,
    unknown: 0,
    runtimeLoadedYes: 0,
    runtimeLoadedNo: 0,
    runtimeLoadedUnknown: 0,
    operationalYes: 0,
    operationalNo: 0,
    operationalUnknown: 0,
    byType: {},
  };
  const types = new Set([...CAPABILITY_TYPES, ...catalog.capabilities.map((capability) => capability.type)]);
  for (const type of [...types].sort()) {
    const entries = catalog.capabilities.filter((capability) => capability.type === type);
    summary.byType[type] = entries.length;
    for (const capability of entries) {
      if (["enabled", "disabled", "enabled_project", "disabled_project"].includes(capability.configurationStatus)) summary.configured += 1;
      if (capability.configurationStatus === "disabled" || capability.configurationStatus === "disabled_project") summary.disabled += 1;
      if (capability.configurationStatus === "enabled" || capability.configurationStatus === "enabled_project") summary.enabledConfiguration += 1;
      if (capability.enabledStatus === "yes") summary.enabledYes += 1;
      else if (capability.enabledStatus === "no") summary.enabledNo += 1;
      else summary.enabledUnknown += 1;
      if (capability.installationStatus === "installed") summary.installed += 1;
      else if (capability.installationStatus === UNKNOWN) summary.installationUnknown += 1;
      if (capability.availabilityStatus === "available_for_install") summary.availableForInstall += 1;
      if (capability.availabilityStatus === "available_for_use") summary.availableForUse += 1;
      if (capability.availabilityStatus === UNKNOWN) summary.unknown += 1;
      if (capability.runtimeLoadedStatus === "yes") summary.runtimeLoadedYes += 1;
      else if (capability.runtimeLoadedStatus === "no") summary.runtimeLoadedNo += 1;
      else summary.runtimeLoadedUnknown += 1;
      if (capability.operationalStatus === "yes") summary.operationalYes += 1;
      else if (capability.operationalStatus === "no") summary.operationalNo += 1;
      else summary.operationalUnknown += 1;
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
    `Enabled: ${safeText(capability.enabledStatus)}`,
    `Available for use: ${safeText(capability.availabilityStatus)}`,
    `Runtime loaded: ${safeText(capability.runtimeLoadedStatus)}`,
    `Operational: ${safeText(capability.operationalStatus)}`,
    `Runtime evidence: ${safeText(capability.runtimeEvidence?.status || UNKNOWN)}`,
    `Runtime source: ${safeText(capability.runtimeEvidence?.source || "unknown")}`,
    `Runtime observed at: ${safeText(capability.runtimeEvidence?.observedAt || "unknown")}`,
    `Runtime detail: ${safeText(capability.runtimeEvidence?.detail || "unknown")}`,
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
    `Installed: ${summary.installed} · installation unknown: ${summary.installationUnknown}`,
    `Enabled: yes ${summary.enabledYes} · no ${summary.enabledNo} · unknown ${summary.enabledUnknown}`,
    `Available to install: ${summary.availableForInstall}`,
    `Enabled configuration: ${summary.enabledConfiguration}`,
    `Available for use: ${summary.availableForUse}`,
    `Unknown availability: ${summary.unknown}`,
    `Runtime loaded: yes ${summary.runtimeLoadedYes} · no ${summary.runtimeLoadedNo} · unknown ${summary.runtimeLoadedUnknown}`,
    `Operational: yes ${summary.operationalYes} · no ${summary.operationalNo} · unknown ${summary.operationalUnknown}`,
    `Runtime inspection: ${safeText(catalog.runtimeInspection?.status || "unsupported")}`,
    `Runtime source: ${safeText(catalog.runtimeInspection?.source || "unknown")}`,
    `Runtime checked at: ${safeText(catalog.runtimeInspection?.checkedAt || "unknown")}`,
    `Runtime observations omitted: ${safeText(catalog.runtimeInspection?.omittedItems || 0)}`,
    `Malformed runtime notifications: ${safeText(catalog.runtimeInspection?.malformedCount || 0)}`,
    `Runtime note: ${safeText(catalog.runtimeInspection?.detail || "No runtime status adapter is available.")}`,
    `By type: ${Object.entries(summary.byType).map(([type, count]) => `${safeText(type)} ${count}`).join(", ") || "none"}`,
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
  return String(value ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
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
  registerCapabilitySourceAdapter,
  renderCapability,
  renderCapabilityList,
  renderCatalogStatus,
  searchCapabilities,
  summarizeCatalog,
};
