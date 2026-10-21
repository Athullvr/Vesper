"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverMcp, discoverPlugins, discoverSkills, renderDiscovery } = require("../integration-discovery");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-discovery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
}

test("plugin discovery distinguishes cached, locally available, and unknown marketplace states", (t) => {
  const root = fixture(t);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const cachePlugin = path.join(codexHome, "plugins", "cache", "repo-market", "cached-tool", "1.0.0");
  fs.mkdirSync(path.join(cachePlugin), { recursive: true });
  writeJson(path.join(project, ".agents", "plugins", "marketplace.json"), {
    name: "repo-market",
    plugins: [
      { name: "cached-tool", policy: { installation: "AVAILABLE" }, description: "Do not display this private description." },
      { name: "catalog-tool", policy: { installation: "AVAILABLE" } },
      { name: "restricted-tool", policy: { installation: "REQUEST_ONLY" } },
    ],
  });
  writeJson(path.join(home, ".agents", "plugins", "marketplace.json"), {
    name: "personal-market",
    plugins: [{ name: "personal-tool", policy: { installation: "AVAILABLE" } }],
  });

  const result = discoverPlugins({ cwd: project, home, codexHome });
  const statuses = Object.fromEntries(result.items.map((item) => [item.name, item.status]));
  const output = renderDiscovery(result);
  assert.deepEqual(statuses, {
    "cached-tool": "installed",
    "catalog-tool": "available",
    "restricted-tool": "unknown",
    "personal-tool": "available",
  });
  assert.match(output, /project \.agents\/plugins\/marketplace\.json/u);
  assert.match(output, /user ~\/\.agents\/plugins\/marketplace\.json/u);
  assert.doesNotMatch(output, /private description/u);
  assert.match(output, /enabled or loaded state is unknown/u);
  assert.match(output, /Remote, universal, and managed marketplace state is unknown/u);
});

test("skill discovery reports manifest availability without printing skill instructions", (t) => {
  const root = fixture(t);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const repoSkill = path.join(project, ".agents", "skills", "repo-check", "SKILL.md");
  const userSkill = path.join(codexHome, "skills", "user-check", "SKILL.md");
  const nestedSkill = path.join(codexHome, "skills", ".system", "nested-check", "SKILL.md");
  const malformedSkill = path.join(project, ".agents", "skills", "unknown-check", "SKILL.md");
  fs.mkdirSync(path.dirname(repoSkill), { recursive: true });
  fs.mkdirSync(path.dirname(userSkill), { recursive: true });
  fs.mkdirSync(path.dirname(nestedSkill), { recursive: true });
  fs.mkdirSync(path.dirname(malformedSkill), { recursive: true });
  fs.writeFileSync(repoSkill, "---\nname: repo-check\ndescription: private description\n---\nprivate instruction body\n");
  fs.writeFileSync(userSkill, "---\nname: user-check\ndescription: user description\n---\nuser instruction body\n");
  fs.writeFileSync(nestedSkill, "---\nname: nested-check\ndescription: nested description\n---\nnested instruction body\n");
  fs.writeFileSync(malformedSkill, "not valid frontmatter\nprivate text\n");

  const result = discoverSkills({ cwd: project, home, codexHome });
  const statuses = Object.fromEntries(result.items.map((item) => [item.name, item.status]));
  const output = renderDiscovery(result);
  assert.equal(statuses["repo-check"], "available");
  assert.equal(statuses["user-check"], "available");
  assert.equal(statuses["nested-check"], "available");
  assert.equal(statuses["unknown-check"], "unknown");
  assert.match(output, /project \.agents\/skills\/repo-check\/SKILL\.md/u);
  assert.match(output, /user CODEX_HOME\/skills\/user-check\/SKILL\.md/u);
  assert.match(output, /user CODEX_HOME\/skills\/.system\/nested-check\/SKILL\.md/u);
  assert.doesNotMatch(output, /private description|private instruction|user description|user instruction|nested description|nested instruction/u);
  assert.match(output, /whether Codex loaded or activated it is unknown/u);
});

test("MCP discovery uses Codex's JSON listing and prints only names and status", async () => {
  let invoked;
  const result = await discoverMcp({
    cwd: "/workspace/project",
    commandRunner: async (command, args, options) => {
      invoked = { command, args, cwd: options.cwd };
      return JSON.stringify([
        { name: "enabled-server", enabled: true, transport: { command: "secret-command", env: { TOKEN: "secret-token" } } },
        { name: "disabled-server", enabled: false, transport: { url: "https://example.invalid/?token=secret-token" } },
        { name: "unknown-state-server", transport: { args: ["secret-argument"] } },
      ]);
    },
  });
  const statuses = Object.fromEntries(result.items.map((item) => [item.name, item.status]));
  const output = renderDiscovery(result);

  assert.deepEqual(invoked, { command: "codex", args: ["mcp", "list", "--json"], cwd: "/workspace/project" });
  assert.deepEqual(statuses, {
    "enabled-server": "installed",
    "disabled-server": "available",
    "unknown-state-server": "unknown",
  });
  assert.match(output, /codex mcp list --json/u);
  assert.doesNotMatch(output, /secret-command|secret-token|secret-argument|example\.invalid/u);
  assert.match(output, /configured but disabled/u);
  assert.match(output, /unconfigured servers/u);
});

test("MCP discovery reports unknown and a useful error without exposing process output", async () => {
  const result = await discoverMcp({
    cwd: "/workspace/project",
    commandRunner: async () => {
      const error = new Error("private error with token=secret-token");
      error.code = "ENOENT";
      throw error;
    },
  });
  const output = renderDiscovery(result);
  assert.equal(result.failed, true);
  assert.equal(result.items[0].status, "unknown");
  assert.match(output, /Codex CLI was not found on PATH/u);
  assert.doesNotMatch(output, /secret-token/u);
});
