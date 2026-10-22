"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppServerClient } = require("../app-server-client");
const { buildCapabilityCatalog, createCapabilityProvider, findCapability, renderCapability, renderCatalogStatus } = require("../capability-catalog");
const { createCodexRuntimeStatusAdapter } = require("../codex-runtime-status");
const { runVesper } = require("../cli");

function temporaryProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-runtime-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(project, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "local",
    plugins: [{ name: "reviewer", policy: { installation: "AVAILABLE" } }],
  }));
  fs.mkdirSync(path.join(project, ".agents", "skills", "review"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Local review helper\n---\nprivate body\n");
  return { project, home, codexHome };
}

function capture() {
  let value = "";
  return { stream: { write: (text) => { value += String(text); } }, text: () => value };
}

test("Codex runtime adapter only normalizes passive startup observations from an existing thread", async () => {
  const unavailable = await createCodexRuntimeStatusAdapter().inspect();
  assert.equal(unavailable.status, "unsupported");
  assert.match(unavailable.detail, /does not start a runtime/u);

  const adapter = createCodexRuntimeStatusAdapter({ runtimeClient: {
    getMcpStartupStatusSnapshot: () => ({
      supported: true,
      items: [
        { name: "atlas", status: "ready", observedAt: "2026-10-22T00:00:00.000Z", error: "token=should-not-appear" },
        { name: "broken", status: "failed", observedAt: "2026-10-22T00:01:00.000Z", error: "password=hidden" },
        { name: "ignored", status: "connected", observedAt: "not-a-date" },
      ],
    }),
  } });
  const result = await adapter.inspect();
  assert.equal(result.status, "observed");
  assert.deepEqual(result.items.map(({ name, runtimeLoadedStatus, operationalStatus }) => ({ name, runtimeLoadedStatus, operationalStatus })), [
    { name: "atlas", runtimeLoadedStatus: "yes", operationalStatus: "unknown" },
    { name: "broken", runtimeLoadedStatus: "no", operationalStatus: "no" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /should-not-appear|password=hidden/u);

  const partial = await createCodexRuntimeStatusAdapter({ runtimeClient: {
    getMcpStartupStatusSnapshot: () => ({ supported: true, items: [{ name: "atlas", status: "ready" }], malformedCount: 1 }),
  } }).inspect();
  assert.equal(partial.status, "partial");
});

test("catalog accepts normalized runtime observations from future capability-type adapters", async () => {
  const catalog = await buildCapabilityCatalog({
    cwd: "/workspace/project",
    sourceAdapters: new Map([[
      "vendor-source",
      { type: "vendor", discover: async () => ({ items: [{ name: "extension" }], notes: [] }) },
    ]]),
    mapperRegistry: new Map([[
      "vendor",
      (item) => ({
        id: "vendor:extension",
        type: "vendor",
        name: item.name,
        displayName: item.name,
        source: { name: "local vendor manifest", location: [] },
        configurationStatus: "unknown",
        installationStatus: "unknown",
        availabilityStatus: "unknown",
      }),
    ]]),
    runtimeStatusAdapter: {
      provider: "vendor-runtime",
      async inspect() {
        return {
          status: "observed",
          provider: "vendor-runtime",
          source: "Vendor runtime status",
          items: [{
            type: "vendor",
            name: "extension",
            runtimeLoadedStatus: "yes",
            availabilityStatus: "available_for_use",
            operationalStatus: "unknown",
            observedAt: "2026-10-22T00:00:00.000Z",
          }],
        };
      },
    },
  });
  const extension = findCapability(catalog, "vendor:extension");
  assert.equal(extension.runtimeLoadedStatus, "yes");
  assert.equal(extension.availabilityStatus, "available_for_use");
  assert.equal(extension.operationalStatus, "unknown");
  assert.equal(extension.runtimeEvidence.source, "Vendor runtime status");
});

test("app-server captures bounded MCP startup notifications without retaining error text", () => {
  const client = new AppServerClient({ initialThreadId: "thread-a" });
  client.child = {};
  client.threadReady = true;
  client.handleNotification("mcpServer/startupStatus/updated", {
    threadId: "thread-a", name: "atlas", status: "ready", error: "token=do-not-store",
  });
  client.handleNotification("mcpServer/startupStatus/updated", {
    threadId: "other-thread", name: "wrong", status: "ready",
  });
  client.handleNotification("mcpServer/startupStatus/updated", {
    threadId: "thread-a", name: "bad-state", status: "connected",
  });

  const snapshot = client.getMcpStartupStatusSnapshot();
  assert.equal(snapshot.supported, true);
  assert.deepEqual(snapshot.items.map(({ name, status }) => ({ name, status })), [{ name: "atlas", status: "ready" }]);
  assert.equal(snapshot.malformedCount, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-store|wrong|bad-state/u);

  client.threadReady = false;
  assert.equal(client.getMcpStartupStatusSnapshot().supported, false);
});

test("catalog and CLI keep configured, runtime-loaded, and operational states separate", async (t) => {
  const { project, home, codexHome } = temporaryProject(t);
  const runtimeStatusAdapter = createCodexRuntimeStatusAdapter({ runtimeClient: {
    getMcpStartupStatusSnapshot: () => ({
      supported: true,
      items: [{ name: "atlas", status: "ready", observedAt: "2026-10-22T00:00:00.000Z" }],
    }),
  } });
  const common = {
    cwd: project,
    discoveryOptions: { home, codexHome },
    commandRunner: async () => JSON.stringify([
      { name: "atlas", enabled: true },
      { name: "sleeping", enabled: false },
    ]),
  };
  const catalog = await buildCapabilityCatalog({ ...common, runtimeStatusAdapter });
  const atlas = findCapability(catalog, "mcp:atlas");
  const sleeping = findCapability(catalog, "mcp:sleeping");
  const plugin = findCapability(catalog, "plugin:local/reviewer");
  const skill = findCapability(catalog, "skill:project/review/SKILL.md");

  assert.equal(atlas.configurationStatus, "enabled");
  assert.equal(atlas.enabledStatus, "yes");
  assert.equal(atlas.runtimeLoadedStatus, "yes");
  assert.equal(atlas.availabilityStatus, "available_for_use");
  assert.equal(atlas.operationalStatus, "unknown");
  assert.equal(atlas.runtimeEvidence.observedAt, "2026-10-22T00:00:00.000Z");
  assert.equal(sleeping.availabilityStatus, "unavailable");
  assert.equal(sleeping.runtimeLoadedStatus, "unknown");
  assert.equal(plugin.runtimeLoadedStatus, "unknown");
  assert.equal(skill.operationalStatus, "unknown");
  assert.match(renderCapability(atlas), /Runtime loaded: yes/u);
  assert.match(renderCapability(atlas), /Operational: unknown/u);
  assert.match(renderCatalogStatus(catalog), /Runtime inspection: observed/u);

  const provider = createCapabilityProvider({ ...common, runtimeStatusAdapter });
  const routerContext = await provider.getRouterContext();
  assert.equal(routerContext.runtimeInspection, "observed");
  assert.equal(routerContext.items.find((item) => item.id === "mcp:atlas").runtimeLoaded, "yes");
  assert.equal(routerContext.items.find((item) => item.id === "mcp:atlas").operational, "unknown");
  assert.doesNotMatch(JSON.stringify(routerContext), /observedAt|Runtime detail|private body/u);

  const output = capture();
  const errors = capture();
  const exitCode = await runVesper(["capabilities", "status", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: common.commandRunner,
  });
  assert.equal(exitCode, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /Runtime inspection: unsupported/u);
  assert.match(output.text(), /Runtime loaded: yes 0 · no 0 · unknown 4/u);
  assert.doesNotMatch(output.text(), /private body/u);

  const showOutput = capture();
  const showErrors = capture();
  const showExitCode = await runVesper(["capabilities", "show", "mcp:atlas", project], {
    output: showOutput.stream,
    errorOutput: showErrors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: common.commandRunner,
    runtimeStatusAdapter,
  });
  assert.equal(showExitCode, 0);
  assert.equal(showErrors.text(), "");
  assert.match(showOutput.text(), /Runtime loaded: yes/u);
  assert.match(showOutput.text(), /Operational: unknown/u);
  assert.match(showOutput.text(), /Runtime observed at: 2026-10-22T00:00:00\.000Z/u);
  assert.doesNotMatch(showOutput.text(), /private body|raw runtime error/u);
});

test("interactive capability commands show passive status from the existing Codex thread", async (t) => {
  const { project, home, codexHome } = temporaryProject(t);
  const output = capture();
  const errors = capture();
  const session = { sessionId: "session-local", cwd: project, threadId: "thread-local" };
  const appServer = {
    threadId: "thread-local",
    runTurn: async () => { throw new Error("No turn should be started by capability inspection."); },
    getMcpStartupStatusSnapshot: () => ({
      supported: true,
      items: [{ name: "atlas", status: "ready", observedAt: "2026-10-22T00:00:00.000Z" }],
      malformedCount: 0,
    }),
    dispose() {},
  };
  const answers = [":capabilities status", ":capabilities show mcp:atlas", ":quit"];
  const lineIO = {
    async question() { return answers.shift() ?? null; },
    onInterrupt() {},
    close() {},
  };
  const exitCode = await runVesper(["--new", project], {
    output: output.stream,
    errorOutput: errors.stream,
    lineIO,
    store: {
      create: () => session,
      touch: () => session,
      dispose() {},
    },
    clientFactory: () => appServer,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async () => JSON.stringify([{ name: "atlas", enabled: true }]),
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /Runtime inspection: observed/u);
  assert.match(output.text(), /Runtime loaded: yes 1 · no 0 · unknown 2/u);
  assert.match(output.text(), /Runtime loaded: yes\n/u);
  assert.match(output.text(), /Operational: unknown\n/u);
});
