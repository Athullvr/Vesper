"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, runVesper } = require("../cli");
const { createPermissionedToolRuntime, listToolDefinitions, renderToolApproval } = require("../permissioned-tool-runtime");
const { OPENAI_CAPABILITIES } = require("../openai-chat-completions-provider");
const workspaceFiles = require("../tool-workspace-files");

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-tools-test-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

function makeRuntime(root, options = {}) {
  const sessionId = options.sessionId || crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId, ...options });
  return { runtime, sessionId };
}

function request(root, sessionId, toolId, input, requestId = crypto.randomUUID()) {
  return { toolId, input, context: { projectRoot: root, sessionId }, requestId };
}

function capture() {
  let text = "";
  return { stream: { write: (chunk) => { text += String(chunk); } }, get text() { return text; } };
}

test("tool definitions are explicit, and the public runtime exposes only the invocation boundary", (t) => {
  const { root } = fixture(t);
  const { runtime } = makeRuntime(root);
  t.after(() => runtime.dispose());
  const definitions = runtime.getDefinitions();
  assert.deepEqual(definitions.map((entry) => entry.id), ["read_file", "list_files", "search_files", "git_status", "git_diff", "git_log", "run_command", "propose_file_change", "apply_file_change"]);
  assert.equal(definitions.find((entry) => entry.id === "run_command").enabled, false);
  assert.equal(definitions.find((entry) => entry.id === "apply_file_change").enabled, false);
  assert.equal(definitions.find((entry) => entry.id === "read_file").inputSchema.properties.path.format, "project-relative-path");
  assert.equal(definitions.find((entry) => entry.id === "read_file").inputSchema.additionalProperties, false);
  assert.equal(definitions.find((entry) => entry.id === "run_command").requiresApproval, true);
  assert.equal(definitions.find((entry) => entry.id === "apply_file_change").requiresApproval, true);
  assert.equal(typeof runtime.runCommand, "undefined");
  assert.equal(typeof runtime.applyFileChange, "undefined");
  assert.equal(listToolDefinitions().find((entry) => entry.id === "run_command").enabled, false);
});

test("preview validates a registered request without executing or auditing it", async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "sample.txt"), "hello\n");
  const { runtime, sessionId } = makeRuntime(root);
  t.after(() => runtime.dispose());
  const result = await runtime.preview(request(root, sessionId, "read_file", { path: "sample.txt" }));
  assert.equal(result.state, "validated");
  assert.equal(result.executes, false);
  assert.deepEqual(runtime.getAuditEvents(), []);
});

test("project file access rejects traversal, absolute paths, and symlink escapes", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { parent, root } = fixture(t);
  const outside = path.join(parent, "outside.txt");
  fs.writeFileSync(outside, "outside-secret\n");
  fs.symlinkSync(outside, path.join(root, "escape.txt"));
  const { runtime, sessionId } = makeRuntime(root);
  t.after(() => runtime.dispose());

  const traversal = await runtime.invoke(request(root, sessionId, "read_file", { path: "../outside.txt" }));
  const absolute = await runtime.invoke(request(root, sessionId, "read_file", { path: outside }));
  const symlink = await runtime.invoke(request(root, sessionId, "read_file", { path: "escape.txt" }));
  assert.equal(traversal.state, "rejected");
  assert.equal(absolute.state, "rejected");
  assert.equal(symlink.state, "rejected");
  assert.match([traversal.error.code, absolute.error.code, symlink.error.code].join(" "), /INVALID_PATH|PATH_REJECTED/u);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside-secret\n");
});

test("read, directory listing, and literal search are bounded and redact sensitive text", async (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "config.js"), `const api_key = "sk-proj-12345678901234567890";\nneedle\n`);
  fs.writeFileSync(path.join(root, "src", "many.txt"), `${"needle\n".repeat(130)}`);
  fs.writeFileSync(path.join(root, "oversized.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
  const wide = path.join(root, "wide");
  fs.mkdirSync(wide);
  for (let index = 0; index < 105; index += 1) fs.writeFileSync(path.join(wide, `entry-${index}.txt`), "x");
  const { runtime, sessionId } = makeRuntime(root);
  t.after(() => runtime.dispose());

  const read = await runtime.invoke(request(root, sessionId, "read_file", { path: "src/config.js" }));
  assert.equal(read.state, "verified");
  assert.equal(read.result.redacted, true);
  assert.doesNotMatch(read.result.content, /sk-proj-12345678901234567890/u);

  const listing = await runtime.invoke(request(root, sessionId, "list_files", { path: "src" }));
  assert.equal(listing.state, "verified");
  assert.ok(listing.result.entries.some((entry) => entry.name === "many.txt"));
  const boundedListing = await runtime.invoke(request(root, sessionId, "list_files", { path: "wide" }));
  assert.equal(boundedListing.result.entries.length, 100);
  assert.equal(boundedListing.result.truncated, true);

  const search = await runtime.invoke(request(root, sessionId, "search_files", { query: "needle" }));
  assert.equal(search.state, "executed");
  assert.equal(search.result.matches.length, 100);
  assert.equal(search.truncated, true);

  const oversized = await runtime.invoke(request(root, sessionId, "read_file", { path: "oversized.txt" }));
  assert.equal(oversized.state, "rejected");
  assert.equal(oversized.error.code, "INPUT_TOO_LARGE");
  await assert.rejects(runtime.preview(request(root, sessionId, "propose_file_change", { path: "x.txt", content: "x".repeat(8_001) })),
    /reviewable file-change limit/u);
});

test("request schemas reject unknown tools, extra fields, accessors, and project/session mismatches", async (t) => {
  const { root } = fixture(t);
  const { runtime, sessionId } = makeRuntime(root);
  t.after(() => runtime.dispose());
  const unknown = await runtime.invoke(request(root, sessionId, "execute_arbitrary", {}));
  const extra = await runtime.invoke(request(root, sessionId, "read_file", { path: "x", other: true }));
  const wrongProject = await runtime.invoke({ ...request(root, sessionId, "list_files", {}), context: { projectRoot: os.tmpdir(), sessionId } });
  let getterCalls = 0;
  const input = {};
  Object.defineProperty(input, "path", { enumerable: true, get() { getterCalls += 1; return "README.md"; } });
  const accessor = await runtime.invoke(request(root, sessionId, "read_file", input));
  assert.equal(unknown.error.code, "INVALID_TOOL");
  assert.equal(extra.error.code, "INVALID_ARGUMENT");
  assert.equal(wrongProject.error.code, "CONTEXT_MISMATCH");
  assert.equal(accessor.error.code, "INVALID_REQUEST");
  assert.equal(getterCalls, 0);
});

test("Git inspection is read-only, bounded, and scoped to an in-project repository", async (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, ".git", "objects", "info"), { recursive: true });
  const calls = [];
  const { runtime, sessionId } = makeRuntime(root, {
    execFileImpl: async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (args.includes("rev-parse")) return { stdout: Buffer.from(`${root}\n`) };
      return { stdout: Buffer.from("## main\n"), stderr: Buffer.alloc(0) };
    },
  });
  t.after(() => runtime.dispose());
  const status = await runtime.invoke(request(root, sessionId, "git_status", {}));
  const diff = await runtime.invoke(request(root, sessionId, "git_diff", { path: "-nasty-name" }));
  const history = await runtime.invoke(request(root, sessionId, "git_log", { limit: 4, path: "-nasty-name" }));
  const invalidHistory = await runtime.invoke(request(root, sessionId, "git_log", { limit: 21 }));
  assert.equal(status.state, "verified");
  assert.equal(status.result.text, "## main\n");
  assert.equal(diff.state, "verified");
  assert.equal(history.state, "verified");
  assert.equal(invalidHistory.state, "rejected");
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.executable === "git" && call.options.shell !== true && call.options.timeout <= 5_000));
  const diffArgs = calls[3].args;
  assert.ok(diffArgs.includes("--no-ext-diff"));
  assert.ok(diffArgs.includes("--no-textconv"));
  assert.ok(diffArgs.includes(":(literal)-nasty-name"));
  const logArgs = calls[5].args;
  assert.ok(logArgs.includes("--max-count=4"));
  assert.ok(logArgs.includes("--format=%h %ad %s"));
  assert.ok(logArgs.includes(":(literal)-nasty-name"));
  assert.ok(!logArgs.includes("--all"), "history inspection should stay on the local selected branch graph");

  const nestedRoot = path.join(root, "nested");
  fs.mkdirSync(nestedRoot);
  const nested = makeRuntime(nestedRoot, { execFileImpl: async () => { throw new Error("must not inspect outside repository"); } });
  t.after(() => nested.runtime.dispose());
  const rejected = await nested.runtime.invoke(request(nestedRoot, nested.sessionId, "git_status", {}));
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.error.code, "GIT_SCOPE_REJECTED");

  const includedRoot = path.join(root, "included-config-project");
  fs.mkdirSync(path.join(includedRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(includedRoot, ".git", "config"), '[include]\npath = "/outside/config"\n');
  let externalConfigCalls = 0;
  const included = makeRuntime(includedRoot, { execFileImpl: async () => { externalConfigCalls += 1; return { stdout: Buffer.from(`${includedRoot}\n`) }; } });
  t.after(() => included.runtime.dispose());
  const includeResult = await included.runtime.invoke(request(includedRoot, included.sessionId, "git_status", {}));
  assert.equal(includeResult.state, "rejected");
  assert.equal(includeResult.error.code, "GIT_SCOPE_REJECTED");
  assert.equal(externalConfigCalls, 0);
});

test("file changes remain proposals until exact one-time approval, then are atomically verified", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "note.txt"), "original\n");
  fs.chmodSync(path.join(root, "note.txt"), 0o640);
  let approvalCount = 0;
  let approvalSnapshot;
  const { runtime, sessionId } = makeRuntime(root, {
    approvalHandler: async (snapshot) => {
      approvalCount += 1;
      approvalSnapshot = snapshot;
      return "approve-once";
    },
  });
  t.after(() => runtime.dispose());
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "note.txt", content: "replacement\n" }));
  assert.equal(proposal.state, "proposed");
  assert.equal(proposal.executed, false);
  assert.equal(proposal.proposal.approvalState, "not-requested");
  assert.equal(fs.readFileSync(path.join(root, "note.txt"), "utf8"), "original\n");

  const applyRequest = request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId });
  const result = await runtime.invoke(applyRequest);
  assert.equal(result.state, "verified");
  assert.equal(result.verified, true);
  assert.equal(result.proposalState, "applied");
  assert.equal(fs.readFileSync(path.join(root, "note.txt"), "utf8"), "replacement\n");
  assert.equal(approvalCount, 1);
  assert.equal(approvalSnapshot.requestId, applyRequest.requestId);
  assert.equal(approvalSnapshot.operation.originalHash, proposal.proposal.originalHash);
  assert.equal(Object.isFrozen(approvalSnapshot.operation), true);
  assert.equal(fs.statSync(path.join(root, "note.txt")).mode & 0o777, 0o640);

  const replay = await runtime.invoke(applyRequest);
  assert.equal(replay.state, "rejected");
  assert.equal(replay.error.code, "DUPLICATE_REQUEST");
  assert.equal(approvalCount, 1);
  assert.ok(runtime.getAuditEvents().some((event) => event.state === "verified" && event.approvalId));
});

test("file changes made while approval is pending reject as stale", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "before\n");
  const { runtime, sessionId } = makeRuntime(root, {
    approvalHandler: async () => { fs.writeFileSync(target, "concurrent edit\n"); return "approve-once"; },
  });
  t.after(() => runtime.dispose());
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "note.txt", content: "Vesper edit\n" }));
  const result = await runtime.invoke(request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId }));
  assert.equal(result.state, "rejected");
  assert.equal(result.error.code, "STALE_PROPOSAL");
  assert.equal(result.proposalState, "stale");
  assert.equal(fs.readFileSync(target, "utf8"), "concurrent edit\n");
});

test("file proposal inspection errors fail closed instead of treating an inaccessible target as missing", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "target.txt"), "original\n");
  const fileOperations = {
    ...workspaceFiles,
    statAt() { const error = new Error("private filesystem detail"); error.code = "EACCES"; throw error; },
  };
  const { runtime, sessionId } = makeRuntime(root, { fileOperations });
  t.after(() => runtime.dispose());
  const result = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "target.txt", content: "replacement\n" }));
  assert.equal(result.state, "failed");
  assert.match(result.error.message, /did not confirm a successful result/u);
  assert.equal(fs.readFileSync(path.join(root, "target.txt"), "utf8"), "original\n");
});

test("malformed approvals cancel, and an explicit decline never writes the proposal", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "before\n");
  let decision = { decision: "approve-once" };
  const { runtime, sessionId } = makeRuntime(root, { approvalHandler: async () => decision });
  t.after(() => runtime.dispose());
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "note.txt", content: "after\n" }));
  const malformed = await runtime.invoke(request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId }));
  assert.equal(malformed.state, "rejected");
  assert.equal(malformed.error.code, "APPROVAL_CANCELLED");
  assert.equal(malformed.proposalState, "cancelled");
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");

  decision = "decline";
  const declined = await runtime.invoke(request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId }));
  assert.equal(declined.state, "rejected");
  assert.equal(declined.error.code, "APPROVAL_DECLINED");
  assert.equal(declined.proposalState, "declined");
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
});

test("disposing while approval is pending prevents the protected operation from continuing", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "before\n");
  let resolveDecision;
  let resolveApprovalRequested;
  const approvalRequested = new Promise((resolve) => { resolveApprovalRequested = resolve; });
  const { runtime, sessionId } = makeRuntime(root, { approvalHandler: () => {
    resolveApprovalRequested();
    return new Promise((resolve) => { resolveDecision = resolve; });
  } });
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "note.txt", content: "after\n" }));
  const pending = runtime.invoke(request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId }));
  await approvalRequested;
  runtime.dispose();
  resolveDecision("approve-once");
  const result = await pending;
  assert.equal(result.state, "rejected");
  assert.equal(result.error.code, "RUNTIME_DISPOSED");
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
});

test("interrupting an approval wait cancels a model-style file apply before any write", async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "target.txt"), "before\n");
  let approvalStarted;
  const started = new Promise((resolve) => { approvalStarted = resolve; });
  const { runtime, sessionId } = makeRuntime(root, {
    approvalHandler: (_snapshot, { signal } = {}) => new Promise((resolve) => {
      approvalStarted();
      if (signal?.aborted) return resolve("cancel");
      signal?.addEventListener("abort", () => resolve("cancel"), { once: true });
    }),
  });
  t.after(() => runtime.dispose());
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", {
    path: "target.txt", content: "after\n",
  }));
  assert.equal(proposal.state, "proposed");
  const applying = runtime.invoke(request(root, sessionId, "apply_file_change", {
    proposalId: proposal.proposal.proposalId,
  }));
  await started;
  assert.equal(runtime.interrupt(), true);
  const result = await applying;
  assert.equal(result.state, "interrupted");
  assert.equal(result.verified, false);
  assert.equal(fs.readFileSync(path.join(root, "target.txt"), "utf8"), "before\n");
});

test("a staged atomic-write failure is not reported as success and preserves existing content", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "old\n");
  const { runtime, sessionId } = makeRuntime(root, {
    approvalHandler: async () => "approve-once",
    atomicReplace() { throw new Error("synthetic atomic replacement failure"); },
  });
  t.after(() => runtime.dispose());
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "note.txt", content: "new\n" }));
  const result = await runtime.invoke(request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId }));
  assert.equal(result.state, "failed");
  assert.equal(result.verified, false);
  assert.equal(fs.readFileSync(target, "utf8"), "old\n");
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
});

test("a committed file write that cannot be verified is reported as uncertain, never successful", async (t) => {
  if (process.platform !== "linux") return t.skip("Race-resistant project file access is currently Linux-only.");
  const { root } = fixture(t);
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "before\n");
  let renamed = false;
  const fileOperations = {
    ...workspaceFiles,
    readFileAt(...args) {
      if (renamed) { const error = new Error("private verification detail"); error.code = "EIO"; throw error; }
      return workspaceFiles.readFileAt(...args);
    },
  };
  const { runtime, sessionId } = makeRuntime(root, {
    approvalHandler: async () => "approve-once",
    fileOperations,
    atomicReplace(from, to) { fs.renameSync(from, to); renamed = true; },
  });
  t.after(() => runtime.dispose());
  const proposal = await runtime.invoke(request(root, sessionId, "propose_file_change", { path: "note.txt", content: "after\n" }));
  const result = await runtime.invoke(request(root, sessionId, "apply_file_change", { proposalId: proposal.proposal.proposalId }));
  assert.equal(result.state, "failed");
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.proposalState, "uncertain");
  assert.equal(result.error.code, "WRITE_VERIFICATION_FAILED");
  assert.equal(fs.readFileSync(target, "utf8"), "after\n");
});

test("audit events contain bounded metadata and omit request content and command output", async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "secret.txt"), "api_key=never-audit-this-value\n");
  const externalEvents = [];
  const { runtime, sessionId } = makeRuntime(root, { auditSink: (event) => externalEvents.push(event) });
  t.after(() => runtime.dispose());
  await runtime.invoke(request(root, sessionId, "read_file", { path: "secret.txt" }));
  const serialized = JSON.stringify([...externalEvents, ...runtime.getAuditEvents()]);
  assert.doesNotMatch(serialized, /never-audit-this-value/u);
  assert.doesNotMatch(serialized, /secret\.txt/u);
  assert.ok(externalEvents.every((event) => event.toolId === "read_file" && event.projectId && event.timestamp));
  assert.ok(externalEvents.length <= 50);
});

test("shell execution is disabled by default and approved argv execution is bounded", async (t) => {
  const { root } = fixture(t);
  const { runtime, sessionId } = makeRuntime(root);
  t.after(() => runtime.dispose());
  const requestId = crypto.randomUUID();
  const result = await runtime.invoke(request(root, sessionId, "run_command", { argv: [process.execPath, "-e", "process.stdout.write('ran')"] }, requestId));
  assert.equal(result.state, "rejected");
  assert.equal(result.error.code, "UNSUPPORTED_OPERATION");
});

test("only one tool request can remain active across an approval wait", async (t) => {
  const { root } = fixture(t);
  let releaseApproval;
  const { runtime, sessionId } = makeRuntime(root, {
    commandExecutionEnabled: true,
    approvalHandler: () => new Promise((resolve) => { releaseApproval = resolve; }),
    commandBackend: createMockCommandBackend(),
  });
  t.after(() => runtime.dispose());
  const pending = runtime.invoke(request(root, sessionId, "run_command", { argv: ["fixture-command"] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseApproval, "function");
  const concurrent = await runtime.invoke(request(root, sessionId, "list_files", {}));
  assert.equal(concurrent.state, "rejected");
  assert.equal(concurrent.error.code, "BUSY");
  releaseApproval("cancel");
  const cancelled = await pending;
  assert.equal(cancelled.error.code, "APPROVAL_CANCELLED");
});

test("approved command execution uses argv without a shell, redacts output, and rejects replay", async (t) => {
  const { root } = fixture(t);
  let approvals = 0;
  let shown;
  let runOptions;
  const { runtime, sessionId } = makeRuntime(root, {
    commandExecutionEnabled: true,
    approvalHandler: async (snapshot) => { approvals += 1; shown = snapshot; return "approve-once"; },
    commandBackend: createMockCommandBackend({ stdout: "api_key=never-audit-this-value", onRun: (options) => { runOptions = options; } }),
  });
  t.after(() => runtime.dispose());
  const invoke = request(root, sessionId, "run_command", { argv: ["fixture-command", "safe-arg"] });
  const result = await runtime.invoke(invoke);
  assert.equal(result.state, "executed");
  assert.equal(result.verified, false);
  assert.match(result.result.stdout, /api_key=\[redacted\]/u);
  assert.equal(result.result.isolated, true);
  assert.doesNotMatch(JSON.stringify(runtime.getAuditEvents()), /never-audit-this-value/u);
  assert.equal(shown.operation.shell, false);
  assert.deepEqual(shown.operation.argv, ["fixture-command", "safe-arg"]);
  assert.equal(shown.operation.workspaceAccess, "read-only");
  assert.equal(shown.operation.isolation.network, "disabled");
  assert.match(renderToolApproval({ ...shown, operation: { ...shown.operation, argv: ["command\u202e--unsafe"] } }), /\\u202e/u);
  assert.deepEqual(runOptions.argv, ["fixture-command", "safe-arg"]);
  assert.equal(runOptions.workspaceAccess, "read-only");
  assert.equal(approvals, 1);
  const replay = await runtime.invoke(invoke);
  assert.equal(replay.error.code, "DUPLICATE_REQUEST");
  assert.equal(approvals, 1);
});

test("an approved command with a nonzero exit is reported failed after execution", async (t) => {
  const { root } = fixture(t);
  const { runtime, sessionId } = makeRuntime(root, {
    commandExecutionEnabled: true,
    approvalHandler: async () => "approve-once",
    commandBackend: createMockCommandBackend({ stdout: "diagnostic", exitCode: 7 }),
  });
  t.after(() => runtime.dispose());
  const result = await runtime.invoke(request(root, sessionId, "run_command", { argv: ["fixture-command"] }));
  assert.equal(result.state, "failed");
  assert.equal(result.approved, true);
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.error.code, "COMMAND_FAILED");
  assert.equal(result.result.exitCode, 7);
  assert.ok(runtime.getAuditEvents().some((event) => event.state === "failed" && event.resultStatus === "error"));
});

test("approved command timeout terminates the child and returns no success state", async (t) => {
  const { root } = fixture(t);
  const { runtime, sessionId } = makeRuntime(root, {
    commandExecutionEnabled: true,
    commandTimeoutMs: 25,
    approvalHandler: async () => "approve-once",
    commandBackend: createMockCommandBackend({ runError: "COMMAND_TIMEOUT" }),
  });
  t.after(() => runtime.dispose());
  const invoke = request(root, sessionId, "run_command", { argv: ["fixture-command"] });
  const started = Date.now();
  const result = await runtime.invoke(invoke);
  assert.equal(result.state, "timed-out");
  assert.equal(result.error.code, "COMMAND_TIMEOUT");
  assert.equal(result.executed, true);
  assert.ok(Date.now() - started < 1_500);
});

test("command output limits terminate the child and preserve the failed state", async (t) => {
  const { root } = fixture(t);
  const { runtime, sessionId } = makeRuntime(root, {
    commandExecutionEnabled: true,
    approvalHandler: async () => "approve-once",
    commandBackend: createMockCommandBackend({ runError: "OUTPUT_LIMIT" }),
  });
  t.after(() => runtime.dispose());
  const result = await runtime.invoke(request(root, sessionId, "run_command", { argv: ["fixture-command"] }));
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "OUTPUT_LIMIT");
  assert.equal(result.executed, true);
});

test("the command approval binds the exact isolation policy and refuses policy changes", async (t) => {
  const { root } = fixture(t);
  let runCount = 0;
  let prepareCount = 0;
  const backend = createMockCommandBackend({ onPrepare: () => `policy-${++prepareCount}`, onRun: () => { runCount += 1; } });
  const { runtime, sessionId } = makeRuntime(root, { commandExecutionEnabled: true, commandBackend: backend,
    approvalHandler: async () => "approve-once" });
  t.after(() => runtime.dispose());
  const result = await runtime.invoke(request(root, sessionId, "run_command", { argv: ["fixture-command"] }));
  assert.equal(result.state, "rejected");
  assert.equal(result.error.code, "ISOLATION_POLICY_CHANGED");
  assert.equal(result.executed, false);
  assert.equal(runCount, 0);
});

test("unavailable isolation never reaches approval and never falls back to host execution", async (t) => {
  const { root } = fixture(t);
  let approvalCount = 0;
  let runCount = 0;
  const backend = createMockCommandBackend({ prepareError: "ISOLATION_RUNTIME_MISSING", onRun: () => { runCount += 1; } });
  const { runtime, sessionId } = makeRuntime(root, { commandExecutionEnabled: true, commandBackend: backend,
    approvalHandler: async () => { approvalCount += 1; return "approve-once"; } });
  t.after(() => runtime.dispose());
  const result = await runtime.invoke(request(root, sessionId, "run_command", { argv: ["touch", "should-not-exist"] }));
  assert.equal(result.state, "isolation-unavailable");
  assert.equal(result.error.code, "ISOLATION_RUNTIME_MISSING");
  assert.equal(result.executed, false);
  assert.equal(approvalCount, 0);
  assert.equal(runCount, 0);
  assert.equal(fs.existsSync(path.join(root, "should-not-exist")), false);
});

test("writable workspace access requires a separate host setting and is bound into approval", async (t) => {
  const { root } = fixture(t);
  let approvals = 0;
  const { runtime, sessionId } = makeRuntime(root, { commandExecutionEnabled: true,
    commandBackend: createMockCommandBackend(), approvalHandler: async () => { approvals += 1; return "decline"; } });
  t.after(() => runtime.dispose());
  const blocked = await runtime.invoke(request(root, sessionId, "run_command", { argv: ["make"], workspaceAccess: "read-write" }));
  assert.equal(blocked.state, "rejected");
  assert.equal(blocked.error.code, "UNSUPPORTED_OPERATION");
  assert.equal(approvals, 0);
});

test("an explicitly enabled writable command is reviewed with its exact mount mode", async (t) => {
  const { root } = fixture(t);
  let reviewed;
  let executed;
  const { runtime, sessionId } = makeRuntime(root, { commandExecutionEnabled: true, commandWorkspaceWriteEnabled: true,
    commandBackend: createMockCommandBackend({ onRun: (input) => { executed = input; } }),
    approvalHandler: async (snapshot) => { reviewed = snapshot; return "approve-once"; } });
  t.after(() => runtime.dispose());
  const result = await runtime.invoke(request(root, sessionId, "run_command", { argv: ["make", "test"], workspaceAccess: "read-write" }));
  assert.equal(result.state, "executed");
  assert.equal(reviewed.operation.workspaceAccess, "read-write");
  assert.equal(executed.workspaceAccess, "read-write");
});

test("runtime interruption reaches the sandbox boundary and is reported as interrupted", async (t) => {
  const { root } = fixture(t);
  let executionStarted = false;
  const backend = createMockCommandBackend();
  backend.run = ({ signal }) => new Promise((_resolve, reject) => {
    executionStarted = true;
    signal.addEventListener("abort", () => {
      const error = new Error("cancelled"); error.code = "COMMAND_INTERRUPTED"; error.executed = true; reject(error);
    }, { once: true });
  });
  const { runtime, sessionId } = makeRuntime(root, { commandExecutionEnabled: true, commandBackend: backend,
    approvalHandler: async () => "approve-once" });
  t.after(() => runtime.dispose());
  const pending = runtime.invoke(request(root, sessionId, "run_command", { argv: ["sleep", "100"] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executionStarted, true);
  assert.equal(runtime.interrupt(), true);
  const result = await pending;
  assert.equal(result.state, "interrupted");
  assert.equal(result.error.code, "COMMAND_INTERRUPTED");
  assert.equal(result.executed, true);
});

test("manual CLI list, preview, and explicit proposal/apply use the same runtime", async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "readme.txt"), "hello\n");
  const listed = capture();
  const listStatus = await runVesper(["tools"], { output: listed.stream, errorOutput: capture().stream });
  assert.equal(listStatus, 0);
  assert.match(listed.text, /read_file/u);
  assert.match(listed.text, /disabled/u);

  const preview = capture();
  const previewError = capture();
  const previewStatus = await runVesper(["tools", "preview", "read_file", '{"path":"readme.txt"}', "--project", root], { output: preview.stream, errorOutput: previewError.stream });
  assert.equal(previewStatus, 0);
  assert.match(preview.text, /validated only · not executed/u);
  assert.equal(previewError.text, "");

  const output = capture();
  const errorOutput = capture();
  let approvalCount = 0;
  const status = await runVesper(["tools", "run", "propose_file_change", '{"path":"new.txt","content":"new text\\n"}', "--project", root, "--apply"], {
    output: output.stream,
    errorOutput: errorOutput.stream,
    confirmToolApproval: async (snapshot) => { approvalCount += 1; assert.equal(snapshot.toolId, "apply_file_change"); return "approve-once"; },
  });
  assert.equal(status, 0);
  assert.equal(approvalCount, 1);
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "new text\n");
  assert.match(output.text, /proposed/u);
  assert.match(output.text, /verified/u);
  assert.match(output.text, /Operation state: awaiting approval/u);
  assert.equal(errorOutput.text, "");
});

test("CLI parser requires a registered-tool-shaped JSON argument and rejects unrelated apply flags", () => {
  assert.deepEqual(parseArgs(["tools", "preview", "read_file", '{"path":"a"}']), {
    command: "tools", action: "preview", toolId: "read_file", input: { path: "a" }, projectDirectory: null, apply: false, help: false,
  });
  assert.throws(() => parseArgs(["tools", "run", "read_file", "not-json"]), /valid JSON/u);
  assert.throws(() => parseArgs(["tools", "run", "read_file", '{"path":"a"}', "--apply"]), /only follow a propose_file_change/u);
  assert.deepEqual(parseArgs(["tools", "status"]), { command: "tools", action: "status", help: false });
});

test("tools status is an explicit read-only diagnostic and tools list does not probe Podman", async (t) => {
  const { root } = fixture(t);
  let inspections = 0;
  const backend = createMockCommandBackend({ onInspect: () => { inspections += 1; } });
  const listed = capture();
  assert.equal(await runVesper(["tools", "list"], { commandBackend: backend, output: listed.stream, errorOutput: capture().stream }), 0);
  assert.equal(inspections, 0);
  const status = capture();
  const exitCode = await runVesper(["tools", "status"], { commandBackend: backend, output: status.stream, errorOutput: capture().stream });
  assert.equal(exitCode, 0);
  assert.equal(inspections, 1);
  assert.match(status.text, /Rootless runtime: yes/u);
  assert.match(status.text, /does not start a container/u);
  assert.doesNotMatch(status.text, /test-secret-must-not-pass/u);
});

test("OpenAI provider remains text-only and Codex-native approval implementation stays separate", () => {
  assert.equal(OPENAI_CAPABILITIES.approvalEvents, false);
  assert.equal(OPENAI_CAPABILITIES.fileChanges, false);
  assert.equal(OPENAI_CAPABILITIES.commandExecutionEvents, false);
  const approvalSource = fs.readFileSync(path.join(__dirname, "..", "file-change-approval.js"), "utf8");
  assert.match(approvalSource, /createFileChangeSnapshot/u);
  assert.match(approvalSource, /invalidated/u);
});

function createMockCommandBackend({ stdout = "", stderr = "", exitCode = 0, onRun = () => {}, onPrepare = null,
  onInspect = () => {}, prepareError = null, runError = null } = {}) {
  let preparations = 0;
  const imageId = `sha256:${"a".repeat(64)}`;
  return {
    inspect: async () => { onInspect(); return { backend: "podman-rootless", platform: "linux", installed: true, rootless: true,
      configured: true, imagePresent: true, imageId, available: true, enabled: true, restrictions: {}, unsupported: [],
      policy: { version: "test", seccompEnabled: true, cgroupVersion: "v2", controllers: ["cpu", "memory", "pids"] } }; },
    prepare: async (input) => {
      preparations += 1;
      if (prepareError) { const error = new Error(prepareError); error.code = prepareError; error.rejected = true; throw error; }
      const binding = onPrepare ? onPrepare(input, preparations) : crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
      return Object.freeze({ binding, argv: input.argv, workspaceRoot: input.workspaceRoot, workspaceAccess: input.workspaceAccess,
        imageId, display: { backend: "Rootless Podman", imageId, network: "disabled", readOnlyRootFilesystem: true,
          seccomp: "enabled", noNewPrivileges: true, capabilities: "all dropped", cpuCount: 1, memoryMiB: 512,
          privateNamespaces: "PID, IPC, UTS, cgroup", hostSockets: "not mounted", hostProc: "not mounted",
          processLimit: 64, timeoutMs: input.timeoutMs, outputLimitBytesPerStream: 16_384 } });
    },
    run: async (input) => {
      onRun(input);
      if (runError) { const error = new Error(runError); error.code = runError; error.executed = true; throw error; }
      return Object.freeze({ argv: input.argv, exitCode, signal: null, stdout, stderr, truncated: false, isolated: true,
        backend: "podman-rootless", imageId, workspaceAccess: input.workspaceAccess, containerConfigurationVerified: true });
    },
    dispose: async () => {},
  };
}
