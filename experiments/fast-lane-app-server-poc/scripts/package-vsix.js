"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DEFAULT_PROVIDER_ID, resolveDefaultProviderId } = require("../execution-provider");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const output = path.resolve(process.argv[2] || path.join(root, ".audit-artifacts", `vesper-preview-${manifest.version}.vsix`));
const localVsce = path.join(root, "tooling", "vsce", "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const vsce = process.env.VESPER_VSCE_BIN || (fs.existsSync(localVsce) ? localVsce : "vsce");

validateManifest();
fs.mkdirSync(path.dirname(output), { recursive: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-vsix-stage-"));
try {
  createStage(stage);
  const packed = spawnSync(vsce, ["package", "--no-dependencies", "--allow-missing-repository", "--out", output], {
    cwd: stage, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  if (packed.stdout) process.stdout.write(packed.stdout);
  if (packed.stderr) process.stderr.write(packed.stderr);
  if (packed.error || packed.status !== 0) {
    if (packed.error) process.stderr.write(`VSIX packager launch failed (${packed.error.code || "spawn error"}): ${packed.error.message}\n`);
    else process.stderr.write(`VSIX packager exited with status ${packed.status}.\n`);
    if (packed.error?.code === "ENOENT") {
      process.stderr.write("Install @vscode/vsce in a controlled temporary prefix and set VESPER_VSCE_BIN to its executable.\n");
    }
    process.exitCode = 1;
  } else {
    try {
      inspectArchive(output);
      process.stdout.write(`Verified VSIX: ${output}\n`);
    } catch (error) {
      process.stderr.write(`VSIX inspection failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

function validateManifest() {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(manifest.name || "")) throw new Error("package name must be a lowercase VS Code extension slug.");
  if (!manifest.displayName || !manifest.publisher || !/^\d+\.\d+\.\d+$/u.test(manifest.version || "")) {
    throw new Error("displayName, publisher, and a SemVer version are required.");
  }
  if (!manifest.engines?.vscode || manifest.engines.vscode === "*") throw new Error("a specific VS Code engine range is required.");
  if (!manifest.main || !fs.existsSync(path.resolve(root, manifest.main))) throw new Error("extension main entry point is missing.");
  const commandIds = (manifest.contributes?.commands || []).map((command) => command.command);
  const activations = manifest.activationEvents || [];
  if (!commandIds.length || commandIds.some((id) => !activations.includes(`onCommand:${id}`))) {
    throw new Error("every contributed command must have an onCommand activation event.");
  }
  const entrypoint = fs.readFileSync(path.resolve(root, manifest.main), "utf8");
  const registeredCommands = new Set([...entrypoint.matchAll(/registerCommand\(\s*["']([^"']+)["']/gu)].map((match) => match[1]));
  const missingRegistrations = commandIds.filter((id) => !registeredCommands.has(id));
  if (missingRegistrations.length) {
    throw new Error(`contributed commands are not registered by the extension entry point: ${missingRegistrations.join(", ")}.`);
  }
  if (resolveDefaultProviderId({}) !== DEFAULT_PROVIDER_ID) throw new Error("the documented default provider has changed; update the preview checks.");
  if (manifest.icon && !fs.existsSync(path.resolve(root, manifest.icon))) throw new Error(`manifest icon is missing: ${manifest.icon}`);
}

function inspectArchive(artifact) {
  const listing = run("unzip", ["-Z1", artifact]);
  const files = listing.stdout.split(/\r?\n/u).filter(Boolean);
  const required = new Set(["extension.vsixmanifest", "[Content_Types].xml", "extension/package.json", "extension/readme.md", "extension/INSTALL.md", "extension/PREVIEW-GUIDE.md", "extension/PREVIEW-FEEDBACK.md", "extension/PROVIDER-LIVE-VALIDATION.md"]);
  for (const file of ["extension/extension.js", "extension/cli.js", "extension/bin/vesper.js", ...fs.readdirSync(root).filter((entry) => entry.endsWith(".js")).map((entry) => `extension/${entry}`)]) {
    required.add(file);
  }
  const missing = [...required].filter((file) => !files.includes(file));
  if (missing.length) throw new Error(`required runtime or documentation files are missing: ${missing.join(", ")}`);
  const unwanted = files.filter((file) => /(?:^|\/)(?:test|benchmark|scripts|\.git|\.audit-artifacts|node_modules|\.aws|\.codex|\.config|sessions|provider-conversations)(?:\/|$)/iu.test(file) ||
    /(?:^|\/)(?:\.env[^/]*|\.npmrc|\.yarnrc|auth\.json|credentials|[^/]*credentials[^/]*|[^/]*secret[^/]*|[^/]*token[^/]*|\.fast-lane-test-result\.json|[^/]*\.(?:db(?:-[^/]*)?|sqlite(?:3)?(?:-[^/]*)?|log|tmp|vsix))$/iu.test(file));
  if (unwanted.length) throw new Error(`sensitive or development files are present: ${unwanted.join(", ")}`);

  const packedManifest = JSON.parse(run("unzip", ["-p", artifact, "extension/package.json"]).stdout);
  for (const field of ["name", "displayName", "publisher", "version", "main"]) {
    if (packedManifest[field] !== manifest[field]) throw new Error(`packed manifest field ${field} differs from package.json.`);
  }
  if (packedManifest.engines?.vscode !== manifest.engines.vscode) throw new Error("packed VS Code engine range differs from package.json.");
  if (packedManifest.icon) {
    const iconPath = `extension/${packedManifest.icon.replace(/^\.\//u, "")}`;
    if (!files.includes(iconPath)) throw new Error(`manifest icon is absent from the archive: ${iconPath}`);
    process.stdout.write(`Icon included: ${iconPath}\n`);
  } else {
    process.stdout.write("Icon: not declared in the manifest; no icon asset is required by this package.\n");
  }
  process.stdout.write(`Extension ID: ${packedManifest.publisher}.${packedManifest.name}\n`);
  process.stdout.write(`VS Code engine: ${packedManifest.engines.vscode}\n`);
  process.stdout.write(`VS Code settings: ${(packedManifest.contributes?.configuration ? "declared" : "none; provider defaults remain environment-driven")}; default provider ${DEFAULT_PROVIDER_ID}.\n`);
  process.stdout.write(`Archive contents: ${files.length} files; ${required.size} required entries present; sensitive/development exclusions pass.\n`);
}

function createStage(stage) {
  const stagedManifest = { ...manifest };
  delete stagedManifest.files;
  delete stagedManifest.scripts;
  delete stagedManifest.devDependencies;
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);
  fs.copyFileSync(path.join(root, ".vscodeignore"), path.join(stage, ".vscodeignore"));
  for (const entry of fs.readdirSync(root).filter((name) => name.endsWith(".js"))) {
    fs.copyFileSync(path.join(root, entry), path.join(stage, entry));
  }
  for (const relative of ["bin/vesper.js", "README.md", "INSTALL.md", "DEVELOPER-WORKFLOW.md", "PREVIEW-GUIDE.md", "PREVIEW-FEEDBACK.md", "PROVIDER-LIVE-VALIDATION.md"]) {
    const destination = path.join(stage, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    const error = result.error?.code || `exit ${result.status}`;
    throw new Error(`${command} ${args[0]} failed (${error}): ${(result.stderr || "").trim().slice(-1_000)}`);
  }
  return result;
}
