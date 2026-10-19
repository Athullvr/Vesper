"use strict";

const readline = require("node:readline");
const { RouteMetrics, classifyRequest, routeRequest } = require("./routing-core");

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
      const label = failed ? "Vesper local · unavailable" : `Vesper local · ${routed.result.status} · no Codex turn`;
      this.write(`\n[${label}] ${safeTerminalText(routed.result.summary)}\n`);
      return;
    }

    this.activeRequest = true;
    this.write(`\n[Codex · ${decision.reason} · connecting]\n`);
    try {
      const routed = await routeRequest(prompt, {
        decision,
        handlers: this.handlers,
        context: { cwd: this.cwd },
        fallback: () => this.appServer.runTurn({
          prompt,
          cwd: this.cwd,
          onDelta: (delta) => this.write(String(delta)),
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
      if (this.exitAfterTurn) this.lineIO.close?.();
    }
  }

  async requestApproval(method, params = {}) {
    const details = approvalDetails(method, params);
    this.write(`\n\n[Codex approval required · ${details.title}]\n`);
    if (details.body) this.write(`${details.body}\n`);

    if (method === "item/commandExecution/requestApproval" && Array.isArray(params.availableDecisions) && !params.availableDecisions.includes("accept")) {
      this.write("This command cannot be approved through the available protocol decisions.\n");
      return { decision: "decline" };
    }

    const answer = await this.lineIO.question("Type yes to approve once, cancel to cancel, or anything else to decline: ");
    const choice = String(answer || "").trim().toLowerCase();
    const approved = choice === "yes";
    const cancelled = choice === "cancel";

    if (method === "item/permissions/requestApproval") {
      if (!approved) return { permissions: {}, scope: "turn" };
      return { permissions: cloneJsonValue(params.permissions || {}), scope: "turn" };
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      return { decision: approved ? "approved" : cancelled ? "abort" : "denied" };
    }
    return { decision: approved ? "accept" : cancelled ? "cancel" : "decline" };
  }

  handleProgress(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "thread_starting": this.write("[Codex] Starting a thread…\n"); break;
      case "thread_resuming": this.write("[Codex] Resuming the saved thread…\n"); break;
      case "turn_started": this.write("[Codex] Working…\n"); break;
      case "turn_timed_out": this.write("[Vesper] Turn timed out; asking Codex to interrupt…\n"); break;
      case "interrupt_requested": this.write("[Vesper] Interrupting the Codex turn…\n"); break;
      default: break;
    }
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
    question(prompt) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        pendingResolve = resolve;
        try {
          rl.question(prompt, (answer) => {
            if (pendingResolve === resolve) pendingResolve = undefined;
            resolve(answer);
          });
        } catch (error) {
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

function approvalDetails(method, params) {
  if (method === "item/commandExecution/requestApproval") {
    const lines = [];
    if (params.command) lines.push(`Command: ${safeTerminalText(params.command)}`);
    if (params.cwd) lines.push(`Directory: ${safeTerminalText(params.cwd)}`);
    if (params.reason) lines.push(`Reason: ${safeTerminalText(params.reason)}`);
    return { title: "command execution", body: lines.join("\n") };
  }
  if (method === "item/fileChange/requestApproval") {
    const lines = [];
    if (params.grantRoot) lines.push(`Requested write root: ${safeTerminalText(params.grantRoot)}`);
    if (params.reason) lines.push(`Reason: ${safeTerminalText(params.reason)}`);
    return { title: "file changes", body: lines.join("\n") };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      title: "additional permissions for this turn",
      body: [params.reason && `Reason: ${safeTerminalText(params.reason)}`, `Requested profile: ${JSON.stringify(params.permissions || {})}`].filter(Boolean).join("\n"),
    };
  }
  if (method === "applyPatchApproval") {
    const files = Object.keys(params.fileChanges || {});
    return {
      title: "patch application",
      body: [params.reason && `Reason: ${safeTerminalText(params.reason)}`, files.length ? `Files: ${files.map(safeTerminalText).join(", ")}` : "The patch did not include a file list."].filter(Boolean).join("\n"),
    };
  }
  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
    return {
      title: "command execution",
      body: [command && `Command: ${safeTerminalText(command)}`, params.cwd && `Directory: ${safeTerminalText(params.cwd)}`, params.reason && `Reason: ${safeTerminalText(params.reason)}`].filter(Boolean).join("\n"),
    };
  }
  return { title: "unknown approval", body: "No approval details are available." };
}

function safeTerminalText(value) {
  return String(value ?? "")
    .replace(/\u001b/gu, "\\x1b")
    .replace(/\r/gu, "\\r")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .slice(0, 4_000);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  TerminalFrontend,
  approvalDetails,
  createLineIO,
  safeTerminalText,
};
