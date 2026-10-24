"use strict";

const path = require("node:path");

const MAX_COMMAND_LENGTH = 4_096;
const MAX_CWD_LENGTH = 2_048;
const MAX_OUTPUT_LENGTH = 16_384;
const MAX_RETAINED_ITEMS = 50;
const MAX_PENDING_STATES_PER_ITEM = 8;
const MAX_APPROVALS_PER_ITEM = 8;
const MAX_ID_LENGTH = 512;
const COMMAND_STATUSES = new Set(["inProgress", "completed", "failed", "declined"]);
const TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

class CommandActivityStore {
  constructor({ maxItems = MAX_RETAINED_ITEMS } = {}) {
    this.maxItems = Math.max(1, Math.min(MAX_RETAINED_ITEMS, Number.isInteger(maxItems) ? maxItems : MAX_RETAINED_ITEMS));
    this.boundIdentity = null;
    this.items = new Map();
    this.nextNumber = 1;
    this.omitted = 0;
    this.overflowReported = false;
  }

  bindTurn(threadId, turnId) {
    if (!isIdentity(threadId) || !isIdentity(turnId)) return [];
    if (this.boundIdentity && (this.boundIdentity.threadId !== threadId || this.boundIdentity.turnId !== turnId)) {
      this.items.clear();
      this.omitted = 0;
      this.overflowReported = false;
      this.nextNumber = 1;
    }
    this.boundIdentity = { threadId, turnId };
    for (const [key, item] of this.items) {
      if (item.threadId !== threadId || item.turnId !== turnId) this.items.delete(key);
    }
    const updates = [];
    for (const item of this.items.values()) {
      updates.push(...item.pendingStates);
      item.pendingStates = [];
      if (item.pendingOutput) {
        updates.push(item.pendingOutput);
        item.pendingOutput = null;
      }
      if (item.renderedState === null) updates.push(...this.flush(item));
    }
    if (this.omitted && !this.overflowReported) {
      this.overflowReported = true;
      updates.push({ type: "overflow", omitted: this.omitted });
    }
    return updates;
  }

  applyProtocolNotification(method, params) {
    if (!isObject(params)) return [];
    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (!isObject(item) || item.type !== "commandExecution" || !isIdentity(item.id)) return [];
      const record = this.getRecord(params.threadId, params.turnId, item.id);
      if (!record) return this.flushOverflow();
      this.updateCommandFields(record, item);
      this.updateExecutionFields(record, item, method);
      if (typeof item.aggregatedOutput === "string") {
        const aggregate = redactSensitiveText(item.aggregatedOutput);
        const limited = limitText(aggregate, MAX_OUTPUT_LENGTH, "");
        record.output = limited.text;
        record.outputTruncated ||= limited.truncated;
        record.outputAvailable = true;
        record.aggregateOutputSeen = true;
      }
      record.itemCompletedEvent ||= method === "item/completed";
      const updates = this.flush(record);
      if (record.itemCompletedEvent && record.outputAvailable && !record.outputRendered) {
        record.outputRendered = true;
        const output = { type: "output", activity: snapshot(record), output: record.output, truncated: record.outputTruncated, partial: false };
        if (this.boundIdentity) updates.push(output);
        else record.pendingOutput = output;
      }
      return updates;
    }

    if (method === "item/commandExecution/outputDelta") {
      if (typeof params.delta !== "string") return [];
      const record = this.getRecord(params.threadId, params.turnId, params.itemId);
      if (!record || record.executionTerminal || record.aggregateOutputSeen) return record ? [] : this.flushOverflow();
      const remaining = Math.max(0, MAX_OUTPUT_LENGTH - record.output.length);
      if (remaining > 0) record.output += params.delta.slice(0, remaining);
      if (params.delta.length > remaining) record.outputTruncated = true;
      record.outputAvailable ||= params.delta.length > 0;
      return [];
    }

    return [];
  }

  applyApproval(params, status) {
    if (!isObject(params) || !["requested", "approved", "declined", "cancelled"].includes(status)) return [];
    const approvalKey = approvalRequestKey(params.requestId) ||
      (isIdentity(params.approvalId) ? `approval:${params.approvalId}` : null);
    if (!approvalKey) return [];
    const record = this.getRecord(params.threadId, params.turnId, params.itemId);
    if (!record) return this.flushOverflow();
    const current = record.approvals.get(approvalKey);
    if (status === "requested") {
      if (current || record.approvals.size >= MAX_APPROVALS_PER_ITEM) return [];
      record.approvals.set(approvalKey, "requested");
    } else {
      if (current !== "requested") return [];
      record.approvals.set(approvalKey, status);
    }
    this.updateCommandFields(record, { command: params.command, cwd: params.cwd });
    const latest = [...record.approvals.values()].at(-1);
    record.approvalStatus = latest || record.approvalStatus;
    return this.flush(record);
  }

  setTurnStatus(threadId, turnId, status) {
    if (!isIdentity(threadId) || !isIdentity(turnId) || !TURN_STATUSES.has(status)) return [];
    if (!this.matchesBoundIdentity(threadId, turnId)) return [];
    const updates = [];
    for (const record of this.items.values()) {
      if (record.threadId !== threadId || record.turnId !== turnId) continue;
      if (!record.turnStatus) record.turnStatus = status;
      updates.push(...this.flush(record));
      if (record.turnStatus && record.outputAvailable && !record.outputRendered) {
        record.outputRendered = true;
        updates.push({
          type: "output",
          activity: snapshot(record),
          output: record.output,
          truncated: record.outputTruncated,
          partial: !record.executionTerminal,
        });
      }
    }
    return updates;
  }

  updateCommandFields(record, item) {
    if (record.command === null && typeof item.command === "string") {
      const limited = limitText(redactSensitiveText(item.command), MAX_COMMAND_LENGTH, "[command truncated]");
      record.command = limited.text;
      record.commandTruncated = limited.truncated;
    }
    if (record.cwd === null && isValidWorkingDirectory(item.cwd)) {
      const limited = limitText(item.cwd, MAX_CWD_LENGTH, "[working directory truncated]");
      record.cwd = limited.text;
      record.cwdTruncated = limited.truncated;
    }
  }

  updateExecutionFields(record, item, method) {
    const status = COMMAND_STATUSES.has(item.status) ? item.status : null;
    if (status) {
      if (!record.executionTerminal || status === record.executionStatus) {
        record.executionStatus = status;
        if (status !== "inProgress") record.executionTerminal = true;
      }
    } else if (method === "item/completed" && !record.executionTerminal) {
      // The item lifecycle ended, but a missing/invalid command status is not
      // evidence of command success or failure.
      record.executionStatus = null;
    }
    if (Number.isInteger(item.exitCode) && (method === "item/completed" || !record.exitCodeAvailable)) {
      record.exitCode = item.exitCode;
      record.exitCodeAvailable = true;
    }
  }

  getRecord(threadId, turnId, itemId) {
    if (![threadId, turnId, itemId].every(isIdentity)) return null;
    if (!this.matchesBoundIdentity(threadId, turnId)) return null;
    const key = JSON.stringify([threadId, turnId, itemId]);
    let record = this.items.get(key);
    if (record) return record;
    if (this.items.size >= this.maxItems) {
      this.omitted += 1;
      return null;
    }
    record = {
      threadId,
      turnId,
      itemId,
      number: this.nextNumber++,
      command: null,
      commandTruncated: false,
      cwd: null,
      cwdTruncated: false,
      executionStatus: null,
      executionTerminal: false,
      exitCode: null,
      exitCodeAvailable: false,
      approvals: new Map(),
      approvalStatus: null,
      turnStatus: null,
      output: "",
      outputAvailable: false,
      outputTruncated: false,
      aggregateOutputSeen: false,
      itemCompletedEvent: false,
      outputRendered: false,
      renderedState: null,
      pendingStates: [],
      pendingOutput: null,
    };
    this.items.set(key, record);
    return record;
  }

  matchesBoundIdentity(threadId, turnId) {
    return !this.boundIdentity || (this.boundIdentity.threadId === threadId && this.boundIdentity.turnId === turnId);
  }

  flushOverflow() {
    if (!this.boundIdentity || !this.omitted || this.overflowReported) return [];
    this.overflowReported = true;
    return [{ type: "overflow", omitted: this.omitted }];
  }

  flush(record) {
    const key = stateKey(record);
    if (key === record.renderedState) return [];
    record.renderedState = key;
    const update = { type: "state", activity: snapshot(record) };
    if (!this.boundIdentity) {
      if (record.pendingStates.length < MAX_PENDING_STATES_PER_ITEM) record.pendingStates.push(update);
      else record.pendingStates[MAX_PENDING_STATES_PER_ITEM - 1] = update;
      return [];
    }
    if (!this.matchesBoundIdentity(record.threadId, record.turnId)) return [];
    return [update];
  }
}

function stateKey(record) {
  const visibleTurnStatus = record.turnStatus === "completed" && record.executionTerminal ? null : record.turnStatus;
  return JSON.stringify([
    record.command,
    record.commandTruncated,
    record.cwd,
    record.cwdTruncated,
    record.executionStatus,
    record.exitCodeAvailable,
    record.exitCode,
    record.approvalStatus,
    visibleTurnStatus,
  ]);
}

function snapshot(record) {
  return Object.freeze({
    threadId: record.threadId,
    turnId: record.turnId,
    itemId: record.itemId,
    number: record.number,
    command: record.command,
    commandTruncated: record.commandTruncated,
    cwd: record.cwd,
    cwdTruncated: record.cwdTruncated,
    executionStatus: record.executionStatus,
    exitCode: record.exitCode,
    exitCodeAvailable: record.exitCodeAvailable,
    approvalStatus: record.approvalStatus,
    turnStatus: record.turnStatus,
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function approvalRequestKey(value) {
  if (isIdentity(value)) return `request:string:${value}`;
  if (Number.isSafeInteger(value)) return `request:number:${value}`;
  return null;
}

function isValidWorkingDirectory(value) {
  return typeof value === "string" && value.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value) && path.isAbsolute(value);
}

function limitText(value, maxLength, marker) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return { text, truncated: false };
  const suffix = marker ? ` … ${marker}` : "";
  let end = Math.max(0, maxLength - suffix.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}${suffix}`, truncated: true };
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, "[redacted private key]")
    .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s'"`]+/giu, "$1[redacted]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[redacted]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(?:'[^']*'|"[^"]*"|[^\s;&|]+)/giu, "$1[redacted]")
    .replace(/((?<![\p{L}\p{N}_])--?(?:password|passwd|token|secret|api-key|access-token|client-secret)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s;&|]+)/giu, "$1[redacted]")
    .replace(/\b(https?:\/\/[^:/\s]+:)[^@/\s]+(@)/giu, "$1[redacted]$2")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gu, "[redacted token]");
}

function escapeTerminalField(value) {
  return escapeTerminalText(value, { preserveNewlines: false });
}

function escapeTerminalOutput(value) {
  return escapeTerminalText(value, { preserveNewlines: true });
}

function escapeTerminalText(value, { preserveNewlines }) {
  let result = "";
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if (character === "\n" && preserveNewlines) result += "\n";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (code === 0x1b) result += "\\x1b";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (/\p{Cf}|\p{Cs}/u.test(character)) result += code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
    else result += character;
  }
  return result;
}

function renderActivityUpdates(updates, write) {
  for (const update of updates || []) {
    if (update.type === "overflow") {
      write("[Vesper] Command activity limit reached; additional commands are omitted.\n");
    } else if (update.type === "state") {
      const item = update.activity;
      const state = [];
      if (item.approvalStatus) state.push(`approval ${item.approvalStatus}`);
      if (item.executionStatus === "inProgress") state.push("execution started");
      else if (item.executionStatus) state.push(`execution ${item.executionStatus}`);
      else state.push("execution status unavailable");
      if (item.exitCodeAvailable) state.push(`exit code ${item.exitCode}`);
      else if (["completed", "failed", "declined"].includes(item.executionStatus)) state.push("exit code unavailable");
      if (item.turnStatus === "interrupted") state.push("turn interrupted");
      else if (item.turnStatus === "failed") state.push("turn failed");
      else if (item.turnStatus === "completed" && !["completed", "failed", "declined"].includes(item.executionStatus)) state.push("turn ended before command status was reported");
      write(`\n[Codex command #${item.number} · ${state.join(" · ")}]\n`);
      if (item.command !== null) {
        write(`Command: ${escapeTerminalField(item.command)}\n`);
      } else {
        write("Command: [not supplied]\n");
      }
      if (item.cwd !== null) write(`Working directory: ${escapeTerminalField(item.cwd)}\n`);
      if (item.commandTruncated && !item.command.includes("[command truncated]")) write("[command text truncated]\n");
      if (item.cwdTruncated && !item.cwd.includes("[working directory truncated]")) write("[working directory truncated]\n");
      const commandTerminal = ["completed", "failed", "declined"].includes(item.executionStatus);
      if (item.turnStatus === "interrupted" && !commandTerminal) {
        write("Command execution outcome was not reported; turn-level interruption does not establish command termination.\n");
      } else if (item.turnStatus === "failed" && !commandTerminal) {
        write("Command execution outcome was not reported; turn-level failure does not establish command failure.\n");
      } else if (item.turnStatus === "completed" && !commandTerminal) {
        write("Command execution outcome was not reported before the turn ended.\n");
      }
    } else if (update.type === "output") {
      const item = update.activity;
      write(`\n[Codex command #${item.number} · ${update.partial ? "partial output" : "output"}]\n`);
      const text = redactSensitiveText(update.output);
      if (text) {
        const safe = escapeTerminalOutput(text);
        write(safe.split("\n").map((line) => `| ${line}`).join("\n") + "\n");
      }
      if (update.truncated) write("| [output truncated at the display limit]\n");
      if (update.partial) write("| [command execution outcome not reported]\n");
    }
  }
}

module.exports = {
  CommandActivityStore,
  MAX_COMMAND_LENGTH,
  MAX_CWD_LENGTH,
  MAX_OUTPUT_LENGTH,
  MAX_RETAINED_ITEMS,
  escapeTerminalField,
  escapeTerminalOutput,
  redactSensitiveText,
  renderActivityUpdates,
};
