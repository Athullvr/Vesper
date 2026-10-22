"use strict";

const MAX_RUNTIME_STATUS_ITEMS = 100;
const MAX_STATUS_NAME_LENGTH = 120;
const MAX_STATUS_REASON_LENGTH = 240;
const STARTUP_STATES = new Set(["starting", "ready", "failed", "cancelled"]);
// Present in the locally generated app-server schema for codex-cli 0.162.1.
const RUNTIME_SOURCE = "Codex app-server mcpServer/startupStatus/updated";

function createCodexRuntimeStatusAdapter({ runtimeClient, getRuntimeClient } = {}) {
  const resolveClient = typeof getRuntimeClient === "function"
    ? getRuntimeClient
    : () => runtimeClient;

  return Object.freeze({
    provider: "codex-app-server",
    async inspect() {
      const checkedAt = new Date().toISOString();
      let client;
      try {
        client = resolveClient();
      } catch {
        return unsupportedObservation(checkedAt, "The existing Codex runtime handle is unavailable.");
      }

      if (!client || typeof client.getMcpStartupStatusSnapshot !== "function") {
        return unsupportedObservation(checkedAt, "No existing Codex app-server thread is available. Vesper does not start a runtime for status inspection.");
      }

      let snapshot;
      try {
        snapshot = client.getMcpStartupStatusSnapshot();
      } catch {
        return {
          status: "error",
          provider: "codex-app-server",
          source: RUNTIME_SOURCE,
          checkedAt,
          items: [],
          detail: "The existing Codex runtime status snapshot could not be read; capability runtime state remains unknown.",
        };
      }

      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.supported !== true) {
        return unsupportedObservation(checkedAt, "No already-connected Codex app-server thread is available. Vesper does not start a runtime for status inspection.");
      }

      if (!Array.isArray(snapshot.items)) {
        return {
          status: "error",
          provider: "codex-app-server",
          source: RUNTIME_SOURCE,
          checkedAt,
          items: [],
          detail: "Codex returned a malformed startup status snapshot; capability runtime state remains unknown.",
        };
      }

      const items = [];
      for (const item of snapshot.items.slice(0, MAX_RUNTIME_STATUS_ITEMS)) {
        const name = safeStatusName(item?.name);
        if (!name || !STARTUP_STATES.has(item.status)) continue;
        items.push({
          type: "mcp",
          name,
          startupStatus: item.status,
          runtimeLoadedStatus: item.status === "ready" ? "yes" : ["failed", "cancelled"].includes(item.status) ? "no" : "unknown",
          availabilityStatus: item.status === "ready" ? "available_for_use" : ["failed", "cancelled"].includes(item.status) ? "unavailable" : "unknown",
          operationalStatus: ["failed", "cancelled"].includes(item.status) ? "no" : "unknown",
          observedAt: safeTimestamp(item.observedAt),
          source: RUNTIME_SOURCE,
          detail: statusDetail(item.status),
        });
      }

      const malformedCount = Number.isSafeInteger(snapshot.malformedCount)
        ? Math.max(0, Math.min(100, snapshot.malformedCount))
        : 0;

      return {
        status: malformedCount ? items.length ? "partial" : "error" : items.length ? "observed" : "available",
        provider: "codex-app-server",
        source: RUNTIME_SOURCE,
        checkedAt,
        items,
        omittedItems: Math.max(0, snapshot.items.length - MAX_RUNTIME_STATUS_ITEMS),
        malformedCount,
        detail: inspectionDetail(malformedCount ? items.length ? "partial" : "error" : items.length ? "observed" : "available"),
      };
    },
  });
}

function unsupportedObservation(checkedAt, detail) {
  return {
    status: "unsupported",
    provider: "codex-app-server",
    source: RUNTIME_SOURCE,
    checkedAt,
    items: [],
    detail: safeReason(detail),
  };
}

function safeStatusName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_STATUS_NAME_LENGTH || /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(name)) return null;
  return name;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeReason(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").slice(0, MAX_STATUS_REASON_LENGTH);
}

function statusDetail(status) {
  switch (status) {
    case "ready": return "Codex reported that MCP startup completed; Vesper did not run a health check or tool call.";
    case "failed": return "Codex reported MCP startup failure; raw runtime error text is withheld.";
    case "cancelled": return "Codex reported that MCP startup was cancelled.";
    default: return "Codex reported that MCP startup is in progress.";
  }
}

function inspectionDetail(status) {
  switch (status) {
    case "observed": return "Read only MCP startup notifications already observed by this Codex app-server thread. No RPC, server launch, or health probe was sent.";
    case "partial": return "Some MCP startup notifications were malformed and ignored. Valid observations remain visible; raw error text is withheld.";
    case "error": return "Codex runtime status could not be read safely; runtime state remains unknown.";
    default: return "This Codex app-server thread supports passive MCP startup status, but no startup notification was observed. Absence does not establish unavailability.";
  }
}

module.exports = {
  MAX_RUNTIME_STATUS_ITEMS,
  RUNTIME_SOURCE,
  createCodexRuntimeStatusAdapter,
};
