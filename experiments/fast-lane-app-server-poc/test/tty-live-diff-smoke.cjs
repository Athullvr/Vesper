"use strict";

// Manual/controlled smoke driver for the real terminal streams. It emits
// synthetic frontend progress only; it never constructs AppServerClient.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { TerminalFrontend, MAX_TURN_DIFF_RENDERED_LENGTH } = require("../terminal-frontend");
const { MAX_TURN_DIFF_LENGTH } = require("../turn-diff-activity");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(ROOT, ".audit-artifacts");
const REPORT_PATH = path.join(ARTIFACTS, process.argv.includes("--non-tty") ? "non-tty-live-diff-smoke.json" : "tty-live-diff-smoke.json");
const WAIT_FOR_FRAME_MS = 90;
const capturedWrites = [];
let throwNextDiffFrame = false;
let renderingErrorInjected = false;
const injectedWriteErrors = [];

class SyntheticAppServer extends EventEmitter {
  constructor(report) {
    super();
    this.report = report;
    this.frontend = null;
    this.turnCount = 0;
    this.revision = 0;
  }

  async runTurn({ onDelta }) {
    const turnNumber = ++this.turnCount;
    const threadId = "synthetic-tty-thread";
    const turnId = `synthetic-tty-turn-${turnNumber}`;
    this.emit("progress", { type: "turn_identity", threadId, turnId, fileChanges: [] });
    this.emit("progress", { type: "turn_started", threadId, turnId });

    if (turnNumber === 1) return this.runInteractiveScenario(threadId, turnId, onDelta);
    if (turnNumber === 2) {
      await this.showSnapshot(threadId, turnId, "SMOKE-INTERRUPTED-SNAPSHOT");
      this.emitFinal(threadId, turnId, "SMOKE-INTERRUPTED-SNAPSHOT", "interrupted");
      this.report.turnOutcomes.push({ turnNumber, status: "interrupted", synthetic: true });
      return { status: "interrupted" };
    }
    if (turnNumber === 3) {
      await this.showSnapshot(threadId, turnId, "SMOKE-DISCONNECTED-SNAPSHOT");
      this.emitFinal(threadId, turnId, "SMOKE-DISCONNECTED-SNAPSHOT", "disconnected");
      this.report.turnOutcomes.push({ turnNumber, status: "disconnected", synthetic: true });
      throw new Error("Synthetic transport disconnect; no app-server process was started.");
    }
    if (turnNumber === 4) {
      throwNextDiffFrame = true;
      await this.showSnapshot(threadId, turnId, "SMOKE-RENDER-ERROR-SNAPSHOT");
      await delay(WAIT_FOR_FRAME_MS);
      const failed = this.frontend.turnDiffView.failed;
      this.report.renderingErrorRecovered = renderingErrorInjected && failed && this.frontend.turnDiffView.closed && !this.frontend.turnDiffView.resizeAttached;
      this.emitFinal(threadId, turnId, "SMOKE-RENDER-ERROR-SNAPSHOT", "completed");
      this.report.turnOutcomes.push({ turnNumber, status: "completed", synthetic: true });
      return { status: "completed" };
    }

    throw new Error("The TTY smoke harness supports four synthetic turns; enter :quit after turn four.");
  }

  async runInteractiveScenario(threadId, turnId, onDelta) {
    await this.showSnapshot(threadId, turnId, "SMOKE-SNAPSHOT-A");
    await this.showSnapshot(threadId, turnId, "SMOKE-SNAPSHOT-B");

    const oldColumns = process.stdout.columns;
    const oldRows = process.stdout.rows;
    const resizeCountBefore = this.report.resizeEvents.length;
    resizeTerminal(42, 11);
    await delay(20);
    this.report.resize = {
      before: { columns: oldColumns, rows: oldRows },
      after: { columns: process.stdout.columns, rows: process.stdout.rows },
      resizeEventReceived: this.report.resizeEvents.length > resizeCountBefore,
      drawnRowsAfterResize: this.frontend.turnDiffView.drawnRows,
    };

    const longDiff = [
      "SMOKE-LONG-START",
      ...Array.from({ length: 100 }, (_, index) => `+line ${index} ${"x".repeat(90)}`),
      "SMOKE-LONG-END",
    ].join("\n");
    await this.showSnapshot(threadId, turnId, longDiff);

    this.emitCommandActivity(threadId, turnId, "synthetic-command-1");
    onDelta("SMOKE-STREAMED-OUTPUT (synthetic; no model was contacted)\n");
    await delay(WAIT_FOR_FRAME_MS);

    const frameCountBeforeApproval = diffFrameCount();
    const approval = this.frontend.requestApproval("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "synthetic-command-approval",
      command: "synthetic-placeholder (never executed)",
      cwd: ROOT,
      availableDecisions: ["accept", "decline", "cancel"],
    });
    await delay(20);
    const suspendedAtPrompt = this.frontend.turnDiffView.suspended === 1;

    await this.showSnapshot(threadId, turnId, "SMOKE-UPDATED-DURING-APPROVAL");
    onDelta("SMOKE-STREAMED-DURING-APPROVAL (synthetic)\n");
    await delay(WAIT_FOR_FRAME_MS);
    const frameCountWhileApprovalOpen = diffFrameCount();
    const decision = await approval;
    await delay(WAIT_FOR_FRAME_MS);
    const frameCountAfterApproval = diffFrameCount();

    this.report.approvalInterleaving = {
      suspendedAtPrompt,
      frameCountBeforeApproval,
      frameCountWhileApprovalOpen,
      frameCountAfterApproval,
      restoredAfterDecision: frameCountAfterApproval > frameCountWhileApprovalOpen,
      decision: decision?.decision,
      syntheticCommandExecuted: false,
    };
    this.emitFinal(threadId, turnId, "SMOKE-UPDATED-DURING-APPROVAL", "completed");
    this.report.turnOutcomes.push({ turnNumber: 1, status: "completed", synthetic: true });

    resizeTerminal(oldColumns, oldRows);
    await delay(10);
    return { status: "completed" };
  }

  emitCommandActivity(threadId, turnId, itemId) {
    this.emit("progress", { type: "codex_progress", method: "item/started", params: {
      threadId,
      turnId,
      startedAtMs: 1,
      item: {
        type: "commandExecution",
        id: itemId,
        command: "synthetic-display-only",
        cwd: ROOT,
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      },
    } });
    this.emit("progress", { type: "codex_progress", method: "item/commandExecution/outputDelta", params: {
      threadId, turnId, itemId, delta: "SMOKE-COMMAND-ACTIVITY (synthetic; command not executed)\n",
    } });
    this.emit("progress", { type: "codex_progress", method: "item/completed", params: {
      threadId,
      turnId,
      completedAtMs: 2,
      item: {
        type: "commandExecution",
        id: itemId,
        command: "synthetic-display-only",
        cwd: ROOT,
        status: "failed",
        aggregatedOutput: "SMOKE-COMMAND-ACTIVITY (synthetic; command not executed)\n",
        exitCode: null,
      },
    } });
  }

  async showSnapshot(threadId, turnId, diff) {
    this.revision += 1;
    this.emit("progress", { type: "turn_diff_updated", activity: {
      threadId,
      turnId,
      evidenceState: "available",
      evidenceReason: null,
      diff,
      sourceLength: diff.length,
      redacted: false,
      revision: this.revision,
    } });
    await delay(WAIT_FOR_FRAME_MS);
  }

  emitFinal(threadId, turnId, diff, closeReason) {
    this.emit("progress", { type: "turn_status", threadId, turnId, status: closeReason });
    this.emit("progress", { type: "turn_diff_activity", activity: {
      threadId,
      turnId,
      evidenceState: "available",
      evidenceReason: null,
      closeReason,
      diff,
      sourceLength: diff.length,
      redacted: false,
      revision: this.revision,
    } });
  }

  async interrupt() { return true; }
  dispose() {}
}

function resizeTerminal(columns, rows) {
  const result = spawnSync("stty", ["cols", String(columns), "rows", String(rows)], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Could not resize the smoke TTY (${result.error?.message || result.status}).`);
  process.kill(process.pid, "SIGWINCH");
}

function diffFrameCount() {
  return capturedWrites.filter((chunk) => chunk.includes("turn-level aggregate diff")).length;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installWriteCapture() {
  const realWrite = process.stdout.write;
  process.stdout.write = function capturedWrite(chunk, encoding, callback) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
    if (throwNextDiffFrame && text.includes("turn-level aggregate diff")) {
      throwNextDiffFrame = false;
      renderingErrorInjected = true;
      injectedWriteErrors.push(text);
      throw new Error("Synthetic one-shot terminal rendering failure.");
    }
    const result = realWrite.call(this, chunk, encoding, callback);
    capturedWrites.push(text);
    return result;
  };
  return () => { process.stdout.write = realWrite; };
}

function makeReport(mode) {
  return {
    mode,
    actualInputTTY: Boolean(process.stdin.isTTY),
    actualOutputTTY: Boolean(process.stdout.isTTY),
    initialColumns: process.stdout.columns || null,
    initialRows: process.stdout.rows || null,
    resizeEvents: [],
    turnOutcomes: [],
  };
}

async function runTTYSmoke() {
  const report = makeReport("actual-pty-with-synthetic-app-server-events");
  if (!report.actualInputTTY || !report.actualOutputTTY || process.env.TERM === "dumb") {
    throw new Error("Run this mode in an interactive PTY with a usable TERM; no app-server will be started.");
  }
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const initialRawMode = Boolean(process.stdin.isRaw);
  const restoreOutput = installWriteCapture();
  const onResize = () => report.resizeEvents.push({ columns: process.stdout.columns, rows: process.stdout.rows });
  process.stdout.on("resize", onResize);

  const appServer = new SyntheticAppServer(report);
  const frontend = new TerminalFrontend({
    cwd: ROOT,
    handlers: {},
    appServer,
    input: process.stdin,
    output: process.stdout,
  });
  appServer.frontend = frontend;
  const completedTurns = [];
  const handlePrompt = frontend.handlePrompt.bind(frontend);
  frontend.handlePrompt = async (prompt) => {
    try { await handlePrompt(prompt); }
    finally {
      completedTurns.push({ viewClosed: frontend.turnDiffView.closed, resizeListenerDetached: !frontend.turnDiffView.resizeAttached });
    }
  };

  try {
    await frontend.run();
  } finally {
    if (process.stdout.columns !== originalColumns || process.stdout.rows !== originalRows) {
      resizeTerminal(originalColumns, originalRows);
      await delay(10);
    }
    process.stdout.off("resize", onResize);
    report.inputRawModeBeforeClose = initialRawMode;
    report.inputRawModeAfterClose = Boolean(process.stdin.isRaw);
    report.completedPromptCleanup = completedTurns;
    report.exitRestoredViewAndInput = frontend.closed && completedTurns.every((entry) => entry.viewClosed && entry.resizeListenerDetached) && !process.stdin.isRaw;
    report.liveFrames = capturedWrites
      .map((chunk, index) => ({ chunk, index }))
      .filter(({ chunk }) => chunk.includes("turn-level aggregate diff"))
      .map(({ chunk, index }) => ({
        index,
        markers: ["SMOKE-SNAPSHOT-A", "SMOKE-SNAPSHOT-B", "SMOKE-LONG-START", "SMOKE-UPDATED-DURING-APPROVAL", "SMOKE-INTERRUPTED-SNAPSHOT", "SMOKE-DISCONNECTED-SNAPSHOT", "SMOKE-RENDER-ERROR-SNAPSHOT"].filter((marker) => chunk.includes(marker)),
        truncated: /diff view truncated/u.test(chunk),
        length: chunk.length,
      }));
    report.clearSequences = capturedWrites.filter((chunk) => /\u001b\[\d*A\r\u001b\[J|\r\u001b\[J/u.test(chunk)).length;
    report.cursorHideOrAlternateScreenUsed = capturedWrites.some((chunk) => /\u001b\[\?25[lh]|\u001b\[\?1049[lh]/u.test(chunk));
    report.commandActivityRendered = capturedWrites.some((chunk) => chunk.includes("SMOKE-COMMAND-ACTIVITY"));
    report.streamedOutputInterleaved = capturedWrites.some((chunk) => chunk.includes("SMOKE-STREAMED-OUTPUT"));
    report.longDiffWasClipped = report.liveFrames.some((frame) => frame.markers.includes("SMOKE-LONG-START") && frame.truncated);
    report.renderingErrorWriteInjected = renderingErrorInjected && injectedWriteErrors.length === 1;
    report.renderErrorCleanupWritten = capturedWrites.some((chunk) => chunk.includes("\u001b[0m\r\n"));
    report.replacementUsedClearSequences = report.clearSequences > 0 && report.liveFrames.length >= 4;
    report.ttyOutputBounded = report.liveFrames.every((frame) => frame.length <= MAX_TURN_DIFF_RENDERED_LENGTH);
    restoreOutput();
    saveReport(report);
    process.stderr.write(`TTY smoke report: ${REPORT_PATH}\n`);
    process.stderr.write(`${JSON.stringify(summarize(report), null, 2)}\n`);
    const checks = [
      report.actualInputTTY && report.actualOutputTTY,
      report.resize?.resizeEventReceived && report.resize.after.columns === 42 && report.resize.after.rows === 11,
      report.approvalInterleaving?.suspendedAtPrompt && report.approvalInterleaving.restoredAfterDecision,
      report.commandActivityRendered && report.streamedOutputInterleaved,
      report.longDiffWasClipped,
      report.turnOutcomes.length === 4 && report.turnOutcomes.some((entry) => entry.status === "interrupted") && report.turnOutcomes.some((entry) => entry.status === "disconnected"),
      report.renderingErrorRecovered,
      report.renderErrorCleanupWritten,
      report.exitRestoredViewAndInput,
      report.ttyOutputBounded && !report.cursorHideOrAlternateScreenUsed,
    ];
    if (checks.some((passed) => !passed)) process.exitCode = 1;
  }
}

async function runNonTTYSmoke() {
  const report = makeReport("redirected-stdout-synthetic-events");
  if (report.actualOutputTTY) throw new Error("Run --non-tty with stdout redirected to a file.");
  const restoreOutput = installWriteCapture();
  const appServer = new EventEmitter();
  appServer.runTurn = async () => {
    const threadId = "synthetic-redirect-thread";
    const turnId = "synthetic-redirect-turn";
    appServer.emit("progress", { type: "turn_identity", threadId, turnId, fileChanges: [] });
    for (const [revision, diff] of [
      [1, "SMOKE-OLD-REDIRECTED-SNAPSHOT"],
      [2, `SMOKE-LATEST-REDIRECTED-SNAPSHOT\n${"x".repeat(MAX_TURN_DIFF_LENGTH + 1)}`],
    ]) {
      appServer.emit("progress", { type: "turn_diff_updated", activity: {
        threadId, turnId, evidenceState: "available", diff, sourceLength: diff.length, redacted: false, revision,
      } });
    }
    appServer.emit("progress", { type: "turn_diff_activity", activity: {
      threadId, turnId, evidenceState: "unavailable", evidenceReason: "oversized", closeReason: "completed", diff: "", sourceLength: MAX_TURN_DIFF_LENGTH + 1, redacted: false, revision: 2,
    } });
    return { status: "completed" };
  };
  const frontend = new TerminalFrontend({
    cwd: ROOT,
    handlers: {},
    appServer,
    input: process.stdin,
    output: process.stdout,
    lineIO: { question: async () => null, close() {} },
  });
  try {
    await frontend.handlePrompt("Inspect this repository and explain its architecture.");
  } finally {
    report.diffFrames = capturedWrites.filter((chunk) => chunk.includes("turn-level aggregate diff")).length;
    report.viewEnabled = frontend.turnDiffView.enabled;
    report.renderedDiff = capturedWrites.find((chunk) => chunk.includes("turn-level aggregate diff")) || "";
    report.renderedDiffLength = report.renderedDiff.length;
    report.renderedDiffHash = crypto.createHash("sha256").update(report.renderedDiff).digest("hex");
    report.hasRawTerminalEscape = report.renderedDiff.includes("\u001b");
    report.latestSnapshotWasClearedAsOversized = report.renderedDiff.includes("exceeded the");
    report.olderSnapshotWasNotRendered = !report.renderedDiff.includes("SMOKE-OLD-REDIRECTED-SNAPSHOT");
    report.bounded = report.diffFrames === 1 && report.renderedDiffLength <= MAX_TURN_DIFF_RENDERED_LENGTH && !report.hasRawTerminalEscape && frontend.turnDiffView.closed;
    restoreOutput();
    saveReport(report);
    process.stderr.write(`Redirected-output smoke report: ${REPORT_PATH}\n`);
    process.stderr.write(`${JSON.stringify(summarize(report), null, 2)}\n`);
    if (!report.bounded || !report.latestSnapshotWasClearedAsOversized || !report.olderSnapshotWasNotRendered) process.exitCode = 1;
  }
}

function summarize(report) {
  const summary = { ...report };
  delete summary.liveFrames;
  delete summary.renderedDiff;
  return summary;
}

function saveReport(report) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const nonTTY = process.argv.includes("--non-tty");
(nonTTY ? runNonTTYSmoke() : runTTYSmoke()).catch((error) => {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify({ error: error.message, actualInputTTY: Boolean(process.stdin.isTTY), actualOutputTTY: Boolean(process.stdout.isTTY) }, null, 2)}\n`, { mode: 0o600 });
  } catch {}
  process.stderr.write(`TTY smoke harness failed: ${error.message}\n`);
  process.exitCode = 1;
});
