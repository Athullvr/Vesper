"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const output = path.resolve(process.argv[2] || path.join(root, ".audit-artifacts", `vesper-private-preview-${manifest.version}.tar.gz`));
if (!output.endsWith(".tar.gz")) throw new Error("preview kit output must end with .tar.gz.");

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-private-preview-"));
const artifacts = path.join(stage, "artifacts");
const docs = path.join(stage, "docs");
const tarPath = `${output}.tmp.tar`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(docs, { recursive: true });

try {
  const pack = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts]);
  let npmArtifact;
  try { npmArtifact = JSON.parse(pack.stdout)[0]; }
  catch { throw new Error("npm pack did not return valid JSON metadata."); }
  if (!npmArtifact?.filename) throw new Error("npm pack did not produce an artifact.");
  inspectNpmPackage(npmArtifact.files.map((file) => file.path));

  const vsixPath = path.join(artifacts, `vesper-preview-${manifest.version}.vsix`);
  const vsix = run(process.execPath, ["scripts/package-vsix.js", vsixPath]);
  process.stdout.write(vsix.stdout);
  if (vsix.stderr) process.stderr.write(vsix.stderr);
  if (!fs.existsSync(vsixPath) || fs.statSync(vsixPath).size === 0) throw new Error("VSIX artifact is missing or empty.");

  for (const file of ["INSTALL.md", "PREVIEW-GUIDE.md", "PREVIEW-VALIDATION-CHECKLIST.md", "PREVIEW-FEEDBACK.md", "PROVIDER-LIVE-VALIDATION.md"]) {
    fs.copyFileSync(path.join(root, file), path.join(docs, file));
  }
  fs.writeFileSync(path.join(stage, "KIT-README.md"), createKitReadme(npmArtifact.filename, path.basename(vsixPath)));
  fs.writeFileSync(path.join(stage, "SHA256SUMS"), createChecksums(stage));

  run("tar", ["--create", "--file", tarPath, "--directory", stage, "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "."]);
  const compressed = spawnSync("gzip", ["--no-name", "--stdout", tarPath], {
    encoding: null, timeout: 120_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  if (compressed.error || compressed.status !== 0 || !compressed.stdout?.length) {
    throw new Error(`gzip failed (${compressed.error?.code || compressed.status}): ${(compressed.stderr || Buffer.alloc(0)).toString("utf8").trim()}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, compressed.stdout);
  fs.rmSync(tarPath, { force: true });
  inspectKit(output, npmArtifact.filename, path.basename(vsixPath));

  process.stdout.write(`npm package: ${npmArtifact.filename} · ${npmArtifact.size} compressed bytes · ${npmArtifact.unpackedSize} unpacked bytes\n`);
  process.stdout.write(`Private preview kit: ${output} · ${fs.statSync(output).size} bytes\n`);
  process.stdout.write(`Identity: ${manifest.publisher}.${manifest.name} · distribution gate: ${distributionGate().join("; ") || "owner approval still required before sharing"}\n`);
} finally {
  fs.rmSync(tarPath, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
}

function inspectNpmPackage(files) {
  const required = ["package.json", "bin/vesper.js", "cli.js", "extension.js", "INSTALL.md", "PREVIEW-GUIDE.md", "PREVIEW-VALIDATION-CHECKLIST.md", "PREVIEW-FEEDBACK.md"];
  const missing = required.filter((file) => !files.includes(file));
  if (missing.length) throw new Error(`npm package is missing preview/runtime files: ${missing.join(", ")}.`);
  const unwanted = files.filter((file) => /^(?:test|benchmark|scripts|tooling|node_modules|\.audit-artifacts)(?:\/|$)/u.test(file) ||
    /(?:^|\/)(?:\.env(?:\..*)?|[^/]*credentials[^/]*|[^/]*secret[^/]*|[^/]*token[^/]*|[^/]*\.(?:db|sqlite|log|tmp|vsix))$/iu.test(file));
  if (unwanted.length) throw new Error(`npm package includes development or sensitive files: ${unwanted.join(", ")}.`);
  process.stdout.write(`PASS npm preview artifact inspection · ${files.length} files · runtime and onboarding present\n`);
}

function distributionGate() {
  const licenseFiles = fs.readdirSync(root).filter((file) => /^LICENSE(?:\..*)?$/iu.test(file));
  const pending = [];
  if (manifest.name === "fast-lane-app-server-poc") pending.push("approved package/extension slug pending");
  if (manifest.displayName === "Vesper") pending.push("unique Marketplace display name pending");
  if (manifest.publisher === "local-experiment") pending.push("owner-controlled publisher ID pending");
  if (!manifest.license || !licenseFiles.length) pending.push("owner-approved license metadata/file pending");
  return pending;
}

function createKitReadme(npmFilename, vsixFilename) {
  const pending = distributionGate();
  const state = pending.length ? `BLOCKED: ${pending.join("; ")}.` : "Identity and license fields are populated; separate owner approval to share is still required.";
  return `# Vesper private preview candidate\n\nDistribution status: ${state}\n\nThis archive contains a CLI npm tarball, a local VSIX, the tester guide, manual validation checklist, feedback template, and provider validation procedure. It has not been published or sent to testers. Do not distribute until the Vesper owner approves its identity and license and authorizes private sharing.\n\n## Install the CLI\n\n\`npm install --global ./artifacts/${npmFilename}\`\n\nThen run \`vesper setup\` and follow \`docs/PREVIEW-GUIDE.md\`.\n\n## Install the VS Code extension\n\n\`code --install-extension ./artifacts/${vsixFilename} --user-data-dir /tmp/vesper-preview-code-data --extensions-dir /tmp/vesper-preview-code-extensions\`\n\nFollow \`docs/PREVIEW-VALIDATION-CHECKLIST.md\` for isolation, expected behavior, approvals, failures, and cleanup. Check \`SHA256SUMS\` before using the artifacts. The kit does not collect feedback automatically.\n`;
}

function createChecksums(directory) {
  const paths = listFiles(directory).filter((file) => file !== "SHA256SUMS");
  return paths.map((relative) => `${hashFile(path.join(directory, relative))}  ${relative}`).join("\n") + "\n";
}

function listFiles(directory, relative = "") {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(relative, entry.name);
    return entry.isDirectory() ? listFiles(directory, next) : [next.split(path.sep).join("/")];
  }).sort();
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function inspectKit(archive, npmFilename, vsixFilename) {
  const result = run("tar", ["--list", "--gzip", "--file", archive]);
  const entries = result.stdout.split(/\r?\n/u).filter(Boolean).map((entry) => entry.replace(/^\.\//u, ""));
  const required = [
    "KIT-README.md", "SHA256SUMS", `artifacts/${npmFilename}`, `artifacts/${vsixFilename}`,
    "docs/INSTALL.md", "docs/PREVIEW-GUIDE.md", "docs/PREVIEW-VALIDATION-CHECKLIST.md", "docs/PREVIEW-FEEDBACK.md", "docs/PROVIDER-LIVE-VALIDATION.md",
  ];
  const missing = required.filter((file) => !entries.includes(file));
  if (missing.length) throw new Error(`preview kit archive is missing entries: ${missing.join(", ")}.`);
  if (entries.some((file) => /(?:^|\/)(?:\.env[^/]*|credentials|[^/]*secret[^/]*|[^/]*token[^/]*|[^/]*\.(?:db|sqlite|log|tmp))$/iu.test(file))) {
    throw new Error("preview kit contains a sensitive or temporary file.");
  }
  process.stdout.write(`PASS preview kit archive inspection · ${entries.length} entries · checksums and onboarding present\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.error?.code || result.status}): ${(result.stderr || "").trim().slice(-2_000)}`);
  }
  return result;
}
