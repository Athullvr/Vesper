"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCapabilityCatalog, findCapability, renderCapability, renderCatalogStatus, summarizeCatalog } = require("../capability-catalog");
const { parseMcpConfiguration } = require("../capability-management");
const { parseArgs, runVesper } = require("../cli");
const { routeRequest } = require("../routing-core");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-capability-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function capture() {
  let value = "";
  return { stream: { write: (text) => { value += String(text); } }, text: () => value };
}

function createDiscoveryFixture(root) {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(path.join(project, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "local-market",
    plugins: [
      { name: "candidate", interface: { displayName: "Candidate UI" }, description: "A local helper plugin", policy: { installation: "AVAILABLE" } },
      { name: "restricted", policy: { installation: "REQUEST_ONLY" } },
    ],
  }));
  const skill = path.join(project, ".agents", "skills", "review", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: review\ndescription: Reviews local changes\n---\nprivate instruction body\n");
  return { project, home, codexHome };
}

test("unified catalog assigns stable ids and separates discovery, configuration, and availability", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  const catalog = await buildCapabilityCatalog({
    cwd: project,
    discoveryOptions: { home, codexHome },
    commandRunner: async () => JSON.stringify([
      { name: "active-server", enabled: true, command: "private-command", env: { TOKEN: "secret-token" } },
      { name: "disabled-server", enabled: false },
    ]),
  });
  const active = findCapability(catalog, "mcp:active-server");
  const plugin = findCapability(catalog, "plugin:local-market/candidate");
  const restricted = findCapability(catalog, "plugin:local-market/restricted");
  const skill = findCapability(catalog, "skill:project/review/SKILL.md");

  assert.equal(active.configurationStatus, "enabled");
  assert.equal(active.availabilityStatus, "unknown");
  assert.equal(active.operationalStatus, "unknown");
  assert.equal(plugin.installationStatus, "not_installed");
  assert.equal(plugin.availabilityStatus, "available_for_install");
  assert.equal(plugin.description, "A local helper plugin");
  assert.equal(plugin.displayName, "Candidate UI");
  assert.equal(restricted.installationStatus, "not_installed");
  assert.equal(restricted.availabilityStatus, "unknown");
  assert.equal(skill.description, "Reviews local changes");
  assert.deepEqual(skill.actions, ["show"]);
  assert.match(renderCapability(skill), /Location:|Locations:/u);
  const status = renderCatalogStatus(catalog);
  assert.match(status, /Enabled configuration: 1/u);
  assert.match(status, /Available for use: 0/u);
  assert.doesNotMatch(status, /private-command|secret-token|private instruction body/u);
});

test("capability CLI parses list, search, inspect, and MCP configuration workflows", () => {
  assert.deepEqual(parseArgs(["capabilities"]), {
    command: "capabilities", action: "list", projectDirectory: null, help: false,
  });
  assert.deepEqual(parseArgs(["capabilities", "status", "/workspace"]), {
    command: "capabilities", action: "status", projectDirectory: "/workspace", help: false,
  });
  assert.deepEqual(parseArgs(["capabilities", "search", "git status"]), {
    command: "capabilities", action: "search", query: "git status", projectDirectory: null, help: false,
  });
  assert.deepEqual(parseArgs(["capabilities", "show", "mcp:server"]), {
    command: "capabilities", action: "show", capabilityId: "mcp:server", projectDirectory: null, help: false,
  });
  assert.deepEqual(parseArgs(["capabilities", "configure", "mcp", "local", "--stdio", "server", "--arg", "start"]), {
    command: "capabilities",
    action: "configure",
    capabilityType: "mcp",
    projectDirectory: null,
    mcpConfiguration: { name: "local", transport: "stdio", command: "server", url: null, args: ["start"], bearerTokenEnvVar: null },
    help: false,
  });
  assert.throws(() => parseMcpConfiguration("remote", { transport: "url", url: "https://host.invalid/path?token=secret" }), /may not contain credentials, query parameters/u);
  assert.throws(() => parseMcpConfiguration("remote", { transport: "url", url: "https://user:secret@host.invalid/path" }), /may not contain credentials/u);
});

test("capability list, search, show, and status dispatch through the CLI without creating sessions", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  const run = async (args) => {
    const output = capture();
    const errors = capture();
    const status = await runVesper(["capabilities", ...args], {
      output: output.stream,
      errorOutput: errors.stream,
      discoveryOptions: { home, codexHome },
      codexCommandRunner: async () => JSON.stringify([{ name: "configured", enabled: true }]),
    });
    assert.equal(status, 0);
    assert.equal(errors.text(), "");
    return output.text();
  };

  const list = await run([project]);
  const search = await run(["search", "local helper", "--project", project]);
  const show = await run(["show", "skill:project/review/SKILL.md", project]);
  const status = await run(["status", project]);
  assert.match(list, /plugin:local-market\/candidate/u);
  assert.match(search, /plugin:local-market\/candidate/u);
  assert.match(show, /Reviews local changes/u);
  assert.match(show, /skill:project\/review\/SKILL\.md/u);
  assert.match(status, /Discovered: 4/u);
});

test("routing receives capability context through a narrow provider interface without changing its decision", async () => {
  const capabilities = { getRouterContext: async () => ({ items: [{ id: "mcp:server", availableForUse: "unknown" }] }) };
  const result = await routeRequest("Explain a rebase", {
    context: { cwd: "/workspace", capabilities },
    fallback: async (decision, context) => ({ route: decision.route, capabilityContext: await context.capabilities.getRouterContext() }),
  });
  assert.equal(result.decision.route, "codex");
  assert.equal(result.fallbackResult.route, "codex");
  assert.deepEqual(result.fallbackResult.capabilityContext.items, [{ id: "mcp:server", availableForUse: "unknown" }]);
});

test("catalog accepts an additional source and capability mapper without changing CLI dispatch", async () => {
  const mapperRegistry = new Map([[
    "future",
    (item) => ({
      id: `future:${item.name}`,
      type: "future",
      name: item.name,
      displayName: item.name,
      description: null,
      source: { name: "test adapter", location: [] },
      configurationStatus: "unknown",
      availabilityStatus: "unknown",
      installationStatus: "unknown",
      operationalStatus: "unknown",
      requirementsStatus: "unknown",
      requiredPermissions: { status: "unknown", items: [] },
      declaredCapabilities: { status: "unknown", items: [] },
      actions: ["show"],
      detail: "test entry",
    }),
  ]]);
  const catalog = await buildCapabilityCatalog({
    cwd: "/workspace",
    mapperRegistry,
    sourceAdapters: new Map([[
      "future-source",
      { type: "future", discover: async () => ({ items: [{ name: "entry" }], notes: [] }) },
    ]]),
  });
  assert.equal(catalog.capabilities[0].id, "future:entry");
  assert.equal(summarizeCatalog(catalog).byType.future, 1);
});

test("capability removal requires exact confirmation before backup or Codex mutation", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  fs.mkdirSync(codexHome, { recursive: true });
  const config = path.join(codexHome, "config.toml");
  const original = 'other_setting = "keep-me"\n';
  fs.writeFileSync(config, original, { mode: 0o600 });
  let configured = true;
  const calls = [];
  const output = capture();
  const errors = capture();

  const status = await runVesper(["capabilities", "remove", "mcp:active-server", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "mcp" && args[1] === "list") {
        return JSON.stringify(configured ? [{ name: "active-server", enabled: true }] : []);
      }
      configured = false;
      return "removed";
    },
    confirmCapabilityAction: async (request) => {
      assert.equal(request.id, "mcp:active-server");
      assert.match(request.summary, /Remove MCP server active-server/u);
      return false;
    },
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, [["mcp", "list", "--json"]]);
  assert.equal(fs.readFileSync(config, "utf8"), original);
  assert.deepEqual(fs.readdirSync(codexHome), ["config.toml"]);
  assert.match(output.text(), /No changes made/u);
  assert.doesNotMatch(output.text() + errors.text(), /other_setting|keep-me/u);
});

test("confirmed MCP removal backs up the existing Codex config and verifies the result", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  fs.mkdirSync(codexHome, { recursive: true });
  const config = path.join(codexHome, "config.toml");
  const original = 'unrelated = "preserve this"\n';
  fs.writeFileSync(config, original, { mode: 0o600 });
  let configured = true;
  let mutationCalls = 0;
  const output = capture();
  const errors = capture();

  const status = await runVesper(["capabilities", "remove", "mcp:active-server", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async (_command, args) => {
      if (args[0] === "mcp" && args[1] === "list") {
        return JSON.stringify(configured ? [{ name: "active-server", enabled: true }] : []);
      }
      assert.deepEqual(args, ["mcp", "remove", "active-server"]);
      mutationCalls += 1;
      configured = false;
      return "removed";
    },
    confirmCapabilityAction: async (request) => request.id === "mcp:active-server",
  });

  const backupName = fs.readdirSync(codexHome).find((name) => name.includes("config.toml.vesper-backup-"));
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.equal(mutationCalls, 1);
  assert.ok(backupName);
  const backup = path.join(codexHome, backupName);
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.match(output.text(), /Completed and verified/u);
  assert.doesNotMatch(output.text() + errors.text(), /preserve this/u);
});

test("confirmed MCP configuration uses the documented Codex add command without exposing argument values", async (t) => {
  const root = fixture(t);
  const project = path.join(root, "project");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(project);
  let configured = false;
  let addArgs;
  const output = capture();
  const errors = capture();

  const status = await runVesper(["capabilities", "configure", "mcp", "new-server", "--stdio", "server-bin", "--arg", "argument-secret-value"], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { codexHome },
    codexCommandRunner: async (_command, args) => {
      if (args[0] === "mcp" && args[1] === "list") {
        return JSON.stringify(configured ? [{ name: "new-server", enabled: true }] : []);
      }
      addArgs = args;
      configured = true;
      return "configured";
    },
    confirmCapabilityAction: async (request) => request.id === "mcp:new-server",
  });

  assert.equal(status, 0);
  assert.deepEqual(addArgs, ["mcp", "add", "new-server", "--", "server-bin", "argument-secret-value"]);
  assert.match(output.text(), /Completed and verified/u);
  assert.match(output.text(), /values omitted/u);
  assert.doesNotMatch(output.text() + errors.text(), /server-bin|argument-secret-value/u);
  assert.equal(errors.text(), "");
});

test("project plugin enable and disable preserve config, create private backups, and verify only the project setting", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  const cached = path.join(codexHome, "plugins", "cache", "local-market", "candidate", "1.0.0");
  fs.mkdirSync(cached, { recursive: true });
  const projectCodex = path.join(project, ".codex");
  fs.mkdirSync(projectCodex);
  const config = path.join(projectCodex, "config.toml");
  const original = '# preserve this comment\r\n[tool]\r\nvalue = "keep this value"\r\n';
  fs.writeFileSync(config, original, { mode: 0o640 });
  let listCalls = 0;

  const run = async (action) => {
    const output = capture();
    const errors = capture();
    const status = await runVesper(["capabilities", action, "plugin:local-market/candidate", project], {
      output: output.stream,
      errorOutput: errors.stream,
      discoveryOptions: { home, codexHome },
      codexCommandRunner: async (_command, args) => {
        assert.deepEqual(args, ["mcp", "list", "--json"]);
        listCalls += 1;
        return "[]";
      },
      confirmCapabilityAction: async (request) => {
        assert.equal(request.id, "plugin:local-market/candidate");
        assert.match(request.summary, /project-scoped Codex override/u);
        assert.equal(request.configPath, config);
        return true;
      },
    });
    assert.equal(errors.text(), "");
    return { status, output: output.text() };
  };

  const enabled = await run("enable");
  assert.equal(enabled.status, 0, `${enabled.output}`);
  assert.match(enabled.output, /Completed and verified/u);
  assert.match(enabled.output, /\.codex\/config\.toml/u);
  const afterEnable = fs.readFileSync(config, "utf8");
  assert.ok(afterEnable.startsWith(original));
  assert.match(afterEnable, /\[plugins\."candidate@local-market"\]\r?\nenabled = true/u);
  assert.equal(fs.statSync(config).mode & 0o777, 0o640);
  let backups = fs.readdirSync(projectCodex).filter((name) => name.includes("config.toml.vesper-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(projectCodex, backups[0]), "utf8"), original);
  assert.equal(fs.statSync(path.join(projectCodex, backups[0])).mode & 0o777, 0o600);

  const catalog = await buildCapabilityCatalog({
    cwd: project,
    discoveryOptions: { home, codexHome },
    commandRunner: async () => "[]",
  });
  const plugin = findCapability(catalog, "plugin:local-market/candidate");
  assert.equal(plugin.configurationStatus, "enabled_project");
  assert.equal(plugin.availabilityStatus, "unknown");
  assert.ok(plugin.actions.includes("disable"));

  const disabled = await run("disable");
  assert.equal(disabled.status, 0);
  assert.match(fs.readFileSync(config, "utf8"), /enabled = false/u);
  backups = fs.readdirSync(projectCodex).filter((name) => name.includes("config.toml.vesper-backup-"));
  assert.equal(backups.length, 2);
  const backupContents = backups.map((name) => fs.readFileSync(path.join(projectCodex, name), "utf8"));
  assert.ok(backupContents.includes(original));
  assert.ok(backupContents.includes(afterEnable));
  assert.equal(listCalls, 4);
  assert.doesNotMatch(enabled.output + disabled.output, /keep this value|preserve this comment/u);
});

test("enabling a project plugin in a project without Codex config states and applies the new file modes", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  fs.mkdirSync(path.join(codexHome, "plugins", "cache", "local-market", "candidate", "1.0.0"), { recursive: true });
  const config = path.join(project, ".codex", "config.toml");
  const output = capture();
  const errors = capture();
  const status = await runVesper(["capabilities", "enable", "plugin:local-market/candidate", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async () => "[]",
    confirmCapabilityAction: async (request) => {
      assert.match(request.summary, /new config file uses mode 0600/u);
      assert.match(request.summary, /requested mode 0700/u);
      return true;
    },
  });

  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.match(fs.readFileSync(config, "utf8"), /enabled = true/u);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(config)).mode & 0o077, 0);
  assert.match(output.text(), /no existing .*config.toml is present/u);
});

test("project plugin toggle refuses a cache-only plugin before confirmation or backup", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  fs.mkdirSync(path.join(codexHome, "plugins", "cache", "local-market", "candidate", "1.0.0"), { recursive: true });
  fs.unlinkSync(path.join(project, ".agents", "plugins", "marketplace.json"));
  let confirmations = 0;
  let listCalls = 0;
  const output = capture();
  const errors = capture();
  const status = await runVesper(["capabilities", "enable", "plugin:local-market/candidate", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async () => {
      listCalls += 1;
      return "[]";
    },
    confirmCapabilityAction: async () => { confirmations += 1; return true; },
  });

  assert.equal(status, 1);
  assert.equal(listCalls, 1);
  assert.equal(confirmations, 0);
  assert.equal(fs.existsSync(path.join(project, ".codex", "config.toml")), false);
  assert.match(errors.text(), /installed plugin listed in this project's local marketplace/u);
});

test("project plugin toggle refuses a duplicate plugin table before confirmation and preserves config", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  fs.mkdirSync(path.join(codexHome, "plugins", "cache", "local-market", "candidate", "1.0.0"), { recursive: true });
  const projectCodex = path.join(project, ".codex");
  fs.mkdirSync(projectCodex);
  const config = path.join(projectCodex, "config.toml");
  const original = '[plugins."candidate@local-market"]\nenabled = false\n[plugins."candidate@local-market"]\nenabled = true\n';
  fs.writeFileSync(config, original, { mode: 0o600 });
  let confirmations = 0;
  const output = capture();
  const errors = capture();
  const status = await runVesper(["capabilities", "enable", "plugin:local-market/candidate", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async () => "[]",
    confirmCapabilityAction: async () => { confirmations += 1; return true; },
  });

  assert.equal(status, 1);
  assert.equal(confirmations, 0);
  assert.equal(fs.readFileSync(config, "utf8"), original);
  assert.deepEqual(fs.readdirSync(projectCodex), ["config.toml"]);
  assert.match(errors.text(), /cannot safely edit the project Codex config/u);
});

test("project plugin toggle detects a config created after confirmation instead of changing it without a backup", async (t) => {
  const root = fixture(t);
  const { project, home, codexHome } = createDiscoveryFixture(root);
  fs.mkdirSync(path.join(codexHome, "plugins", "cache", "local-market", "candidate", "1.0.0"), { recursive: true });
  const projectCodex = path.join(project, ".codex");
  const config = path.join(projectCodex, "config.toml");
  const externalConfig = '# created while the operation was awaiting confirmation\n';
  const output = capture();
  const errors = capture();
  const status = await runVesper(["capabilities", "enable", "plugin:local-market/candidate", project], {
    output: output.stream,
    errorOutput: errors.stream,
    discoveryOptions: { home, codexHome },
    codexCommandRunner: async () => "[]",
    confirmCapabilityAction: async () => {
      fs.mkdirSync(projectCodex);
      fs.writeFileSync(config, externalConfig, { mode: 0o600 });
      return true;
    },
  });

  assert.equal(status, 1);
  assert.equal(fs.readFileSync(config, "utf8"), externalConfig);
  assert.deepEqual(fs.readdirSync(projectCodex), ["config.toml"]);
  assert.match(errors.text(), /appeared after confirmation/u);
  assert.doesNotMatch(output.text(), /Completed and verified/u);
});
