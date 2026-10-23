"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SourceReferenceIndex, parseJavaScriptLike, MAX_INDEX_FILE_BYTES } = require("../source-reference-index");
const { createPermissionedToolRuntime } = require("../permissioned-tool-runtime");
const { createRepositoryIntelligence } = require("../repository-intelligence");
const { createSystemModel, renderSystemModelReport } = require("../system-model");

function temporaryProject(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-reference-index-"));
  const root = path.join(parent, "repo");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

test("JS/TS lexical index separates definitions, imports, exports, likely calls, and text matches", () => {
  const source = [
    'import { checkout as runCheckout } from "./service";',
    "export class CheckoutController {",
    "  handleCheckout(request) { return runCheckout(request); }",
    "}",
    'router.post("/checkout", handleCheckout);',
    'const note = "handleCheckout";',
    "// handleCheckout is mentioned in documentation only.",
  ].join("\n");
  const parsed = parseJavaScriptLike(source, "src/checkout.test.ts", { querySymbols: ["handleCheckout", "checkout"] });
  const definitions = parsed.relationships.filter((item) => item.type === "symbol-definition");
  assert.ok(definitions.some((item) => item.symbol === "CheckoutController" && item.definitionKind === "class" && item.lineStart === 2));
  assert.ok(definitions.some((item) => item.symbol === "handleCheckout" && item.definitionKind === "method" && item.lineStart === 3));
  assert.ok(parseJavaScriptLike("export interface CheckoutRequest {}\ntype CheckoutResult = boolean;\n", "src/types.ts")
    .relationships.some((item) => item.type === "symbol-definition" && item.symbol === "CheckoutRequest" && item.definitionKind === "type"));
  assert.ok(parsed.relationships.some((item) => item.type === "symbol-import" && item.symbol === "runCheckout" && item.importedName === "checkout" && item.moduleSpecifier === "./service" && item.lineStart === 1));
  assert.ok(parsed.relationships.some((item) => item.type === "likely-call-site" && item.symbol === "runCheckout" && item.importedName === "checkout" && item.lineStart === 3));
  assert.ok(parsed.relationships.some((item) => item.type === "symbol-export" && item.symbol === "CheckoutController"));
  assert.ok(parsed.relationships.some((item) => item.type === "likely-call-site" && item.symbol === "runCheckout" && item.lineStart === 3 && item.observation === "inferred"));
  assert.ok(parsed.relationships.some((item) => item.type === "route-handler" && item.symbol === "handleCheckout" && item.route === "/checkout" && item.lineStart === 5));
  assert.ok(parsed.relationships.some((item) => item.type === "test-reference" && item.symbol === "handleCheckout" && item.lineStart === 5));
  assert.ok(parsed.relationships.some((item) => item.type === "textual-reference" && item.symbol === "handleCheckout" && item.lineStart === 6));
  assert.ok(parsed.relationships.some((item) => item.type === "textual-reference" && item.symbol === "handleCheckout" && item.lineStart === 7));
  assert.equal(parsed.relationships.some((item) => item.type === "likely-call-site" && item.symbol === "handleCheckout" && item.lineStart === 5), false);
  const commonJs = parseJavaScriptLike('const { handleCheckout: checkout } = require("./service");\n', "src/consumer.js");
  assert.ok(commonJs.relationships.some((item) => item.type === "symbol-import" && item.symbol === "checkout" && item.importedName === "handleCheckout" && item.moduleSpecifier === "./service"));
});

test("reference matches distinguish bare identifiers from calls and preserve ambiguous definitions", () => {
  const index = new SourceReferenceIndex();
  index.addFile("src/a.js", "export function handleCheckout() { return true; }\n");
  index.addFile("src/b.ts", "export const handleCheckout = () => false;\n");
  index.addFile("src/caller.ts", "function route() { handleCheckout; handleCheckout(); }\n", null, { querySymbols: ["handleCheckout"] });
  const matches = index.matches("handleCheckout");
  assert.equal(matches.filter((item) => item.type === "symbol-definition").length, 2);
  assert.equal(matches.filter((item) => item.type === "likely-call-site" && item.path === "src/caller.ts").length, 1);
  assert.equal(matches.filter((item) => item.type === "identifier-reference" && item.path === "src/caller.ts").length, 1);
  assert.deepEqual(index.definitions(["handleCheckout"]).map((item) => item.path), ["src/a.js", "src/b.ts"]);
});

test("index bounds reject unsupported, out-of-project, oversized, and over-budget inputs explicitly", () => {
  const index = new SourceReferenceIndex({ maxFiles: 1, maxBytes: 1_024 });
  assert.equal(index.addFile("../outside.js", "function outside() {}\n").reason, "invalid-path-or-content");
  assert.equal(index.addFile("node_modules/pkg/index.js", "function vendor() {}\n").reason, "excluded-path");
  assert.equal(index.addFile("src/module.py", "def module(): pass\n").reason, "unsupported-language");
  assert.equal(index.addFile("src/binary.js", "\0binary").reason, "binary-content");
  assert.equal(index.addFile("src/large.js", "x".repeat(MAX_INDEX_FILE_BYTES + 1)).reason, "file-limit");
  assert.equal(index.addFile("src/first.js", "function first() {}\n").indexed, true);
  assert.equal(index.addFile("src/second.js", "function second() {}\n").reason, "index-budget");
  assert.equal(index.summary().partial, true);
  assert.equal(index.summary().unsupportedFiles, 2);
});

test("unterminated lexical input marks the index partial instead of asserting complete parsing", () => {
  const index = new SourceReferenceIndex();
  index.addFile("src/broken.js", "function maybe() { /* unfinished");
  assert.equal(index.summary().partial, true);
  assert.equal(index.summary().malformedFiles, 1);
});

test("parser deadline stops tokenization and marks the partial result", () => {
  let clock = 0;
  const result = parseJavaScriptLike("function handleCheckout() { return true; }", "src/handler.js", {
    maxDurationMs: 1,
    clock: () => { clock += 1; return clock; },
  });
  assert.equal(result.timeLimit, true);
  assert.equal(result.truncated, true);
});

test("iterative inspection reads index-selected references and refreshes line evidence after edits, deletion, and rename", async (t) => {
  const { root } = temporaryProject(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "generated"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "src/generated/\n.env*\n");
  fs.writeFileSync(path.join(root, "src", "handleCheckout.js"), "export function handleCheckout() { return true; }\n");
  fs.writeFileSync(path.join(root, "src", "caller.js"), 'import { handleCheckout } from "./handleCheckout";\nfunction route() { return handleCheckout(); }\n');
  fs.writeFileSync(path.join(root, "src", "handleCheckout.test.js"), 'import { handleCheckout } from "./handleCheckout";\nhandleCheckout();\n');
  fs.writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "export const b = 1;\n");
  fs.writeFileSync(path.join(root, "src", "c.js"), "export const c = 1;\n");
  fs.writeFileSync(path.join(root, "src", "generated", "ignored.js"), "function handleCheckout() {}\n");
  fs.writeFileSync(path.join(root, "src", "binary.js"), Buffer.from([0x66, 0x00, 0x6f]));
  fs.writeFileSync(path.join(root, "src", "large.js"), "function large() {}\n" + " ".repeat(MAX_INDEX_FILE_BYTES));
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "function handleCheckout() {}\n");
  fs.writeFileSync(path.join(root, ".env.local"), "API_KEY=sk-should-not-appear\n");
  const outside = path.join(path.dirname(root), "outside.js");
  fs.writeFileSync(outside, "function handleCheckout() {}\n");
  fs.symlinkSync(outside, path.join(root, "src", "outside.js"));
  const sessionId = crypto.randomUUID();
  const runtime = createPermissionedToolRuntime({ projectRoot: root, sessionId });
  t.after(() => runtime.dispose());
  const service = createRepositoryIntelligence({ toolRuntime: runtime, projectRoot: root, sessionId });
  const systemModel = createSystemModel({ repositoryIntelligence: service });

  const first = await systemModel.investigate({ task: "Trace handleCheckout", intent: "trace" });
  assert.ok(first.findings.some((item) => item.type === "likely-call-site" && item.path === "src/caller.js" && item.lineStart === 2 && item.relatedPath === "src/handleCheckout.js" && item.relatedLine === 1));
  assert.ok(first.findings.some((item) => item.type === "test-reference" && item.path === "src/handleCheckout.test.js" && item.lineStart === 2));
  assert.ok(first.steps.some((step) => step.purpose.includes("matched definition") && step.operation.input.path === "src/caller.js"));
  assert.ok(first.referenceIndex.indexedFiles >= 2);
  assert.ok(first.referenceIndex.excludedFiles >= 1);
  assert.ok(first.findings.every((item) => !/generated|node_modules|outside\.js|env\.local/u.test(item.path || "")));
  assert.equal(JSON.stringify(first).includes("should-not-appear"), false);
  assert.match(renderSystemModelReport(first), /not a complete call graph/u);

  fs.writeFileSync(path.join(root, "src", "handleCheckout.js"), "// updated\nexport function handleCheckout() { return true; }\n");
  const edited = await systemModel.investigate({ task: "Trace handleCheckout", intent: "trace" });
  assert.ok(edited.referenceIndex.changes.changed.includes("src/handleCheckout.js"));
  assert.ok(edited.findings.some((item) => item.type === "symbol-definition" && item.path === "src/handleCheckout.js" && item.lineStart === 2));
  assert.equal(edited.findings.some((item) => item.type === "symbol-definition" && item.path === "src/handleCheckout.js" && item.lineStart === 1), false);

  fs.unlinkSync(path.join(root, "src", "handleCheckout.test.js"));
  const deleted = await systemModel.investigate({ task: "Trace handleCheckout", intent: "trace" });
  assert.ok(deleted.referenceIndex.changes.removed.includes("src/handleCheckout.test.js"));
  assert.equal(deleted.findings.some((item) => item.path === "src/handleCheckout.test.js"), false);

  fs.renameSync(path.join(root, "src", "handleCheckout.js"), path.join(root, "src", "handleCheckout-renamed.js"));
  const renamed = await systemModel.investigate({ task: "Trace handleCheckout", intent: "trace" });
  assert.ok(renamed.referenceIndex.changes.renamed.some((item) => item.from === "src/handleCheckout.js" && item.to === "src/handleCheckout-renamed.js"));
  assert.equal(renamed.findings.some((item) => item.type === "symbol-definition" && item.path === "src/handleCheckout.js"), false);

  fs.writeFileSync(path.join(root, "src", "handleCheckout-support.js"), "export const checkoutSupport = true;\n");
  const created = await systemModel.investigate({ task: "Trace handleCheckout", intent: "trace" });
  assert.ok(created.referenceIndex.changes.added.includes("src/handleCheckout-support.js"));
});
