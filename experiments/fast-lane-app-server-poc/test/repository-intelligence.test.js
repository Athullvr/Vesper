"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPermissionedToolRuntime } = require("../permissioned-tool-runtime");
const { createRepositoryIntelligence, MAX_CONTEXT_LENGTH, parseManifest, renderRepositoryContext } = require("../repository-intelligence");
const { createSystemModel, interpretTask, renderSystemModelReport } = require("../system-model");
const { createTaskEvidence, mergeRepositoryEvidence } = require("../task-evidence");
const { parseArgs, runVesper } = require("../cli");

function project(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-repo-intel-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

function mockGit(root) {
  return async (_executable, args, options) => {
    if (args.includes("rev-parse")) return { stdout: Buffer.from(`${root}\n`) };
    if (args.includes("check-ignore")) {
      const ignored = args.filter((arg) => arg.startsWith(":(literal)")).map((arg) => arg.slice(10))
        .filter((item) => item === "generated-files" || item.startsWith("generated-files/") || item.startsWith(".env"));
      return { stdout: ignored.length ? Buffer.from(`${ignored.join("\0")}\0`) : Buffer.alloc(0) };
    }
    if (args.includes("status")) return { stdout: Buffer.from("## feature/checkout\n M src/checkout.js\n") };
    if (args.includes("log")) return { stdout: Buffer.from("abcde 2026-10-01 add checkout flow\n") };
    if (args.includes("diff")) return { stdout: Buffer.from("diff --git a/src/checkout.js b/src/checkout.js\nindex 0000000..1111111 100644\n--- a/src/checkout.js\n+++ b/src/checkout.js\n@@ -1 +1,2 @@\n function handleCheckout() {\n+ return checkoutService();\n") };
    throw new Error(`Unexpected Git fixture request: ${options?.cwd || "unknown"}`);
  };
}

function addProjectFiles(root) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated-files"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "sample"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "generated-files/\n.env*\n");
  fs.writeFileSync(path.join(root, ".env.local"), "OPENAI_API_KEY=sk-test-value\n");
  fs.writeFileSync(path.join(root, "generated-files", "ignored.js"), "function ignored() {}\n");
  fs.writeFileSync(path.join(root, "node_modules", "sample", "index.js"), "function vendorCode() {}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "checkout-app",
    main: "src/main.js",
    scripts: { start: "node src/main.js", test: "node --test", build: "node build.js" },
    dependencies: { express: "^5.0.0", "safe-package": "1.2.3" },
  }, null, 2));
  fs.writeFileSync(path.join(root, "src", "main.js"), 'const checkout = require("./checkout");\nmodule.exports = checkout;\n');
  fs.writeFileSync(path.join(root, "src", "checkout.js"), 'const service = require("./checkout-service");\nfunction handleCheckout(request) { return service(request); }\nmodule.exports = handleCheckout;\n');
  fs.writeFileSync(path.join(root, "src", "checkout-service.js"), "module.exports = function checkoutService() { return true; };\n");
  fs.writeFileSync(path.join(root, "src", "checkout.test.js"), "test(\"checkout\", () => {});\n");
  fs.mkdirSync(path.join(root, ".git", "objects", "info"), { recursive: true });
}

test("repository intelligence returns bounded manifest, framework, entry, Git, symbol, and import evidence", async (t) => {
  const { parent, root } = project(t);
  addProjectFiles(root);
  const outside = path.join(parent, "outside.js");
  fs.writeFileSync(outside, "function outsideSecret() {}\n");
  fs.symlinkSync(outside, path.join(root, "src", "outside-link.js"));
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId, execFileImpl: mockGit(root) });
  t.after(() => runtime.dispose());
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId, providerId: "codex-app-server", now: () => new Date("2026-10-23T00:00:00Z") });

  const result = await service.inspect({ task: "Trace handleCheckout through checkout-service", intent: "trace", includeHistory: true, includeDiff: true });
  assert.equal(result.status, "complete");
  assert.ok(result.project.fileCount >= 5);
  assert.ok(result.project.languages.some((item) => item.name === "JavaScript"));
  assert.ok(result.project.frameworks.some((item) => item.name === "Express"));
  assert.ok(result.project.entryPoints.some((item) => item.path === "src/main.js" && item.confidence === "high"));
  assert.ok(result.project.commands.some((item) => item.name === "test" && item.command === "node --test" && item.autoRun === false));
  assert.ok(result.findings.some((item) => item.type === "symbol" && item.path === "src/checkout.js" && item.lineStart === 2 && item.symbol === "handleCheckout"));
  assert.ok(result.findings.some((item) => item.type === "execution-path" && item.path === "src/checkout.js" && item.observation === "inferred"));
  assert.ok(result.findings.some((item) => item.type === "git-history" && item.commit === "abcde"));
  assert.ok(result.findings.some((item) => item.type === "git-diff-hunk" && item.path === "src/checkout.js"));
  assert.ok(result.findings.every((item) => item.observedAt === "2026-10-23T00:00:00.000Z"));
  assert.ok(result.project.structure.every((item) => !item.includes(".env") && !item.includes("generated-files") && !item.includes("node_modules") && !item.includes("outside-link")));
  assert.ok(result.evidence.inspections.some((item) => item.kind === "read_file" && item.path === "src/checkout.js"));
  assert.ok(result.evidence.inspections.some((item) => item.kind === "git_check_ignore" && item.state === "verified"));
  assert.ok(result.findings.some((item) => item.type === "execution-path" && item.description.includes("resolves to src/checkout-service.js")));
  assert.ok(!JSON.stringify(result).includes("sk-test-value"));
  assert.ok(!JSON.stringify(result).includes("outsideSecret"));
  assert.ok(result.git.status.includes("feature/checkout"));
  assert.ok(result.git.history.includes("add checkout flow"));
});

test("non-Git inspection honors bounded .gitignore rules and reports missing Git evidence", async (t) => {
  const { parent, root } = project(t);
  fs.mkdirSync(path.join(root, "generated-files"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "generated-files/\n!generated-files/keep.js\n");
  fs.writeFileSync(path.join(root, "generated-files", "ignored.js"), "function hidden() {}\n");
  fs.writeFileSync(path.join(root, "src", "main.py"), "def start_app():\n    return True\n");
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"sample\"\ndependencies = [\"fastapi>=0.100\"]\n[tool.pytest.ini_options]\n");
  const outside = path.join(parent, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(root, "escape.txt"));
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });

  const result = await service.inspect({ task: "Explain the FastAPI startup path", intent: "overview", includeHistory: false });
  assert.equal(result.status, "partial");
  assert.ok(result.project.structure.includes("src/main.py"));
  assert.ok(!result.project.structure.some((item) => item.includes("generated-files") || item.includes("escape.txt")));
  assert.ok(result.project.frameworks.some((item) => item.name === "FastAPI"));
  assert.ok(result.findings.some((item) => item.type === "entry-point" && item.observation === "inferred"));
  assert.match(result.incomplete.join(" "), /Git status is unavailable/u);
  assert.ok(!JSON.stringify(result).includes("outside\n"));
});

test("malformed manifests, inventory limits, and report/context sizes remain explicit and bounded", async (t) => {
  assert.equal(parseManifest("package.json", "null").valid, false);
  assert.equal(parseManifest("package.json", "{").valid, false);
  const deno = parseManifest("deno.jsonc", `// project config\n{\n  "main": "src/main.ts",\n  "tasks": { "test": "deno test", },\n  "imports": { "@std/assert": "jsr:@std/assert@1", },\n}`);
  assert.equal(deno.valid, true);
  assert.equal(deno.ecosystem, "Deno");
  assert.equal(deno.data.entry, "src/main.ts");
  assert.equal(deno.scripts[0].command, "deno test");
  assert.equal(deno.dependencies[0].name, "@std/assert");
  assert.equal(parseManifest("deno.jsonc", "{/* not closed").valid, false);
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "wide"));
  fs.writeFileSync(path.join(root, "package.json"), "null");
  for (let index = 0; index < 105; index += 1) fs.writeFileSync(path.join(root, "wide", `file-${index}.txt`), "x");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });
  const result = await service.inspect({ includeHistory: false });
  assert.notEqual(result.status, "complete");
  assert.ok(result.incomplete.some((item) => /truncated/u.test(item)));
  assert.ok(result.project.structure.length <= 48);
  assert.ok(result.findings.length <= 32);
  assert.ok(renderRepositoryContext(result).length <= MAX_CONTEXT_LENGTH);
  assert.ok(result.incomplete.some((item) => /malformed|partially supported/u.test(item)));
});

test("repository reports escape terminal control sequences in repository-controlled paths", () => {
  const report = renderSystemModelReport({
    intent: "overview",
    status: "partial",
    project: { fileCount: 1, directoryCount: 1, structure: ["src/\u001b[31mname.js"], truncated: false },
    git: { available: false, coverage: "Git metadata unavailable." },
    findings: [],
    plan: [],
    assumptions: [],
    verificationRequirements: [],
  });
  assert.doesNotMatch(report, /\u001b/u);
  assert.match(report, /\\x1b\[31mname\.js/u);
});

test("repository evidence follows the active provider conversation without crossing sessions", async (t) => {
  const { root } = project(t);
  const sessionId = crypto.randomUUID();
  let conversationId = "conversation-one";
  const runtime = {
    sessionId,
    async preview() { return { state: "unavailable", executes: false }; },
    async invoke() { throw new Error("An unavailable preview must not invoke a tool."); },
    async interrupt() { return false; },
  };
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId,
    conversationId: null, getConversationId: () => conversationId });
  const first = await service.inspect({ includeHistory: false });
  assert.equal(first.evidence.context.sessionId, sessionId);
  assert.equal(first.evidence.context.conversationId, "conversation-one");
  conversationId = "conversation-two";
  const second = await service.inspect({ includeHistory: false });
  assert.equal(second.evidence.context.conversationId, "conversation-two");
  assert.equal(second.evidence.context.sessionId, sessionId);
});

test("System Model intent and coordination remain deterministic and do not call a provider", async () => {
  const requests = [];
  const findings = [{ type: "symbol", description: "Observed handler.", path: "src/handler.js", lineStart: 3, source: "read_file", confidence: "high", observation: "observed", status: "confirmed" }];
  const coordinator = createSystemModel({ repositoryIntelligence: {
    async inspect(request) {
      requests.push(request);
      return { status: "partial", project: { fileCount: 1, directoryCount: 1, languages: [], frameworks: [], dependencies: [], manifests: [], entryPoints: [], commands: [], structure: ["src/handler.js"] },
        git: { available: false, status: "", history: "", diff: "" }, findings, incomplete: ["coverage bound"], evidence: createTaskEvidence({ sessionId: "session-a", projectRoot: "/project" }) };
    },
    async interrupt() { return true; },
  } });
  assert.equal(interpretTask("Trace how handler dispatch works"), "trace");
  const result = await coordinator.investigate({
    task: "Trace how handler dispatch works",
    routeDecision: { route: "codex", intent: "general", reason: "codex_fallback" },
  });
  assert.equal(result.intent, "trace");
  assert.deepEqual(result.routeDecision, { route: "codex", intent: "general", reason: "codex_fallback" });
  assert.equal(result.coordination.additionalInspectionRecommended, true);
  assert.equal(result.coordination.providerReasoningRecommended, true);
  assert.deepEqual(result.inspectedPaths, ["src/handler.js"]);
  assert.ok(result.plan.some((item) => item.includes("src/handler.js")));
  assert.ok(result.assumptions.some((item) => /heuristic/u.test(item)));
  assert.ok(result.assumptions.some((item) => /Git/u.test(item)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].includeDiff, false);
  assert.ok(result.providerContext.includes("untrusted project data"));

  const target = createTaskEvidence({ sessionId: "session-a", conversationId: "conversation-a", projectRoot: "/project" });
  const otherSession = createTaskEvidence({ sessionId: "session-b", projectRoot: "/project" });
  const otherConversation = createTaskEvidence({ sessionId: "session-a", conversationId: "conversation-b", projectRoot: "/project" });
  assert.equal(mergeRepositoryEvidence(target, result.evidence), true);
  assert.equal(mergeRepositoryEvidence(target, otherSession), false);
  assert.equal(mergeRepositoryEvidence(target, otherConversation), false);
});

test("CLI inspection is explicit, local-only, and does not instantiate an execution provider", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.js"), "function start() {}\n");
  const parsed = parseArgs(["inspect", "Trace the start function", "--project", root]);
  assert.equal(parsed.command, "inspect");
  assert.equal(parsed.task, "Trace the start function");
  assert.equal(parsed.projectDirectory, root);
  const output = { value: "", write(text) { this.value += String(text); } };
  const errorOutput = { value: "", write(text) { this.value += String(text); } };
  let providerCreated = false;
  const code = await runVesper(["inspect", "Trace the start function", "--project", root], {
    output,
    errorOutput,
    executionProviderFactory() { providerCreated = true; throw new Error("inspection must not create a provider"); },
  });
  assert.equal(code, 0);
  assert.equal(providerCreated, false);
  assert.equal(errorOutput.value, "");
  assert.match(output.value, /Vesper repository investigation · deterministic and read-only/u);
  assert.match(output.value, /src\/main.js/u);
  assert.match(output.value, /not executed/u);
  assert.doesNotMatch(output.value, /Existing route:/u);
});
