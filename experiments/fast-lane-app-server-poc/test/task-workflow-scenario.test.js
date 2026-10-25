"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createExecutionProvider } = require("../execution-provider");
const { TerminalFrontend } = require("../terminal-frontend");

const API_KEY = "local-workflow-fixture-key";
const SESSION_ID = "f80cc030-9d8a-4ac6-b71a-9852837d4269";
const IMPLEMENTATION_PATH = "packages/pricing/src/price.js";
const PRICING_TEST_PATH = "packages/pricing/test/price.test.js";
const CHECKOUT_TEST_PATH = "packages/checkout/test/checkout.test.js";

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-multipackage-workflow-"));
  fs.mkdirSync(path.join(root, "packages", "pricing", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "pricing", "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "checkout", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "checkout", "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "vesper-workflow-fixture", private: true, workspaces: ["packages/*"], scripts: { test: "node --test" },
  }, null, 2));
  fs.writeFileSync(path.join(root, "packages", "pricing", "package.json"), JSON.stringify({ name: "@fixture/pricing", scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(root, "packages", "checkout", "package.json"), JSON.stringify({ name: "@fixture/checkout", scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(root, IMPLEMENTATION_PATH), [
    "function calculateTotal(subtotal, taxRate) {",
    "  return subtotal + subtotal * taxRate;",
    "}",
    "module.exports = { calculateTotal };",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, PRICING_TEST_PATH), [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const { calculateTotal } = require("../src/price");',
    'test("calculates subtotal with tax", () => { assert.equal(calculateTotal(1.11, 0.08), 1.1988); });',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "packages", "checkout", "src", "checkout.js"), [
    'const { calculateTotal } = require("../../pricing/src/price");',
    "function checkout(subtotal, taxRate) { return { total: calculateTotal(subtotal, taxRate) }; }",
    "module.exports = { checkout };",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, CHECKOUT_TEST_PATH), [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const { checkout } = require("../src/checkout");',
    'test("checkout returns the taxed total", () => { assert.deepEqual(checkout(1.11, 0.08), { total: 1.1988 }); });',
    "",
  ].join("\n"));

  fs.mkdirSync(path.join(root, ".git", "objects", "info"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n repositoryformatversion = 0\n filemode = true\n bare = false\n");
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "index"), "");
  const baseline = new Map([IMPLEMENTATION_PATH, PRICING_TEST_PATH, CHECKOUT_TEST_PATH].map((relativePath) =>
    [relativePath, fs.readFileSync(path.join(root, relativePath), "utf8")]));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, baseline };
}

function mockGit(root, baseline) {
  return async (_executable, args) => {
    if (args.includes("rev-parse")) return { stdout: Buffer.from(`${root}\n`) };
    if (args.includes("check-ignore")) return { stdout: Buffer.alloc(0) };
    if (args.includes("status")) return { stdout: Buffer.from("## main\n") };
    if (args.includes("log")) return { stdout: Buffer.from("fixture 2026-10-25 initial multi-package fixture\n") };
    if (args.includes("diff")) {
      const pathspec = args.find((argument) => argument.startsWith(":(literal)"));
      const paths = pathspec ? [pathspec.slice(10)] : [...baseline.keys()];
      const diff = paths.map((relativePath) => {
        const original = baseline.get(relativePath);
        const currentPath = path.join(root, relativePath);
        if (typeof original !== "string" || !fs.existsSync(currentPath)) return "";
        const current = fs.readFileSync(currentPath, "utf8");
        if (original === current) return "";
        return [
          `diff --git a/${relativePath} b/${relativePath}`,
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@",
          ...original.trimEnd().split("\n").map((line) => `-${line}`),
          ...current.trimEnd().split("\n").map((line) => `+${line}`),
          "",
        ].join("\n");
      }).join("\n");
      return { stdout: Buffer.from(diff) };
    }
    throw new Error(`Unexpected mocked Git inspection: ${args.join(" ")}`);
  };
}

function sseResponse(payload) {
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function toolCall(index, id, name, args) {
  return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolRound(calls, content = "") {
  return sseResponse({ choices: [{ delta: { ...(content ? { content } : {}), tool_calls: calls }, finish_reason: "tool_calls" }] });
}

function finalAnswer(content) {
  return sseResponse({ choices: [{ delta: { content }, finish_reason: "stop" }] });
}

function verifiedMockCommandBackend(runOptions) {
  const imageId = `sha256:${"b".repeat(64)}`;
  return {
    async inspect() {
      return { backend: "podman-rootless", platform: "linux", installed: true, rootless: true, configured: true,
        imagePresent: true, imageId, available: true, enabled: true, restrictions: {}, unsupported: [], policy: { version: "fixture" } };
    },
    async prepare(input) {
      return Object.freeze({ binding: crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"), argv: input.argv,
        workspaceRoot: input.workspaceRoot, workspaceAccess: input.workspaceAccess, imageId,
        display: { backend: "mocked validated isolated runtime", network: "disabled", readOnlyRootFilesystem: true,
          workspaceAccess: input.workspaceAccess, timeoutMs: input.timeoutMs } });
    },
    async run(input) {
      runOptions.push(input);
      return Object.freeze({ argv: input.argv, exitCode: 0, signal: null, stdout: "fixture runner: passed", stderr: "", truncated: false,
        isolated: true, backend: "mocked validated isolated runtime", imageId, workspaceAccess: input.workspaceAccess,
        containerConfigurationVerified: true });
    },
    async dispose() {},
  };
}

test("multi-package task runs through preflight, impact, approved edits, diff review, and permissioned verification", async (t) => {
  const { root, baseline } = project(t);
  const requests = [];
  const baseUrl = "https://api.fixture.test/v1";
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/chat\/completions$/u);
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      assert.equal(body.tools.some((tool) => tool.function.name === "run_command"), false, "model command tools stay unavailable");
      return toolRound([
        toolCall(0, "read_pricing", "read_file", { path: IMPLEMENTATION_PATH }),
        toolCall(1, "read_pricing_test", "read_file", { path: PRICING_TEST_PATH }),
        toolCall(2, "read_checkout_test", "read_file", { path: CHECKOUT_TEST_PATH }),
      ]);
    }
    if (requests.length === 2) {
      const readPaths = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content).result?.path);
      assert.deepEqual(readPaths, [IMPLEMENTATION_PATH, PRICING_TEST_PATH, CHECKOUT_TEST_PATH]);
      return toolRound([
        toolCall(0, "propose_pricing", "propose_file_change", { path: IMPLEMENTATION_PATH,
          content: "function calculateTotal(subtotal, taxRate) {\n  return Math.round((subtotal + subtotal * taxRate) * 100) / 100;\n}\nmodule.exports = { calculateTotal };\n" }),
        toolCall(1, "propose_pricing_test", "propose_file_change", { path: PRICING_TEST_PATH,
          content: 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { calculateTotal } = require("../src/price");\ntest("calculates subtotal with tax rounded to cents", () => { assert.equal(calculateTotal(1.11, 0.08), 1.2); });\n' }),
        toolCall(2, "propose_checkout_test", "propose_file_change", { path: CHECKOUT_TEST_PATH,
          content: 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { checkout } = require("../src/checkout");\ntest("checkout returns a taxed total rounded to cents", () => { assert.deepEqual(checkout(1.11, 0.08), { total: 1.2 }); });\n' }),
      ], `Plan: round the total in \`${IMPLEMENTATION_PATH}\` and update the two related package tests after tracing the checkout import.`);
    }
    if (requests.length === 3) {
      const proposals = ["propose_pricing", "propose_pricing_test", "propose_checkout_test"].map((id) => {
        const message = body.messages.find((item) => item.role === "tool" && item.tool_call_id === id);
        const proposal = JSON.parse(message.content).proposal;
        assert.equal(JSON.parse(message.content).state, "proposed");
        return proposal.proposalId;
      });
      return toolRound(proposals.map((proposalId, index) => toolCall(index, `apply_${index}`, "apply_file_change", { proposalId })));
    }
    if (requests.length === 4) {
      const applyResults = body.messages.filter((message) => message.role === "tool" && message.tool_call_id.startsWith("apply_"));
      assert.equal(applyResults.length, 3);
      for (const message of applyResults) assert.equal(JSON.parse(message.content).state, "verified");
      return finalAnswer("Rounded totals are implemented; Vesper applied and read-back verified three approved files.");
    }
    throw new Error(`Unexpected deterministic provider request ${requests.length}`);
  };

  const previousLocalOnly = process.env.VESPER_LOCAL_ONLY;
  process.env.VESPER_LOCAL_ONLY = "1";
  t.after(() => {
    if (previousLocalOnly === undefined) delete process.env.VESPER_LOCAL_ONLY;
    else process.env.VESPER_LOCAL_ONLY = previousLocalOnly;
  });
  const provider = createExecutionProvider({
    providerId: "openai-chat-completions",
    environment: {
      VESPER_OPENAI_API_KEY: API_KEY,
      VESPER_OPENAI_MODEL: "fixture-model",
      VESPER_OPENAI_BASE_URL: baseUrl,
      VESPER_OPENAI_TIMEOUT_MS: "4000",
      VESPER_OPENAI_TOOL_CALLING_MODEL: "fixture-model",
      VESPER_OPENAI_MAX_TOOL_CALLS: "16",
      VESPER_OPENAI_MAX_AGENT_ELAPSED_MS: "4000",
    },
    conversationDirectory: path.join(root, ".provider-conversations"),
    fetchImpl,
  });
  const approvals = [];
  const output = { isTTY: true, text: "", write(value) { this.text += String(value); } };
  const lineIO = {
    async question(prompt) { approvals.push(prompt.trim()); return "yes"; },
    onInterrupt() {},
    cancelPending() {},
    close() {},
  };
  const commandRuns = [];
  const terminal = new TerminalFrontend({ cwd: root, handlers: {}, executionProvider: provider, sessionId: SESSION_ID,
    input: { isTTY: true }, output, lineIO, commandExecutionEnabled: true, commandBackend: verifiedMockCommandBackend(commandRuns),
    toolExecFileImpl: mockGit(root, baseline) });
  try {
    const trace = await terminal.systemModel.investigate({ task: "Trace calculateTotal from pricing through checkout", intent: "trace" });
    assert.ok(trace.findings.some((item) => item.type === "symbol-definition" && item.path === IMPLEMENTATION_PATH));
    assert.ok(trace.dependencyTrace.some((item) => item.from === "packages/checkout/src/checkout.js" && item.to === IMPLEMENTATION_PATH));
    const impact = await terminal.systemModel.investigate({ task: "Assess the impact of changing calculateTotal", intent: "impact" });
    assert.ok(impact.impactReport.tests.some((item) => item.path === PRICING_TEST_PATH || item.path === CHECKOUT_TEST_PATH));
    assert.ok(impact.impactReport.dependencies.some((item) => item.path === "packages/checkout/src/checkout.js"));

    await terminal.handlePrompt("Implement cent rounding for the pricing total and update related tests.");
    const changedFiles = [IMPLEMENTATION_PATH, PRICING_TEST_PATH, CHECKOUT_TEST_PATH];
    assert.equal(requests.length, 4, output.text);
    assert.equal(approvals.length, 3);
    assert.equal(terminal.lastTaskLifecycle.snapshot().status, "completed", JSON.stringify(terminal.lastTaskLifecycle.snapshot()));
    assert.deepEqual([...terminal.lastTaskLifecycle.snapshot().verifiedFiles].sort(), changedFiles.sort());
    assert.equal(terminal.lastTaskLifecycle.snapshot().verification.state, "not-run");
    assert.equal(terminal.toolRuntime.sessionId, SESSION_ID);
    assert.ok(terminal.lastTaskLifecycle.snapshot().diff, JSON.stringify(terminal.toolRuntime.getAuditEvents().filter((event) => event.toolId === "git_diff")));
    assert.match(terminal.lastTaskLifecycle.snapshot().diff.diff, /Math\.round/u);
    assert.match(terminal.lastTaskLifecycle.snapshot().diff.diff, /rounded to cents/u);
    assert.match(output.text, /Vesper-managed file writes verified by read-back/u);
    assert.match(output.text, /Observed diff:[\s\S]*Math\.round/u);
    assert.equal(fs.readFileSync(path.join(root, IMPLEMENTATION_PATH), "utf8").includes("Math.round"), true);
    assert.equal(fs.readFileSync(path.join(root, CHECKOUT_TEST_PATH), "utf8").includes("1.2"), true);

    await terminal.handlePrompt(":verify 1");
    assert.equal(commandRuns.length, 1);
    assert.deepEqual(commandRuns[0].argv, ["node", "--test"]);
    assert.equal(commandRuns[0].workspaceAccess, "read-only");
    assert.equal(approvals[3], "Run verification once?");
    assert.equal(terminal.lastTaskLifecycle.snapshot().verification.state, "passed");
    assert.equal(terminal.lastTaskLifecycle.snapshot().status, "completed");
    assert.match(output.text, /Verification: passed · node --test/u);
    assert.match(output.text, /Suggested verification, not run/u);
  } finally {
    await terminal.toolRuntime.dispose();
    provider.dispose();
  }
});
