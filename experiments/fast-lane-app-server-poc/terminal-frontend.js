"use strict";

const readline = require("node:readline");
const { RouteMetrics, classifyRequest, routeRequest } = require("./routing-core");
const { createFileChangeSnapshot } = require("./file-change-approval");
const { CommandActivityStore, escapeTerminalField, escapeTerminalOutput, redactSensitiveText, renderActivityUpdates } = require("./command-activity");

const QUIT_COMMANDS = new Set([":quit", ":exit", "/quit", "/exit"]);

class TerminalFrontend {
  constructor({ cwd, handlers, appServer, input = process.stdin, output = process.stdout, lineIO, metrics = new RouteMetrics() } = {}) {
    if (typeof cwd !== "string" || !cwd) throw new TypeError("A project directory is required.");
    if (!handlers || typeof handlers !== "object") throw new TypeError("Local handlers are required.");
    if (!appServer || typeof appServer.runTurn !== "function") throw new TypeError("A Codex app-server client is required.");
    this.cwd = cwd;
    this.handlers = handlers;
    this.appServer = appServer;
    this.output = output;
    this.lineIO = lineIO || createLineIO(input, output);
    this.metrics = metrics;
    this.activeRequest = false;
    this.exitAfterTurn = false;
    this.closed = false;
    this.commandActivity = null;
    this.pendingApprovals = new Set();
    this.approvalQueue = Promise.resolve();
    this.handleProgress = this.handleProgress.bind(this);

    this.appServer.on?.("progress", this.handleProgress);
    this.lineIO.onInterrupt?.(() => this.handleInterrupt());
  }

  async run() {
    this.write("Vesper · local routing with Codex app-server fallback\n");
    this.write(`Project: ${this.cwd}\n`);
    this.write("Use :quit to exit. Local answers do not start Codex turns.\n\n");

    try {
      while (!this.closed && !this.exitAfterTurn) {
        let prompt;
        try {
          prompt = await this.lineIO.question("vesper> ");
        } catch (error) {
          this.write(`\n[Vesper input error] ${safeTerminalText(error.message)}\n`);
          break;
        }
        if (prompt === null || prompt === undefined) break;
        const text = String(prompt).trim();
        if (!text) continue;
        if (QUIT_COMMANDS.has(text.toLowerCase())) break;
        await this.handlePrompt(text);
      }
    } finally {
      this.closed = true;
      this.lineIO.close?.();
      this.appServer.off?.("progress", this.handleProgress);
    }
  }

  async handlePrompt(prompt) {
    const startedAt = Date.now();
    const decision = classifyRequest(prompt);

    if (decision.route === "local") {
      const routed = await routeRequest(prompt, {
        decision,
        handlers: this.handlers,
        context: { cwd: this.cwd },
      });
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const failed = routed.result?.status === "unavailable";
      this.metrics.record(decision, elapsedMs, { handlerFailed: failed });
      const routeDiagnostic = `${decision.reason}/${decision.intent}`;
      const label = failed
        ? `Vesper local · unavailable · ${routeDiagnostic}`
        : `Vesper local · ${routed.result.status} · no Codex turn · ${routeDiagnostic}`;
      this.write(`\n[${label}] ${safeTerminalText(routed.result.summary)}\n`);
      return;
    }

    this.activeRequest = true;
    this.commandActivity = new CommandActivityStore();
    this.write(`\n[Codex · ${decision.reason} · connecting]\n`);
    try {
      const routed = await routeRequest(prompt, {
        decision,
        handlers: this.handlers,
        context: { cwd: this.cwd },
        fallback: () => this.appServer.runTurn({
          prompt,
          cwd: this.cwd,
          onDelta: (delta) => this.write(safeStreamText(delta)),
        }),
      });
      const result = routed.fallbackResult;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.metrics.record(decision, elapsedMs);
      if (result?.status === "completed") this.write(`\n\n[Codex · completed · ${elapsedMs} ms]\n`);
      else if (result?.status === "interrupted") this.write("\n\n[Codex · interrupted]\n");
      else if (result?.status === "timeout") this.write("\n\n[Codex · timed out and interrupted]\n");
      else this.write(`\n\n[Codex · ended with status ${safeTerminalText(result?.status || "unknown")}]\n`);
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.metrics.record(decision, elapsedMs);
      this.write(`\n\n[Codex error · ${elapsedMs} ms] ${safeTerminalText(error?.message || error)}\n`);
    } finally {
      this.activeRequest = false;
      this.commandActivity = null;
      if (this.pendingApprovals.size) {
        this.write("[Vesper] Waiting for the pending approval decision before the next prompt.\n");
        await Promise.allSettled([...this.pendingApprovals]);
      }
      if (this.exitAfterTurn) this.lineIO.close?.();
    }
  }

  requestApproval(method, params = {}, context) {
    const pending = this.approvalQueue.then(() => this.promptForApproval(method, params, context));
    this.approvalQueue = pending.catch(() => undefined);
    this.pendingApprovals.add(pending);
    pending.then(
      () => this.pendingApprovals.delete(pending),
      () => this.pendingApprovals.delete(pending)
    );
    return pending;
  }

  async promptForApproval(method, params = {}, context) {
    const fileApproval = method === "item/fileChange/requestApproval";
    const snapshot = fileApproval && context?.fileChange ? createFileChangeSnapshot(context.fileChange) : null;
    const currentFileReview = () => snapshot && context?.signal && !context.signal.aborted &&
      typeof context.isCurrent === "function" && context.isCurrent() &&
      snapshot.threadId === params.threadId && snapshot.turnId === params.turnId && snapshot.itemId === params.itemId;
    if (method === "applyPatchApproval" || (fileApproval && (!currentFileReview() || params.grantRoot != null))) {
      this.write("[Vesper] File-change approval declined: complete changes with an exact current thread/turn/item identity and one-time scope are required.\n");
      return refusedApproval(method);
    }
    const details = approvalDetails(method, params, snapshot);
    this.write(`\n\n[Codex approval required · ${details.title}]\n`);
    if (details.body) this.write(`${details.body}\n`);

    if (details.truncated) {
      this.write("The complete approval details do not fit the terminal review limit; Vesper declined this request.\n");
      return refusedApproval(method);
    }

    if (method === "item/commandExecution/requestApproval" && Array.isArray(params.availableDecisions) && !params.availableDecisions.includes("accept")) {
      this.write("This command cannot be approved through the available protocol decisions.\n");
      return refusedApproval(method);
    }

    const answer = await this.lineIO.question("Type yes to approve once, cancel to cancel, or anything else to decline: ",
      fileApproval ? { signal: context.signal } : undefined);
    if (fileApproval && !currentFileReview()) {
      this.write("[Vesper] File-change review expired or changed; approval declined.\n");
      return refusedApproval(method);
    }
    const choice = String(answer || "").trim().toLowerCase();
    const approved = choice === "yes";
    const cancelled = choice === "cancel";
    this.write(`[Vesper] Approval choice: ${approved ? "approve once" : cancelled ? "cancel" : "decline"}.\n`);

    if (method === "item/permissions/requestApproval") {
      if (!approved) return { permissions: {}, scope: "turn" };
      return { permissions: cloneJsonValue(params.permissions || {}), scope: "turn" };
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      return {
        decision: approved
          ? "approved"
          : cancelled
            ? "abort"
            : { denied: { rejection: "User declined the request." } },
      };
    }
    return { decision: approved ? "accept" : cancelled ? "cancel" : "decline" };
  }

  handleProgress(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "thread_starting": this.write("[Codex] Starting a thread…\n"); break;
      case "thread_resuming": this.write("[Codex] Resuming the saved thread…\n"); break;
      case "turn_started": this.write("[Codex] Working…\n"); break;
      case "turn_identity":
        this.renderCommandActivity(this.commandActivity?.bindTurn(event.threadId, event.turnId));
        break;
      case "turn_status":
        this.renderCommandActivity(this.commandActivity?.setTurnStatus(event.threadId, event.turnId, event.status));
        break;
      case "approval_requested":
        if (event.method === "item/commandExecution/requestApproval") {
          this.renderCommandActivity(this.commandActivity?.applyApproval(event.params, "requested"));
        }
        break;
      case "approval_decided":
        if (event.method === "item/commandExecution/requestApproval") {
          this.renderCommandActivity(this.commandActivity?.applyApproval(event.params, event.status));
        }
        break;
      case "codex_progress":
        if (["item/started", "item/completed", "item/commandExecution/outputDelta"].includes(event.method)) {
          this.renderCommandActivity(this.commandActivity?.applyProtocolNotification(event.method, event.params));
        }
        break;
      case "turn_timed_out": this.write("[Vesper] Turn timed out; asking Codex to interrupt…\n"); break;
      case "interrupt_requested": this.write("[Vesper] Interrupting the Codex turn…\n"); break;
      case "file_approval_declined": this.write(`[Vesper] File-change approval declined: ${safeTerminalText(event.reason)}\n`); break;
      default: break;
    }
  }

  renderCommandActivity(updates) {
    renderActivityUpdates(updates, (text) => this.write(text));
  }

  handleInterrupt() {
    this.exitAfterTurn = true;
    if (this.activeRequest) {
      this.write("\n[Vesper] Ctrl+C received; interrupting Codex and saving the session.\n");
      Promise.resolve(this.appServer.interrupt?.()).catch((error) => {
        this.write(`[Vesper interrupt error] ${safeTerminalText(error?.message || error)}\n`);
      });
    } else {
      this.lineIO.close?.();
    }
  }

  write(text) {
    this.output.write(String(text));
  }
}

function createLineIO(input, output) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let closed = false;
  let pendingResolve;
  const interruptHandlers = new Set();

  rl.on("close", () => {
    closed = true;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = undefined;
      resolve(null);
    }
  });
  rl.on("SIGINT", () => {
    for (const handler of interruptHandlers) handler();
    rl.close();
  });

  return {
    question(prompt, { signal } = {}) {
      if (closed || signal?.aborted) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const finish = (answer) => {
          signal?.removeEventListener("abort", abort);
          if (pendingResolve === finish) pendingResolve = undefined;
          resolve(answer);
        };
        const abort = () => finish(null);
        pendingResolve = finish;
        signal?.addEventListener("abort", abort, { once: true });
        try {
          rl.question(prompt, { signal }, finish);
        } catch (error) {
          signal?.removeEventListener("abort", abort);
          pendingResolve = undefined;
          reject(error);
        }
      });
    },
    onInterrupt(handler) {
      interruptHandlers.add(handler);
      return () => interruptHandlers.delete(handler);
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

function approvalDetails(method, params, fileChange) {
  const lines = [];
  let truncated = false;
  const add = (label, value, json = false, redact = false, singleLine = false) => {
    if (value === undefined || value === null || value === "") return;
    let text = json ? JSON.stringify(value, null, 2) : String(value);
    if (redact) text = redactSensitiveText(text);
    text = singleLine ? escapeTerminalField(text) : redact ? escapeTerminalOutput(text) : escapeTerminalControls(text);
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
    add("Working directory", params.cwd);
    add("Reason", params.reason);
    add("Parsed actions", params.commandActions, true, true);
    add("Additional permissions requested", params.additionalPermissions, true);
    add("Network approval context", params.networkApprovalContext, true);
    add("Proposed future command rules", params.proposedExecpolicyAmendment, true, true);
    add("Proposed future network rules", params.proposedNetworkPolicyAmendments, true);
  } else if (method === "item/fileChange/requestApproval") {
    title = "file changes";
    add("Thread / turn / item", [params.threadId, params.turnId, params.itemId], true);
    add("Reason", params.reason);
    for (const change of fileChange?.changes || []) {
      add("File", change.path, true);
      add("Change", change.kind, true);
      // Prefix content lines and escape controls visibly so patch text cannot
      // imitate a terminal prompt or hide characters in the proposed content.
      const diff = change.diff.replace(/\\/gu, "\\\\")
        .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, (character) => {
          if (character === "\n") return "\n";
          const code = character.codePointAt(0);
          return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
        });
      add("Diff (server snapshot)", diff.split("\n").map((line) => `| ${line}`).join("\n"));
    }
  } else if (method === "item/permissions/requestApproval") {
    title = "additional permissions for this turn";
    add("Reason", params.reason);
    add("Requested profile", params.permissions || {}, true);
  } else if (method === "applyPatchApproval") {
    title = "patch application";
    add("Reason", params.reason);
    add("File changes", params.fileChanges || {}, true);
  } else if (method === "execCommandApproval") {
    title = "command execution";
    add("Command argv", params.command, true, true, true);
    add("Working directory", params.cwd);
    add("Parsed command", params.parsedCmd, true, true);
    add("Reason", params.reason);
  } else {
    lines.push("No approval details are available.");
  }

  let body = lines.join("\n");
  if (body.length > 20_000) {
    body = `${body.slice(0, 20_000)}\n[truncated]`;
    truncated = true;
  }
  return { title, body, truncated };
}

function safeTerminalText(value) {
  return escapeTerminalControls(value).slice(0, 4_000);
}

function escapeTerminalControls(value) {
  return String(value ?? "")
    .replace(/\u001b/gu, "\\x1b")
    .replace(/\r/gu, "\\r")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

function safeStreamText(value) {
  return String(value ?? "")
    .replace(/\u001b/gu, "\\x1b")
    .replace(/\r/gu, "\\r")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function refusedApproval(method) {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: { denied: { rejection: "Vesper declined because the approval details could not be safely reviewed." } } };
  }
  return { decision: "decline" };
}

module.exports = {
  TerminalFrontend,
  approvalDetails,
  createLineIO,
  safeTerminalText,
  safeStreamText,
};
