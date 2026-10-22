"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  MAX_OUTPUT_BYTES,
  buildCreateArguments,
  createLinuxCommandBackend,
  workspaceRootRestriction,
} = require("../linux-command-backend");

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-podman-test-"));
  const project = path.join(directory, "project");
  fs.mkdirSync(project);
  const executable = path.join(directory, "podman");
  fs.writeFileSync(executable, "fixture executable\n", { mode: 0o700 });
  const tracker = { calls: [], started: false, exitCode: 0, stdout: "safe output", stderr: "", inspectMutation: null };
  const backend = createLinuxCommandBackend({
    podmanPath: options.missing ? path.join(directory, "missing-podman") : executable,
    image: options.image === undefined ? "localhost/vesper-test:latest" : options.image,
    env: { PATH: directory, HOME: directory, XDG_RUNTIME_DIR: directory, VESPER_TEST_ARCH: process.arch, API_KEY: "test-secret-must-not-pass" },
    platform: options.platform || "linux",
    uid: options.uid === undefined ? 1000 : options.uid,
    gid: options.gid === undefined ? 1000 : options.gid,
    maximumRuntimeMs: options.maximumRuntimeMs || 5_000,
    execFileImpl: options.execFileImpl || createPodmanRunner(tracker, options),
    spawnImpl: options.spawnImpl || createPodmanSpawn(tracker, options),
  });
  t.after(() => backend.dispose());
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { backend, directory, project, executable, tracker };
}

function createPodmanRunner(tracker, options) {
  return async (_executable, argv, callOptions) => {
    assert.equal(callOptions.shell, false);
    assert.ok(callOptions.timeout > 0);
    assert.equal(callOptions.env.API_KEY, undefined);
    const args = argv.slice(1);
    const commandIndex = args.findIndex((value) => ["info", "image", "create", "container", "kill", "rm"].includes(value));
    const command = args[commandIndex];
    tracker.calls.push(command);
    if (command === "info") {
      const info = {
        version: { Version: "5.7.1" },
        host: {
          cgroupVersion: options.cgroupVersion || "v2",
          cgroupControllers: options.controllers || ["cpu", "memory", "pids"],
          security: { rootless: options.rootless === undefined ? true : options.rootless, seccompEnabled: options.seccomp === undefined ? true : options.seccomp },
        },
      };
      return { stdout: JSON.stringify(info), stderr: "" };
    }
    if (command === "image") {
      if (options.imageMissing) throw Object.assign(new Error("secret-bearing runtime error"), { code: "ENOENT" });
      return { stdout: JSON.stringify([{ Id: IMAGE_ID, Os: "linux", Architecture: hostArchitecture() }]), stderr: "" };
    }
    if (command === "create") {
      tracker.createArgs = args.slice(commandIndex);
      tracker.container = containerFixture(tracker, options);
      return { stdout: "vesper fixture created", stderr: "" };
    }
    if (command === "container" && args[1] === "inspect") {
      tracker.calls.push(tracker.started ? "inspect-after" : "inspect-before");
      const container = tracker.container;
      if (tracker.inspectMutation) tracker.inspectMutation(container);
      return { stdout: JSON.stringify([container]), stderr: "" };
    }
    if (command === "kill" || command === "rm") return { stdout: "", stderr: "" };
    throw new Error(`Unexpected Podman command: ${command}`);
  };
}

function containerFixture(tracker, options) {
  const args = tracker.createArgs;
  const readOption = (name) => args[args.indexOf(name) + 1];
  const name = readOption("--name");
  const volume = readOption("--volume");
  const [source, destination, mode] = volume.split(":");
  const entrypoint = readOption("--entrypoint");
  const imageIndex = args.indexOf(IMAGE_ID);
  return {
    Name: `/${name}`,
    ImageName: IMAGE_ID,
    Image: IMAGE_ID.slice("sha256:".length),
    Config: { User: "1000:1000", WorkingDir: "/workspace", Entrypoint: entrypoint, Cmd: args.slice(imageIndex + 1),
      Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp", "TMPDIR=/tmp"] },
    HostConfig: {
      NetworkMode: options.networkMode || "none", Privileged: false, ReadonlyRootfs: true,
      PidsLimit: 64, Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"], UsernsMode: "keep-id", PidMode: "private", IpcMode: "private",
      UTSMode: "private", CgroupMode: "private", Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=67108864" }, ShmSize: 8 * 1024 * 1024,
    },
    State: { Running: false, Status: "created", ExitCode: 0 },
    Mounts: [
      { Type: "bind", Source: source, Destination: destination, RW: mode.startsWith("rw") },
      { Type: "tmpfs", Source: "tmpfs", Destination: "/tmp", RW: true },
      { Type: "tmpfs", Source: "shm", Destination: "/dev/shm", RW: true },
    ],
    NetworkSettings: { Networks: {} },
  };
}

function createPodmanSpawn(tracker, options) {
  return (executable, args, spawnOptions) => {
    tracker.calls.push("start");
    tracker.spawnOptions = spawnOptions;
    tracker.spawnArgs = args;
    const child = new EventEmitter();
    child.pid = 123_456;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
  let keepAlive;
  let closed = false;
  if (options.hang) keepAlive = setTimeout(() => {}, 2_000);
  child.kill = (signal) => {
      clearTimeout(keepAlive);
      tracker.calls.push(`child-${signal}`);
      if (!child.stdout.writableEnded) child.stdout.end();
      if (!child.stderr.writableEnded) child.stderr.end();
      setImmediate(() => { if (!closed) { closed = true; child.emit("close", null, signal); } });
      return true;
    };
    tracker.started = true;
    tracker.container.State = { Running: false, Status: "exited", ExitCode: tracker.exitCode };
    if (options.hang) {
      tracker.container.State = { Running: true, Status: "running", ExitCode: 0 };
      setImmediate(() => options.onSpawn?.());
    } else {
      setImmediate(() => {
        if (!child.stdout.writableEnded) {
          if (options.overflow) child.stdout.end(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 120));
          else child.stdout.end(tracker.stdout);
        }
        if (!child.stderr.writableEnded) child.stderr.end(tracker.stderr);
        setImmediate(() => { if (!closed) { closed = true; child.emit("close", tracker.exitCode, null); } });
      });
    }
    return child;
  };
}

function hostArchitecture() {
  return ({ x64: "amd64", arm64: "arm64", arm: "arm", ppc64: "ppc64le", s390x: "s390x" })[process.arch] || process.arch;
}

test("missing or non-rootless Podman is reported unavailable with no fallback", async (t) => {
  const missing = fixture(t, { missing: true });
  const missingStatus = await missing.backend.inspect();
  assert.equal(missingStatus.installed, false);
  assert.equal(missingStatus.available, false);
  assert.equal(missingStatus.reasonCode, "ISOLATION_RUNTIME_MISSING");
  assert.deepEqual(missing.tracker.calls, []);

  const notRootless = fixture(t, { rootless: false });
  const status = await notRootless.backend.inspect();
  assert.equal(status.available, false);
  assert.equal(status.rootless, false);
  assert.match(status.unsupported.join(" "), /rootless/iu);
  assert.deepEqual(notRootless.tracker.calls, ["info"]);
});

test("missing cgroup or seccomp protections fails closed before image use", async (t) => {
  const cgroups = fixture(t, { controllers: ["cpu", "pids"] });
  const cgroupStatus = await cgroups.backend.inspect();
  assert.equal(cgroupStatus.available, false);
  assert.match(cgroupStatus.unsupported.join(" "), /memory controller/iu);
  assert.deepEqual(cgroups.tracker.calls, ["info"]);

  const seccomp = fixture(t, { seccomp: false });
  const seccompStatus = await seccomp.backend.inspect();
  assert.equal(seccompStatus.available, false);
  assert.match(seccompStatus.unsupported.join(" "), /seccomp/iu);
});

test("workspace roots cannot expose the user home or host system/runtime trees", async (t) => {
  const { backend, directory } = fixture(t);
  await assert.rejects(backend.prepare({ workspaceRoot: directory, argv: ["git", "status"] }), { code: "INVALID_PROJECT" });
  assert.match(workspaceRootRestriction("/home", "/home/tester", { realpathSync: (value) => value }), /home/iu);
  for (const root of ["/proc", "/sys", "/dev", "/run", "/var/run", "/var"]) {
    assert.match(workspaceRootRestriction(root, "/home/tester", { realpathSync: (value) => value }), /system|runtime/iu);
  }
});

test("prepared policy pins a local immutable image and emits a bounded read-only, no-network Podman argv", async (t) => {
  const { backend, project, tracker } = fixture(t);
  const plan = await backend.prepare({ workspaceRoot: project, argv: ["make", "test"] });
  const args = buildCreateArguments("vesper-safe", plan, 1000, 1000, "/tmp/hooks");
  assert.equal(plan.imageId, IMAGE_ID);
  assert.equal(plan.workspaceAccess, "read-only");
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only=true"));
  assert.ok(args.includes("--pids-limit=64"));
  assert.ok(args.includes("--memory=536870912"));
  assert.ok(args.includes("--cpus=1"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
  assert.ok(args.includes("--unsetenv-all"));
  assert.ok(args.includes(`${project}:/workspace:ro,nosuid,nodev,rprivate`));
  assert.equal(args.some((item) => String(item).includes("API_KEY")), false);
  assert.equal(tracker.calls.includes("create"), false);
  assert.doesNotMatch(JSON.stringify(backend.podmanEnvironment()), /test-secret-must-not-pass/u);
  const writable = await backend.prepare({ workspaceRoot: project, argv: ["make"], workspaceAccess: "read-write" });
  const writableArgs = buildCreateArguments("vesper-write", writable, 1000, 1000, "/tmp/hooks");
  assert.ok(writableArgs.includes(`${project}:/workspace:rw,nosuid,nodev,rprivate`));
});

test("container settings are inspected before start and a successful result is confirmed then cleaned", async (t) => {
  const { backend, project, tracker } = fixture(t);
  const plan = await backend.prepare({ workspaceRoot: project, argv: ["printf", "safe"] });
  const result = await backend.run({ plan, workspaceRoot: project, argv: plan.argv });
  assert.equal(result.isolated, true);
  assert.equal(result.containerConfigurationVerified, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(tracker.calls.slice(-7), ["container", "inspect-before", "start", "container", "inspect-after", "kill", "rm"]);
  assert.ok(tracker.calls.indexOf("create") < tracker.calls.indexOf("inspect-before"));
  assert.equal(tracker.spawnOptions.shell, false);
  assert.equal(tracker.spawnOptions.env.API_KEY, undefined);
  assert.equal(tracker.spawnArgs.includes("--attach"), true);
});

test("effective network or mount policy mismatch prevents command start and removes the created container", async (t) => {
  const network = fixture(t, { networkMode: "bridge" });
  const plan = await network.backend.prepare({ workspaceRoot: network.project, argv: ["make"] });
  await assert.rejects(network.backend.run({ plan, workspaceRoot: network.project, argv: plan.argv }), { code: "ISOLATION_VERIFY_FAILED" });
  assert.equal(network.tracker.calls.includes("start"), false);
  assert.equal(network.tracker.calls.at(-1), "rm");

  const outsideMount = fixture(t);
  outsideMount.tracker.inspectMutation = (container) => {
    if (!container.Mounts.some((mount) => mount.Type === "bind" && mount.Source === "/etc")) {
      container.Mounts.push({ Type: "bind", Source: "/etc", Destination: "/host-etc", RW: false });
    }
  };
  const outsidePlan = await outsideMount.backend.prepare({ workspaceRoot: outsideMount.project, argv: ["make"] });
  await assert.rejects(outsideMount.backend.run({ plan: outsidePlan, workspaceRoot: outsideMount.project, argv: outsidePlan.argv }), { code: "ISOLATION_VERIFY_FAILED" });
  assert.equal(outsideMount.tracker.calls.includes("start"), false);
});

test("nested project mounts are rejected because they can cross the selected workspace boundary", async (t) => {
  const { backend, project } = fixture(t);
  const escaped = project.replace(/ /gu, "\\040");
  backend.readMountInfo = () => `1 0 0:1 / ${escaped} rw - ext4 /dev/root rw\n2 1 0:2 / ${escaped}/vendor rw - tmpfs tmpfs rw\n`;
  await assert.rejects(backend.prepare({ workspaceRoot: project, argv: ["make"] }), { code: "ISOLATION_UNAVAILABLE" });
});

test("timeout, interruption, and output overflow kill and remove the sandbox", async (t) => {
  const timed = fixture(t, { hang: true, maximumRuntimeMs: 25 });
  const timeoutPlan = await timed.backend.prepare({ workspaceRoot: timed.project, argv: ["sleep", "100"], timeoutMs: 25 });
  await assert.rejects(timed.backend.run({ plan: timeoutPlan, workspaceRoot: timed.project, argv: timeoutPlan.argv, timeoutMs: 25 }), { code: "COMMAND_TIMEOUT" });
  assert.ok(timed.tracker.calls.includes("kill"));
  assert.ok(timed.tracker.calls.includes("rm"));

  const interrupted = fixture(t, { hang: true, onSpawn: null, maximumRuntimeMs: 1_000 });
  const controller = new AbortController();
  const interruptedPlan = await interrupted.backend.prepare({ workspaceRoot: interrupted.project, argv: ["sleep", "100"], timeoutMs: 1_000 });
  const pending = interrupted.backend.run({ plan: interruptedPlan, workspaceRoot: interrupted.project, argv: interruptedPlan.argv, timeoutMs: 1_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "COMMAND_INTERRUPTED" });
  assert.ok(interrupted.tracker.calls.includes("rm"));

  const overflow = fixture(t, { overflow: true });
  const overflowPlan = await overflow.backend.prepare({ workspaceRoot: overflow.project, argv: ["yes"] });
  await assert.rejects(overflow.backend.run({ plan: overflowPlan, workspaceRoot: overflow.project, argv: overflowPlan.argv }), { code: "OUTPUT_LIMIT" });
  assert.ok(overflow.tracker.calls.includes("rm"));
});

test("unconfigured and non-local images remain unavailable without a pull attempt", async (t) => {
  const unconfigured = fixture(t, { image: "" });
  const absent = await unconfigured.backend.inspect();
  assert.equal(absent.available, false);
  assert.equal(absent.reasonCode, "ISOLATION_IMAGE_UNCONFIGURED");
  assert.deepEqual(unconfigured.tracker.calls, ["info"]);

  const imageMissing = fixture(t, { imageMissing: true });
  const unavailable = await imageMissing.backend.inspect();
  assert.equal(unavailable.imagePresent, false);
  assert.equal(unavailable.available, false);
  assert.deepEqual(imageMissing.tracker.calls, ["info", "image"]);
  assert.doesNotMatch(JSON.stringify(unavailable), /secret-bearing|test-secret-must-not-pass/u);
});

test("uncertain container creation with unconfirmed removal is reported as cleanup failure", async (t) => {
  const state = fixture(t);
  const base = createPodmanRunner(state.tracker, {});
  state.backend.execFileImpl = async (executable, argv, options) => {
    const command = argv.includes("create") ? "create" : argv.includes("rm") ? "rm" : null;
    if (command === "create" || command === "rm") throw new Error("runtime detail must stay private");
    return base(executable, argv, options);
  };
  const plan = await state.backend.prepare({ workspaceRoot: state.project, argv: ["git", "status"] });
  await assert.rejects(state.backend.run({ plan, argv: ["git", "status"], workspaceRoot: state.project }), { code: "SANDBOX_CLEANUP_FAILED" });
  assert.equal(state.tracker.started, false);
});
