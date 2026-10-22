"use strict";

const { escapeTerminalField, escapeTerminalOutput, redactSensitiveText } = require("./command-activity");

function approvalReview(method, params = {}, fileChange) {
  const lines = [];
  let truncated = false;
  const add = (label, value, json = false, redact = false, singleLine = false) => {
    if (value === undefined || value === null || value === "") return;
    let text = json ? JSON.stringify(value, null, 2) : String(value);
    if (redact) text = redactSensitiveText(text);
    text = singleLine ? escapeTerminalField(text) : redact ? escapeTerminalOutput(text) : escapeControls(text);
    if (text.length > 8_000) {
      text = `${text.slice(0, 8_000)}\n[truncated]`;
      truncated = true;
    }
    lines.push(`${label}: ${text}`);
  };

  let title = "unknown approval";
  if (method === "item/commandExecution/requestApproval") {
    title = "command execution";
    add("Command", params.command, false, true, true);
    add("Working directory", params.cwd, false, true);
    add("Reason", params.reason, false, true);
    add("Parsed actions", params.commandActions, true, true);
    add("Additional permissions requested", params.additionalPermissions, true, true);
    add("Network approval context", params.networkApprovalContext, true, true);
    add("Proposed future command rules", params.proposedExecpolicyAmendment, true, true);
    add("Proposed future network rules", params.proposedNetworkPolicyAmendments, true, true);
  } else if (method === "item/fileChange/requestApproval") {
    title = "file changes";
    add("Thread / turn / item", [params.threadId, params.turnId, params.itemId], true);
    add("Reason", params.reason, false, true);
    for (const change of fileChange?.changes || []) {
      if (!change || typeof change !== "object" || typeof change.diff !== "string" ||
          typeof change.path !== "string" || !change.kind || typeof change.kind !== "object") {
        truncated = true;
        lines.push("Change details are malformed; this request cannot be safely approved.");
        break;
      }
      add("File", change.path, true);
      add("Change", change.kind, true);
      const diff = change.diff.replace(/\\/gu, "\\\\").replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, (character) => {
        if (character === "\n") return "\n";
        const code = character.codePointAt(0);
        return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
      });
      add("Diff (server snapshot)", diff.split("\n").map((line) => `| ${line}`).join("\n"));
    }
  } else if (method === "item/permissions/requestApproval") {
    title = "additional permissions for this turn";
    add("Reason", params.reason, false, true);
    add("Requested profile", params.permissions || {}, true, true);
  } else if (method === "applyPatchApproval") {
    title = "patch application";
    add("Reason", params.reason, false, true);
    add("File changes", params.fileChanges || {}, true, true);
  } else if (method === "execCommandApproval") {
    title = "command execution";
    add("Command argv", params.command, true, true, true);
    add("Working directory", params.cwd, false, true);
    add("Parsed command", params.parsedCmd, true, true);
    add("Reason", params.reason, false, true);
  } else {
    lines.push("No approval details are available.");
  }

  let body = lines.join("\n");
  if (body.length > 20_000) {
    body = `${body.slice(0, 20_000)}\n[truncated]`;
    truncated = true;
  }
  return Object.freeze({ title, body, truncated });
}

function escapeControls(value) {
  return String(value ?? "")
    .replace(/\u001b/gu, "\\x1b")
    .replace(/\r/gu, "\\r")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

module.exports = { approvalReview };
