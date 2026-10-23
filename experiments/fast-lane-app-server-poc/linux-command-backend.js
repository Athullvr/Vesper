"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { redactSensitiveText } = require("./command-activity");

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_RUNTIME_MS = 5_000;
const MAX_DIAGNOSTIC_BYTES = 512 * 1024;
const MAX_CONCURRENT_SANDBOXES = 2;
const MEMORY_BYTES = 512 * 1024 * 1024;
const CPU_COUNT = 1;
const PID_LIMIT = 64;
const TMPFS_SIZE_BYTES = 64 * 1024 * 1024;
const SHM_SIZE_BYTES = 8 * 1024 * 1024;
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const HOST_RUNTIME_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/iu;
let activeSandboxes = 0;

class LinuxPodmanCommandBackend {
  constructor({
    podmanPath = process.env.VESPER_PODMAN_PATH || "podman",
    image = process.env.VESPER_SANDBOX_IMAGE || "",
    env = process.env,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : null,
    gid = typeof process.getgid === "function" ? process.getgid() : null,
    execFileImpl = execFileAsync,
    spawnImpl = spawn,
    fsImpl = fs,
    osTmpdir = os.tmpdir,
    readMountInfo = () => fs.readFileSync("/proc/self/mountinfo", "utf8"),
    now = () => Date.now(),
    createId = () => crypto.randomUUID(),
    maximumRuntimeMs = MAX_RUNTIME_MS,
  } = {}) {
    this.podmanPathSetting = podmanPath;
    this.imageSetting = image;
    this.hostEnv = env;
    this.platform = platform;
    this.uid = uid;
    this.gid = gid;
    this.execFileImpl = execFileImpl;
    this.spawnImpl = spawnImpl;
    this.fs = fsImpl;
    this.osTmpdir = osTmpdir;
    this.readMountInfo = readMountInfo;
    this.now = now;
    this.createId = createId;
    this.maximumRuntimeMs = Number.isInteger(maximumRuntimeMs) && maximumRuntimeMs > 0
      ? Math.min(MAX_RUNTIME_MS, maximumRuntimeMs) : MAX_RUNTIME_MS;
    this.disposed = false;
    this.active = new Map();
    this.privateConfig = null;
  }

  async inspect() {
    const restrictions = {
      rootless: "unverified",
      userNamespace: "unverified",
      seccomp: "unverified",
      readOnlyRootFilesystem: "configured per command; not inspected",
      workspaceMount: "configured per command; not inspected",
      network: "disabled per command; not inspected",
      memoryLimit: "unverified",
      cpuLimit: "unverified",
      processLimit: "unverified",
      temporaryStorage: "unverified",
      hostEnvironment: "container receives a fixed allowlist",
      hostSockets: "not mounted by Vesper",
    };
    const status = {
      backend: "podman-rootless",
      platform: this.platform,
      installed: false,
      rootless: this.uid !== null && this.uid !== 0 ? "unknown" : false,
      configured: typeof this.imageSetting === "string" && this.imageSetting.trim().length > 0,
      imagePresent: false,
      imageId: null,
      version: null,
      available: false,
      enabled: false,
      restrictions,
      unsupported: ["Container policy has not been verified."],
      reasonCode: "ISOLATION_UNAVAILABLE",
      message: "Isolated command execution is unavailable.",
      policy: null,
    };
    if (this.disposed) return freezeStatus({ ...status, reasonCode: "BACKEND_DISPOSED", message: "The isolation backend has been disposed." });
    if (this.platform !== "linux") return freezeStatus({ ...status, unsupported: ["This backend supports Linux only."], message: "Rootless Podman isolation is supported only on Linux." });

    let executable;
    try { executable = this.resolvePodmanExecutable(); }
    catch {
      return freezeStatus({
        ...status, unsupported: ["Podman executable is missing or invalid."], reasonCode: "ISOLATION_RUNTIME_MISSING",
        message: "Rootless Podman was not found. Vesper will not run this command on the host."
      });
    }
    status.installed = true;
    const executableIdentity = executableFingerprint(this.fs, executable);
    if (this.uid === null || this.uid === 0 || this.gid === null) {
      return freezeStatus({
        ...status, rootless: false, unsupported: ["Vesper must run as a non-root Linux user."],
        message: "Rootless isolation is unavailable when Vesper runs as root or without a Linux uid/gid."
      });
    }

    let info;
    let temp;
    try {
      temp = this.ensurePrivateConfig();
      info = await this.runPodman(executable, ["info", "--format=json"], {
        maximumBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 3_000, env: this.podmanEnvironment(temp),
      });
    } catch (error) {
      return freezeStatus({
        ...status, unsupported: [error.code === "ISOLATION_RUNTIME_MISSING"
          ? "Podman executable could not be started." : "Podman could not report local runtime status."],
        reasonCode: error.code || "ISOLATION_RUNTIME_UNAVAILABLE", message: "Podman did not provide verifiable local runtime status."
      });
    }
    let host;
    try { host = parsePodmanInfo(info.stdout); }
    catch {
      return freezeStatus({
        ...status, unsupported: ["Podman returned malformed or incomplete runtime status."],
        reasonCode: "ISOLATION_STATUS_UNVERIFIABLE", message: "Podman's isolation status could not be verified."
      });
    }
    status.rootless = host.rootless;
    status.version = host.version;
    restrictions.rootless = host.rootless === true ? "verified" : host.rootless === false ? "unsupported" : "unknown";
    restrictions.userNamespace = host.rootless === true ? "rootless user namespace required; per-container check pending" : "unverified";
    restrictions.seccomp = host.seccomp === true ? "enabled by local runtime; per-container check pending" : host.seccomp === false ? "unsupported" : "unknown";
    restrictions.memoryLimit = host.controllers.includes("memory") && host.cgroupVersion === "v2" ? "available; per-container check pending" : "unsupported";
    restrictions.cpuLimit = host.controllers.includes("cpu") && host.cgroupVersion === "v2" ? "available; per-container check pending" : "unsupported";
    restrictions.processLimit = host.controllers.includes("pids") && host.cgroupVersion === "v2" ? "available; per-container check pending" : "unsupported";

    const missingHost = [];
    if (host.rootless !== true) missingHost.push("Podman did not confirm rootless operation.");
    if (host.seccomp !== true) missingHost.push("The runtime did not confirm that seccomp is enabled.");
    if (host.cgroupVersion !== "v2") missingHost.push("A cgroup v2 runtime is required for bounded CPU, memory, and process counts.");
    for (const controller of ["cpu", "memory", "pids"]) {
      if (!host.controllers.includes(controller)) missingHost.push(`The cgroup ${controller} controller is unavailable.`);
    }
    if (missingHost.length) return freezeStatus({
      ...status, unsupported: missingHost,
      reasonCode: "ISOLATION_REQUIREMENTS_UNAVAILABLE", message: "The local Podman runtime lacks one or more required isolation controls."
    });

    if (!status.configured) return freezeStatus({
      ...status, unsupported: ["No local sandbox image is configured.", "Vesper never pulls or builds an image."],
      reasonCode: "ISOLATION_IMAGE_UNCONFIGURED", message: "Set VESPER_SANDBOX_IMAGE to a locally available, trusted Linux image."
    });
    if (!validImageReference(this.imageSetting)) return freezeStatus({
      ...status, unsupported: ["The configured image reference is malformed."],
      reasonCode: "ISOLATION_IMAGE_INVALID", message: "The configured sandbox image reference is invalid."
    });

    let imageResult;
    try {
      imageResult = await this.runPodman(executable, ["image", "inspect", "--format=json", this.imageSetting], {
        maximumBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 3_000,
      });
    } catch {
      return freezeStatus({
        ...status, unsupported: ["The configured image is not present locally or could not be inspected.", "Vesper never pulls or builds an image."],
        reasonCode: "ISOLATION_IMAGE_UNAVAILABLE", message: "The configured sandbox image is unavailable locally."
      });
    }
    let image;
    try { image = parsePodmanImage(imageResult.stdout); }
    catch {
      return freezeStatus({
        ...status, unsupported: ["The local image metadata is malformed or ambiguous."],
        reasonCode: "ISOLATION_IMAGE_UNVERIFIABLE", message: "The sandbox image could not be verified safely."
      });
    }
    const expectedArchitecture = hostArchitecture(this.platform, this.hostEnv);
    try {
      if (stableStringify(executableIdentity) !== stableStringify(executableFingerprint(this.fs, executable))) {
        return freezeStatus({
          ...status, imagePresent: true, imageId: safeImageId(image.id), unsupported: ["The local Podman executable changed during inspection."],
          reasonCode: "ISOLATION_STATUS_UNVERIFIABLE", message: "The local Podman executable changed while its status was being checked."
        });
      }
    } catch {
      return freezeStatus({
        ...status, unsupported: ["The local Podman executable could not be revalidated."], reasonCode: "ISOLATION_STATUS_UNVERIFIABLE",
        message: "The local Podman executable changed while its status was being checked."
      });
    }
    if (image.os !== "linux" || image.architecture !== expectedArchitecture || !IMAGE_ID_PATTERN.test(image.id)) {
      return freezeStatus({
        ...status, imagePresent: true, imageId: safeImageId(image.id),
        unsupported: ["The local image must have a verified immutable id and match the host Linux architecture."],
        reasonCode: "ISOLATION_IMAGE_UNSUPPORTED", message: "The local sandbox image is incompatible or lacks a verifiable immutable id."
      });
    }
    status.imagePresent = true;
    status.imageId = image.id;
    status.available = true;
    status.enabled = true;
    status.unsupported = [];
    status.reasonCode = null;
    status.message = "Rootless Podman and the required host controls are available; per-container policy is checked before each command starts.";
    status.policy = this.basePolicy(executableIdentity, image.id, host);
    return freezeStatus(status);
  }

  async prepare({ workspaceRoot, argv, workspaceAccess = "read-only", timeoutMs = this.maximumRuntimeMs } = {}) {
    if (this.disposed) throw isolationError("BACKEND_DISPOSED", "The isolation backend has been disposed.", true);
    const command = validateArgv(argv);
    if (workspaceAccess !== "read-only" && workspaceAccess !== "read-write") {
      throw isolationError("INVALID_ARGUMENT", "Workspace access must be read-only or read-write.", true);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw isolationError("INVALID_ARGUMENT", "The command timeout is invalid.", true);
    let root;
    let stat;
    try {
      root = this.fs.realpathSync(workspaceRoot);
      stat = this.fs.statSync(root);
    } catch { throw isolationError("INVALID_PROJECT", "The selected workspace is unavailable.", true); }
    if (!path.isAbsolute(root) || !stat.isDirectory() || root === path.parse(root).root || /[:,\r\n]/u.test(root)) {
      throw isolationError("INVALID_PROJECT", "The selected workspace cannot be mounted safely by the configured container runtime.", true);
    }
    const workspaceRestriction = workspaceRootRestriction(root, this.hostEnv.HOME || os.homedir(), this.fs);
    if (workspaceRestriction) throw isolationError("INVALID_PROJECT", workspaceRestriction, true);
    const status = await this.inspect();
    if (!status.available || !status.policy) {
      throw isolationError(status.reasonCode || "ISOLATION_UNAVAILABLE", status.message || "OS-isolated command execution is unavailable.", true);
    }
    const executable = this.resolvePodmanExecutable();
    const currentExecutable = executableFingerprint(this.fs, executable);
    if (stableStringify(status.policy.podman) !== stableStringify(currentExecutable)) {
      throw isolationError("ISOLATION_POLICY_CHANGED", "The local Podman executable changed while its runtime status was being checked.", true);
    }
    const identity = Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
    const workspaceMount = inspectWorkspaceMounts(root, this.readMountInfo);
    const policy = Object.freeze({
      backend: "podman-rootless",
      podman: currentExecutable,
      imageId: status.imageId,
      workspaceRoot: root,
      workspaceIdentity: identity,
      workspaceMount,
      workspaceAccess,
      network: "none",
      cpuCount: CPU_COUNT,
      memoryBytes: MEMORY_BYTES,
      pidsLimit: PID_LIMIT,
      timeoutMs: Math.min(this.maximumRuntimeMs, timeoutMs),
      stdoutBytes: MAX_OUTPUT_BYTES,
      stderrBytes: MAX_OUTPUT_BYTES,
      tmpfsBytes: TMPFS_SIZE_BYTES,
      shmBytes: SHM_SIZE_BYTES,
      seccomp: true,
      noNewPrivileges: true,
      dropAllCapabilities: true,
      readOnlyRootFilesystem: true,
      userNamespace: "keep-id",
      uid: this.uid,
      gid: this.gid,
      namespaces: { pid: "private", ipc: "private", uts: "private", cgroup: "private" },
      environment: ["PATH", "HOME", "TMPDIR"],
      noHostSockets: true,
      noHostProc: true,
      noHostsFileImport: true,
      imageVolumes: "ignore",
      hooksDirectory: "empty-private-directory",
      logDriver: "none",
      runtimeVersion: status.policy.version,
      cgroupVersion: status.policy.cgroupVersion,
      cgroupControllers: status.policy.controllers,
      seccompEnabled: status.policy.seccompEnabled,
    });
    const binding = digest(stableStringify({ policy, argv: command }));
    return Object.freeze({
      backend: "podman-rootless",
      available: true,
      workspaceRoot: root,
      workspaceAccess,
      argv: command,
      imageId: status.imageId,
      policy,
      binding,
      display: Object.freeze({
        backend: "Rootless Podman",
        imageId: status.imageId,
        workspace: root,
        workspaceAccess,
        network: "disabled",
        readOnlyRootFilesystem: true,
        seccomp: "enabled (Podman runtime default)",
        noNewPrivileges: true,
        capabilities: "all dropped",
        privateNamespaces: "PID, IPC, UTS, cgroup",
        hostSockets: "not mounted",
        hostProc: "not mounted",
        cpuCount: CPU_COUNT,
        memoryMiB: MEMORY_BYTES / (1024 * 1024),
        processLimit: PID_LIMIT,
        timeoutMs: policy.timeoutMs,
        outputLimitBytesPerStream: MAX_OUTPUT_BYTES,
      }),
    });
  }

  async run({ plan, argv, workspaceRoot, workspaceAccess = "read-only", timeoutMs = this.maximumRuntimeMs, signal } = {}) {
    if (this.disposed) throw isolationError("BACKEND_DISPOSED", "The isolation backend has been disposed.", true);
    if (signal?.aborted) throw isolationError("COMMAND_INTERRUPTED", "The isolated command was cancelled before it started.", true);
    if (activeSandboxes >= MAX_CONCURRENT_SANDBOXES) throw isolationError("BUSY", "The isolated command limit is already in use.", true);
    activeSandboxes += 1;
    const runId = this.createId();
    const name = `vesper-${String(runId).replace(/[^a-z0-9]/giu, "").slice(0, 24)}`;
    const active = { name, child: null, createAttempted: false, created: false, started: false, cleanupPromise: null, abortReason: null };
    this.active.set(name, active);
    const requestStart = this.now();
    let createAttempted = false;
    try {
      const currentPlan = await this.prepare({ workspaceRoot, argv, workspaceAccess, timeoutMs });
      if (!plan || plan.binding !== currentPlan.binding) throw isolationError("ISOLATION_POLICY_CHANGED", "The reviewed command or isolation policy changed. Review a new operation before execution.", true);
      if (signal?.aborted) throw isolationError("COMMAND_INTERRUPTED", "The isolated command was cancelled before it started.", true);
      const executable = currentPlan.policy.podman.path;
      const temp = this.ensurePrivateConfig();
      const createArgs = buildCreateArguments(name, currentPlan, this.uid, this.gid, temp.hooks);
      this.assertExecutableCurrent(currentPlan);
      this.assertWorkspaceMountCurrent(currentPlan);
      createAttempted = true;
      active.createAttempted = true;
      await this.runPodman(executable, createArgs, { maximumBytes: 32 * 1024, timeoutMs: 4_000, env: this.podmanEnvironment(temp) });
      active.created = true;
      const inspected = await this.runPodman(executable, ["container", "inspect", "--type=container", "--format=json", name], {
        maximumBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 3_000, env: this.podmanEnvironment(temp),
      });
      const effective = parsePodmanContainer(inspected.stdout);
      verifyEffectivePolicy(effective, currentPlan, this.uid, this.gid, name);
      this.assertExecutableCurrent(currentPlan);
      this.assertWorkspaceMountCurrent(currentPlan);
      if (signal?.aborted) throw isolationError("COMMAND_INTERRUPTED", "The isolated command was cancelled before it started.", true);
      const remaining = Math.max(1, currentPlan.policy.timeoutMs - (this.now() - requestStart));
      const result = await this.startAndCapture({ executable, name, plan: currentPlan, temp, signal, active, timeoutMs: remaining });
      const after = await this.runPodman(executable, ["container", "inspect", "--type=container", "--format=json", name], {
        maximumBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 3_000, env: this.podmanEnvironment(temp),
      });
      const state = parsePodmanContainer(after.stdout).state;
      if (state.status !== "exited" || !Number.isInteger(state.exitCode)) {
        const uncertain = isolationError("COMMAND_OUTCOME_UNCERTAIN", "Podman did not confirm a completed command with an exit status. Do not retry it automatically.", false);
        uncertain.executed = true;
        throw uncertain;
      }
      if (result.exitCode !== null && result.exitCode !== state.exitCode) {
        const uncertain = isolationError("COMMAND_OUTCOME_UNCERTAIN", "Podman reported conflicting command exit status. Do not retry it automatically.", false);
        uncertain.executed = true;
        throw uncertain;
      }
      const output = Object.freeze({
        argv: currentPlan.argv, exitCode: state.exitCode, signal: result.signal,
        stdout: redactSensitiveText(result.stdout.toString("utf8")), stderr: redactSensitiveText(result.stderr.toString("utf8")),
        executionStatus: "completed", truncated: false, isolated: true, backend: "podman-rootless", imageId: currentPlan.imageId,
        workspaceAccess: currentPlan.workspaceAccess, containerConfigurationVerified: true
      });
      if (await this.cleanupContainer(active, executable, temp)) {
        const failure = isolationError("SANDBOX_CLEANUP_FAILED", "Vesper could not confirm sandbox cleanup. Inspect Podman before retrying.", false);
        failure.executed = true;
        throw failure;
      }
      return output;
    } catch (error) {
      if (createAttempted || active.started) {
        const cleanupError = await this.cleanupContainer(active, this.podmanExecutablePath(), this.privateConfig).catch(() => true);
        if (cleanupError) {
          const failedCleanup = isolationError("SANDBOX_CLEANUP_FAILED", "Vesper could not confirm sandbox cleanup. Inspect Podman before retrying.", false);
          failedCleanup.executed = active.started;
          throw failedCleanup;
        }
      }
      throw error;
    } finally {
      if (createAttempted || active.started) await this.cleanupContainer(active, this.podmanExecutablePath(), this.privateConfig).catch(() => { });
      this.active.delete(name);
      activeSandboxes = Math.max(0, activeSandboxes - 1);
    }
  }

  async startAndCapture({ executable, name, plan, temp, signal, active, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let child;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timeout = false;
      let overflow = false;
      const append = (target, chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const room = Math.max(0, MAX_OUTPUT_BYTES - target.length);
        if (bytes.length > room) overflow = true;
        return room ? Buffer.concat([target, bytes.subarray(0, room)]) : target;
      };
      const abort = (reason) => {
        if (settled) return;
        active.abortReason = reason;
        void this.cleanupContainer(active, executable, temp).catch(() => { });
        terminatePodmanClient(child, process.platform === "linux");
      };
      const onAbort = () => abort("interrupted");
      if (signal?.aborted) {
        reject(isolationError("COMMAND_INTERRUPTED", "The isolated command was cancelled before it started.", true));
        return;
      }
      try {
        child = this.spawnImpl(executable, ["--remote=false", "start", "--attach", name], {
          shell: false,
          windowsHide: true,
          detached: true,
          cwd: plan.workspaceRoot,
          env: this.podmanEnvironment(temp),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(isolationError("ISOLATION_RUNTIME_UNAVAILABLE", "Podman could not start the verified sandbox.", false));
        return;
      }
      active.child = child;
      active.started = true;
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); if (overflow) abort("output-limit"); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); if (overflow) abort("output-limit"); });
      const timer = setTimeout(() => { timeout = true; abort("timeout"); }, timeoutMs);
      timer.unref?.();
      const finish = (error, code, childSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        active.child = null;
        if (timeout || active.abortReason === "timeout") {
          const failure = isolationError("COMMAND_TIMEOUT", `The isolated command exceeded its ${plan.policy.timeoutMs} ms limit and was stopped.`, false);
          failure.executed = true;
          reject(failure);
        } else if (overflow || active.abortReason === "output-limit") {
          const failure = isolationError("OUTPUT_LIMIT", "The isolated command exceeded the captured output limit and was stopped.", false);
          failure.executed = true;
          reject(failure);
        } else if (signal?.aborted || active.abortReason === "interrupted") {
          const failure = isolationError("COMMAND_INTERRUPTED", "The isolated command was interrupted and stopped.", false);
          failure.executed = true;
          reject(failure);
        } else if (error) {
          const failure = isolationError("COMMAND_OUTCOME_UNCERTAIN", "The Podman connection ended before command completion could be confirmed. Do not retry automatically.", false);
          failure.executed = true;
          reject(failure);
        } else {
          resolve({ exitCode: Number.isInteger(code) ? code : null, signal: typeof childSignal === "string" ? childSignal : null, stdout, stderr });
        }
      };
      child.once("error", (error) => finish(error, null, null));
      child.once("close", (code, childSignal) => finish(null, code, childSignal));
    });
  }

  async cleanupContainer(active, executable, temp) {
    if (!active?.name) return false;
    if (active.cleanupPromise) return active.cleanupPromise;
    active.cleanupPromise = (async () => {
      let failed = false;
      const env = this.podmanEnvironment(temp || this.privateConfig);
      try {
        await this.runPodman(executable, ["kill", "--signal=KILL", active.name], { maximumBytes: 4_096, timeoutMs: 2_000, env, allowDisposed: true });
      } catch { /* A completed or not-yet-started container need not be killable. */ }
      try {
        await this.runPodman(executable, ["rm", "--force", active.name], { maximumBytes: 4_096, timeoutMs: 3_000, env, allowDisposed: true });
      } catch { failed = active.createAttempted || active.created || active.started; }
      return failed;
    })();
    return active.cleanupPromise;
  }

  basePolicy(executable, imageId, host) {
    return Object.freeze({
      podman: executable, imageId, rootless: host.rootless,
      version: host.version, seccompEnabled: host.seccomp, cgroupVersion: host.cgroupVersion, controllers: host.controllers
    });
  }

  assertExecutableCurrent(plan) {
    try {
      const actual = executableFingerprint(this.fs, plan.policy.podman.path);
      if (stableStringify(actual) !== stableStringify(plan.policy.podman)) throw new Error("executable changed");
    } catch { throw isolationError("ISOLATION_POLICY_CHANGED", "The local Podman executable changed after approval. Review the operation again.", true); }
  }

  assertWorkspaceMountCurrent(plan) {
    const current = inspectWorkspaceMounts(plan.workspaceRoot, this.readMountInfo);
    if (stableStringify(current) !== stableStringify(plan.policy.workspaceMount)) {
      throw isolationError("ISOLATION_POLICY_CHANGED", "The workspace mount layout changed after approval. Review the operation again.", true);
    }
  }

  resolvePodmanExecutable() {
    const setting = this.podmanPathSetting;
    if (typeof setting !== "string" || !setting.trim() || setting.includes("\0")) throw new Error("invalid podman path");
    if (!path.isAbsolute(setting) && path.basename(setting) !== setting) throw new Error("podman path must be absolute or a PATH command name");
    const candidates = path.isAbsolute(setting) ? [setting] : (typeof this.hostEnv.PATH === "string" ? this.hostEnv.PATH.split(path.delimiter).map((dir) => path.join(dir || ".", setting)) : []);
    for (const candidate of candidates) {
      try {
        const real = this.fs.realpathSync(candidate);
        const stat = this.fs.statSync(real);
        if (stat.isFile() && (stat.mode & 0o111) !== 0 && this.fs.accessSync(real, this.fs.constants.X_OK) === undefined) return real;
      } catch { /* Check the next PATH candidate. */ }
    }
    throw new Error("podman unavailable");
  }

  podmanExecutablePath() {
    try { return this.resolvePodmanExecutable(); } catch { return this.podmanPathSetting; }
  }

  ensurePrivateConfig() {
    if (this.privateConfig) return this.privateConfig;
    const directory = this.fs.mkdtempSync(path.join(this.osTmpdir(), "vesper-podman-"));
    this.fs.chmodSync(directory, 0o700);
    const hooks = path.join(directory, "hooks");
    this.fs.mkdirSync(hooks, { mode: 0o700 });
    const config = path.join(directory, "containers.conf");
    this.fs.writeFileSync(config, "# Vesper managed empty Podman configuration\n", { mode: 0o600, flag: "wx" });
    this.privateConfig = Object.freeze({ directory, hooks, config });
    return this.privateConfig;
  }

  podmanEnvironment(temp = this.privateConfig) {
    const env = {};
    env.PATH = HOST_RUNTIME_PATH;
    if (typeof this.hostEnv.HOME === "string" && path.isAbsolute(this.hostEnv.HOME)) env.HOME = this.hostEnv.HOME;
    if (typeof this.hostEnv.XDG_RUNTIME_DIR === "string" && path.isAbsolute(this.hostEnv.XDG_RUNTIME_DIR)) env.XDG_RUNTIME_DIR = this.hostEnv.XDG_RUNTIME_DIR;
    if (typeof this.hostEnv.XDG_CONFIG_HOME === "string" && path.isAbsolute(this.hostEnv.XDG_CONFIG_HOME)) env.XDG_CONFIG_HOME = this.hostEnv.XDG_CONFIG_HOME;
    if (typeof this.hostEnv.XDG_DATA_HOME === "string" && path.isAbsolute(this.hostEnv.XDG_DATA_HOME)) env.XDG_DATA_HOME = this.hostEnv.XDG_DATA_HOME;
    if (temp?.config) env.CONTAINERS_CONF = temp.config;
    return Object.freeze(env);
  }

  async runPodman(executable, args, { maximumBytes = MAX_DIAGNOSTIC_BYTES, timeoutMs = 3_000, env = this.podmanEnvironment(), allowDisposed = false } = {}) {
    if (this.disposed && !allowDisposed) throw isolationError("BACKEND_DISPOSED", "The isolation backend has been disposed.", true);
    try {
      const result = await this.execFileImpl(executable, ["--remote=false", ...args], {
        cwd: "/", env, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: maximumBytes, encoding: "utf8",
      });
      const stdout = typeof result?.stdout === "string" ? result.stdout : Buffer.isBuffer(result?.stdout) ? result.stdout.toString("utf8") : "";
      if (Buffer.byteLength(stdout) > maximumBytes) throw isolationError("ISOLATION_STATUS_UNVERIFIABLE", "The Podman response exceeded Vesper's inspection limit.", false);
      return { stdout };
    } catch (error) {
      if (["ISOLATION_STATUS_UNVERIFIABLE"].includes(error?.code)) throw error;
      const code = error?.code === "ENOENT" ? "ISOLATION_RUNTIME_MISSING" : error?.killed ? "ISOLATION_RUNTIME_TIMEOUT" : "ISOLATION_RUNTIME_UNAVAILABLE";
      throw isolationError(code, "The local Podman operation failed; Vesper did not use a host execution fallback.", false);
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const executable = this.podmanExecutablePath();
    await Promise.all([...this.active.values()].map(async (active) => {
      const cleanup = this.cleanupContainer(active, executable, this.privateConfig).catch(() => true);
      terminatePodmanClient(active.child, process.platform === "linux");
      await cleanup;
    }));
    if (this.privateConfig) {
      try { this.fs.rmSync(this.privateConfig.directory, { recursive: true, force: true }); } catch { /* Best-effort temporary config cleanup. */ }
      this.privateConfig = null;
    }
  }
}

function createLinuxCommandBackend(options) {
  return new LinuxPodmanCommandBackend(options);
}

function buildCreateArguments(name, plan, uid, gid, hooksDirectory) {
  const access = plan.workspaceAccess === "read-write" ? "rw" : "ro";
  return [
    "--hooks-dir", hooksDirectory, "create", "--pull=never", "--name", name,
    "--network=none", "--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private",
    "--userns=keep-id", "--user", `${uid}:${gid}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--read-only=true", "--read-only-tmpfs=false",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${TMPFS_SIZE_BYTES}`,
    `--shm-size=${SHM_SIZE_BYTES}`,
    `--pids-limit=${PID_LIMIT}`, `--memory=${MEMORY_BYTES}`, `--cpus=${CPU_COUNT}`,
    "--http-proxy=false", "--unsetenv-all", "--env", `PATH=${CONTAINER_PATH}`,
    "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
    "--no-hosts", "--image-volume=ignore", "--log-driver=none", "--workdir=/workspace",
    "--volume", `${plan.workspaceRoot}:/workspace:${access},nosuid,nodev,rprivate`,
    "--entrypoint", plan.argv[0], plan.imageId, ...plan.argv.slice(1),
  ];
}

function verifyEffectivePolicy(container, plan, uid, gid, expectedName) {
  const config = container.config;
  const host = container.hostConfig;
  const state = container.state;
  if (container.name !== expectedName || !config || !host || !state || state.running === true || state.status !== "created") {
    throw isolationError("ISOLATION_VERIFY_FAILED", "Podman did not return a verifiable, unstarted container configuration.", true);
  }
  if (container.image !== plan.imageId && container.imageId !== plan.imageId) throw isolationError("ISOLATION_VERIFY_FAILED", "The container image did not match the reviewed immutable image id.", true);
  if (stringValue(config.workingDir) !== "/workspace") throw isolationError("ISOLATION_VERIFY_FAILED", "The container working directory did not match the selected workspace.", true);
  const user = stringValue(config.user);
  if (user !== `${uid}:${gid}`) throw isolationError("ISOLATION_VERIFY_FAILED", "The container did not retain the reviewed non-root user mapping.", true);
  if (stringValue(host.networkMode).toLowerCase() !== "none") throw isolationError("ISOLATION_VERIFY_FAILED", "The container network is not disabled.", true);
  if (host.privileged === true || host.readonlyRootfs !== true) throw isolationError("ISOLATION_VERIFY_FAILED", "The container privilege or read-only root filesystem policy did not match.", true);
  if (Number(host.pidsLimit) !== PID_LIMIT || Number(host.memory) !== MEMORY_BYTES) throw isolationError("ISOLATION_VERIFY_FAILED", "The container process or memory limit did not match.", true);
  const cpuLimited = Number(host.nanoCpus) === CPU_COUNT * 1_000_000_000 || (Number(host.cpuQuota) > 0 && Number(host.cpuPeriod) > 0 && Number(host.cpuQuota) / Number(host.cpuPeriod) === CPU_COUNT);
  if (!cpuLimited) throw isolationError("ISOLATION_VERIFY_FAILED", "The container CPU limit could not be verified.", true);
  const capDrop = arrayValue(host.capDrop).map((value) => String(value).toUpperCase());
  if (!capDrop.includes("ALL")) throw isolationError("ISOLATION_VERIFY_FAILED", "The container did not drop all Linux capabilities.", true);
  const securityOptions = arrayValue(host.securityOpt).map((value) => String(value).toLowerCase());
  if (!securityOptions.some((value) => value === "no-new-privileges" || value === "no-new-privileges:true") || securityOptions.some((value) => value.includes("seccomp=unconfined"))) {
    throw isolationError("ISOLATION_VERIFY_FAILED", "No-new-privileges or the default seccomp policy could not be verified.", true);
  }
  if (!/keep-id/iu.test(stringValue(host.usernsMode))) throw isolationError("ISOLATION_VERIFY_FAILED", "The container user namespace mapping could not be verified.", true);
  if (stringValue(host.pidMode).toLowerCase() !== "private" || stringValue(host.ipcMode).toLowerCase() !== "private" ||
    stringValue(host.utsMode).toLowerCase() !== "private" || stringValue(host.cgroupMode).toLowerCase() !== "private") {
    throw isolationError("ISOLATION_VERIFY_FAILED", "The container process, IPC, UTS, or cgroup namespace is not private.", true);
  }
  const requestedEntry = config.entrypoint;
  const requestedArgs = arrayValue(config.cmd);
  if (!(typeof requestedEntry === "string" ? requestedEntry === plan.argv[0] : arrayValue(requestedEntry).join("\0") === plan.argv[0]) ||
    requestedArgs.join("\0") !== plan.argv.slice(1).join("\0")) {
    throw isolationError("ISOLATION_VERIFY_FAILED", "The container command differs from the reviewed argv.", true);
  }
  const env = arrayValue(config.env).map((value) => String(value));
  const allowedEnv = [`PATH=${CONTAINER_PATH}`, "HOME=/tmp", "TMPDIR=/tmp"];
  if (env.some((value) => !allowedEnv.includes(value)) || allowedEnv.some((value) => !env.includes(value))) {
    throw isolationError("ISOLATION_VERIFY_FAILED", "The container environment differs from Vesper's fixed allowlist.", true);
  }
  const mounts = arrayValue(container.mounts);
  const binds = mounts.filter((mount) => stringValue(mount.type).toLowerCase() === "bind");
  if (binds.length !== 1) throw isolationError("ISOLATION_VERIFY_FAILED", "The container has unexpected host bind mounts.", true);
  const workspace = binds[0];
  if (path.resolve(stringValue(workspace.source)) !== plan.workspaceRoot || stringValue(workspace.destination) !== "/workspace" ||
    Boolean(workspace.rw) !== (plan.workspaceAccess === "read-write")) {
    throw isolationError("ISOLATION_VERIFY_FAILED", "The workspace mount does not match the reviewed path or permissions.", true);
  }
  const unexpectedMount = mounts.some((mount) => {
    const type = stringValue(mount.type).toLowerCase();
    const destination = stringValue(mount.destination);
    return type !== "bind" && !(type === "tmpfs" && ["/tmp", "/dev/shm"].includes(destination));
  });
  if (unexpectedMount) throw isolationError("ISOLATION_VERIFY_FAILED", "The container includes an unapproved mount.", true);
  const tmp = mounts.find((mount) => stringValue(mount.type).toLowerCase() === "tmpfs" && stringValue(mount.destination) === "/tmp");
  const tmpfs = host.tmpfs && typeof host.tmpfs === "object" ? host.tmpfs : {};
  const tmpOptions = stringValue(tmpfs["/tmp"]);
  if (!tmp || !tmpOptions.includes(`size=${TMPFS_SIZE_BYTES}`) || Number(host.shmSize) !== SHM_SIZE_BYTES) {
    throw isolationError("ISOLATION_VERIFY_FAILED", "The bounded temporary and shared-memory filesystems could not be verified.", true);
  }
  const networkDisabled = container.networkDisabled === true || stringValue(host.networkMode).toLowerCase() === "none";
  if (!networkDisabled) throw isolationError("ISOLATION_VERIFY_FAILED", "The container network could not be verified as disabled.", true);
}

function parsePodmanInfo(text) {
  const data = JSON.parse(text);
  const host = data?.host;
  if (!host || typeof host !== "object") throw new Error("invalid info");
  const security = host.security && typeof host.security === "object" ? host.security : {};
  const rootlessSignals = [security.rootless, host.rootless].filter((value) => typeof value === "boolean");
  const rootless = rootlessSignals.length && rootlessSignals.every((value) => value === rootlessSignals[0]) ? rootlessSignals[0] : null;
  const seccomp = security.seccompEnabled === true ? true : security.seccompEnabled === false ? false : null;
  const version = typeof data.version?.Version === "string" ? data.version.Version.slice(0, 64) : null;
  return {
    rootless, seccomp, cgroupVersion: typeof host.cgroupVersion === "string" ? host.cgroupVersion.toLowerCase() : null,
    controllers: Array.isArray(host.cgroupControllers) ? host.cgroupControllers.filter((entry) => typeof entry === "string").map((entry) => entry.toLowerCase()) : [], version
  };
}

function parsePodmanImage(text) {
  const data = JSON.parse(text);
  const images = Array.isArray(data) ? data : [data];
  if (images.length !== 1 || !images[0] || typeof images[0] !== "object") throw new Error("ambiguous image");
  const image = images[0];
  const id = typeof image.Id === "string" ? image.Id : image.ID;
  return {
    id: normalizeImageId(id), os: typeof image.Os === "string" ? image.Os.toLowerCase() : typeof image.OS === "string" ? image.OS.toLowerCase() : null,
    architecture: typeof image.Architecture === "string" ? image.Architecture.toLowerCase() : null
  };
}

function parsePodmanContainer(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") throw new Error("invalid container inspect");
  const row = rows[0];
  const config = row.Config || row.config;
  const hostConfig = row.HostConfig || row.hostConfig || row.hostconfig;
  const state = row.State || row.state;
  const mounts = row.Mounts || row.mounts;
  if (!config || !hostConfig || !state || !Array.isArray(mounts)) throw new Error("incomplete container inspect");
  const normalizedHostConfig = lowerKeys(hostConfig);
  normalizedHostConfig.utsMode = hostConfig.UTSMode ?? hostConfig.UtsMode ?? normalizedHostConfig.utsMode;
  return {
    name: trimLeadingSlash(stringValue(row.Name || row.name)),
    image: stringValue(row.ImageName || row.imageName),
    imageId: normalizeImageId(row.Image || row.imageId),
    config: lowerKeys(config), hostConfig: normalizedHostConfig, state: lowerKeys(state),
    mounts: mounts.map(lowerKeys), networkDisabled: row.NetworkSettings?.Networks && Object.keys(row.NetworkSettings.Networks).length === 0,
  };
}

function lowerKeys(value) {
  const output = {};
  for (const [key, item] of Object.entries(value || {})) output[key[0].toLowerCase() + key.slice(1)] = item;
  return output;
}

function executableFingerprint(fileSystem, executable) {
  const stat = fileSystem.statSync(executable, { bigint: true });
  return Object.freeze({
    path: executable, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs)
  });
}

function inspectWorkspaceMounts(root, readMountInfo) {
  let content;
  try { content = readMountInfo(); } catch { throw isolationError("ISOLATION_UNAVAILABLE", "Vesper could not verify the workspace mount layout.", true); }
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024) {
    throw isolationError("ISOLATION_UNAVAILABLE", "Vesper could not verify the bounded workspace mount layout.", true);
  }
  const rootMounts = [];
  const nestedMounts = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields.length < 6 || !/^\d+$/u.test(fields[0]) || !/^\d+:\d+$/u.test(fields[2])) {
      throw isolationError("ISOLATION_UNAVAILABLE", "The Linux mount table could not be parsed safely.", true);
    }
    const mountpoint = decodeMountInfoPath(fields[4]);
    if (mountpoint === root) rootMounts.push({ id: fields[0], device: fields[2] });
    else if (mountpoint.startsWith(`${root}${path.sep}`)) nestedMounts.push(mountpoint);
  }
  if (nestedMounts.length) throw isolationError("ISOLATION_UNAVAILABLE", "The selected workspace contains nested mount points, so its filesystem boundary cannot be confirmed.", true);
  if (rootMounts.length > 1) throw isolationError("ISOLATION_UNAVAILABLE", "The selected workspace has an ambiguous mount identity.", true);
  return Object.freeze({ rootMount: rootMounts[0] || null, nestedMounts: Object.freeze([]) });
}

function workspaceRootRestriction(root, homeSetting, fileSystem) {
  const protectedRoots = ["/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/containers", "/var/lib/docker"];
  for (const protectedRoot of protectedRoots) {
    if (isSameOrInside(root, protectedRoot) || isSameOrInside(protectedRoot, root)) {
      return "The selected workspace is inside a host system or container-runtime directory and cannot be mounted.";
    }
  }
  if (typeof homeSetting === "string" && path.isAbsolute(homeSetting)) {
    try {
      const home = fileSystem.realpathSync(homeSetting);
      if (isSameOrInside(home, root)) {
        return "The selected workspace is the Vesper user's home directory or contains it; Vesper will not mount the host home.";
      }
    } catch {
      // An unavailable home path is not exposed by a workspace bind mount.
    }
  }
  return null;
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function decodeMountInfoPath(value) {
  return value.replace(/\\(040|011|012|134)/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || argv.some((item) => typeof item !== "string" || !item || item.includes("\0"))) {
    throw isolationError("INVALID_ARGUMENT", "The command requires a non-empty argv array with at most 64 text arguments.", true);
  }
  let bytes = 0;
  const copied = argv.map((item) => {
    const size = Buffer.byteLength(item, "utf8");
    bytes += size;
    if (size > 4_096 || bytes > 4_096) throw isolationError("INVALID_ARGUMENT", "The command argv exceeds Vesper's bounded argument size.", true);
    return item;
  });
  return Object.freeze(copied);
}

function validImageReference(value) {
  return typeof value === "string" && value.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/u.test(value) && !value.includes("..") && !value.includes("//");
}

function hostArchitecture(platform, env) {
  const arch = env.VESPER_TEST_ARCH || process.arch;
  return ({ x64: "amd64", arm64: "arm64", arm: "arm", ppc64: "ppc64le", s390x: "s390x" })[arch] || arch;
}

function stringValue(value) { return typeof value === "string" ? value : ""; }
function arrayValue(value) { return Array.isArray(value) ? value : []; }
function trimLeadingSlash(value) { return value.startsWith("/") ? value.slice(1) : value; }
function safeImageId(value) { return IMAGE_ID_PATTERN.test(String(value || "")) ? value : null; }
function normalizeImageId(value) {
  if (typeof value !== "string") return value;
  if (/^[a-f0-9]{64}$/iu.test(value)) return `sha256:${value.toLowerCase()}`;
  return value;
}
function digest(text) { return crypto.createHash("sha256").update(text).digest("hex"); }
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
function freezeStatus(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeStatus));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeStatus(child)])));
  return value;
}
function terminatePodmanClient(child, killProcessGroup) {
  if (!child) return;
  const send = (signal) => {
    try {
      if (killProcessGroup && Number.isInteger(child.pid)) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch { /* The Podman client may already have exited. */ }
    }
  };
  send("SIGTERM");
  const timer = setTimeout(() => send("SIGKILL"), 250);
  timer.unref?.();
  child.once?.("close", () => clearTimeout(timer));
}
function isolationError(code, message, rejected = false) {
  const error = new Error(message);
  error.code = code;
  error.rejected = rejected;
  error.retryable = ["BUSY", "ISOLATION_RUNTIME_TIMEOUT", "ISOLATION_RUNTIME_UNAVAILABLE", "COMMAND_TIMEOUT", "COMMAND_INTERRUPTED"].includes(code);
  return error;
}

module.exports = {
  LinuxPodmanCommandBackend,
  MAX_CONCURRENT_SANDBOXES,
  MAX_OUTPUT_BYTES,
  MAX_RUNTIME_MS,
  buildCreateArguments,
  createLinuxCommandBackend,
  parsePodmanContainer,
  parsePodmanInfo,
  parsePodmanImage,
  verifyEffectivePolicy,
  workspaceRootRestriction,
};
