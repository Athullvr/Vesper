"use strict";

const { escapeTerminalOutput, redactSensitiveText } = require("./command-activity");

const MAX_HISTORY_TURNS = 50;
const MAX_HISTORY_MESSAGES = 240;
const MAX_HISTORY_MESSAGE_LENGTH = 12_000;
const MAX_HISTORY_TEXT_LENGTH = 128_000;
const MAX_ID_LENGTH = 512;
const TURN_STATUSES = new Set(["completed", "failed", "interrupted", "inProgress"]);
const ITEM_STATUSES = new Set(["inProgress", "completed", "failed", "declined", "interrupted", "cancelled", "started", "interacted"]);

function projectConversationHistory({ turns, truncated = false } = {}) {
  if (!Array.isArray(turns)) {
    return unavailableHistory("Codex did not return a valid saved-history list.");
  }

  const turnList = turns.length > MAX_HISTORY_TURNS ? turns.slice(-MAX_HISTORY_TURNS) : turns;
  let incomplete = Boolean(truncated) || turns.length > MAX_HISTORY_TURNS;
  const seenTurns = new Set();
  const reverseEntries = [];
  let visibleTextLength = 0;
  let stop = false;

  const append = (entry) => {
    if (reverseEntries.length >= MAX_HISTORY_MESSAGES) {
      incomplete = true;
      stop = true;
      return;
    }
    if (entry.truncated || entry.text.includes("[message truncated]")) incomplete = true;
    const remaining = MAX_HISTORY_TEXT_LENGTH - visibleTextLength - entry.label.length;
    if (remaining <= 0) {
      incomplete = true;
      stop = true;
      return;
    }
    if (entry.text.length > remaining) {
      const limited = limitText(entry.text, remaining, "[history truncated]");
      if (limited.text) reverseEntries.push({ ...entry, text: limited.text, truncated: undefined });
      visibleTextLength += entry.label.length + limited.text.length;
      incomplete = true;
      stop = true;
      return;
    }
    const { truncated: _truncated, ...visibleEntry } = entry;
    reverseEntries.push(visibleEntry);
    visibleTextLength += entry.label.length + entry.text.length;
  };

  for (let turnIndex = turnList.length - 1; turnIndex >= 0 && !stop; turnIndex -= 1) {
    const turn = turnList[turnIndex];
    if (!isObject(turn) || !isIdentity(turn.id) || !TURN_STATUSES.has(turn.status)) {
      incomplete = true;
      continue;
    }
    if (seenTurns.has(turn.id)) {
      incomplete = true;
      continue;
    }
    seenTurns.add(turn.id);

    const itemsView = turn.itemsView === undefined ? "full" : turn.itemsView;
    if (!["full", "summary", "notLoaded"].includes(itemsView)) incomplete = true;
    if (itemsView !== "full") incomplete = true;

    let items = turn.items;
    if (!Array.isArray(items)) {
      items = [];
      incomplete = true;
    }

    const statusEntry = turnStatusEntry(turn);
    if (statusEntry) append(statusEntry);
    if (stop) break;

    if (itemsView === "notLoaded") {
      append({
        id: `${turn.id}:items-unavailable`,
        kind: "availability",
        label: "Turn details unavailable",
        text: "Codex did not include the stored items for this turn.",
      });
      continue;
    }

    const seenItems = new Set();
    for (let itemIndex = items.length - 1; itemIndex >= 0 && !stop; itemIndex -= 1) {
      const item = items[itemIndex];
      if (!isObject(item) || !isIdentity(item.id) || typeof item.type !== "string") {
        incomplete = true;
        continue;
      }
      if (seenItems.has(item.id)) {
        incomplete = true;
        continue;
      }
      seenItems.add(item.id);

      const projected = projectItem(turn.id, item);
      if (projected.incomplete) incomplete = true;
      if (projected.entry) append(projected.entry);
    }

    if (!stop && itemsView === "summary") {
      append({
        id: `${turn.id}:summary-only`,
        kind: "availability",
        label: "Partial turn history",
        text: "Codex returned summary-level items for this turn; some details are unavailable.",
      });
    }
  }

  const entries = reverseEntries.reverse();
  const hasHistory = turnList.length > 0 || entries.length > 0;
  const state = !hasHistory && !incomplete ? "empty" : incomplete ? "partial" : "available";
  return {
    state,
    entries,
    truncated: incomplete,
    text: state === "empty"
      ? "The saved Codex thread has no conversation turns yet."
      : state === "partial"
        ? "Showing available saved history. Some older turns or details are omitted or unavailable."
        : "Saved conversation history restored from the Codex thread.",
  };
}

function unavailableHistory(text = "Saved conversation history is unavailable.") {
  return { state: "unavailable", entries: [], truncated: false, text: cleanText(text, 800) };
}

function turnStatusEntry(turn) {
  if (turn.status === "completed") {
    return {
      id: `${turn.id}:status`,
      kind: "turn",
      label: "Turn completed",
      text: "Codex recorded this turn as completed.",
    };
  }
  if (turn.status === "interrupted") {
    return {
      id: `${turn.id}:status`,
      kind: "error",
      label: "Turn interrupted",
      text: turnErrorText(turn, "Codex recorded this turn as interrupted."),
    };
  }
  if (turn.status === "failed") {
    return {
      id: `${turn.id}:status`,
      kind: "error",
      label: "Turn failed",
      text: turnErrorText(turn, "Codex recorded this turn as failed."),
    };
  }
  return {
    id: `${turn.id}:status`,
    kind: "availability",
    label: "Turn still in progress",
    text: "The saved history has no terminal outcome for this turn.",
  };
}

function turnErrorText(turn, fallback) {
  const message = isObject(turn.error) && typeof turn.error.message === "string"
    ? cleanText(turn.error.message, MAX_HISTORY_MESSAGE_LENGTH)
    : "";
  return message || fallback;
}

function projectItem(turnId, item) {
  const id = `${turnId}:${item.id}`;
  switch (item.type) {
    case "userMessage": {
      const content = Array.isArray(item.content) ? item.content : [];
      const fragments = [];
      let incomplete = !Array.isArray(item.content);
      for (const part of content) {
        if (isObject(part) && part.type === "text" && typeof part.text === "string") fragments.push(part.text);
        else if (isObject(part)) {
          fragments.push(`[${describeInputType(part.type)} omitted]`);
          incomplete = true;
        }
        else incomplete = true;
      }
      return { entry: makeEntry(id, "user", "You", fragments.join("")), incomplete };
    }
    case "agentMessage":
      if (typeof item.text !== "string") return { incomplete: true };
      return { entry: makeEntry(id, "assistant", "Codex", item.text) };
    case "commandExecution": {
      const status = safeStatus(item.status);
      const details = [];
      if (typeof item.command === "string") details.push(`Command: ${cleanText(item.command, 2_000)}`);
      else details.push("Command text unavailable.");
      details.push(`Execution status: ${status || "unavailable"}.`);
      if (Number.isInteger(item.exitCode)) details.push(`Exit code: ${item.exitCode}.`);
      else if (["completed", "failed", "declined"].includes(status)) details.push("Exit code unavailable.");
      if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) {
        details.push(`Output:\n${cleanText(item.aggregatedOutput, 4_000)}`);
      }
      return {
        entry: makeEntry(id, status === "failed" ? "error" : "tool", `Command execution · ${status || "status unavailable"}`, details.join("\n")),
        incomplete: !status,
      };
    }
    case "fileChange": {
      const status = safeStatus(item.status);
      const count = Array.isArray(item.changes) ? item.changes.length : null;
      const details = count === null ? "Change details unavailable." : `${count} recorded change${count === 1 ? "" : "s"}.`;
      return {
        entry: makeEntry(id, "tool", `File-change activity · ${status || "status unavailable"}`, `${details} This history item does not verify current disk state.`),
        incomplete: !status || count === null,
      };
    }
    case "mcpToolCall":
      return projectNamedTool(id, "MCP tool", item.server, item.tool, item.status);
    case "dynamicToolCall":
      return projectNamedTool(id, "Dynamic tool", item.namespace, item.tool, item.status);
    case "webSearch":
      return {
        entry: makeEntry(id, "tool", "Web search", typeof item.query === "string" ? `Query: ${cleanText(item.query, 2_000)}` : "Query unavailable."),
        incomplete: typeof item.query !== "string",
      };
    case "functionCallOutput":
      return {
        entry: makeEntry(id, "tool", `Tool result · ${cleanText(item.name, 200) || "unnamed"}`, "Saved tool output is not expanded in conversation history."),
        incomplete: typeof item.name !== "string",
      };
    case "plan":
      return typeof item.text === "string"
        ? { entry: makeEntry(id, "activity", "Plan", item.text) }
        : { incomplete: true };
    case "reasoning":
    case "hookPrompt":
      // Internal reasoning and hook prompts are not conversation messages.
      return { entry: null, incomplete: false };
    case "imageView":
      return { entry: makeEntry(id, "activity", "Image activity", "Image path omitted from restored history.") };
    case "imageGeneration":
      return { entry: makeEntry(id, "tool", `Image generation · ${safeStatus(item.status) || "status unavailable"}`, "Generated content is not restored in this view.") };
    case "contextCompaction":
      return { entry: makeEntry(id, "activity", "Context compacted", "Codex recorded a context-compaction event.") };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { entry: makeEntry(id, "activity", item.type === "enteredReviewMode" ? "Review started" : "Review ended", cleanText(item.review, 1_000)) };
    case "sleep":
      return { entry: makeEntry(id, "tool", "Interruptible wait", Number.isInteger(item.durationMs) ? `${item.durationMs} ms.` : "Duration unavailable.") };
    case "subAgentActivity":
      return { entry: makeEntry(id, "activity", `Sub-agent activity · ${safeStatus(item.kind) || "recorded"}`, "Sub-agent details are not expanded in this view.") };
    case "collabAgentToolCall":
      return projectNamedTool(id, "Agent collaboration", item.tool, "", item.status);
    default:
      return {
        entry: makeEntry(id, "availability", "Stored activity omitted", `This Vesper version does not render the “${cleanText(item.type, 120)}” activity type.`),
        incomplete: true,
      };
  }
}

function projectNamedTool(id, label, primary, secondary, statusValue) {
  const status = safeStatus(statusValue);
  const name = [primary, secondary].filter((value) => typeof value === "string" && value).map((value) => cleanText(value, 160)).join(" · ");
  return {
    entry: makeEntry(id, status === "failed" || status === "error" ? "error" : "tool", `${label}${name ? ` · ${name}` : ""} · ${status || "status unavailable"}`, "Tool arguments and results are not expanded in restored history."),
    incomplete: !status,
  };
}

function makeEntry(id, kind, label, text) {
  const sanitized = escapeTerminalOutput(redactSensitiveText(String(text ?? "")));
  const limited = limitText(sanitized, MAX_HISTORY_MESSAGE_LENGTH, "[message truncated]");
  return {
    id,
    kind,
    label: cleanText(label, 240),
    text: limited.text,
    truncated: limited.truncated,
  };
}

function describeInputType(type) {
  switch (type) {
    case "image":
    case "localImage": return "Image input";
    case "audio":
    case "localAudio": return "Audio input";
    case "skill": return "Skill reference";
    case "mention": return "Mention";
    default: return "Non-text input";
  }
}

function safeStatus(value) {
  return typeof value === "string" && ITEM_STATUSES.has(value) ? value : "";
}

function cleanText(value, maxLength) {
  return limitText(escapeTerminalOutput(redactSensitiveText(String(value ?? ""))), maxLength, "[message truncated]").text;
}

function limitText(value, maxLength, marker) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return { text, truncated: false };
  const suffix = ` … ${marker}`;
  if (maxLength <= 0) return { text: "", truncated: true };
  if (maxLength < suffix.length) {
    let end = Math.max(0, maxLength - 1);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return { text: `${text.slice(0, end)}…`, truncated: true };
  }
  let end = maxLength - suffix.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}${suffix}`, truncated: true };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

module.exports = {
  MAX_HISTORY_MESSAGE_LENGTH,
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_TEXT_LENGTH,
  MAX_HISTORY_TURNS,
  projectConversationHistory,
  unavailableHistory,
};
