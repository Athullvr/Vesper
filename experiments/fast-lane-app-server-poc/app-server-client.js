"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const RPC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 5 * 60_000;
const INTERRUPT_GRACE_MS = 10_000;
const CLIENT_INFO = Object.freeze({
  name: "vesper_terminal",
  title: "Vesper Terminal Frontend",
  version: "0.1.0",
});

class AppServerClient extends EventEmitter {
  constructor({
    spawnProcess = spawn,
    command = "codex",
    initialThreadId = null,
    onThreadId = async () => {},
    onApproval = async (method) => defaultApproval(method),
    rpcTimeoutMs = RPC_TIMEOUT_MS,
    turnTimeoutMs = TURN_TIMEOUT_MS,
    interruptGraceMs = INTERRUPT_GRACE_MS,
  } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.command = command;
    this.threadId = initialThreadId;
    this.threadReady = false;
    this.onThreadId = onThreadId;
    this.onApproval = onApproval;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.interruptGraceMs = interruptGraceMs;
    this.child = undefined;
    this.readyPromise = undefined;
    this.nextRpcId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.activeTurn = undefined;
    this.startingTurn = false;
    this.pendingInterrupt = false;
    this.disposed = false;
    this.connectionGeneration = 0;
  }

  connect(cwd) {
    if (this.readyPromise) return this.readyPromise;
    if (this.disposed) return Promise.reject(new Error("Vesper app-server client is closed."));

    let child;
    try {
      child = this.spawnProcess(this.command, ["app-server", "--listen", "stdio://"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.reject(new Error(`Could not start Codex app-server: ${safeErrorMessage(error)}`));
    }

    this.child = child;
    this.threadReady = false;
    this.stdoutBuffer = "";
    const generation = ++this.connectionGeneration;
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      if (this.child === child && this.connectionGeneration === generation) this.handleStdout(chunk);
    });
    // App-server stderr can contain project or prompt details. Never copy it to Vesper output.
    child.stderr?.on("data", () => {});
    child.on("error", (error) => this.handleExit(error, generation));
    child.on("close", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited (code=${code}, signal=${signal || "none"}).`), generation);
    });

    this.readyPromise = this.request("initialize", {
      clientInfo: CLIENT_INFO,
    }).then((result) => {
      if (!result || typeof result !== "object") throw new Error("Codex app-server returned an invalid initialize response.");
      this.write({ method: "initialized", params: {} });
      this.emit("progress", { type: "initialized" });
      return true;
    }).catch((error) => {
      if (this.connectionGeneration === generation) {
        this.readyPromise = undefined;
        // An initialization failure leaves the transport unusable. In
        // particular, an initialize timeout would otherwise leak a child
        // process that no later request can safely reuse.
        this.terminateChild();
      }
      throw error;
    });

    return this.readyPromise;
  }

  async runTurn({ prompt, cwd, onDelta = () => {} } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("A non-empty prompt is required.");
    if (typeof cwd !== "string" || !cwd) throw new TypeError("A project directory is required.");
    if (this.activeTurn || this.startingTurn) throw new Error("A Codex turn is already active or starting.");

    this.startingTurn = true;
    try {
      await this.connect(cwd);
      await this.ensureThread(cwd);
    } finally {
      this.startingTurn = false;
    }
    if (this.pendingInterrupt) {
      this.pendingInterrupt = false;
      return { status: "interrupted" };
    }

    const active = this.createActiveTurn(onDelta);
    this.activeTurn = active;
    const generation = this.connectionGeneration;

    try {
      const response = await this.request("turn/start", {
        threadId: this.threadId,
        cwd,
        input: [{ type: "text", text: prompt }],
      });
      const turn = response?.turn;
      if (!turn || typeof turn.id !== "string" || !turn.id) {
        throw new Error("Codex app-server did not return a turn id.");
      }
      active.turnId = turn.id;
      if (active.interruptRequested) await this.sendInterrupt(active);

      if (isTerminalStatus(turn.status) && !active.settled) {
        this.finishFromStatus(active, turn);
      }
    } catch (error) {
      // A lost start reply leaves acceptance unknown. Close this transport
      // before allowing another request, rather than leaving an orphan turn.
      this.handleExit(error, generation);
      this.finish(active, undefined, error);
    }

    return active.completion;
  }

  async interrupt() {
    const active = this.activeTurn;
    if (!active || active.settled) {
      if (this.startingTurn) {
        this.pendingInterrupt = true;
        this.emit("progress", { type: "interrupt_requested" });
        return true;
      }
      return false;
    }
    active.interruptRequested = true;
    this.emit("progress", { type: "interrupt_requested" });
    if (active.turnId) await this.sendInterrupt(active);
    return true;
  }

  async ensureThread(cwd) {
    if (this.threadReady) return;

    if (this.threadId) {
      this.emit("progress", { type: "thread_resuming" });
      const response = await this.request("thread/resume", { threadId: this.threadId });
      const resumedId = response?.thread?.id;
      if (resumedId !== this.threadId) throw new Error("Codex app-server resumed a different thread than the saved Vesper session.");
      const serverCwd = response?.cwd;
      if (typeof serverCwd !== "string" || !samePath(serverCwd, cwd)) {
        throw new Error("Saved Codex thread belongs to a different project directory.");
      }
      await this.onThreadId(this.threadId);
      this.threadReady = true;
      this.emit("progress", { type: "thread_resumed" });
      return;
    }

    this.emit("progress", { type: "thread_starting" });
    const response = await this.request("thread/start", { cwd });
    const threadId = response?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new Error("Codex app-server did not return a thread id.");
    if (typeof response?.cwd !== "string" || !samePath(response.cwd, cwd)) {
      throw new Error("Codex app-server created the thread in a different project directory.");
    }
    this.threadId = threadId;
    await this.onThreadId(threadId);
    this.threadReady = true;
    this.emit("progress", { type: "thread_started" });
  }

  createActiveTurn(onDelta) {
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Notifications may fail the turn before the turn/start RPC resolves.
    // Observe that rejection immediately; runTurn still returns this original
    // promise, so callers receive the failure once the start request settles.
    completion.catch(() => {});
    const active = {
      threadId: this.threadId,
      turnId: null,
      onDelta,
      completion,
      resolveCompletion,
      rejectCompletion,
      settled: false,
      interruptRequested: false,
      timedOut: false,
      interruptSent: false,
      turnTimer: undefined,
      interruptTimer: undefined,
    };
    active.turnTimer = setTimeout(() => this.handleTurnTimeout(active), this.turnTimeoutMs);
    return active;
  }

  handleTurnTimeout(active) {
    if (this.activeTurn !== active || active.settled) return;
    active.timedOut = true;
    active.interruptRequested = true;
    this.emit("progress", { type: "turn_timed_out" });
    if (active.turnId) void this.sendInterrupt(active).catch((error) => this.finish(active, undefined, error));
    active.interruptTimer = setTimeout(() => {
      if (this.activeTurn !== active || active.settled) return;
      this.threadReady = false;
      this.finish(active, undefined, new Error("Codex turn timed out; the app-server did not confirm interruption. The connection was closed; another request will try to resume the saved thread."));
      this.terminateChild();
    }, this.interruptGraceMs);
  }

  async sendInterrupt(active) {
    if (active.interruptSent || !active.turnId || active.settled) return;
    active.interruptSent = true;
    try {
      await this.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId,
      });
    } catch (error) {
      active.interruptSent = false;
      throw error;
    }
  }

  request(method, params = {}) {
    if (!this.child || !this.child.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }

    const id = this.nextRpcId++;
    let timer;
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}.`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });

    try {
      this.write({ id, method, params });
    } catch (error) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      entry?.reject(error);
    }
    return promise;
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server input is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += String(chunk);
    if (this.stdoutBuffer.length > 8 * 1024 * 1024) {
      this.stdoutBuffer = "";
      this.handleExit(new Error("Codex app-server sent an oversized protocol message."), this.connectionGeneration);
      return;
    }

    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.handleExit(new Error("Codex app-server sent an invalid JSON-RPC message."), this.connectionGeneration);
        return;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (Object.prototype.hasOwnProperty.call(message, "id") && typeof message.method === "string") {
      void this.handleServerRequest(message);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const messageText = typeof message.error.message === "string" ? message.error.message : "Codex app-server returned an RPC error.";
        pending.reject(new Error(messageText));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (typeof message.method === "string") this.handleNotification(message.method, message.params || {});
  }

  async handleServerRequest(message) {
    const { id, method, params = {} } = message;
    const active = this.activeTurn;
    const child = this.child;
    const generation = this.connectionGeneration;
    // Approval prompts can outlive a disconnected transport. Never send their
    // replies (including denials/errors) to a replacement process with new IDs.
    const respond = (response) => {
      if (this.child === child && child) this.write(response);
    };
    try {
      if (!isApprovalMethod(method)) {
        respond({ id, error: { code: -32601, message: `Vesper does not support app-server request ${method}.` } });
        if (active) this.handleExit(new Error(`Codex requested unsupported server method ${method}.`), generation);
        return;
      }

      if (!isCurrentApproval(active, method, params, this.activeTurn)) {
        respond({ id, result: validateApprovalResult(method, defaultApproval(method)) });
        return;
      }

      this.emit("progress", { type: "approval_requested", method });
      const result = await this.onApproval(method, params);
      if (!isCurrentApproval(active, method, params, this.activeTurn)) {
        respond({ id, result: validateApprovalResult(method, defaultApproval(method)) });
        return;
      }
      const safeResult = validateApprovalResult(method, result);
      respond({ id, result: safeResult });
    } catch (error) {
      try {
        respond({ id, error: { code: -32000, message: "Vesper could not complete the approval request." } });
      } catch {
        // A closed transport is already reported through the active turn.
      }
      if (active && !active.settled) this.handleExit(error, generation);
    }
  }

  handleNotification(method, params) {
    const active = this.activeTurn;
    if (!active) return;
    if (params.threadId && params.threadId !== active.threadId) return;
    const eventTurnId = params.turnId || params.turn?.id;
    if (eventTurnId && active.turnId && eventTurnId !== active.turnId) return;

    if (method === "turn/started") {
      const turnId = params.turn?.id;
      if (typeof turnId === "string") active.turnId = turnId;
      this.emit("progress", { type: "turn_started" });
      if (active.interruptRequested && active.turnId) {
        void this.sendInterrupt(active).catch((error) => this.finish(active, undefined, error));
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (typeof params.turnId === "string" && active.turnId && params.turnId !== active.turnId) return;
      if (typeof params.delta === "string" && params.delta) active.onDelta(params.delta);
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn || {};
      if (turn.id && active.turnId && turn.id !== active.turnId) return;
      if (turn.id && !active.turnId) active.turnId = turn.id;
      this.finishFromStatus(active, turn);
      return;
    }

    if (method === "item/started" || method === "item/completed" ||
        method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta" ||
        method === "item/fileChange/patchUpdated" || method === "turn/diff/updated" ||
        method === "turn/plan/updated" || method === "item/mcpToolCall/progress" || method === "error") {
      // Keep protocol payloads for additive frontend activity/diff/error views.
      // Error notifications may describe retries; only turn/completed settles.
      this.emit("progress", { type: "codex_progress", method, params });
    }
  }

  finishFromStatus(active, turn) {
    switch (turn.status) {
      case "completed":
        this.finish(active, { status: "completed" });
        break;
      case "interrupted":
        this.finish(active, { status: active.timedOut ? "timeout" : "interrupted" });
        break;
      case "failed":
        this.finish(active, undefined, new Error(turn.error?.message || "Codex turn failed."));
        break;
      default:
        this.finish(active, undefined, new Error(`Codex turn ended in unsupported status ${String(turn.status || "unknown")}.`));
    }
  }

  finish(active, value, error) {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.turnTimer);
    clearTimeout(active.interruptTimer);
    if (this.activeTurn === active) this.activeTurn = undefined;
    if (error) active.rejectCompletion(error);
    else active.resolveCompletion(value);
  }

  handleExit(error, generation) {
    if (generation !== this.connectionGeneration) return;
    const child = this.child;
    this.child = undefined;
    this.readyPromise = undefined;
    this.threadReady = false;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
    if (this.activeTurn) this.finish(this.activeTurn, undefined, error);
    if (child && !child.killed) child.kill();
  }

  terminateChild() {
    const child = this.child;
    this.child = undefined;
    this.readyPromise = undefined;
    this.threadReady = false;
    if (child && !child.killed) child.kill();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeTurn) this.finish(this.activeTurn, undefined, new Error("Vesper closed during the Codex turn."));
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error("Vesper app-server client closed."));
    }
    this.terminateChild();
  }
}

function isApprovalMethod(method) {
  return new Set([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ]).has(method);
}

function defaultApproval(method) {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: { denied: { rejection: "Declined by Vesper." } } };
  }
  return { decision: "decline" };
}

function isCurrentApproval(capturedTurn, method, params, currentTurn) {
  if (!capturedTurn || capturedTurn.settled || capturedTurn !== currentTurn) return false;
  const requestThreadId = params.threadId || params.conversationId;
  if (requestThreadId && requestThreadId !== capturedTurn.threadId) return false;
  if (params.turnId && capturedTurn.turnId && params.turnId !== capturedTurn.turnId) return false;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval") {
    return Boolean(params.threadId && params.turnId);
  }
  return true;
}

function validateApprovalResult(method, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Approval handler returned an invalid response.");
  if (method === "item/permissions/requestApproval") {
    if (!value.permissions || typeof value.permissions !== "object" || Array.isArray(value.permissions)) {
      throw new Error("Permission approval must return a permission profile.");
    }
    if (value.scope !== undefined && !["turn", "session"].includes(value.scope)) throw new Error("Permission approval scope is invalid.");
    if (value.scope === "session") throw new Error("Vesper only supports turn-scoped permission grants.");
    return { permissions: value.permissions, scope: "turn" };
  }
  const decision = value.decision;
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    if (decision === "approved" || decision === "abort") return { decision };
    if (isStructuredDenial(decision)) {
      return { decision: { denied: { rejection: decision.denied.rejection } } };
    }
    throw new Error("Legacy approval decision is not supported by Vesper.");
  }
  const choices = method === "item/commandExecution/requestApproval"
    ? ["accept", "decline", "cancel"]
    : method === "item/fileChange/requestApproval"
      ? ["accept", "decline", "cancel"]
      : [];
  if (!choices.includes(decision)) throw new Error("Approval decision is not supported by Vesper.");
  return { decision };
}

function isStructuredDenial(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision) || Object.keys(decision).length !== 1) return false;
  const denied = decision.denied;
  return Boolean(
    denied &&
    typeof denied === "object" &&
    !Array.isArray(denied) &&
    Object.keys(denied).length === 1 &&
    typeof denied.rejection === "string"
  );
}

function samePath(first, second) {
  return path.resolve(first) === path.resolve(second);
}

function isTerminalStatus(status) {
  return ["completed", "interrupted", "failed"].includes(status);
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 800);
}

module.exports = {
  AppServerClient,
  INTERRUPT_GRACE_MS,
  RPC_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  validateApprovalResult,
};
