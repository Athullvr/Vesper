"use strict";

const readline = require("node:readline");
const { RouteMetrics, ROUTING_REASON_COUNT_CODES, classifyRequest, createRoutingDecisionRecord, routeRequest } = require("./routing-core");
const { createFileChangeSnapshot } = require("./file-change-approval");
const { CommandActivityStore, escapeTerminalField, escapeTerminalOutput, redactSensitiveText, renderActivityUpdates } = require("./command-activity");
const { projectConversationHistory, unavailableHistory } = require("./conversation-history");
const { MAX_TURN_DIFF_LENGTH } = require("./turn-diff-activity");
const { LiveTurnDiffView } = require("./live-turn-diff-view");

const QUIT_COMMANDS = new Set([":quit", ":exit", "/quit", "/exit"]);
const MAX_FILE_ACTIVITY_ITEMS = 50;
const MAX_FILE_ACTIVITY_OUTPUT_LENGTH = 12_000;
const MAX_FILE_ACTIVITY_CHANGES_PER_ITEM = 8;
const MAX_FILE_ACTIVITY_PATH_LENGTH = 1_024;
const FILE_ACTIVITY_LIMIT_MARKER = "\n[Vesper] File-change summary output is limited; later summaries or updates are omitted.\n";
const MAX_TURN_DIFF_RENDERED_LENGTH = 16_000;
const MAX_STREAMED_TURN_OUTPUT = 256_000;
const MAX_ROUTING_SUMMARY_LENGTH = 1_600;
const STREAMED_OUTPUT_LIMIT_MARKER = "\n[Vesper] Streamed response truncated at the terminal output limit.\n";
const PRIVATE_KEY_START = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/iu;
const STREAM_URL_CREDENTIAL_START = /\bhttps?:\/\/[^:/\s]+:/giu;
const STREAM_PARTIAL_TOKEN_SUFFIX = /(?:\bhttps?:\/\/\S*|\bsk-(?:proj-)?[A-Za-z0-9_-]*|\bgh[pousr]_[A-Za-z0-9_]*|\bgithub_pat_[A-Za-z0-9_]*|\bxox[baprs]-[A-Za-z0-9-]*|\bAKIA[0-9A-Z]*)$/iu;
const STREAM_SENSITIVE_STARTS = [
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+/giu,
  /\bBearer\s+/giu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)\s*[:=]\s*/giu,
  /(?<![\p{L}\p{N}_])--?(?:password|passwd|token|secret|api-key|access-token|client-secret)(?:=|\s+)/giu,
];
const STREAM_SENSITIVE_MARKER_NAMES = [
  "authorization", "bearer", "api_key", "api-key", "apikey", "access_token", "access-token", "accesstoken",
  "refresh_token", "refresh-token", "refreshtoken", "auth_token", "auth-token", "authtoken", "password", "passwd",
  "secret", "client_secret", "client-secret", "clientsecret", "private_key", "private-key", "privatekey",
  "--password", "--passwd", "--token", "--secret", "--api-key", "--access-token", "--client-secret",
];

class TerminalFrontend {
  constructor({ cwd, handlers, appServer, input = process.stdin, output = process.stdout, lineIO, metrics = new RouteMetrics(), savedThreadId = null, sessionId = null, onWorkspaceCommand, onTask, routingDiagnostics = process.env.VESPER_ROUTING_DEBUG === "1" } = {}) {
    if (typeof cwd !== "string" || !cwd) throw new TypeError("A project directory is required.");
    if (!handlers || typeof handlers !== "object") throw new TypeError("Local handlers are required.");
    if (!appServer || typeof appServer.runTurn !== "function") throw new TypeError("A Codex app-server client is required.");
    this.cwd = cwd;
    this.handlers = handlers;
    this.appServer = appServer;
    this.savedThreadId = savedThreadId;
    this.savedHistoryState = savedThreadId ? "pending" : "not-needed";
    this.sessionId = sessionId;
    this.onWorkspaceCommand = onWorkspaceCommand;
    this.onTask = onTask;
    this.routingDiagnostics = Boolean(routingDiagnostics);
    this.output = output;
    this.lineIO = lineIO || createLineIO(input, output);
    this.metrics = metrics;
    this.activeRequest = false;
    this.exitAfterTurn = false;
    this.interruptPending = false;
    this.closed = false;
    this.streamedOutputLength = 0;
    this.streamLimitReported = false;
    this.streamInputLength = 0;
    this.streamInputLimitReached = false;
    this.streamPending = "";
    this.commandActivity = null;
    this.fileActivityIdentities = new Set();
    this.fileActivityOutputLength = 0;
    this.fileActivityLimitReported = false;
    this.turnDiffIdentity = null;
    this.turnDiffRendered = false;
    this.pendingTurnDiffFinal = null;
    this.approvalPromptDepth = 0;
    this.turnDiffView = new LiveTurnDiffView({
      output,
      enabled: Boolean(input?.isTTY && output?.isTTY && process.env.TERM !== "dumb"),
      renderActivity: (activity) => renderTurnDiffActivity({ ...activity, closeReason: activity?.closeReason || "inProgress" }),
    });
    this.pendingApprovals = new Set();
    this.approvalQueue = Promise.resolve();
    this.handleProgress = this.handleProgress.bind(this);

    this.appServer.on?.("progress", this.handleProgress);
    this.lineIO.onInterrupt?.(() => this.handleInterrupt());
  }

  async run() {
    this.write("Vesper · local routing with Codex app-server fallback\n");
    this.write(`Project: ${safeTerminalText(this.cwd)}\n`);
    this.write("Use :sessions to list sessions, :switch ID to resume one, :new to start separately, :routing for session counts, and :quit to exit. Local answers do not start Codex turns.\n\n");

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
    if (prompt.startsWith(":")) {
      if (prompt.trim() === ":routing") {
        this.write(renderRoutingSummary(this.metrics, this.sessionId));
        return;
      }
      try {
        if (await this.onWorkspaceCommand?.(prompt, this)) return;
      } catch (error) {
        this.write(`[Vesper command error] ${safeTerminalText(error?.message || error)}\n`);
        return;
      }
      this.write(`[Vesper] Unknown workspace command: ${safeTerminalText(prompt)}. Use :sessions, :switch ID, :new, :routing, or :quit.\n`);
      return;
    }

    try {
      await this.onTask?.(prompt);
    } catch (error) {
      this.write(`[Vesper session warning] Could not update session activity time: ${safeTerminalText(error?.message || error)}\n`);
    }

    const startedAt = Date.now();
    const decision = classifyRequest(prompt);

    if (decision.route === "local") {
      const routed = await routeRequest(prompt, {
        decision,
        handlers: this.handlers,
        context: { cwd: this.cwd },
        onRoutingDecision: (routingDecision) => this.writeRoutingDecision(routingDecision),
      });
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const failed = routed.result?.status === "unavailable";
      this.metrics.record(decision, elapsedMs, { handlerFailed: failed, routingDecision: routed.routingDecision });
      this.write(`${safeTerminalText(routed.result.summary)}\n`);
      return;
    }

    let routingDecision;
    this.activeRequest = true;
    this.interruptPending = false;
    this.commandActivity = new CommandActivityStore();
    this.streamedOutputLength = 0;
    this.streamLimitReported = false;
    this.streamInputLength = 0;
    this.streamInputLimitReached = false;
    this.streamPending = "";
    this.turnDiffIdentity = null;
    this.turnDiffRendered = false;
    this.pendingTurnDiffFinal = null;
    this.turnDiffView.begin();
    this.fileActivityIdentities.clear();
    this.fileActivityOutputLength = 0;
    this.fileActivityLimitReported = false;
    try {
      const routed = await routeRequest(prompt, {
        decision,
        handlers: this.handlers,
        context: { cwd: this.cwd },
        onRoutingDecision: (record) => {
          routingDecision = record;
          this.writeRoutingDecision(record);
          this.write("[Codex · connecting]\n");
        },
        fallback: async () => {
          await this.restoreSavedHistory();
          return this.appServer.runTurn({
            prompt,
            cwd: this.cwd,
            onDelta: (delta) => this.writeStreamDelta(delta),
          });
        },
      });
      const result = routed.fallbackResult;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.metrics.record(decision, elapsedMs, { routingDecision: routed.routingDecision });
      this.finishStream();
      if (result?.status === "completed") this.write(`\n\n[Codex · completed · ${elapsedMs} ms]\n`);
      else if (result?.status === "interrupted") this.write("\n\n[Codex · interrupted]\n");
      else if (result?.status === "timeout") this.write("\n\n[Codex · timed out and interrupted]\n");
      else this.write(`\n\n[Codex · ended with status ${safeTerminalText(result?.status || "unknown")}]\n`);
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.metrics.record(decision, elapsedMs, { routingDecision });
      this.finishStream();
      this.write(`\n\n[Codex error · ${elapsedMs} ms] ${safeTerminalText(error?.message || error)}\n`);
    } finally {
      this.finishStream();
      this.turnDiffView.end();
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
    const pending = this.approvalQueue.then(async () => {
      this.approvalPromptDepth += 1;
      this.turnDiffView.suspend();
      try {
        return await this.promptForApproval(method, params, context);
      } finally {
        this.approvalPromptDepth = Math.max(0, this.approvalPromptDepth - 1);
        if (this.approvalPromptDepth === 0) {
          if (this.pendingTurnDiffFinal) {
            const activity = this.pendingTurnDiffFinal;
            this.pendingTurnDiffFinal = null;
            this.write(renderTurnDiffActivity(activity));
          } else {
            this.turnDiffView.resume();
          }
        } else {
          this.turnDiffView.resume();
        }
      }
    });
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

  async restoreSavedHistory() {
    if (!this.savedThreadId || this.savedHistoryState === "loaded") return;

    let resumedThreadId;
    try {
      resumedThreadId = await this.appServer.resumeThread(this.cwd);
      if (resumedThreadId !== this.savedThreadId) {
        throw new Error("Codex app-server resumed a different thread than the saved Vesper session.");
      }
    } catch (error) {
      this.savedHistoryState = "pending";
      throw error;
    }

    this.savedHistoryState = "loaded";
    let historyView;
    try {
      const history = await this.appServer.readThreadHistory();
      if (history?.threadId !== this.savedThreadId) {
        throw new Error("Codex returned history for a different saved thread.");
      }
      historyView = projectConversationHistory(history);
    } catch (error) {
      historyView = unavailableHistory(
        `The saved Codex thread is connected, but conversation history could not be retrieved: ${safeTerminalText(error?.message || error)}. Vesper has not treated it as empty.`
      );
    }

    this.write(`\n[Vesper history · ${historyView.state}] ${historyView.text}\n`);
    for (const entry of historyView.entries) {
      this.write(`[${entry.label}] ${entry.text}\n`);
    }
  }

  replaceAppServer(appServer, { sessionId = null, savedThreadId = null } = {}) {
    if (this.activeRequest || this.pendingApprovals.size) throw new Error("A Vesper session can only be switched while the terminal is idle.");
    if (!appServer || typeof appServer.runTurn !== "function") throw new TypeError("A Codex app-server client is required.");
    this.appServer.off?.("progress", this.handleProgress);
    this.appServer = appServer;
    this.appServer.on?.("progress", this.handleProgress);
    this.sessionId = sessionId;
    this.savedThreadId = savedThreadId;
    this.savedHistoryState = savedThreadId ? "pending" : "not-needed";
    this.turnDiffIdentity = null;
    this.turnDiffRendered = false;
    this.pendingTurnDiffFinal = null;
    this.commandActivity = null;
    this.metrics = new RouteMetrics();
  }

  writeStreamDelta(delta) {
    if (this.streamLimitReported || this.streamInputLimitReached) return;
    const source = String(delta ?? "");
    const remainingInput = Math.max(0, MAX_STREAMED_TURN_OUTPUT - this.streamInputLength);
    const accepted = source.slice(0, remainingInput);
    this.streamInputLength += accepted.length;
    this.streamPending += accepted;
    this.flushStreamPrefix();
    if (accepted.length < source.length) {
      this.streamInputLimitReached = true;
      this.finishStreamPending();
      this.writeStreamLimitMarker();
    }
  }

  flushStreamPrefix() {
    if (!this.streamPending) return;
    const protectedStart = findOpenSensitiveSpan(this.streamPending, this.streamPending.length);
    const partialMarkerStart = findPartialSensitiveMarkerStart(this.streamPending);
    let cut = protectedStart < 0 ? this.streamPending.length : protectedStart;
    if (partialMarkerStart >= 0) cut = Math.min(cut, partialMarkerStart);
    if (cut <= 0) return;
    const prefix = this.streamPending.slice(0, cut);
    this.streamPending = this.streamPending.slice(cut);
    this.writeSanitizedStreamText(prefix);
  }

  finishStream() {
    if (this.streamPending) this.finishStreamPending();
    if (this.streamInputLimitReached) this.writeStreamLimitMarker();
  }

  finishStreamPending() {
    const pending = this.streamPending;
    this.streamPending = "";
    const start = PRIVATE_KEY_START.exec(pending);
    if (start && !PRIVATE_KEY_END.test(pending.slice(start.index + start[0].length))) {
      const prefix = pending.slice(0, start.index);
      this.writeSanitizedStreamText(prefix);
      this.writeSanitizedStreamText("[redacted private key]");
      return;
    }
    this.writeSanitizedStreamText(pending);
  }

  writeSanitizedStreamText(value) {
    if (this.streamLimitReported || !value) return;
    const text = safeStreamText(value);
    const contentLimit = MAX_STREAMED_TURN_OUTPUT - STREAMED_OUTPUT_LIMIT_MARKER.length;
    const remaining = Math.max(0, contentLimit - this.streamedOutputLength);
    const visible = text.slice(0, remaining);
    if (visible) {
      this.write(visible);
      this.streamedOutputLength += visible.length;
    }
    if (visible.length < text.length) {
      this.writeStreamLimitMarker();
    }
  }

  writeStreamLimitMarker() {
    if (this.streamLimitReported) return;
    this.write(STREAMED_OUTPUT_LIMIT_MARKER);
    this.streamLimitReported = true;
  }

  handleProgress(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "thread_starting": this.write("[Codex] Starting a thread…\n"); break;
      case "thread_resuming": this.write("[Codex] Resuming the saved thread…\n"); break;
      case "turn_started": this.write("[Codex] Working…\n"); break;
      case "turn_identity":
        this.turnDiffIdentity = isTurnDiffIdentity(event.threadId, event.turnId)
          ? { threadId: event.threadId, turnId: event.turnId }
          : null;
        if (this.turnDiffIdentity) this.turnDiffView.begin();
        this.renderCommandActivity(this.commandActivity?.bindTurn(event.threadId, event.turnId));
        this.renderFileChangeActivities(event.fileChanges);
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
      case "file_change_activity":
        this.renderFileChangeActivities([event.activity]);
        break;
      case "turn_diff_activity":
        this.renderTurnDiffActivity(event.activity);
        break;
      case "turn_diff_updated":
        this.updateTurnDiffActivity(event.activity);
        break;
      case "turn_timed_out": this.write("[Vesper] Turn timed out; asking Codex to interrupt…\n"); break;
      case "disconnected": this.write(`[Codex disconnected] ${safeTerminalText(event.reason || "app-server connection closed")}\n`); break;
      case "interrupt_requested": this.write("[Vesper] Interrupting the Codex turn…\n"); break;
      case "file_approval_declined": this.write(`[Vesper] File-change approval declined: ${safeTerminalText(event.reason)}\n`); break;
      default: break;
    }
  }

  renderCommandActivity(updates) {
    renderActivityUpdates(updates, (text) => this.write(text));
  }

  renderFileChangeActivities(activities) {
    for (const activity of activities || []) {
      if (this.fileActivityLimitReported) return;
      if (!isFileActivityIdentity(activity)) continue;
      const key = JSON.stringify([activity.threadId, activity.turnId, activity.itemId]);
      if (!this.fileActivityIdentities.has(key)) {
        if (this.fileActivityIdentities.size >= MAX_FILE_ACTIVITY_ITEMS) {
          this.writeFileActivityLimitMarker();
          return;
        }
        this.fileActivityIdentities.add(key);
      }
      const rendered = renderFileChangeActivity(activity);
      const contentBudget = MAX_FILE_ACTIVITY_OUTPUT_LENGTH - FILE_ACTIVITY_LIMIT_MARKER.length;
      if (this.fileActivityOutputLength + rendered.length > contentBudget) {
        this.writeFileActivityLimitMarker();
        return;
      }
      this.write(rendered);
      this.fileActivityOutputLength += rendered.length;
    }
  }

  renderTurnDiffActivity(activity) {
    if (this.turnDiffRendered || !isTurnDiffIdentity(activity?.threadId, activity?.turnId)) return;
    if (!this.turnDiffIdentity || activity.threadId !== this.turnDiffIdentity.threadId || activity.turnId !== this.turnDiffIdentity.turnId) return;
    const retainedInPlace = this.turnDiffView.close(activity);
    this.turnDiffRendered = true;
    if (this.approvalPromptDepth > 0) {
      this.pendingTurnDiffFinal = activity;
      return;
    }
    if (!retainedInPlace) this.write(renderTurnDiffActivity(activity));
  }

  updateTurnDiffActivity(activity) {
    if (this.turnDiffRendered || !isTurnDiffIdentity(activity?.threadId, activity?.turnId)) return;
    if (!this.turnDiffIdentity || activity.threadId !== this.turnDiffIdentity.threadId || activity.turnId !== this.turnDiffIdentity.turnId) return;
    this.turnDiffView.update(activity);
  }

  writeFileActivityLimitMarker() {
    if (this.fileActivityLimitReported) return;
    this.fileActivityLimitReported = true;
    if (this.fileActivityOutputLength + FILE_ACTIVITY_LIMIT_MARKER.length <= MAX_FILE_ACTIVITY_OUTPUT_LENGTH) {
      this.write(FILE_ACTIVITY_LIMIT_MARKER);
      this.fileActivityOutputLength += FILE_ACTIVITY_LIMIT_MARKER.length;
    }
  }

  handleInterrupt() {
    if (this.activeRequest) {
      if (this.interruptPending) return;
      this.interruptPending = true;
      this.lineIO.cancelPending?.();
      this.write("\n[Vesper] Ctrl+C received; interrupting this turn. Vesper will return to the prompt when it ends.\n");
      Promise.resolve(this.appServer.interrupt?.()).catch((error) => {
        this.write(`[Vesper interrupt error] ${safeTerminalText(error?.message || error)}\n`);
      });
    } else {
      this.exitAfterTurn = true;
      this.lineIO.close?.();
    }
  }

  write(text) {
    this.turnDiffView.beforeExternalWrite();
    try {
      this.output.write(String(text));
    } finally {
      this.turnDiffView.afterExternalWrite();
    }
  }

  writeRoutingDecision(routingDecision) {
    this.write(`\n[${formatRoutingIndicator(routingDecision)}]\n`);
    if (this.routingDiagnostics) {
      this.write(`[Routing diagnostic] ${safeTerminalText(JSON.stringify(routingDecision))}\n`);
    }
  }
}

function formatRoutingIndicator(record) {
  const intent = record.intent || "local intent";
  if (record.outcome === "codex_delegated") {
    return record.reasonCode === "local_ambiguous"
      ? "Route · Codex · local topic ambiguous"
      : "Route · Codex · no local intent matched";
  }
  if (record.outcome === "codex_not_dispatched") return "Route · Codex · fallback not configured";
  if (record.outcome === "local_insufficient") return `Route · local · ${intent} · evidence ${record.handlerStatus}`;
  if (record.outcome === "local_unavailable") return `Route · local · ${intent} · unavailable; no Codex fallback`;
  if (record.outcome === "local_selected") return `Route · local · ${intent} · selected`;
  return `Route · local · ${intent} · handler status ${record.handlerStatus || "unknown"}`;
}

function renderRoutingSummary(metrics, sessionId = null) {
  if (!metrics || typeof metrics.snapshot !== "function") {
    return "Routing diagnostics unavailable: no session metrics are attached.\n";
  }

  let snapshot;
  try {
    snapshot = metrics.snapshot();
  } catch {
    return "Routing diagnostics unavailable: session metrics could not be read.\n";
  }
  if (!snapshot || typeof snapshot !== "object") {
    return "Routing diagnostics unavailable: session metrics could not be read.\n";
  }

  const displayCount = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "—";
  const outcomes = snapshot.routingOutcomes && typeof snapshot.routingOutcomes === "object"
    ? snapshot.routingOutcomes
    : null;
  const reasons = snapshot.routingReasons && typeof snapshot.routingReasons === "object"
    ? snapshot.routingReasons
    : null;
  const sessionLabel = sessionId ? ` ${safeTerminalText(sessionId).slice(0, 80)}` : "";
  const lines = [
    `Routing outcomes · current in-memory Vesper session${sessionLabel}`,
    `Total tasks routed: ${displayCount(snapshot.routingDecisionCount)}`,
    `Local handled: ${displayCount(outcomes?.local_handled)}`,
    `Local insufficient: ${displayCount(outcomes?.local_insufficient)}`,
    `Local unavailable: ${displayCount(outcomes?.local_unavailable)}`,
    `Codex delegated: ${displayCount(outcomes?.codex_delegated)}`,
    `Codex not dispatched: ${displayCount(outcomes?.codex_not_dispatched)}`,
    "By reason code:",
    ...ROUTING_REASON_COUNT_CODES.map((reasonCode) => `  ${reasonCode}: ${displayCount(reasons?.[reasonCode])}`),
    "Counts are recorded routing outcomes; delegation does not indicate task success. Saved sessions have no historical counters.",
  ];
  let summary = `${lines.join("\n")}\n`;
  if (summary.length > MAX_ROUTING_SUMMARY_LENGTH) summary = `${summary.slice(0, MAX_ROUTING_SUMMARY_LENGTH - 1)}\n`;
  return summary;
}

function createLineIO(input, output) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let closed = false;
  let pendingResolve;
  let pendingAbortController;
  const interruptHandlers = new Set();

  rl.on("close", () => {
    closed = true;
    pendingAbortController?.abort();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = undefined;
      resolve(null);
    }
  });
  rl.on("SIGINT", () => {
    if (!interruptHandlers.size) {
      pendingAbortController?.abort();
      rl.close();
      return;
    }
    for (const handler of interruptHandlers) handler();
  });

  return {
    question(prompt, { signal } = {}) {
      if (closed || signal?.aborted) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        pendingAbortController = controller;
        let settled = false;
        const finish = (answer) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          controller.signal.removeEventListener("abort", onAbort);
          if (pendingResolve === finish) {
            pendingResolve = undefined;
            pendingAbortController = undefined;
          }
          resolve(answer ?? null);
        };
        const abort = () => {
          controller.abort();
          finish(null);
        };
        const onAbort = () => finish(null);
        pendingResolve = finish;
        controller.signal.addEventListener("abort", onAbort, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          rl.question(prompt, { signal: controller.signal }, finish);
        } catch (error) {
          signal?.removeEventListener("abort", abort);
          pendingResolve = undefined;
          pendingAbortController = undefined;
          controller.signal.removeEventListener("abort", onAbort);
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
    cancelPending() {
      if (!pendingAbortController) return false;
      pendingAbortController.abort();
      return true;
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
  return escapeTerminalField(redactSensitiveText(value)).slice(0, 4_000);
}

function escapeTerminalControls(value) {
  return String(value ?? "")
    .replace(/\u001b/gu, "\\x1b")
    .replace(/\r/gu, "\\r")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

function safeStreamText(value) {
  return escapeTerminalOutput(redactSensitiveText(value));
}

function findOpenSensitiveSpan(text, cut) {
  const privateKeyStart = PRIVATE_KEY_START.exec(text);
  if (privateKeyStart && privateKeyStart.index < cut) {
    const end = PRIVATE_KEY_END.exec(text.slice(privateKeyStart.index + privateKeyStart[0].length));
    if (!end || privateKeyStart.index + privateKeyStart[0].length + end.index >= cut) return privateKeyStart.index;
  }

  let protectedStart = -1;
  STREAM_URL_CREDENTIAL_START.lastIndex = 0;
  let urlMatch;
  while ((urlMatch = STREAM_URL_CREDENTIAL_START.exec(text)) !== null) {
    if (urlMatch.index >= cut) break;
    const afterCredentials = urlMatch.index + urlMatch[0].length;
    const at = text.indexOf("@", afterCredentials);
    const delimiter = text.slice(afterCredentials).search(/[\s/]/u);
    if (at < 0 && (delimiter < 0 || afterCredentials + delimiter >= cut)) {
      protectedStart = urlMatch.index;
      break;
    }
  }
  for (const pattern of STREAM_SENSITIVE_STARTS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index >= cut) break;
      let valueIndex = match.index + match[0].length;
      while (/\s/u.test(text[valueIndex] || "") && valueIndex < text.length) valueIndex += 1;
      if (valueIndex >= cut) {
        protectedStart = protectedStart < 0 ? match.index : Math.min(protectedStart, match.index);
        continue;
      }
      const quote = text[valueIndex] === "'" || text[valueIndex] === '"' ? text[valueIndex] : null;
      if (quote) {
        const close = text.indexOf(quote, valueIndex + 1);
        if (close < 0 || close >= cut) protectedStart = protectedStart < 0 ? match.index : Math.min(protectedStart, match.index);
        continue;
      }
      const delimiter = text.slice(valueIndex).search(/[\s;&|]/u);
      if (delimiter < 0 || valueIndex + delimiter >= cut) {
        protectedStart = protectedStart < 0 ? match.index : Math.min(protectedStart, match.index);
      }
    }
  }
  return protectedStart;
}

function findPartialSensitiveMarkerStart(text) {
  const privateKeyStart = text.lastIndexOf("-----BEGIN");
  if (privateKeyStart >= 0 && /^-----BEGIN(?: [A-Z0-9 ]*)?$/iu.test(text.slice(privateKeyStart))) return privateKeyStart;
  const trailingWord = text.match(/\S+$/u)?.[0]?.toLowerCase();
  if (trailingWord) {
    for (const marker of STREAM_SENSITIVE_MARKER_NAMES) {
      if (trailingWord.length <= marker.length && marker.startsWith(trailingWord)) {
        return text.length - trailingWord.length;
      }
    }
  }
  const partialToken = STREAM_PARTIAL_TOKEN_SUFFIX.exec(text);
  if (partialToken) return partialToken.index;
  return -1;
}

function isFileActivityIdentity(activity) {
  return activity && typeof activity === "object" &&
    [activity.threadId, activity.turnId, activity.itemId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
      !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value));
}

function renderFileChangeActivity(activity) {
  const number = Number.isInteger(activity.number) && activity.number > 0 ? activity.number : "?";
  const states = new Set(["pending", "updated", "invalidated", "completed"]);
  const state = states.has(activity.state) ? activity.state : "invalidated";
  const lines = [`\n[Codex file-change summary #${number} · evidence ${state} · proposed changes; disk state not verified]\n`];

  if (state === "invalidated") {
    lines.push("Earlier details are no longer current; no file paths are shown.\n");
    return lines.join("");
  }
  if (state === "completed") {
    lines.push("The file-change evidence lifecycle completed; this does not verify a disk write.\n");
    return lines.join("");
  }

  const changes = Array.isArray(activity.changes) ? activity.changes : [];
  if (!changes.length) {
    lines.push("Summary incomplete: no safe change details are available.\n");
    return lines.join("");
  }
  let incomplete = Boolean(activity.incomplete);
  const visible = changes.slice(0, MAX_FILE_ACTIVITY_CHANGES_PER_ITEM);
  for (const change of visible) {
    if (!change || typeof change !== "object" || typeof change.path !== "string" || !["add", "delete", "update"].includes(change.kind)) {
      incomplete = true;
      continue;
    }
    const pathText = safeFileSummaryField(change.path);
    lines.push(`File: ${pathText.text}${pathText.truncated || change.pathTruncated ? " … [path truncated]" : ""}\n`);
    lines.push(`Change: ${change.kind}`);
    if (change.kind === "update" && typeof change.movePath === "string") {
      const movePath = safeFileSummaryField(change.movePath);
      lines.push(`; moved to ${movePath.text}${movePath.truncated || change.movePathTruncated ? " … [path truncated]" : ""}`);
    }
    if (Number.isSafeInteger(change.addedLines) && change.addedLines >= 0 && Number.isSafeInteger(change.removedLines) && change.removedLines >= 0) {
      lines.push(` (+${change.addedLines} / −${change.removedLines} lines)`);
    } else {
      lines.push(" (line counts unavailable)");
      incomplete = true;
    }
    lines.push("\n");
    if (pathText.truncated || change.pathTruncated || change.movePathTruncated) incomplete = true;
  }
  if (changes.length > visible.length) {
    lines.push(`[summary truncated: ${changes.length - visible.length} change entries omitted]\n`);
    incomplete = true;
  }
  if (incomplete) lines.push("[summary incomplete or truncated]\n");
  return lines.join("");
}

function isTurnDiffIdentity(threadId, turnId) {
  return [threadId, turnId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value));
}

function renderTurnDiffActivity(activity) {
  if (!isTurnDiffIdentity(activity?.threadId, activity?.turnId)) return "";
  const evidenceStates = new Set(["available", "empty", "unavailable"]);
  const closeReasons = new Set(["completed", "interrupted", "failed", "disconnected", "timeout", "client_closed", "unknown"]);
  const evidenceState = evidenceStates.has(activity.evidenceState) ? activity.evidenceState : "unavailable";
  const closeReason = activity.closeReason === "inProgress"
    ? "inProgress"
    : closeReasons.has(activity.closeReason) ? activity.closeReason : "unknown";
  const lifecycle = {
    inProgress: "turn in progress; snapshot may be partial",
    completed: "turn completed",
    interrupted: "turn interrupted; snapshot may be partial",
    failed: "turn failed; snapshot may be partial",
    disconnected: "transport disconnected; snapshot may be partial",
    timeout: "turn timed out; snapshot may be partial",
    client_closed: "client closed; snapshot may be partial",
    unknown: "turn lifecycle unavailable; snapshot may be partial",
  }[closeReason];
  const heading = `\n[Codex · turn-level aggregate diff · ${lifecycle} · server-reported; disk write not verified]\n`;
  const distinction = "This is a turn-level snapshot; it is not mapped to file-change items.\n";
  let body;

  if (evidenceState === "unavailable") {
    const reason = {
      no_snapshot: "the app-server did not report a snapshot",
      malformed: "the latest matching event was malformed and the previous snapshot was cleared",
      oversized: `the latest snapshot exceeded the ${MAX_TURN_DIFF_LENGTH}-character cache limit and the previous snapshot was cleared`,
      redaction_expanded: "secret redaction would exceed the snapshot cache limit",
      pre_ack_overflow: "too many pre-acknowledgement snapshots arrived to retain this turn safely",
    }[activity.evidenceReason] || "a safe current snapshot is unavailable";
    body = `Aggregate diff unavailable: ${reason}.\n`;
  } else if (evidenceState === "empty") {
    body = "The latest aggregate snapshot is empty; no diff lines were supplied.\n";
  } else if (typeof activity.diff === "string") {
    const safeDiff = escapeTerminalOutput(redactSensitiveText(activity.diff));
    const prefixedDiff = safeDiff.split("\n").map((line) => `| ${line}`).join("\n");
    body = `Latest aggregate snapshot:\n${prefixedDiff}\n`;
  } else {
    body = "Aggregate diff unavailable: the snapshot content was malformed.\n";
  }

  const full = `${heading}${distinction}${body}`;
  if (full.length <= MAX_TURN_DIFF_RENDERED_LENGTH) return full;
  const marker = "\n| [turn-level diff display truncated at the terminal output limit; the cached snapshot was bounded separately]\n";
  const fixed = `${heading}${distinction}Latest aggregate snapshot:\n`;
  const contentBudget = Math.max(0, MAX_TURN_DIFF_RENDERED_LENGTH - fixed.length - marker.length);
  return `${fixed}${body.slice("Latest aggregate snapshot:\n".length, "Latest aggregate snapshot:\n".length + contentBudget)}${marker}`
    .slice(0, MAX_TURN_DIFF_RENDERED_LENGTH);
}

function safeFileSummaryField(value) {
  const source = redactSensitiveText(String(value ?? "").slice(0, 8_000));
  let text = "";
  let truncated = String(value ?? "").length > 8_000;
  for (const character of source) {
    const escaped = escapeTerminalField(character);
    if (text.length + escaped.length > MAX_FILE_ACTIVITY_PATH_LENGTH) {
      truncated = true;
      break;
    }
    text += escaped;
  }
  return { text, truncated };
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
  renderRoutingSummary,
  safeTerminalText,
  safeStreamText,
  renderFileChangeActivity,
  renderTurnDiffActivity,
  MAX_FILE_ACTIVITY_ITEMS,
  MAX_FILE_ACTIVITY_OUTPUT_LENGTH,
  MAX_TURN_DIFF_RENDERED_LENGTH,
  MAX_STREAMED_TURN_OUTPUT,
};
