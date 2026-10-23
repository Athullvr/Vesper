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
const { createTaskEvidence, mergeRepositoryEvidence, renderTaskEvidenceReport } = require("../task-evidence");
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
  assert.ok(result.findings.some((item) => item.type === "import-edge" && item.path === "src/checkout.js" && item.relatedPath === "src/checkout-service.js" && item.lineStart === 1 && item.observation === "inferred"));
  assert.ok(result.findings.some((item) => item.type === "git-history" && item.commit === "abcde"));
  assert.ok(result.findings.some((item) => item.type === "git-diff-hunk" && item.path === "src/checkout.js"));
  assert.ok(result.findings.every((item) => item.observedAt === "2026-10-23T00:00:00.000Z"));
  assert.ok(result.project.structure.every((item) => !item.includes(".env") && !item.includes("generated-files") && !item.includes("node_modules") && !item.includes("outside-link")));
  assert.ok(result.evidence.inspections.some((item) => item.kind === "read_file" && item.path === "src/checkout.js"));
  assert.ok(result.evidence.inspections.some((item) => item.kind === "git_check_ignore" && item.state === "verified"));
  assert.ok(result.findings.some((item) => item.type === "import-edge" && item.description.includes("resolves to src/checkout-service.js")));
  assert.ok(result.evidence.investigation.steps.some((step) => step.operation.toolId === "read_file" && step.operation.input.path === "src/checkout.js" && step.result.evidenceRefs.some((ref) => ref.path === "src/checkout.js" && ref.lineStart === 1)));
  assert.ok(!JSON.stringify(result).includes("sk-test-value"));
  assert.ok(!JSON.stringify(result).includes("outsideSecret"));
  assert.ok(result.git.status.includes("feature/checkout"));
  assert.ok(result.git.history.includes("add checkout flow"));
});

test("impact investigation searches the vetted inventory, reads cross-file candidates, and reports honest relationships", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated-files"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "generated-files/\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src", "main.js"), "export function start() { return true; }\n");
  for (let index = 0; index < 7; index += 1) fs.writeFileSync(path.join(root, "src", `filler-${index}.js`), `export const value${index} = ${index};\n`);
  fs.writeFileSync(path.join(root, "src", "z-handler.js"), "export function handleCheckout(request) { return request; }\n");
  fs.writeFileSync(path.join(root, "src", "z-caller.js"), 'import { handleCheckout } from "./z-handler.js";\nexport function submit(request) { return handleCheckout(request); }\n');
  fs.writeFileSync(path.join(root, "src", "z-route.js"), 'router.post("/checkout", handleCheckout);\n');
  fs.writeFileSync(path.join(root, "src", "z.test.js"), 'test("handleCheckout", () => handleCheckout({}));\n');
  fs.writeFileSync(path.join(root, "generated-files", "ignored.js"), "handleCheckout();\n");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId, execFileImpl: mockGit(root) });
  t.after(() => runtime.dispose());
  const systemModel = createSystemModel({ repositoryIntelligence: createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId }) });

  const result = await systemModel.investigate({ task: "Assess impact of changing handleCheckout", intent: "impact" });
  assert.equal(result.intent, "impact");
  assert.ok(result.candidateDiscovery.searchedFiles >= 10);
  assert.ok(result.candidateDiscovery.matches >= 3);
  assert.ok(result.findings.some((item) => item.type === "search-match" && item.path === "src/z-caller.js" && item.lineStart === 2 && item.sourceContextRead !== true));
  assert.ok(!result.findings.some((item) => item.path === "generated-files/ignored.js"));
  assert.ok(result.findings.some((item) => item.type === "symbol-definition" && item.path === "src/z-handler.js" && item.symbol === "handleCheckout"));
  assert.ok(result.findings.some((item) => item.type === "likely-call-site" && item.path === "src/z-caller.js" && item.sourceContextRead === true));
  assert.ok(result.findings.some((item) => item.type === "route-handler" && item.path === "src/z-route.js"));
  assert.ok(result.findings.some((item) => item.type === "test-reference" && item.path === "src/z.test.js"));
  assert.ok(result.impactReport.callSites.some((item) => item.path === "src/z-caller.js"));
  assert.ok(result.impactReport.tests.some((item) => item.path === "src/z.test.js"));
  assert.match(result.providerContext, /Change-impact summary/u);
  assert.match(result.providerContext, /Suggested verification, not run/u);
  assert.ok(result.evidence.investigation.impactReport);
  const report = renderSystemModelReport(result);
  assert.match(report, /Cross-file candidate discovery/u);
  assert.match(report, /Change impact summary/u);
  assert.match(report, /not a complete call graph/u);
});

test("candidate discovery exposes inventory-bound exhaustion instead of claiming full-project coverage", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src", "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "b"), { recursive: true });
  for (let index = 0; index < 65; index += 1) {
    fs.writeFileSync(path.join(root, "src", "a", `module-${String(index).padStart(2, "0")}.js`), `export const valueA${index} = ${index};\n`);
    fs.writeFileSync(path.join(root, "src", "b", `module-${String(index).padStart(2, "0")}.js`), `export const valueB${index} = ${index};\n`);
  }
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId, execFileImpl: mockGit(root) });
  t.after(() => runtime.dispose());
  const result = await createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId })
    .inspect({ task: "Impact of changing targetSymbol", intent: "impact", includeHistory: false, includeDiff: false });

  assert.equal(result.candidateDiscovery.candidateFiles, 130);
  assert.equal(result.candidateDiscovery.searchedFiles, 128);
  assert.equal(result.candidateDiscovery.status, "partial");
  assert.equal(result.candidateDiscovery.partialReason, "candidate-file-bound");
  assert.ok(result.incomplete.some((item) => item.includes("Cross-file candidate discovery is partial")));
  assert.ok(result.evidence.investigation.steps.some((step) => step.operation.toolId === "search_files" && step.operation.input.candidatePathCount === 128));
});

test("System Model follows local imports progressively and records ordered evidence with exact source lines", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "src/main.js" }));
  fs.writeFileSync(path.join(root, "src", "main.js"), 'const routes = require("./checkout-controller");\nmodule.exports = routes;\n');
  fs.writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "export const b = 1;\n");
  fs.writeFileSync(path.join(root, "src", "c.js"), "export const c = 1;\n");
  fs.writeFileSync(path.join(root, "src", "checkout-controller.js"), 'const service = require("./checkout-service");\nfunction handleCheckout(request) { return service(request); }\n');
  fs.writeFileSync(path.join(root, "src", "checkout-service.js"), 'const repository = require("./checkout-repository");\nfunction checkoutService(request) { return repository(request); }\n');
  fs.writeFileSync(path.join(root, "src", "checkout-repository.js"), "function checkoutRepository() { return true; }\n");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const repositoryIntelligence = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });
  const systemModel = createSystemModel({ repositoryIntelligence });

  const result = await systemModel.investigate({ task: "Trace handleCheckout request flow", intent: "trace" });
  const targeted = result.steps.filter((step) => step.operation.toolId === "read_file" && step.operation.input.path.startsWith("src/checkout-"));
  assert.deepEqual(targeted.map((step) => step.operation.input.path), ["src/checkout-controller.js", "src/checkout-service.js", "src/checkout-repository.js"]);
  assert.ok(result.referenceIndex.status === "partial" || result.referenceIndex.status === "complete");
  assert.ok(result.findings.some((item) => item.type === "symbol-definition" && item.symbol === "handleCheckout" && item.definitionKind === "function"));
  assert.ok(result.referenceTrace.every((item) => item.path && item.line && item.confirmedByRead));
  assert.ok(result.findings.some((item) => item.type === "import-edge" && item.path === "src/main.js" && item.relatedPath === "src/checkout-controller.js" && item.lineStart === 1));
  assert.ok(result.findings.some((item) => item.type === "import-edge" && item.path === "src/checkout-controller.js" && item.relatedPath === "src/checkout-service.js" && item.lineStart === 1));
  assert.deepEqual(result.dependencyTrace.slice(0, 2).map((edge) => [edge.from, edge.line, edge.to]), [
    ["src/main.js", 1, "src/checkout-controller.js"],
    ["src/checkout-controller.js", 1, "src/checkout-service.js"],
  ]);
  assert.ok(result.findings.every((item) => item.type !== "execution-path"));
  assert.match(result.stopReason, /no-justified-next-step|no-targeted-evidence/u);
  assert.match(renderSystemModelReport(result), /Ordered investigation steps/u);
  assert.match(renderSystemModelReport(result), /Ordered local dependency trace/u);
  assert.match(renderSystemModelReport(result), /imports do not prove calls or runtime order/u);
  assert.match(renderSystemModelReport(result), /src\/checkout-controller\.js:1/u);
  const saved = createTaskEvidence({ sessionId, projectRoot: root });
  assert.equal(mergeRepositoryEvidence(saved, result.evidence), true);
  assert.equal(saved.investigation.referenceIndex.status, result.referenceIndex.status);
  assert.equal(saved.investigation.steps.some((step) => step.operation.input.path === "src/checkout-service.js"), true);
  assert.equal(saved.investigation.steps.find((step) => step.operation.input.path === "src/checkout-service.js").operation.input.maxBytes, 65_536);
  assert.ok(renderTaskEvidenceReport(saved).includes("Investigation stopped:"));
});

test("missing and ambiguous symbols remain unresolved rather than becoming a complete call trace", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "function checkoutHandler() { return 1; }\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "function checkoutHandler() { return 2; }\n");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });
  const ambiguous = await service.inspect({ task: "Trace checkoutHandler", intent: "trace", includeHistory: false });
  assert.ok(ambiguous.findings.some((item) => item.type === "ambiguous-symbol" && item.status === "unknown"));
  assert.ok(ambiguous.evidence.investigation.unresolved.some((item) => item.includes("multiple inspected files")));

  const missing = await service.inspect({ task: "Trace notPresentAnywhere", intent: "trace", includeHistory: false });
  assert.ok(!missing.findings.some((item) => item.type === "symbol" && item.symbol === "notPresentAnywhere"));
  assert.ok(missing.evidence.investigation.unresolved.some((item) => /did not match|No matching symbol/u.test(item)));
});

test("project-local Python imports are traced with source line provenance", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.py"), "from .checkout_service import checkout_service\n\ndef route(request):\n    return checkout_service(request)\n");
  fs.writeFileSync(path.join(root, "src", "checkout_service.py"), "def checkout_service(request):\n    return request\n");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const result = await createSystemModel({ repositoryIntelligence: createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId }) })
    .investigate({ task: "Trace checkout_service request flow", intent: "trace" });
  assert.ok(result.findings.some((item) => item.type === "import-edge" && item.path === "src/main.py" &&
    item.relatedPath === "src/checkout_service.py" && item.lineStart === 1));
  assert.ok(result.dependencyTrace.some((edge) => edge.from === "src/main.py" && edge.to === "src/checkout_service.py"));
});

test("malformed follow-up operations are rejected before dispatch and generated sources are skipped", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.js"), "function checkoutHandler() { return true; }\n");
  fs.writeFileSync(path.join(root, "src", "api.generated.ts"), "function checkoutHandler() { return false; }\n");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });
  const invalid = await service.inspect({ task: "Trace checkoutHandler", intent: "trace", includeHistory: false, selectNextStep: () => ({
    operation: { toolId: "read_file", input: { path: "../outside.js" } }, purpose: "Read outside", requiredInputs: ["path"],
    expectedEvidence: "Source content", depth: 1,
  }) });
  assert.equal(invalid.evidence.investigation.stopReason, "invalid-operation");
  assert.ok(!invalid.evidence.investigation.steps.some((step) => step.operation.input.path?.includes("outside")));
  assert.ok(!invalid.project.readPaths.includes("src/api.generated.ts"));
  assert.ok(invalid.incomplete.some((item) => /generated-looking/u.test(item)));
  let getterCalls = 0;
  const accessorPlan = {};
  Object.defineProperty(accessorPlan, "stop", { enumerable: true, get() { getterCalls += 1; return false; } });
  const accessorResult = await service.inspect({ task: "Trace checkoutHandler", intent: "trace", includeHistory: false, selectNextStep: () => accessorPlan });
  assert.equal(accessorResult.evidence.investigation.stopReason, "invalid-operation");
  assert.equal(getterCalls, 0);
});

test("oversized and long source files remain bounded and are reported as incomplete", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.js"), `${Array.from({ length: 2_001 }, (_, index) => `const line${index} = ${index};`).join("\n")}\n`);
  fs.writeFileSync(path.join(root, "src", "large.js"), "x".repeat(64 * 1024 + 1));
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const result = await createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId })
    .inspect({ task: "Explain project structure", includeHistory: false });
  assert.ok(result.incomplete.some((item) => /exceeded the 65536-byte per-file analysis limit/u.test(item)));
  assert.ok(result.incomplete.some((item) => /stopped at 2000 lines/u.test(item)));
  assert.ok(result.project.readPaths.includes("src/main.js"));
  assert.ok(!result.project.readPaths.includes("src/large.js"));
});

test("investigation budgets and cancellation stop without dispatching unbounded follow-up reads", async (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.js"), "function checkoutHandler() { return true; }\n");
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  let clockValue = 0;
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId, clock: () => (clockValue += 2_000) });
  const timedOut = await service.inspect({ task: "Trace checkoutHandler", intent: "trace", includeHistory: false });
  assert.equal(timedOut.evidence.investigation.stopReason, "time-budget");
  assert.ok(timedOut.evidence.investigation.steps.length < 16);

  const controller = new AbortController();
  controller.abort("test-cancel");
  const cancelled = await createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId })
    .inspect({ task: "Trace checkoutHandler", intent: "trace", includeHistory: false, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.evidence.investigation.stopReason, "cancelled");
  assert.equal(cancelled.evidence.investigation.steps.length, 0);
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
  assert.match(output.value, /Ordered investigation steps/u);
  assert.match(output.value, /not executed/u);
  assert.doesNotMatch(output.value, /Existing route:/u);
});
