"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { escapeTerminalOutput, redactSensitiveText } = require("./command-activity");
const workspaceFiles = require("./tool-workspace-files");
const { createLinuxCommandBackend } = require("./linux-command-backend");

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REVIEW_FIELD_LENGTH = 8_000;
const MAX_REVIEW_SIZE = 20_000;
const MAX_TOOL_OUTPUT = 16_384;
const MAX_DIRECTORY_ENTRIES = 100;
const MAX_SEARCH_DEPTH = 5;
const MAX_SEARCH_ENTRIES = 2_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_PATHS = 128;
const MAX_SEARCH_PATH_LIST_BYTES = 16 * 1024;
const MAX_SEARCH_QUERIES = 4;
const MAX_REQUEST_SIZE = 64 * 1024;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_COMMAND_TIMEOUT_MS = 5_000;
const MAX_AUDIT_EVENTS = 50;
const MAX_SEEN_REQUESTS = 1_000;
const MAX_PROPOSALS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOOL_IDS = Object.freeze([
  "read_file",
  "list_files",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
  "git_check_ignore",
  "run_command",
  "propose_file_change",
  "apply_file_change",
]);
const TOOL_DEFINITIONS = Object.freeze([
  definition("read_file", "Read a UTF-8 regular file inside the selected project.", "project-read", false,
    objectSchema({ path: projectPathSchema(), maxBytes: { type: "integer", minimum: 1, maximum: MAX_FILE_BYTES } }, ["path"]),
    { maximumFileBytes: MAX_FILE_BYTES, maximumRequestedBytes: MAX_FILE_BYTES }),
  definition("list_files", "List one project directory without following symbolic links.", "project-read", false,
    objectSchema({ path: projectPathSchema() }), { maximumEntries: MAX_DIRECTORY_ENTRIES, maximumDepth: 1 }),
  definition("search_files", "Search literal text in bounded UTF-8 project files, optionally limited to explicit project-relative files.", "project-search", false,
    objectSchema({ query: { type: "string", minLength: 1, maxLength: 512, "x-maxUtf8Bytes": 512 },
      queries: { type: "array", minItems: 1, maxItems: MAX_SEARCH_QUERIES, items: { type: "string", minLength: 1, maxLength: 512, "x-maxUtf8Bytes": 512 } },
      path: projectPathSchema(), paths: { type: "array", minItems: 1, maxItems: MAX_SEARCH_PATHS, items: projectPathSchema() },
      caseSensitive: { type: "boolean" }, maxFileBytes: { type: "integer", minimum: 1, maximum: MAX_FILE_BYTES } }, []), {
      maximumDepth: MAX_SEARCH_DEPTH, maximumEntries: MAX_SEARCH_ENTRIES,
      maximumMatches: MAX_SEARCH_RESULTS, maximumScannedBytes: MAX_SEARCH_BYTES, maximumOutputCharacters: MAX_TOOL_OUTPUT,
      maximumExplicitPaths: MAX_SEARCH_PATHS, maximumQueries: MAX_SEARCH_QUERIES,
    }),
  definition("git_status", "Inspect bounded, read-only Git status for this project.", "project-git-read", false,
    objectSchema({}), { timeoutMs: MAX_COMMAND_TIMEOUT_MS, maximumOutputCharacters: MAX_TOOL_OUTPUT }),
  definition("git_diff", "Inspect a bounded, read-only Git diff for this project.", "project-git-read", false,
    objectSchema({ path: projectPathSchema() }), { timeoutMs: MAX_COMMAND_TIMEOUT_MS, maximumOutputCharacters: MAX_TOOL_OUTPUT }),
  definition("git_log", "Inspect a bounded, read-only summary of local Git history.", "project-git-read", false,
    objectSchema({ limit: { type: "integer", minimum: 1, maximum: 20 }, path: projectPathSchema() }), { defaultLimit: 10, maximumLimit: 20, timeoutMs: MAX_COMMAND_TIMEOUT_MS, maximumOutputCharacters: MAX_TOOL_OUTPUT, remoteAccess: false }),
  definition("git_check_ignore", "Check project-relative paths against the repository's Git ignore rules.", "project-git-read", false,
    objectSchema({ paths: { type: "array", minItems: 1, maxItems: 100, items: projectPathSchema() } }, ["paths"]),
    { maximumPaths: 100, timeoutMs: MAX_COMMAND_TIMEOUT_MS, externalGitConfiguration: false }),
  definition("run_command", "Run one explicitly approved argv inside a rootless Linux container with network disabled.", "command-execution", true,
    objectSchema({ argv: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: MAX_COMMAND_LENGTH }, "x-maxAggregateUtf8Bytes": MAX_COMMAND_LENGTH },
      workspaceAccess: { type: "string", enum: ["read-only", "read-write"] } }, ["argv"]), { enabledByDefault: false, shell: false, isolation: "rootless-podman-required",
      timeoutMs: MAX_COMMAND_TIMEOUT_MS, maximumArgumentCharacters: MAX_COMMAND_LENGTH, maximumStdoutCharacters: MAX_TOOL_OUTPUT, maximumStderrCharacters: MAX_TOOL_OUTPUT }),
  definition("propose_file_change", "Create an in-memory, reviewable whole-file replacement proposal; never writes a file.", "file-change-proposal", false,
    objectSchema({ path: projectPathSchema(), content: { type: "string", maxLength: MAX_REVIEW_FIELD_LENGTH, "x-maxUtf8Bytes": MAX_REVIEW_FIELD_LENGTH } }, ["path", "content"]), { maximumOriginalBytes: MAX_REVIEW_FIELD_LENGTH,
      maximumProposedBytes: MAX_REVIEW_FIELD_LENGTH, proposalLifetime: "runtime instance" }),
  definition("apply_file_change", "Apply a reviewed proposal only after exact one-time approval and state revalidation.", "file-write",
    true, objectSchema({ proposalId: { type: "string", format: "uuid" } }, ["proposalId"]), { atomicReplace: true,
      maximumReviewSize: MAX_REVIEW_SIZE, proposalLifetime: "runtime instance" }),
]);

class PermissionedToolRuntime {
  constructor({
    projectRoot,
    sessionId,
    approvalHandler,
    commandExecutionEnabled = false,
    commandWorkspaceWriteEnabled = false,
    commandTimeoutMs = MAX_COMMAND_TIMEOUT_MS,
    auditSink,
    fileOperations = workspaceFiles,
    atomicReplace = fs.renameSync,
    atomicCreate = fs.linkSync,
    removeFile = fs.unlinkSync,
    syncDirectory = fs.fsyncSync,
    execFileImpl = execFileAsync,
    commandBackend = createLinuxCommandBackend(),
    now = () => new Date(),
    createId = () => crypto.randomUUID(),
  } = {}) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw new TypeError("A selected absolute project root is required.");
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) throw new TypeError("A Vesper session UUID is required for tool execution.");
    let canonicalRoot;
    try { canonicalRoot = fs.realpathSync(projectRoot); } catch { throw new TypeError("The selected project root is unavailable."); }
    const rootStat = fs.statSync(canonicalRoot, { bigint: true });
    if (!rootStat.isDirectory()) throw new TypeError("The selected project root must be a directory.");
    this.projectRoot = canonicalRoot;
    this.projectIdentity = Object.freeze({ dev: String(rootStat.dev), ino: String(rootStat.ino) });
    this.sessionId = sessionId;
    this.approvalHandler = typeof approvalHandler === "function" ? approvalHandler : null;
    this.commandExecutionEnabled = commandExecutionEnabled === true;
    this.commandWorkspaceWriteEnabled = commandWorkspaceWriteEnabled === true;
    this.commandTimeoutMs = Number.isInteger(commandTimeoutMs) && commandTimeoutMs > 0
      ? Math.min(MAX_COMMAND_TIMEOUT_MS, commandTimeoutMs) : MAX_COMMAND_TIMEOUT_MS;
    this.auditSink = typeof auditSink === "function" ? auditSink : null;
    this.files = fileOperations;
    this.atomicReplace = atomicReplace;
    this.atomicCreate = atomicCreate;
    this.removeFile = removeFile;
    this.syncDirectory = syncDirectory;
    this.execFileImpl = execFileImpl;
    this.commandBackend = commandBackend;
    this.now = now;
    this.createId = createId;
    this.busy = false;
    this.disposed = false;
    this.interruptionRequested = false;
    this.audit = [];
    this.seenRequests = new Set();
    this.proposals = new Map();
    this.proposalStates = new Map();
    this.commandAbortController = null;
    this.approvalAbortController = null;
    this.operationAbortController = null;
  }

  getDefinitions() {
    return TOOL_DEFINITIONS.map((entry) => ({
      ...entry,
      limits: { ...entry.limits },
      enabled: (!entry.requiresApproval || Boolean(this.approvalHandler)) &&
        (entry.id !== "run_command" || this.commandExecutionEnabled && Boolean(this.approvalHandler)),
    }));
  }

  getAuditEvents() {
    return this.audit.map((event) => ({ ...event }));
  }

  async getCommandExecutionStatus() {
    const backend = await this.commandBackend.inspect();
    const { policy, ...safeBackend } = backend;
    return Object.freeze({ ...safeBackend,
      enabled: this.commandExecutionEnabled && Boolean(this.approvalHandler) && backend.available,
      hostEnabled: this.commandExecutionEnabled,
      workspaceWritesEnabled: this.commandWorkspaceWriteEnabled && this.commandExecutionEnabled,
      approvalHandlerAvailable: Boolean(this.approvalHandler),
    });
  }

  async preview(request) {
    const normalized = this.validateRequest(request, { reserveRequestId: false });
    const entry = this.definitionFor(normalized.toolId);
    return Object.freeze({
      requestId: normalized.requestId,
      toolId: normalized.toolId,
      state: "validated",
      executes: false,
      requiresApproval: entry.requiresApproval,
      enabled: (!entry.requiresApproval || Boolean(this.approvalHandler)) &&
        (normalized.toolId !== "run_command" || this.commandExecutionEnabled && Boolean(this.approvalHandler)),
      summary: this.describeRequest(normalized),
      ...(normalized.toolId === "run_command" ? { isolation: await this.previewCommandPolicy(normalized) } : {}),
    });
  }

  async previewCommandPolicy(request) {
    if (!this.commandExecutionEnabled) return Object.freeze({ available: false, enabled: false,
      reasonCode: "UNSUPPORTED_OPERATION", message: "Command execution is disabled in this Vesper runtime." });
    if (request.input.workspaceAccess === "read-write" && !this.commandWorkspaceWriteEnabled) return Object.freeze({ available: false, enabled: false,
      reasonCode: "UNSUPPORTED_OPERATION", message: "Writable sandbox workspaces are disabled by the host." });
    try {
      const plan = await this.prepareCommandPlan(request);
      return Object.freeze({ available: true, enabled: Boolean(this.approvalHandler), policy: plan.display });
    } catch (error) {
      return Object.freeze({ available: false, enabled: false, reasonCode: stableErrorCode(error?.code || "ISOLATION_UNAVAILABLE"),
        message: typeof error?.message === "string" ? redactSensitiveText(error.message).slice(0, 300) : "Isolation unavailable." });
    }
  }

  async invoke(request, { signal } = {}) {
    if (this.disposed) return rejected("RUNTIME_DISPOSED", "This tool runtime has been disposed.");
    if (this.busy) return rejected("BUSY", "Another tool operation is still active.");
    this.busy = true;
    this.approvalAbortController = new AbortController();
    const operationAbortController = new AbortController();
    this.operationAbortController = operationAbortController;
    const abortOperation = () => operationAbortController.abort(signal?.reason || "tool-operation-cancelled");
    signal?.addEventListener("abort", abortOperation, { once: true });
    if (signal?.aborted) abortOperation();
    let normalized;
    let approvalId = null;
    let state = "requested";
    let commandPlan = null;
    try {
      normalized = this.validateRequest(request, { reserveRequestId: true });
      const entry = this.definitionFor(normalized.toolId);
      this.recordAudit(normalized.toolId, state, normalized.requestId, null);
      state = "validated";
      this.recordAudit(normalized.toolId, state, normalized.requestId, null);
      if (normalized.toolId === "run_command" && !this.commandExecutionEnabled) {
        return this.finishRejected(normalized, "UNSUPPORTED_OPERATION", "Command execution is disabled in this Vesper runtime.");
      }
      if (normalized.toolId === "run_command") {
        if (!this.approvalHandler) return this.finishRejected(normalized, "APPROVAL_REQUIRED", "Isolated command execution requires a one-time approval handler.");
        if (normalized.input.workspaceAccess === "read-write" && !this.commandWorkspaceWriteEnabled) {
          return this.finishRejected(normalized, "UNSUPPORTED_OPERATION", "Writable sandbox workspaces are disabled by the host.");
        }
        commandPlan = await this.prepareCommandPlan(normalized);
      }
      if (entry.requiresApproval && normalized.toolId !== "apply_file_change") {
        approvalId = this.createId();
        if (!UUID_PATTERN.test(approvalId)) throw toolError("RUNTIME_ERROR", "Vesper could not create a safe approval identity.", false);
        const snapshot = this.createApprovalSnapshot(normalized, approvalId, commandPlan);
        ensureApprovalReviewFits(snapshot);
        state = "awaiting-approval";
        this.recordAudit(normalized.toolId, state, normalized.requestId, approvalId);
        if (!this.approvalHandler) return this.finishRejected(normalized, "APPROVAL_REQUIRED", "This operation requires a one-time approval handler.", approvalId);
        const decision = await this.approvalHandler(snapshot, { signal: this.approvalAbortController.signal });
        if (this.interruptionRequested) {
          throw toolError(normalized.toolId === "run_command" ? "COMMAND_INTERRUPTED" : "TOOL_INTERRUPTED",
            "The approved operation was cancelled before it started.", true);
        }
        this.assertLive();
        if (!this.isSnapshotCurrent(snapshot, normalized, commandPlan)) return this.finishRejected(normalized, "STALE_APPROVAL", "The reviewed operation changed before approval.", approvalId);
        if (decision !== "approve-once") {
          const declined = decision === "decline" || decision === "cancel" ? decision : "cancel";
          return this.finishRejected(normalized, declined === "decline" ? "APPROVAL_DECLINED" : "APPROVAL_CANCELLED",
            declined === "decline" ? "The operation was declined; nothing was executed." : "The operation was cancelled; nothing was executed.", approvalId);
        }
        if (normalized.toolId === "run_command") {
          const renewedPlan = await this.prepareCommandPlan(normalized);
          if (!this.isSnapshotCurrent(snapshot, normalized, renewedPlan)) {
            return this.finishRejected(normalized, "ISOLATION_POLICY_CHANGED", "The sandbox policy or reviewed command changed after approval. Nothing was run; review the operation again.", approvalId);
          }
          commandPlan = renewedPlan;
        }
        state = "approved";
        this.recordAudit(normalized.toolId, state, normalized.requestId, approvalId);
      }

      if (operationAbortController.signal.aborted) throw toolError("TOOL_INTERRUPTED", "The operation was cancelled before execution.", true);
      const result = await this.execute(normalized, commandPlan, operationAbortController.signal);
      if (result.approvalId) approvalId = result.approvalId;
      if (result.proposal) {
        state = "proposed";
        this.recordAudit(normalized.toolId, state, normalized.requestId, approvalId);
        return Object.freeze({ requestId: normalized.requestId, toolId: normalized.toolId, state, executed: false, verified: false,
          proposal: result.proposal, message: "Proposal created in memory. No file was changed." });
      }
      if (result.failure) {
        state = "failed";
        this.recordAudit(normalized.toolId, state, normalized.requestId, approvalId, result.failure.code);
        return Object.freeze({ requestId: normalized.requestId, toolId: normalized.toolId, state,
          approved: Boolean(approvalId), executed: Boolean(result.executed), verified: false, result: result.value,
          error: Object.freeze({ code: result.failure.code, message: result.failure.message, retryable: false }),
          ...(result.truncated ? { truncated: true } : {}),
        });
      }
      state = "executed";
      this.recordAudit(normalized.toolId, state, normalized.requestId, approvalId);
      if (result.verified) {
        state = "verified";
        this.recordAudit(normalized.toolId, state, normalized.requestId, approvalId);
      }
      return Object.freeze({ requestId: normalized.requestId, toolId: normalized.toolId, state,
        approved: Boolean(approvalId), executed: true, verified: Boolean(result.verified), result: result.value,
        ...(result.proposalState ? { proposalState: result.proposalState } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      });
    } catch (error) {
      if (!approvalId && normalized) {
        approvalId = [...this.audit].reverse().find((event) => event.requestId === normalized.requestId && event.approvalId)?.approvalId || null;
      }
      const toolError = normalizeToolError(error);
      const safeRequestId = normalized?.requestId || safeOwnString(request, "requestId", (value) => UUID_PATTERN.test(value));
      const safeToolId = normalized?.toolId || safeOwnString(request, "toolId", (value) => TOOL_IDS.includes(value));
      const failureState = operationFailureState(toolError);
      if (safeToolId && safeRequestId) {
        this.recordAudit(safeToolId, failureState, safeRequestId, approvalId, toolError.code);
      }
      return Object.freeze({ requestId: safeRequestId, toolId: safeToolId,
        state: failureState,
        approved: Boolean(approvalId && this.audit.some((event) => event.requestId === safeRequestId && event.approvalId === approvalId && event.state === "approved")),
        ...(normalized?.toolId === "apply_file_change" && this.proposalStates.has(normalized.input.proposalId)
          ? { proposalState: this.proposalStates.get(normalized.input.proposalId) } : {}),
        executed: Boolean(toolError.executed), verified: false,
        error: Object.freeze({ code: toolError.code, message: toolError.message, retryable: toolError.retryable }),
      });
    } finally {
      signal?.removeEventListener("abort", abortOperation);
      this.busy = false;
      this.interruptionRequested = false;
      this.approvalAbortController = null;
      this.operationAbortController = null;
    }
  }

  async execute(request, commandPlan = null, signal) {
    switch (request.toolId) {
      case "read_file": return this.readFile(request.input.path, request.input.maxBytes);
      case "list_files": return this.listFiles(request.input.path || ".");
      case "search_files": return this.searchFiles(request.input.query, request.input.path || ".", request.input, signal);
      case "git_status": return this.gitRead(["status", "--short", "--branch", "--untracked-files=no"]);
      case "git_diff": return this.gitDiff(request.input.path);
      case "git_log": return this.gitLog(request.input);
      case "git_check_ignore": return this.gitCheckIgnore(request.input.paths);
      case "run_command": return this.runCommand(request, commandPlan);
      case "propose_file_change": return this.proposeFileChange(request);
      case "apply_file_change": return this.applyFileChange(request);
      default: throw toolError("INVALID_TOOL", "The requested tool is not registered.", true);
    }
  }

  readFile(relativePath, maxBytes = MAX_FILE_BYTES) {
    const root = this.openRoot();
    try {
      const parent = this.files.openProjectParent(root, relativePath);
      try {
        const file = this.files.readFileAt(parent.fd, parent.basename, maxBytes, { expectedDevice: parent.device });
        const text = decodeUtf8(file.buffer);
        if (text === null) throw toolError("UNSUPPORTED_FILE_TYPE", "Only UTF-8 text files are supported by read_file.", true);
        const visibleText = redactSensitiveText(text);
        return { value: { path: parent.relativePath, content: visibleText, bytes: file.buffer.length,
          sha256: sha256(file.buffer), redacted: visibleText !== text }, verified: true };
      } finally { parent.close(); }
    } finally { root.close(); }
  }

  listFiles(relativePath) {
    const root = this.openRoot();
    try {
      const parsed = this.files.parseProjectPath(relativePath, { allowRoot: true });
      const directory = this.files.openProjectDirectory(root, parsed.components);
      try {
        const listing = this.files.listDirectory(directory.fd, { maximum: MAX_DIRECTORY_ENTRIES });
        return { value: { path: parsed.relativePath || ".", ...listing }, verified: !listing.truncated, truncated: listing.truncated };
      } finally { directory.close(); }
    } finally { root.close(); }
  }

  async searchFiles(query, relativePath, options = {}, signal) {
    const queries = Array.isArray(options.queries) ? options.queries : [query];
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_SEARCH_QUERIES ||
        queries.some((value) => typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512 || value.includes("\0")) ||
        new Set(queries).size !== queries.length) {
      throw toolError("INVALID_ARGUMENT", "search_files requires one to four unique literal queries of at most 512 bytes each.", true);
    }
    const explicitPaths = Array.isArray(options.paths) ? [...new Set(options.paths)] : null;
    if (explicitPaths && (explicitPaths.length < 1 || explicitPaths.length > MAX_SEARCH_PATHS || explicitPaths.some((value) => typeof value !== "string") ||
        explicitPaths.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > MAX_SEARCH_PATH_LIST_BYTES)) {
      throw toolError("INVALID_ARGUMENT", `search_files paths must contain at most ${MAX_SEARCH_PATHS} bounded project-relative files.`, true);
    }
    if (explicitPaths && options.path !== undefined) throw toolError("INVALID_ARGUMENT", "search_files accepts either path or explicit paths, not both.", true);
    if (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean") {
      throw toolError("INVALID_ARGUMENT", "search_files caseSensitive must be boolean.", true);
    }
    const caseSensitive = options.caseSensitive !== false;
    const root = this.openRoot();
    const start = explicitPaths ? null : this.files.parseProjectPath(relativePath, { allowRoot: true });
    const results = [];
    let visited = 0;
    let scannedBytes = 0;
    let skippedFiles = 0;
    let outputLength = JSON.stringify(queries).length + 128;
    let truncated = false;
    const ensureActive = () => {
      if (signal?.aborted) throw toolError("TOOL_INTERRUPTED", "The project search was cancelled.", true);
    };
    const yieldToCancellation = () => new Promise((resolve) => setImmediate(resolve));
    const addMatches = (relativeFilePath, text) => {
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        for (const term of queries) {
          const source = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase("en-US");
          const needle = caseSensitive ? term : term.toLocaleLowerCase("en-US");
          const column = source.indexOf(needle);
          if (column < 0) continue;
          const rawLine = lines[index].slice(0, 500);
          const visibleLine = redactSensitiveText(rawLine);
          const match = { query: term, path: relativeFilePath, line: index + 1, column: column + 1,
            text: visibleLine, redacted: visibleLine !== rawLine };
          const size = JSON.stringify(match).length;
          if (outputLength + size > MAX_TOOL_OUTPUT || results.length >= MAX_SEARCH_RESULTS) { truncated = true; return false; }
          results.push(match);
          outputLength += size;
        }
      }
      return true;
    };
    if (explicitPaths) {
      for (const requestedPath of explicitPaths) {
        ensureActive();
        if (visited >= MAX_SEARCH_ENTRIES || scannedBytes >= MAX_SEARCH_BYTES || results.length >= MAX_SEARCH_RESULTS) { truncated = true; break; }
        visited += 1;
        let parent;
        try { parent = this.files.openProjectParent(root, requestedPath); }
        catch { skippedFiles += 1; truncated = true; continue; }
        try {
          let file;
          try { file = this.files.readFileAt(parent.fd, parent.basename, Math.min(options.maxFileBytes || MAX_FILE_BYTES, MAX_SEARCH_BYTES - scannedBytes), { expectedDevice: parent.device }); }
          catch { skippedFiles += 1; truncated = true; continue; }
          scannedBytes += file.buffer.length;
          if (!file.buffer.length || file.buffer.includes(0)) { skippedFiles += 1; truncated = true; continue; }
          const text = decodeUtf8(file.buffer);
          if (text === null) { skippedFiles += 1; truncated = true; continue; }
          if (!addMatches(parent.relativePath, text)) break;
        } finally { parent.close(); }
        await yieldToCancellation();
      }
    }
    const visit = async (components, depth) => {
      ensureActive();
      if (results.length >= MAX_SEARCH_RESULTS || visited >= MAX_SEARCH_ENTRIES || scannedBytes >= MAX_SEARCH_BYTES) {
        truncated = true;
        return;
      }
      const directory = this.files.openProjectDirectory(root, components);
      try {
        const listing = this.files.listRawDirectory(directory.fd, { maximum: Math.max(0, MAX_SEARCH_ENTRIES - visited) });
        truncated ||= listing.truncated;
        for (const name of listing.entries) {
          ensureActive();
          if (results.length >= MAX_SEARCH_RESULTS || visited >= MAX_SEARCH_ENTRIES || scannedBytes >= MAX_SEARCH_BYTES) { truncated = true; break; }
          visited += 1;
          let safeComponents;
          try { safeComponents = this.files.parseProjectPath([...components, name].join("/"), { allowRoot: false }).components; } catch { continue; }
          const stat = this.files.statAt(directory.fd, name);
          if (!stat || stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            if (depth < MAX_SEARCH_DEPTH) await visit(safeComponents, depth + 1);
            else truncated = true;
            continue;
          }
          if (!stat.isFile()) continue;
          if (stat.size > BigInt(MAX_FILE_BYTES) || stat.dev !== root.device) { skippedFiles += 1; truncated = true; continue; }
          const remainingBudget = MAX_SEARCH_BYTES - scannedBytes;
          if (remainingBudget <= 0) { truncated = true; break; }
          let file;
          try { file = this.files.readFileAt(directory.fd, name, Math.min(MAX_FILE_BYTES, remainingBudget), { expectedDevice: root.device }); }
          catch { skippedFiles += 1; truncated = true; continue; }
          scannedBytes += file.buffer.length;
          if (!file.buffer.length || file.buffer.includes(0)) { skippedFiles += 1; truncated = true; continue; }
          const text = decodeUtf8(file.buffer);
          if (text === null) { skippedFiles += 1; truncated = true; continue; }
          if (!addMatches(safeComponents.join("/"), text)) return;
          await yieldToCancellation();
        }
      } finally { directory.close(); }
    };
    try {
      if (!explicitPaths) await visit(start.components, 0);
      ensureActive();
      return { value: { query: queries.length === 1 ? queries[0] : null, queries, caseSensitive, matches: results, scannedEntries: visited, scannedBytes, skippedFiles, truncated }, verified: !truncated, truncated };
    } finally { root.close(); }
  }

  async gitDiff(relativePath) {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", "--"];
    if (relativePath !== undefined && relativePath !== "") {
      const parsed = this.files.parseProjectPath(relativePath, { allowRoot: false });
      args.push(`:(literal)${parsed.relativePath}`);
    }
    return this.gitRead(args);
  }

  async gitLog({ limit = 10, path: relativePath } = {}) {
    const args = ["log", "--no-ext-diff", "--no-color", `--max-count=${limit}`, "--date=short", "--format=%h %ad %s", "--"];
    if (relativePath !== undefined && relativePath !== "") {
      const parsed = this.files.parseProjectPath(relativePath, { allowRoot: false });
      rejectProtectedPath(parsed.relativePath);
      args.push(`:(literal)${parsed.relativePath}`);
    }
    return this.gitRead(args);
  }

  async gitCheckIgnore(relativePaths) {
    if (!Array.isArray(relativePaths) || relativePaths.length < 1 || relativePaths.length > 100) {
      throw toolError("INVALID_ARGUMENT", "git_check_ignore requires 1 to 100 project-relative paths.", true);
    }
    const normalizedPaths = relativePaths.map((value) => this.files.parseProjectPath(value, { allowRoot: false }).relativePath);
    const root = this.openRoot();
    try {
      await this.assertGitProjectRoot(root);
      let result;
      const args = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "core.excludesFile=/dev/null", "-C", root.path,
        "check-ignore", "-z", "--", ...normalizedPaths.map((value) => `:(literal)${value}`)];
      const options = {
        cwd: root.path,
        timeout: MAX_COMMAND_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
        encoding: "buffer",
        windowsHide: true,
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          GIT_OPTIONAL_LOCKS: "0",
        },
      };
      try {
        result = await this.execFileImpl("git", args, options);
      } catch (error) {
        // git check-ignore exits 1 when none of the requested paths are ignored.
        if (error?.code === 1) result = { stdout: error.stdout || Buffer.alloc(0) };
        else if (error?.killed || error?.code === "ETIMEDOUT") throw toolError("TIMEOUT", "The bounded Git ignore inspection timed out.", true);
        else throw toolError("GIT_FAILED", "Git could not evaluate repository ignore rules.", false);
      }
      const buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
      if (buffer.length > 64 * 1024) throw toolError("OUTPUT_LIMIT", "Git ignore output exceeded Vesper's bound.", true);
      const ignored = buffer.toString("utf8").split("\0").filter(Boolean);
      const requested = new Set(normalizedPaths);
      const safeIgnored = ignored.filter((value) => requested.has(value));
      return { value: { ignored: safeIgnored, checked: normalizedPaths.length }, verified: true };
    } finally { root.close(); }
  }

  async gitRead(commandArgs) {
    const root = this.openRoot();
    try {
      await this.assertGitProjectRoot(root);
      const args = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-C", root.path, ...commandArgs];
      let result;
      try {
        result = await this.execFileImpl("git", args, {
          cwd: root.path,
          timeout: MAX_COMMAND_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
          encoding: "buffer",
          windowsHide: true,
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_PAGER: "cat",
            PAGER: "cat",
            GIT_OPTIONAL_LOCKS: "0",
          },
        });
      } catch (error) {
        if (error?.code === "ENOENT") throw toolError("UNAVAILABLE", "Git is unavailable; no project command was run.", true);
        if (error?.killed || error?.code === "ETIMEDOUT") throw toolError("TIMEOUT", "The bounded Git inspection timed out.", true);
        throw toolError("GIT_FAILED", "Git could not complete the read-only project inspection.", false);
      }
      const buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
      const limit = boundedBuffer(buffer, MAX_TOOL_OUTPUT);
      return { value: { text: redactSensitiveText(limit.buffer.toString("utf8")), exitCode: 0 }, verified: !limit.truncated, truncated: limit.truncated };
    } finally { root.close(); }
  }

  async assertGitProjectRoot(root) {
    const metadataPath = path.join(root.path, ".git");
    let metadata;
    try { metadata = fs.lstatSync(metadataPath); } catch { throw toolError("GIT_SCOPE_REJECTED", "Git inspection requires metadata inside the selected project root.", true); }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw toolError("GIT_SCOPE_REJECTED", "Git worktrees and external Git metadata are not supported by the bounded project inspector.", true);
    }
    for (const relative of ["HEAD", "config", "index", "objects", "objects/info", "objects/pack", "refs", "logs"]) {
      try {
        const entry = fs.lstatSync(path.join(metadataPath, relative));
        if (entry.isSymbolicLink()) throw toolError("GIT_SCOPE_REJECTED", "Git metadata contains a symbolic link and may read outside the selected project.", true);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const gitDirectory = this.files.openProjectDirectory(root, [".git"]);
    try {
      const configStat = this.files.statAt(gitDirectory.fd, "config");
      if (configStat) {
        const config = this.files.readFileAt(gitDirectory.fd, "config", MAX_FILE_BYTES, { expectedDevice: root.device });
        const configText = decodeUtf8(config.buffer);
        if (configText === null || /^\s*\[\s*include(?:if)?(?:\s|\])/imu.test(configText)) {
          throw toolError("GIT_SCOPE_REJECTED", "Git config includes may read outside the selected project and are unsupported.", true);
        }
      }
    } finally { gitDirectory.close(); }
    const alternatesPath = path.join(metadataPath, "objects", "info", "alternates");
    try {
      const alternates = fs.lstatSync(alternatesPath);
      if (alternates.isSymbolicLink() || alternates.isFile()) {
        throw toolError("GIT_SCOPE_REJECTED", "Git object alternates may read outside the selected project and are unsupported.", true);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let result;
    try {
      result = await this.execFileImpl("git", ["-c", "core.fsmonitor=false", "-C", root.path, "rev-parse", "--show-toplevel"], {
        cwd: root.path, timeout: MAX_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "buffer", windowsHide: true,
        env: { PATH: process.env.PATH || "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch { throw toolError("GIT_SCOPE_REJECTED", "Git could not confirm that the repository is rooted inside the selected project.", true); }
    const topLevel = (Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "")).toString("utf8").trim();
    let canonicalTop;
    try { canonicalTop = fs.realpathSync(topLevel); } catch { throw toolError("GIT_SCOPE_REJECTED", "Git reported an invalid repository root.", true); }
    if (canonicalTop !== root.path) throw toolError("GIT_SCOPE_REJECTED", "The Git repository extends outside the selected project root.", true);
  }

  async prepareCommandPlan(request) {
    const expectedRoot = this.openRoot();
    expectedRoot.close();
    return this.commandBackend.prepare({ workspaceRoot: this.projectRoot, argv: request.input.argv,
      workspaceAccess: request.input.workspaceAccess || "read-only", timeoutMs: this.commandTimeoutMs });
  }

  async runCommand(request, plan) {
    if (!plan) throw toolError("ISOLATION_UNAVAILABLE", "No approved OS-isolation policy is available for this command.", true);
    const command = validateArgv(request.input.argv);
    let rootStat;
    try { rootStat = fs.statSync(this.projectRoot); } catch { throw toolError("INVALID_PROJECT", "The selected project root changed or disappeared.", true); }
    const expectedRoot = this.openRoot();
    try {
      const opened = fs.fstatSync(expectedRoot.fd);
      if (!opened.isDirectory() || String(opened.dev) !== String(rootStat.dev) || String(opened.ino) !== String(rootStat.ino)) {
        throw toolError("INVALID_PROJECT", "The selected project root changed; command execution was cancelled.", true);
      }
    } finally { expectedRoot.close(); }

    this.commandAbortController = new AbortController();
    if (this.interruptionRequested) this.commandAbortController.abort();
    let result;
    try {
      result = await this.commandBackend.run({ plan, argv: command, workspaceRoot: this.projectRoot,
        workspaceAccess: request.input.workspaceAccess || "read-only", timeoutMs: this.commandTimeoutMs,
        signal: this.commandAbortController.signal });
    } finally { this.commandAbortController = null; }
    const safeResult = Object.freeze({ ...result, stdout: redactSensitiveText(String(result.stdout || "")).slice(0, MAX_TOOL_OUTPUT),
      stderr: redactSensitiveText(String(result.stderr || "")).slice(0, MAX_TOOL_OUTPUT) });
    const successfulExit = safeResult.exitCode === 0 && safeResult.signal === null;
    return { value: safeResult, verified: false, executed: true, truncated: safeResult.truncated,
      ...(successfulExit ? {} : { failure: { code: "COMMAND_FAILED",
        message: safeResult.exitCode === null
          ? "The approved command ended without a confirmed exit status."
          : safeResult.signal
            ? `The approved command was terminated by ${safeResult.signal}.`
            : `The approved command exited with status ${safeResult.exitCode}.` } }),
    };
  }

  proposeFileChange(request) {
    const relativePath = this.files.parseProjectPath(request.input.path).relativePath;
    rejectProtectedPath(relativePath);
    const content = request.input.content;
    const contentBuffer = encodeReviewText(content, "proposed content");
    if (contentBuffer.length > MAX_REVIEW_FIELD_LENGTH) throw toolError("INPUT_TOO_LARGE", "Proposed content exceeds the reviewable file-change limit.", true);
    const root = this.openRoot();
    try {
      const parent = this.files.openProjectParent(root, relativePath);
      try {
        const existing = this.readSnapshot(parent);
        if (existing && existing.buffer.length > MAX_REVIEW_FIELD_LENGTH) {
          throw toolError("INPUT_TOO_LARGE", "The existing file is too large for a complete approval review.", true);
        }
        const ownerUid = typeof process.getuid === "function" ? process.getuid() : null;
        const parentStat = fs.fstatSync(parent.fd, { bigint: true });
        const ownerGid = parentStat.mode & 0o2000n
          ? Number(parentStat.gid)
          : typeof process.getegid === "function" ? process.getegid() : Number(parentStat.gid);
        if (existing && (existing.stat.uid !== ownerUid || existing.stat.gid !== ownerGid)) {
          throw toolError("UNSUPPORTED_FILE_METADATA", "Vesper cannot replace a file owned by another user or group without changing its ownership.", true);
        }
        const proposalId = this.createId();
        if (!UUID_PATTERN.test(proposalId)) throw toolError("RUNTIME_ERROR", "Vesper could not create a safe proposal identity.", false);
        const proposal = Object.freeze({
          proposalId,
          requestId: request.requestId,
          sessionId: this.sessionId,
          projectFingerprint: this.projectFingerprint(),
          path: relativePath,
          originalExists: Boolean(existing),
          originalContent: existing ? decodeUtf8(existing.buffer) : null,
          originalHash: existing ? sha256(existing.buffer) : null,
          originalStat: existing ? existing.stat : null,
          content,
          contentHash: sha256(contentBuffer),
          mode: existing ? (Number(existing.stat.mode) & 0o777) : 0o644,
          ownerUid,
          ownerGid,
        });
        const reviewSize = proposal.path.length + (proposal.originalContent?.length || 0) + proposal.content.length + 128;
        if (reviewSize > MAX_REVIEW_SIZE) throw toolError("INPUT_TOO_LARGE", "The complete file-change review exceeds Vesper's bounded review size.", true);
        if (this.proposals.size >= MAX_PROPOSALS) throw toolError("BUSY", "The in-memory proposal limit was reached; apply or discard a proposal before creating another.", true);
        this.proposals.set(proposalId, proposal);
        this.setProposalState(proposalId, "not-requested");
        return { proposal: Object.freeze({ proposalId, path: relativePath, originalExists: proposal.originalExists,
          originalHash: proposal.originalHash, contentHash: proposal.contentHash, proposedBytes: contentBuffer.length,
          originalBytes: existing?.buffer.length || 0, approvalState: this.proposalStates.get(proposalId),
          review: renderFileProposal(proposal) }) };
      } finally { parent.close(); }
    } finally { root.close(); }
  }

  async applyFileChange(request) {
    const proposalId = request.input.proposalId;
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw toolError("PROPOSAL_NOT_FOUND", "The proposal is unavailable, already consumed, or belongs to another runtime.", true);
    if (proposal.sessionId !== this.sessionId || proposal.projectFingerprint !== this.projectFingerprint()) {
      throw toolError("CONTEXT_MISMATCH", "The proposal does not belong to the active session and project.", true);
    }
    const nowSnapshot = this.snapshotProposal(proposal);
    const approvalId = this.createId();
    if (!UUID_PATTERN.test(approvalId)) throw toolError("RUNTIME_ERROR", "Vesper could not create a safe approval identity.", false);
    const snapshot = Object.freeze({
      approvalId,
      requestId: request.requestId,
      toolId: "apply_file_change",
      projectRoot: this.projectRoot,
      projectFingerprint: this.projectFingerprint(),
      sessionId: this.sessionId,
      operation: Object.freeze({
        proposalId,
        path: proposal.path,
        originalExists: proposal.originalExists,
        originalHash: proposal.originalHash,
        contentHash: proposal.contentHash,
        originalContent: proposal.originalContent,
        proposedContent: proposal.content,
        originalMode: proposal.mode,
        resultingMode: proposal.mode,
        resultingOwnerUid: proposal.ownerUid,
        resultingOwnerGid: proposal.ownerGid,
        originalStat: proposal.originalStat,
        snapshotDigest: nowSnapshot,
      }),
      requestDigest: sha256(stableStringify({ requestId: request.requestId, proposalId, path: proposal.path, originalHash: proposal.originalHash,
        originalStat: proposal.originalStat, contentHash: proposal.contentHash, sessionId: this.sessionId,
        projectFingerprint: this.projectFingerprint(), snapshotDigest: nowSnapshot })),
    });
    if (!this.approvalHandler) throw toolError("APPROVAL_REQUIRED", "This file change requires a one-time approval handler.", true);
    if (redactSensitiveText(stableStringify(snapshot.operation)) !== stableStringify(snapshot.operation)) {
      throw toolError("SENSITIVE_REVIEW_CONTENT", "The reviewed file content contains secret-like text and cannot be safely approved by Vesper.", true);
    }
    ensureApprovalReviewFits(snapshot);
    this.setProposalState(proposalId, "awaiting-approval");
    this.recordAudit("apply_file_change", "awaiting-approval", request.requestId, approvalId);
    let decision;
    try { decision = await this.approvalHandler(snapshot, { signal: this.approvalAbortController?.signal }); } catch (error) {
      if (!this.disposed) this.setProposalState(proposalId, "failed");
      throw error;
    }
    if (this.interruptionRequested) {
      this.setProposalState(proposalId, "cancelled");
      throw toolError("TOOL_INTERRUPTED", "The file change approval was cancelled before application.", true);
    }
    this.assertLive();
    if (decision !== "approve-once") {
      const state = decision === "decline" ? "declined" : "cancelled";
      this.setProposalState(proposalId, state);
      throw toolError(decision === "decline" ? "APPROVAL_DECLINED" : "APPROVAL_CANCELLED",
        decision === "decline" ? "The file change was declined; no file was written." : "The file change was cancelled; no file was written.", true);
    }
    if (this.proposals.get(proposalId) !== proposal || this.snapshotProposal(proposal) !== nowSnapshot ||
        snapshot.requestId !== request.requestId || snapshot.requestDigest !== sha256(stableStringify({ requestId: request.requestId,
          proposalId, path: proposal.path, originalHash: proposal.originalHash, originalStat: proposal.originalStat,
          contentHash: proposal.contentHash, sessionId: this.sessionId, projectFingerprint: this.projectFingerprint(), snapshotDigest: nowSnapshot }))) {
      this.setProposalState(proposalId, "stale");
      throw toolError("STALE_APPROVAL", "The reviewed file change changed before application; request a fresh review.", true);
    }
    this.recordAudit("apply_file_change", "approved", request.requestId, approvalId);
    this.setProposalState(proposalId, "approved");
    this.proposals.delete(proposalId);
    let root;
    let renamed = false;
    let tempPath = null;
    try {
      root = this.openRoot();
      const parent = this.files.openProjectParent(root, proposal.path);
      try {
        this.assertProposalCurrent(parent, proposal);
        const contentBuffer = encodeReviewText(proposal.content, "proposed content");
        const temporaryId = this.createId();
        if (!UUID_PATTERN.test(temporaryId)) throw toolError("RUNTIME_ERROR", "Vesper could not create a safe temporary-file identity.", false);
        const tempName = `.${parent.basename}.vesper-${temporaryId}.tmp`;
        tempPath = this.files.createTemporaryFile(parent.fd, tempName, contentBuffer, proposal.mode);
        // Re-read immediately before the atomic replacement to reject stale review state.
        this.assertProposalCurrent(parent, proposal);
        const targetPath = `${this.files.fdPath(parent.fd)}/${parent.basename}`;
        if (proposal.originalExists) {
          this.atomicReplace(tempPath, targetPath);
          renamed = true;
        } else {
          // link() is an atomic create-if-absent operation; a concurrent file cannot be overwritten.
          this.atomicCreate(tempPath, targetPath);
          renamed = true;
          try { this.removeFile(tempPath); } catch { /* The target is committed; verification below decides success. */ }
        }
        try { this.syncDirectory(parent.fd); } catch { /* Read-back verification below remains authoritative for visible state. */ }
        const written = this.files.readFileAt(parent.fd, parent.basename, MAX_REVIEW_FIELD_LENGTH, { expectedDevice: parent.device });
        if (sha256(written.buffer) !== proposal.contentHash || (Number(written.stat.mode) & 0o777) !== proposal.mode ||
            written.stat.uid !== proposal.ownerUid || written.stat.gid !== proposal.ownerGid || written.stat.nlink !== "1") {
          throw toolError("WRITE_VERIFICATION_FAILED", "The file write completed but its resulting content or basic metadata could not be verified; inspect the target before retrying.", false);
        }
        this.setProposalState(proposalId, "applied");
        return { value: Object.freeze({ path: proposal.path, sha256: proposal.contentHash, bytes: written.buffer.length,
          mode: proposal.mode, ownerUid: proposal.ownerUid, ownerGid: proposal.ownerGid,
          filesystemOperation: proposal.originalExists ? "atomic-replace" : "atomic-create" }), verified: true,
          approvalId, proposalState: "applied" };
      } finally {
        if (tempPath && !renamed) try { this.removeFile(tempPath); } catch { /* The temporary file may already be absent. */ }
        parent.close();
      }
    } catch (error) {
      this.setProposalState(proposalId, renamed ? "uncertain" : error?.code === "STALE_PROPOSAL" ? "stale" : "failed");
      if (renamed) {
        const uncertain = toolError("WRITE_VERIFICATION_FAILED", "The file operation may have completed, but Vesper could not verify the resulting state. Inspect the target before retrying.", false);
        uncertain.executed = true;
        throw uncertain;
      }
      throw error;
    } finally { root?.close(); }
  }

  assertProposalCurrent(parent, proposal) {
    const current = this.readSnapshot(parent);
    if (Boolean(current) !== proposal.originalExists) throw toolError("STALE_PROPOSAL", "The target file changed after review. Create a new proposal and review it again.", true);
    if (!current) return;
    if (sha256(current.buffer) !== proposal.originalHash || !sameStat(current.stat, proposal.originalStat)) {
      throw toolError("STALE_PROPOSAL", "The target file changed after review. Create a new proposal and review it again.", true);
    }
  }

  readSnapshot(parent) {
    const stat = this.files.statAt(parent.fd, parent.basename);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw toolError("UNSUPPORTED_FILE_TYPE", "The target must be a regular file or a new path.", true);
    const file = this.files.readFileAt(parent.fd, parent.basename, MAX_REVIEW_FIELD_LENGTH, { allowMissing: true, expectedDevice: parent.device });
    if (!file) throw toolError("STALE_FILE", "The target disappeared while Vesper was capturing its review snapshot.", true);
    if (decodeUtf8(file.buffer) === null) throw toolError("UNSUPPORTED_FILE_TYPE", "Binary or invalid UTF-8 files cannot be changed by this runtime.", true);
    const after = this.files.statAt(parent.fd, parent.basename);
    if (!after || !sameStat(file.stat, this.files.statSummary(after))) throw toolError("STALE_PROPOSAL", "The target file changed while Vesper was capturing its review snapshot.", true);
    return file;
  }

  snapshotProposal(proposal) {
    return sha256(stableStringify({ proposalId: proposal.proposalId, path: proposal.path,
      originalExists: proposal.originalExists, originalHash: proposal.originalHash, contentHash: proposal.contentHash,
      originalStat: proposal.originalStat, mode: proposal.mode, ownerUid: proposal.ownerUid, ownerGid: proposal.ownerGid,
      sessionId: this.sessionId, projectFingerprint: this.projectFingerprint() }));
  }

  createApprovalSnapshot(request, approvalId, commandPlan = null) {
    const operation = this.describeRequest(request, commandPlan);
    if (redactSensitiveText(stableStringify(operation)) !== stableStringify(operation)) {
      throw toolError("SENSITIVE_REVIEW_CONTENT", "The operation contains secret-like text that Vesper cannot safely display for approval.", true);
    }
    const policyBinding = request.toolId === "run_command" ? commandPlan?.binding || null : null;
    const digest = sha256(stableStringify({ requestId: request.requestId, toolId: request.toolId,
      input: request.input, sessionId: this.sessionId, projectFingerprint: this.projectFingerprint(), policyBinding }));
    return deepFreeze({ approvalId, requestId: request.requestId, toolId: request.toolId,
      projectRoot: this.projectRoot, projectFingerprint: this.projectFingerprint(), sessionId: this.sessionId,
      requestDigest: digest, policyBinding, operation });
  }

  isSnapshotCurrent(snapshot, request, commandPlan = null) {
    if (!snapshot || snapshot.toolId !== request.toolId || snapshot.requestId !== request.requestId ||
        snapshot.sessionId !== this.sessionId || snapshot.projectFingerprint !== this.projectFingerprint()) return false;
    const policyBinding = request.toolId === "run_command" ? commandPlan?.binding || null : null;
    if (snapshot.policyBinding !== policyBinding) return false;
    const expected = sha256(stableStringify({ requestId: request.requestId, toolId: request.toolId,
      input: request.input, sessionId: this.sessionId, projectFingerprint: this.projectFingerprint(), policyBinding }));
    return expected === snapshot.requestDigest;
  }

  describeRequest(request, commandPlan = null) {
    switch (request.toolId) {
      case "run_command": return Object.freeze({ executable: request.input.argv[0], argv: Object.freeze([...request.input.argv]),
        cwd: this.projectRoot, shell: false, workspaceAccess: request.input.workspaceAccess || "read-only",
        timeoutMs: this.commandTimeoutMs, ...(commandPlan ? { isolation: commandPlan.display, policyBinding: commandPlan.binding } : {}) });
      case "apply_file_change": return Object.freeze({ proposalId: request.input.proposalId });
      default: return Object.freeze({ ...request.input });
    }
  }

  validateRequest(request, { reserveRequestId }) {
    this.assertLive();
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !["toolId", "input", "context", "requestId"].includes(key))) {
      throw toolError("INVALID_REQUEST", "A tool request with toolId, input, context, and requestId is required.", true);
    }
    if (!isSafeJsonValue(request)) throw toolError("INVALID_REQUEST", "The tool request must contain bounded plain JSON data only.", true);
    let encoded;
    try { encoded = stableStringify(request); } catch { throw toolError("INVALID_REQUEST", "The tool request is malformed.", true); }
    if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_SIZE) throw toolError("INPUT_TOO_LARGE", "The tool request exceeds Vesper's bounded request size.", true);
    if (typeof request.requestId !== "string" || !UUID_PATTERN.test(request.requestId)) throw toolError("INVALID_REQUEST", "The tool request needs a unique UUID requestId.", true);
    if (reserveRequestId) {
      if (this.seenRequests.has(request.requestId)) throw toolError("DUPLICATE_REQUEST", "This tool request identity has already been handled.", true);
      if (this.seenRequests.size >= MAX_SEEN_REQUESTS) throw toolError("BUSY", "The runtime request history is full; create a new runtime before sending more requests.", true);
      this.seenRequests.add(request.requestId);
    }
    if (!request.context || typeof request.context !== "object" || Array.isArray(request.context) ||
        Object.keys(request.context).some((key) => !["projectRoot", "sessionId"].includes(key)) ||
        request.context.sessionId !== this.sessionId || typeof request.context.projectRoot !== "string" || !path.isAbsolute(request.context.projectRoot)) {
      throw toolError("CONTEXT_MISMATCH", "The tool request does not match the active Vesper session and project.", true);
    }
    let requestedRoot;
    try { requestedRoot = fs.realpathSync(request.context.projectRoot); } catch { throw toolError("CONTEXT_MISMATCH", "The tool request project root is unavailable.", true); }
    if (requestedRoot !== this.projectRoot) throw toolError("CONTEXT_MISMATCH", "The tool request does not match the active Vesper project.", true);
    if (typeof request.toolId !== "string" || !TOOL_IDS.includes(request.toolId)) throw toolError("INVALID_TOOL", "The requested tool is not registered.", true);
    const input = validateInput(request.toolId, request.input);
    return Object.freeze({ toolId: request.toolId, input: deepFreeze(input), context: Object.freeze({
      projectRoot: this.projectRoot, sessionId: this.sessionId,
    }), requestId: request.requestId });
  }

  definitionFor(toolId) {
    const entry = TOOL_DEFINITIONS.find((candidate) => candidate.id === toolId);
    if (!entry) throw toolError("INVALID_TOOL", "The requested tool is not registered.", true);
    return entry;
  }

  openRoot() {
    const root = this.files.openProjectRoot(this.projectRoot);
    const opened = fs.fstatSync(root.fd, { bigint: true });
    if (root.path !== this.projectRoot || String(opened.dev) !== this.projectIdentity.dev || String(opened.ino) !== this.projectIdentity.ino) {
      root.close(); throw toolError("INVALID_PROJECT", "The selected project root changed; the operation was rejected.", true);
    }
    return root;
  }

  projectFingerprint() { return sha256(this.projectRoot).slice(0, 24); }

  setProposalState(proposalId, state) {
    this.proposalStates.delete(proposalId);
    this.proposalStates.set(proposalId, state);
    while (this.proposalStates.size > MAX_PROPOSALS * 2) {
      const expiredId = [...this.proposalStates.keys()].find((candidate) => !this.proposals.has(candidate));
      if (!expiredId) break;
      this.proposalStates.delete(expiredId);
    }
  }

  finishRejected(request, code, message, approvalId = null) {
    this.recordAudit(request.toolId, "rejected", request.requestId, approvalId, code);
    return Object.freeze({ requestId: request.requestId, toolId: request.toolId, state: "rejected",
      executed: false, verified: false, approvalId, error: Object.freeze({ code, message, retryable: false }) });
  }

  recordAudit(toolId, state, requestId, approvalId, errorCode = null) {
    let timestamp;
    try { timestamp = this.now().toISOString(); } catch { timestamp = new Date().toISOString(); }
    const event = Object.freeze({ toolId, sessionId: this.sessionId, projectId: this.projectFingerprint(),
      requestId: validUuidOrNull(requestId), state: AUDIT_STATES.has(state) ? state : "failed",
      approvalId: validUuidOrNull(approvalId), resultStatus: errorCode ? "error" : state === "executed" || state === "verified" ? "success" : "pending",
      ...(errorCode ? { errorCode: stableErrorCode(errorCode) } : {}), timestamp });
    this.audit.push(event);
    if (this.audit.length > MAX_AUDIT_EVENTS) this.audit.shift();
    try { this.auditSink?.(event); } catch { /* Audit observers cannot affect operation safety. */ }
  }

  assertLive() { if (this.disposed) throw toolError("RUNTIME_DISPOSED", "This tool runtime has been disposed.", true); }

  dispose() {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.commandAbortController?.abort();
    this.proposals.clear();
    this.proposalStates.clear();
    return Promise.resolve(this.commandBackend?.dispose?.()).catch(() => {});
  }

  interrupt() {
    if (!this.busy) return false;
    this.interruptionRequested = true;
    this.commandAbortController?.abort();
    this.approvalAbortController?.abort();
    this.operationAbortController?.abort("tool-operation-interrupted");
    return true;
  }
}

const AUDIT_STATES = new Set(["requested", "validated", "awaiting-approval", "approved", "executed", "verified", "proposed", "rejected", "failed", "interrupted",
  "timed-out", "interrupted", "isolation-unavailable", "uncertain"]);

function createPermissionedToolRuntime(options) {
  const runtime = new PermissionedToolRuntime(options);
  return Object.freeze({
    sessionId: runtime.sessionId,
    getDefinitions: () => runtime.getDefinitions(),
    getAuditEvents: () => runtime.getAuditEvents(),
    getCommandExecutionStatus: () => runtime.getCommandExecutionStatus(),
    preview: (request) => runtime.preview(request),
    invoke: (request, options) => runtime.invoke(request, options),
    interrupt: () => runtime.interrupt(),
    dispose: () => runtime.dispose(),
  });
}

function listToolDefinitions({ commandExecutionEnabled = false } = {}) {
  return TOOL_DEFINITIONS.map((entry) => Object.freeze({ ...entry, limits: Object.freeze({ ...entry.limits }),
    enabled: entry.id !== "run_command" || commandExecutionEnabled === true }));
}

function renderToolDefinitions(definitions = listToolDefinitions()) {
  const lines = ["Vesper permissioned tool runtime", "", "Tool                 Permission          Approval  Availability"];
  for (const entry of definitions) {
    lines.push(`${entry.id.padEnd(21)} ${entry.permission.padEnd(19)} ${String(entry.requiresApproval).padEnd(9)} ${entry.enabled ? "enabled" : "disabled"}`);
    lines.push(`  ${entry.description}`);
    lines.push(`  Input: ${JSON.stringify(entry.inputSchema)}`);
    lines.push(`  Limits: ${JSON.stringify(entry.limits)}`);
  }
  lines.push("", "Manual and compatible-provider requests use the same schema, project, session, approval, and audit checks. Command execution is not exposed to model calls. Codex keeps its native tool and approval path.");
  return `${lines.join("\n")}\n`;
}

function renderToolApproval(snapshot) {
  const operation = snapshot?.operation || {};
  const lines = ["Vesper tool approval · one operation only", `Tool: ${safeReviewText(snapshot.toolId)}`,
    `Session: ${safeReviewText(snapshot.sessionId)}`, `Project: ${safeReviewText(snapshot.projectRoot)}`];
  if (snapshot.toolId === "run_command") {
    const displayArgv = Array.isArray(operation.argv) ? operation.argv.map((argument) => safeReviewText(argument)) : [];
    lines.push(`Working directory: ${safeReviewText(operation.cwd)}`, `Workspace mount: ${safeReviewText(operation.workspaceAccess || "read-only")}`,
      `Shell parsing: disabled; executable and argv are explicit`, `Timeout: ${operation.timeoutMs} ms`,
      `Command argv (escaped for display): ${JSON.stringify(displayArgv)}`);
    const isolation = operation.isolation;
    if (isolation) {
      lines.push(`Isolation backend: ${safeReviewText(isolation.backend)}`, `Local image id: ${safeReviewText(isolation.imageId)}`,
        `Network: ${safeReviewText(isolation.network)}`, `Root filesystem read-only: ${isolation.readOnlyRootFilesystem ? "yes" : "no"}`,
        `Seccomp: ${safeReviewText(isolation.seccomp)}`, `No new privileges: ${isolation.noNewPrivileges ? "yes" : "no"}`,
        `Capabilities: ${safeReviewText(isolation.capabilities)}`, `Private namespaces: ${safeReviewText(isolation.privateNamespaces)}`,
        `Host sockets: ${safeReviewText(isolation.hostSockets)}`, `Host /proc: ${safeReviewText(isolation.hostProc)}`,
        `CPU limit: ${isolation.cpuCount}`, `Memory limit: ${isolation.memoryMiB} MiB`,
        `Process limit: ${isolation.processLimit}`, `Output limit: ${isolation.outputLimitBytesPerStream} bytes per stream`);
    }
  } else if (snapshot.toolId === "apply_file_change") {
    lines.push(`Proposal: ${safeReviewText(operation.proposalId)}`, `Target: ${safeReviewText(operation.path)}`,
      `Original exists: ${operation.originalExists}`, `Original SHA-256: ${operation.originalHash || "(new file)"}`,
      `Original mode: ${operation.originalStat ? `0${Number(operation.originalStat.mode & 0o777).toString(8)}` : "(new file)"}`,
      `Result mode: 0${Number(operation.resultingMode).toString(8)} · owner uid ${operation.resultingOwnerUid} · gid ${operation.resultingOwnerGid}`,
      `Proposed SHA-256: ${operation.contentHash}`, "Complete original content:",
      operation.originalExists ? safeReviewText(operation.originalContent, true) : "(file did not exist)", "Complete proposed content:",
      safeReviewText(operation.proposedContent, true));
  } else {
    lines.push(`Operation: ${safeReviewText(stableStringify(operation), true)}`);
  }
  let body = lines.join("\n");
  if (body.length > MAX_REVIEW_SIZE) body = `${body.slice(0, MAX_REVIEW_SIZE)}\n[review truncated; approval refused]`;
  return body;
}

function ensureApprovalReviewFits(snapshot) {
  if (renderToolApproval(snapshot).includes("[review truncated; approval refused]")) {
    throw toolError("APPROVAL_REVIEW_TOO_LARGE", "The complete operation does not fit Vesper's bounded approval review and was not executed.", true);
  }
}

function validateInput(toolId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw toolError("INVALID_ARGUMENT", "Tool input must be a JSON object.", true);
  const exactKeys = (expected, optional = ["path"]) => {
    if (Object.keys(input).some((key) => !expected.includes(key))) throw toolError("INVALID_ARGUMENT", "Tool input contains unsupported fields.", true);
    if (expected.some((key) => !Object.hasOwn(input, key) && !optional.includes(key))) throw toolError("INVALID_ARGUMENT", "Tool input is missing a required field.", true);
  };
  switch (toolId) {
    case "read_file": {
      exactKeys(["path", "maxBytes"], ["maxBytes"]);
      const maxBytes = input.maxBytes === undefined ? MAX_FILE_BYTES : input.maxBytes;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) {
        throw toolError("INVALID_ARGUMENT", `read_file maxBytes must be an integer from 1 to ${MAX_FILE_BYTES}.`, true);
      }
      return { path: validPathValue(input.path, false), maxBytes };
    }
    case "list_files": exactKeys(["path"]); return { ...(input.path === undefined ? {} : { path: validPathValue(input.path, true) }) };
    case "search_files":
      exactKeys(["query", "queries", "path", "paths", "caseSensitive", "maxFileBytes"], ["query", "queries", "path", "paths", "caseSensitive", "maxFileBytes"]);
      if ((input.query === undefined) === (input.queries === undefined) || (input.path !== undefined && input.paths !== undefined)) {
        throw toolError("INVALID_ARGUMENT", "search_files requires one query form and either path or explicit paths.", true);
      }
      const queries = input.queries === undefined ? [input.query] : input.queries;
      if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_SEARCH_QUERIES ||
          queries.some((value) => typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512 || value.includes("\0")) ||
          new Set(queries).size !== queries.length) {
        throw toolError("INVALID_ARGUMENT", `search_files queries must contain 1 to ${MAX_SEARCH_QUERIES} unique literal values of at most 512 bytes.`, true);
      }
      if (input.caseSensitive !== undefined && typeof input.caseSensitive !== "boolean") throw toolError("INVALID_ARGUMENT", "search_files caseSensitive must be boolean.", true);
      if (input.maxFileBytes !== undefined && (!Number.isInteger(input.maxFileBytes) || input.maxFileBytes < 1 || input.maxFileBytes > MAX_FILE_BYTES)) {
        throw toolError("INVALID_ARGUMENT", `search_files maxFileBytes must be an integer from 1 to ${MAX_FILE_BYTES}.`, true);
      }
      if (input.paths !== undefined) {
        if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_SEARCH_PATHS) throw toolError("INVALID_ARGUMENT", `search_files paths must contain 1 to ${MAX_SEARCH_PATHS} project-relative files.`, true);
        const paths = input.paths.map((value) => validPathValue(value, false));
        if (new Set(paths).size !== paths.length || paths.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > MAX_SEARCH_PATH_LIST_BYTES) {
          throw toolError("INVALID_ARGUMENT", "search_files paths must be unique and fit the bounded path-list size.", true);
        }
        return { queries: Object.freeze([...queries]), paths: Object.freeze(paths), ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
          ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }) };
      }
      return { queries: Object.freeze([...queries]), ...(input.path === undefined ? {} : { path: validPathValue(input.path, true) }),
        ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }), ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }) };
    case "git_status": exactKeys([]); return {};
    case "git_diff": exactKeys(["path"]); return input.path === undefined ? {} : { path: validPathValue(input.path, false) };
    case "git_log": {
      exactKeys(["limit", "path"], ["limit", "path"]);
      const limit = input.limit === undefined ? 10 : input.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw toolError("INVALID_ARGUMENT", "git_log limit must be an integer from 1 to 20.", true);
      return { limit, ...(input.path === undefined ? {} : { path: validPathValue(input.path, false) }) };
    }
    case "git_check_ignore": {
      exactKeys(["paths"], ["paths"]);
      if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 100) {
        throw toolError("INVALID_ARGUMENT", "git_check_ignore paths must contain from 1 to 100 values.", true);
      }
      return { paths: input.paths.map((value) => validPathValue(value, false)) };
    }
    case "run_command":
      exactKeys(["argv", "workspaceAccess"], ["workspaceAccess"]);
      if (input.workspaceAccess !== undefined && !["read-only", "read-write"].includes(input.workspaceAccess)) {
        throw toolError("INVALID_ARGUMENT", "workspaceAccess must be read-only or read-write.", true);
      }
      return { argv: validateArgv(input.argv), ...(input.workspaceAccess === undefined ? {} : { workspaceAccess: input.workspaceAccess }) };
    case "propose_file_change":
      exactKeys(["path", "content"]);
      if (typeof input.content !== "string") throw toolError("INVALID_ARGUMENT", "propose_file_change content must be a string.", true);
      if (encodeReviewText(input.content, "proposed content").length > MAX_REVIEW_FIELD_LENGTH) throw toolError("INPUT_TOO_LARGE", "Proposed content exceeds the reviewable file-change limit.", true);
      return { path: validPathValue(input.path, false), content: input.content };
    case "apply_file_change":
      exactKeys(["proposalId"]);
      if (typeof input.proposalId !== "string" || !UUID_PATTERN.test(input.proposalId)) throw toolError("INVALID_ARGUMENT", "apply_file_change requires a valid proposal ID.", true);
      return { proposalId: input.proposalId };
    default: throw toolError("INVALID_TOOL", "The requested tool is not registered.", true);
  }
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw toolError("INVALID_ARGUMENT", "run_command requires a non-empty argv array with at most 64 text arguments.", true);
  }
  let total = 0;
  const copied = argv.map((arg) => {
    const size = Buffer.byteLength(arg, "utf8");
    if (!size || size > MAX_COMMAND_LENGTH) throw toolError("INVALID_ARGUMENT", "Command arguments must be non-empty and at most 4096 bytes each.", true);
    total += size;
    return arg;
  });
  if (total > MAX_COMMAND_LENGTH) throw toolError("INPUT_TOO_LARGE", "The total command argv exceeds 4096 bytes.", true);
  return Object.freeze(copied);
}

function validPathValue(value, allowRoot) {
  try { return workspaceFiles.parseProjectPath(value, { allowRoot }).relativePath || (allowRoot ? "." : ""); }
  catch (error) { throw toolError(error.code || "INVALID_PATH", error.message || "A project-relative path is required.", true); }
}

function rejectProtectedPath(relativePath) {
  if (relativePath.split("/").some((component) => component.toLowerCase() === ".git" || component.toLowerCase() === ".vesper")) {
    throw toolError("PATH_REJECTED", "Tool file changes cannot target Vesper or Git metadata.", true);
  }
}

function encodeReviewText(value, label) {
  if (typeof value !== "string" || hasUnpairedSurrogate(value) || value.includes("\0")) {
    throw toolError("INVALID_ARGUMENT", `${label} must be valid UTF-8 text without NUL bytes.`, true);
  }
  return Buffer.from(value, "utf8");
}

function decodeUtf8(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return null; }
}

function renderFileProposal(proposal) {
  const review = [`Target: ${proposal.path}`, `Original exists: ${proposal.originalExists}`,
    `Original SHA-256: ${proposal.originalHash || "(new file)"}`, `Proposed SHA-256: ${proposal.contentHash}`,
    "Complete original content:", proposal.originalExists ? proposal.originalContent : "(file did not exist)",
    "Complete proposed content:", proposal.content].join("\n");
  return safeReviewText(review, true).slice(0, MAX_REVIEW_SIZE);
}

function safeReviewText(value, preserveNewlines = false) {
  const text = redactSensitiveText(value).replace(/\u001b/gu, "\\x1b")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, (character) => {
      if (preserveNewlines && character === "\n") return "\n";
      const code = character.codePointAt(0);
      return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
    });
  return preserveNewlines ? escapeTerminalOutput(text) : text;
}

function sameStat(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.uid === right.uid && left.gid === right.gid;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => stableStringify(child)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function isSafeJsonValue(value) {
  const seen = new Set();
  let totalBytes = 0;
  const visit = (current, depth) => {
    if (depth > 24) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") {
      if (hasUnpairedSurrogate(current)) return false;
      totalBytes += Buffer.byteLength(current, "utf8");
      return totalBytes <= MAX_REQUEST_SIZE;
    }
    if (typeof current !== "object" || seen.has(current)) return false;
    let prototype;
    let keys;
    try { prototype = Object.getPrototypeOf(current); keys = Reflect.ownKeys(current); } catch { return false; }
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype || current.length > 10_000 ||
          keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) return false;
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !visit(descriptor.value, depth + 1)) return false;
      }
      seen.delete(current);
      return true;
    }
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > 1_024 || keys.some((key) => typeof key !== "string")) return false;
    seen.add(current);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || hasUnpairedSurrogate(key)) return false;
      totalBytes += Buffer.byteLength(key, "utf8");
      if (totalBytes > MAX_REQUEST_SIZE || !visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(current);
    return true;
  };
  return visit(value, 0);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function boundedBuffer(buffer, maximum) {
  return { buffer: buffer.subarray(0, maximum), truncated: buffer.length > maximum };
}

function toolError(code, message, rejected = false) {
  const error = new Error(message);
  error.code = code;
  error.rejected = rejected;
  error.retryable = ["BUSY", "TIMEOUT", "COMMAND_TIMEOUT", "STALE_PROPOSAL", "INVALID_PROJECT"].includes(code);
  return error;
}

function normalizeToolError(error) {
  const known = new Set(["INVALID_REQUEST", "INVALID_TOOL", "INVALID_ARGUMENT", "INVALID_PATH", "CONTEXT_MISMATCH",
    "INPUT_TOO_LARGE", "OUTPUT_LIMIT", "UNSUPPORTED_FILE_TYPE", "PATH_REJECTED", "NOT_FOUND", "UNAVAILABLE",
    "TIMEOUT", "COMMAND_TIMEOUT", "COMMAND_FAILED", "GIT_FAILED", "APPROVAL_REQUIRED", "APPROVAL_DECLINED",
    "APPROVAL_CANCELLED", "STALE_APPROVAL", "STALE_PROPOSAL", "PROPOSAL_NOT_FOUND", "WRITE_VERIFICATION_FAILED",
    "DUPLICATE_REQUEST", "BUSY", "INVALID_PROJECT", "UNSUPPORTED_OPERATION", "UNSUPPORTED_PLATFORM",
    "SENSITIVE_REVIEW_CONTENT", "GIT_SCOPE_REJECTED", "STALE_FILE", "UNSUPPORTED_FILE_METADATA", "APPROVAL_REVIEW_TOO_LARGE", "RUNTIME_ERROR", "RUNTIME_DISPOSED",
    "ISOLATION_UNAVAILABLE", "ISOLATION_RUNTIME_MISSING", "ISOLATION_RUNTIME_UNAVAILABLE", "ISOLATION_RUNTIME_TIMEOUT", "ISOLATION_REQUIREMENTS_UNAVAILABLE",
    "ISOLATION_IMAGE_UNCONFIGURED", "ISOLATION_IMAGE_INVALID", "ISOLATION_IMAGE_UNAVAILABLE", "ISOLATION_IMAGE_UNVERIFIABLE", "ISOLATION_IMAGE_UNSUPPORTED",
    "ISOLATION_STATUS_UNVERIFIABLE", "ISOLATION_POLICY_CHANGED", "ISOLATION_VERIFY_FAILED", "COMMAND_OUTCOME_UNCERTAIN", "COMMAND_INTERRUPTED",
    "SANDBOX_CLEANUP_FAILED", "BACKEND_DISPOSED", "TOOL_INTERRUPTED"]);
  const code = known.has(error?.code) ? error.code : "TOOL_FAILED";
  const messages = {
    NOT_FOUND: "The requested project resource was not found.",
    TOOL_FAILED: "The tool failed; Vesper did not confirm a successful result.",
    WRITE_VERIFICATION_FAILED: "The file operation may have completed, but Vesper could not verify the resulting state. Inspect the target before retrying.",
  };
  return { code, message: messages[code] || (typeof error?.message === "string" ? redactSensitiveText(error.message).slice(0, 500) : "Tool operation failed."),
    retryable: Boolean(error?.retryable), executed: error?.executed === true,
    rejected: Boolean(error?.rejected) || ["INVALID_REQUEST", "INVALID_TOOL", "INVALID_ARGUMENT", "INVALID_PATH", "CONTEXT_MISMATCH", "INPUT_TOO_LARGE", "PATH_REJECTED", "APPROVAL_REQUIRED", "APPROVAL_DECLINED", "APPROVAL_CANCELLED", "STALE_APPROVAL", "STALE_PROPOSAL", "DUPLICATE_REQUEST", "PROPOSAL_NOT_FOUND", "SENSITIVE_REVIEW_CONTENT", "GIT_SCOPE_REJECTED", "STALE_FILE", "UNSUPPORTED_FILE_METADATA", "APPROVAL_REVIEW_TOO_LARGE", "UNSUPPORTED_PLATFORM", "RUNTIME_DISPOSED", "ISOLATION_UNAVAILABLE", "ISOLATION_RUNTIME_MISSING", "ISOLATION_REQUIREMENTS_UNAVAILABLE", "ISOLATION_IMAGE_UNCONFIGURED", "ISOLATION_IMAGE_INVALID", "ISOLATION_IMAGE_UNAVAILABLE", "ISOLATION_IMAGE_UNVERIFIABLE", "ISOLATION_IMAGE_UNSUPPORTED", "ISOLATION_STATUS_UNVERIFIABLE", "ISOLATION_POLICY_CHANGED", "ISOLATION_VERIFY_FAILED", "BACKEND_DISPOSED"].includes(code) };
}

function operationFailureState(error) {
  if (error.code === "COMMAND_TIMEOUT") return "timed-out";
  if (error.code === "COMMAND_INTERRUPTED" || error.code === "TOOL_INTERRUPTED") return "interrupted";
  if (["COMMAND_OUTCOME_UNCERTAIN", "SANDBOX_CLEANUP_FAILED"].includes(error.code)) return "uncertain";
  if (error.code.startsWith("ISOLATION_") && error.code !== "ISOLATION_POLICY_CHANGED") return "isolation-unavailable";
  return error.rejected ? "rejected" : "failed";
}

function validUuidOrNull(value) { return typeof value === "string" && UUID_PATTERN.test(value) ? value : null; }
function rejected(code, message) {
  const error = toolError(code, message, true);
  return Object.freeze({ requestId: null, toolId: null, state: "rejected", approved: false, executed: false, verified: false,
    error: Object.freeze({ code, message, retryable: error.retryable }) });
}
function safeOwnString(value, key, predicate) {
  try {
    if (!value || typeof value !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" && predicate(descriptor.value)
      ? descriptor.value : null;
  } catch { return null; }
}
function stableErrorCode(value) { return /^[A-Z][A-Z0-9_]{0,79}$/u.test(String(value)) ? String(value) : "TOOL_FAILED"; }

function definition(id, description, permission, requiresApproval, inputSchema, limits) {
  return Object.freeze({ id, type: "project-tool", description, permission, requiresApproval,
    inputSchema: deepFreeze(inputSchema), limits: Object.freeze(limits) });
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function projectPathSchema() {
  return { type: "string", format: "project-relative-path", minLength: 1, maxLength: 1_024 };
}

module.exports = {
  MAX_AUDIT_EVENTS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_PROPOSALS,
  MAX_TOOL_OUTPUT,
  createPermissionedToolRuntime,
  listToolDefinitions,
  renderToolApproval,
  renderToolDefinitions,
  validateInput,
};
