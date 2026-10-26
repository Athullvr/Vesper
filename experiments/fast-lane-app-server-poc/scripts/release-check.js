"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-release-check-"));
const cleanEnvironment = { ...process.env };
for (const name of Object.keys(cleanEnvironment)) {
  if (/^(?:OPENAI_API_KEY|NVIDIA_API_KEY|VESPER_OPENAI_|VESPER_NVIDIA_|VESPER_SYSTEM_MODEL_ASSISTED|VESPER_LOCAL_ONLY|VESPER_ENABLE_|VESPER_SANDBOX_)/u.test(name)) delete cleanEnvironment[name];
}
Object.assign(cleanEnvironment, {
  CODEX_HOME: path.join(temp, "codex-home"),
  VESPER_HOME: path.join(temp, "vesper-home"),
  VESPER_PROVIDER: "codex-app-server",
  VESPER_SYSTEM_MODEL_ASSISTED: "0",
});
fs.mkdirSync(cleanEnvironment.CODEX_HOME, { recursive: true });
let failures = 0;
let skipped = 0;

try {
  const productionFiles = fs.readdirSync(root)
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(root, file))
    .concat(path.join(root, "bin", "vesper.js"));
  for (const file of productionFiles) {
    if (!runStep(`Syntax: ${path.relative(root, file)}`, process.execPath, ["--check", file])) break;
  }

  runStep("Provider and approval regression tests", process.execPath, ["--test",
    "test/app-server-client.test.js",
    "test/codex-runtime-status.test.js",
    "test/diagnostics.test.js",
    "test/execution-provider.test.js",
    "test/nvidia-nim-provider.test.js",
    "test/openai-chat-completions-provider.test.js",
    "test/permissioned-tool-runtime.test.js",
    "test/session-store.test.js"]);
  runStep("Full regression tests", "npm", ["test"]);
  runStep("Offline System Model evaluation", process.execPath, ["benchmark/run-system-model.js"]);

  const artifactDir = path.join(temp, "artifact");
  const npmCache = path.join(temp, "npm-cache");
  const sourcePrefix = path.join(temp, "source-install");
  const installPrefix = path.join(temp, "global-install");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });
  const sourceInstall = runCommand("npm", ["install", "--global", "--prefix", sourcePrefix, "--offline", "--no-audit", "--no-fund", "--ignore-scripts", root], {
    env: { npm_config_cache: npmCache, npm_config_update_notifier: "false" },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (report("Global install from clean checkout", sourceInstall)) {
    const sourceCli = runCommand(path.join(sourcePrefix, "bin", "vesper"), ["--help"], { maxBuffer: 512 * 1024 });
    if (report("Checkout install CLI entry point", sourceCli) && !sourceCli.stdout.includes("vesper inspect")) {
      fail("Checkout installation does not expose the documented CLI commands.");
    }
  }
  const pack = runCommand("npm", ["pack", "--pack-destination", artifactDir, "--json"], {
    env: { npm_config_cache: npmCache, npm_config_update_notifier: "false" },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (report("CLI and extension package artifact", pack)) {
    let metadata;
    try { metadata = JSON.parse(pack.stdout)[0]; }
    catch (error) {
      fail("npm pack output was not valid JSON", String(error.message || error));
    }
    if (metadata) {
      process.stdout.write(`Artifact: ${metadata.filename} · ${metadata.size} compressed bytes · ${metadata.unpackedSize} unpacked bytes\n`);
      const packagedPaths = metadata.files.map((file) => file.path);
      verifyPackContents(packagedPaths);
      const tarball = path.join(artifactDir, metadata.filename);
      const install = runCommand("npm", ["install", "--global", "--prefix", installPrefix, "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
        env: { npm_config_cache: npmCache, npm_config_update_notifier: "false" },
        maxBuffer: 2 * 1024 * 1024,
      });
      if (report("Offline global install from packed tarball", install)) {
        const cli = path.join(installPrefix, "bin", "vesper");
        const help = runCommand(cli, ["--help"], { maxBuffer: 512 * 1024 });
        if (report("Installed CLI entry point", help) && !help.stdout.includes("vesper setup") && !help.stdout.includes("vesper doctor")) {
          fail("Installed CLI help is missing setup or doctor commands.");
        }
        const firstRun = runCommand(cli, ["setup", "--provider", "openai-chat-completions"], {
          env: { CODEX_HOME: cleanEnvironment.CODEX_HOME, VESPER_HOME: cleanEnvironment.VESPER_HOME,
            VESPER_PROVIDER: "codex-app-server", VESPER_OPENAI_API_KEY: "", OPENAI_API_KEY: "", VESPER_OPENAI_MODEL: "" },
          maxBuffer: 512 * 1024,
        });
        if (firstRun.status === 1 && firstRun.stdout.includes("VESPER_OPENAI_MODEL") && firstRun.stdout.includes("OPENAI_API_KEY") &&
            !/sk-[A-Za-z0-9_-]{12,}/u.test(firstRun.stdout)) {
          process.stdout.write("PASS Packaged non-interactive setup · actionable missing-provider guidance · secret-free output\n");
        } else {
          fail("Packaged non-interactive setup did not return the expected missing-provider guidance.", `${firstRun.stdout}${firstRun.stderr}`);
        }
        const fixture = path.join(temp, "inspection-project");
        fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
        fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "vesper-release-fixture", main: "src/index.js" }, null, 2));
        fs.writeFileSync(path.join(fixture, "src", "index.js"), "function main() { return 'ready'; }\nmodule.exports = { main };\n");
        const init = runCommand("git", ["init", "--quiet", fixture]);
        if (report("Disposable inspection fixture", init)) {
          const doctor = runCommand(cli, ["doctor", "--project", fixture], {
            env: { CODEX_HOME: cleanEnvironment.CODEX_HOME, VESPER_HOME: cleanEnvironment.VESPER_HOME,
              VESPER_PROVIDER: "codex-app-server", OPENAI_API_KEY: "", VESPER_OPENAI_API_KEY: "",
              NVIDIA_API_KEY: "", VESPER_NVIDIA_API_KEY: "" },
            maxBuffer: 512 * 1024,
          });
          if ([0, 1].includes(doctor.status) && doctor.stdout.includes("Network checks: not performed") &&
              /\[(?:available|unavailable|not tested|not applicable)\] codex-auth:/u.test(doctor.stdout) &&
              !/sk-[A-Za-z0-9_-]{12,}/u.test(doctor.stdout)) {
            process.stdout.write("PASS Packaged offline doctor · auth and connectivity states are explicit · secret-free output\n");
          } else {
            fail("Packaged offline doctor did not report safe local diagnostics.", `${doctor.stdout}${doctor.stderr}`);
          }
          const inspection = runCommand(cli, ["inspect", "Trace main in src/index.js", "--project", fixture], {
            env: { VESPER_HOME: path.join(temp, "vesper-home"), VESPER_LOCAL_ONLY: "1" },
            maxBuffer: 2 * 1024 * 1024,
          });
          report("Packaged CLI repository inspection", inspection);
          if (inspection.status === 0 && !inspection.stdout.includes("Vesper repository investigation")) {
            fail("Packaged inspection completed without rendering a repository investigation report.");
          }
        }
      }
    }
  }

  checkVsixPackaging(temp);
  skip("VS Code Extension Development Host activation", "requires launching a graphical VS Code host; mocked activation and routing tests are in the regression suite");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write(`\nRelease check summary: ${failures ? "FAILED" : "PASSED"} · ${failures} failed · ${skipped} skipped · ${process.platform}/${process.arch} · Node ${process.versions.node}\n`);
process.exitCode = failures ? 1 : 0;

function runStep(label, command, args) {
  const result = runCommand(command, args, { maxBuffer: 4 * 1024 * 1024 });
  if (report(label, result)) return true;
  return false;
}

function runCommand(command, args, { env = {}, maxBuffer = 1024 * 1024 } = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer,
      timeout: 120_000,
      windowsHide: true,
      env: { ...cleanEnvironment, npm_config_update_notifier: "false", ...env },
    });
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error || null };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error };
  }
}

function report(label, result) {
  if (result.status === 0 && !result.error) {
    process.stdout.write(`PASS ${label}\n`);
    if (/tests/u.test(label)) {
      const total = tapCount(result.stdout, "tests");
      const passed = tapCount(result.stdout, "pass");
      const failed = tapCount(result.stdout, "fail");
      if (total !== null) process.stdout.write(`  TAP: ${passed ?? "?"}/${total} test entries passed${failed === null ? "" : ` · ${failed} failed`}\n`);
    }
    return true;
  }
  fail(`${label} failed${result.error?.code ? ` (${result.error.code})` : result.status !== null ? ` (exit ${result.status})` : ""}.`, `${result.stdout}${result.stderr}`);
  return false;
}

function tapCount(output, key) {
  const match = String(output).match(new RegExp(`^# ${key} (\\d+)$`, "m"));
  return match ? Number(match[1]) : null;
}

function verifyPackContents(packagedPaths) {
  const required = ["package.json", "bin/vesper.js", "cli.js", "extension.js", "execution-provider.js", "diagnostics.js", "INSTALL.md"];
  for (const item of required) {
    if (!packagedPaths.includes(item)) fail(`Package artifact is missing required file ${item}.`);
  }
  const unwanted = packagedPaths.filter((item) => /^(?:test|benchmark|\.audit-artifacts|node_modules)(?:\/|$)/u.test(item) ||
    /(?:^|\/)(?:\.env(?:\..*)?|\.fast-lane-test-result\.json|[^/]*\.(?:db|sqlite|log|tmp))$/iu.test(item));
  if (unwanted.length) fail(`Package artifact contains development or sensitive files: ${unwanted.join(", ")}.`);
  else process.stdout.write(`PASS Package contents · ${packagedPaths.length} files · no tests, benchmarks, env files, databases, or temporary artifacts\n`);
}

function checkVsixPackaging(directory) {
  const version = runCommand("vsce", ["--version"], { maxBuffer: 64 * 1024 });
  if (version.status !== 0 || version.error?.code === "ENOENT") {
    skip("VSIX packaging", "@vscode/vsce is not installed in this environment");
    return;
  }
  if (version.error) {
    skip("VSIX packaging", `vsce could not be launched (${version.error.code || "environment error"})`);
    return;
  }
  const artifact = path.join(directory, "vesper.vsix");
  const packageResult = runCommand("vsce", ["package", "--no-dependencies", "--out", artifact]);
  if (report("VSIX packaging", packageResult)) {
    if (!fs.existsSync(artifact) || fs.statSync(artifact).size === 0) fail("VSIX packager returned success without creating a non-empty artifact.");
    else process.stdout.write(`PASS VSIX artifact · ${fs.statSync(artifact).size} bytes\n`);
  }
}

function skip(label, reason) {
  skipped += 1;
  process.stdout.write(`SKIP ${label} · ${reason}\n`);
}

function fail(message, detail = "") {
  failures += 1;
  process.stderr.write(`FAIL ${message}\n`);
  const lines = String(detail).trim().split(/\r?\n/u).filter(Boolean);
  const failureLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*not ok\b/u.test(line));
  for (const failure of failureLines.slice(0, 5)) {
    for (const line of lines.slice(failure.index, failure.index + 16)) process.stderr.write(`  ${line}\n`);
  }
  for (const line of lines.slice(-30)) process.stderr.write(`  ${line}\n`);
}
