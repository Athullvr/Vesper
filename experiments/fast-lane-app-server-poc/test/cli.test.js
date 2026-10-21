"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, resolveProjectDirectory, runVesper } = require("../cli");
const { SessionStore } = require("../session-store");
const { FileChangeApprovalStore } = require("../file-change-approval");

class FakeLineIO {
  constructor(answers) { this.answers = [...answers]; this.closed = false; }
  async question() { return this.answers.length ? this.answers.shift() : null; }
  onInterrupt() {}
  close() { this.closed = true; }
}

function capture() {
  let value = "";
  return { stream: { write: (text) => { value += String(text); } }, text: () => value };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-cli-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function clientFactoryFor(calls, historyTurns = []) {
  return (options) => {
    const client = new EventEmitter();
    client.initialThreadId = options.initialThreadId;
    client.threadId = options.initialThreadId;
    client.turns = [];
    client.events = [];
    client.resumeThread = async (cwd) => {
      client.events.push(["resume", cwd]);
      return client.threadId;
    };
    client.readThreadHistory = async () => {
      client.events.push(["history"]);
      return { threadId: client.threadId, turns: historyTurns, truncated: false };
    };
    client.runTurn = async (request) => {
      client.events.push(["turn"]);
      client.turns.push(request);
      if (!client.threadId) {
        client.initialThreadId = "codex-thread-1";
        client.threadId = client.initialThreadId;
        await options.onThreadId(client.threadId);
      }
      request.onDelta("Mocked Codex answer.");
      return { status: "completed" };
    };
    client.interrupt = async () => false;
    client.dispose = () => { client.disposed = true; };
    calls.push(client);
    return client;
  };
}

test("CLI parsing supports explicit new sessions and resume without silently accepting unknown flags", () => {
  assert.deepEqual(parseArgs(["--new", "/workspace"]), {
    command: "run", newSession: true, resumeId: null, help: false, projectDirectory: "/workspace",
  });
  assert.deepEqual(parseArgs(["--resume", "00000000-0000-4000-8000-000000000000"]), {
    command: "run", newSession: false, resumeId: "00000000-0000-4000-8000-000000000000", help: false, projectDirectory: null,
  });
  assert.throws(() => parseArgs(["--new", "--resume", "00000000-0000-4000-8000-000000000000"]), /either --new or --resume/u);
  assert.throws(() => parseArgs(["--skip-approval"]), /Unknown option/u);
  assert.equal(parseArgs(["run", "--help"]).help, true);
  assert.deepEqual(parseArgs(["sessions", "list", "/workspace"]), {
    command: "sessions", action: "list", projectDirectory: "/workspace", help: false,
  });
  assert.deepEqual(parseArgs(["sessions", "resume", "session-id", "/workspace"]), {
    command: "sessions", action: "resume", sessionId: "session-id", projectDirectory: "/workspace", help: false,
  });
  assert.deepEqual(parseArgs(["plugins"]), { command: "plugins", projectDirectory: null, help: false });
  assert.deepEqual(parseArgs(["mcp", "/workspace"]), { command: "mcp", projectDirectory: "/workspace", help: false });
  assert.throws(() => parseArgs(["sessions", "resume"]), /requires a Vesper session id/u);
  assert.throws(() => parseArgs(["sessions", "list", "--all"]), /Unexpected option/u);
  assert.throws(() => parseArgs(["skills", "--all"]), /Unknown option/u);
  assert.throws(() => parseArgs(["modules"]), /not implemented/u);
});

test("the package exposes a vesper entry point and help does not create a session", async (t) => {
  const root = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entryPoint = path.resolve(root, manifest.bin.vesper);
  const store = new SessionStore({ directory: path.join(fixture(t), "sessions") });
  const output = capture();
  const errors = capture();
  const status = await runVesper(["--help"], { store, output: output.stream, errorOutput: errors.stream });

  assert.equal(manifest.bin.vesper, "./bin/vesper.js");
  assert.equal(fs.existsSync(entryPoint), true);
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /Usage:[\s\S]*vesper \[run\]/u);
  assert.match(output.text(), /most recently updated session/u);
  assert.match(output.text(), /vesper sessions list/u);
  assert.match(output.text(), /:routing to inspect current-session routing counts/u);
  assert.match(output.text(), /read-only/u);
  assert.equal(fs.existsSync(store.directory), false);
});

test("sessions list resolves project aliases, isolates sessions, orders by update time, and omits thread ids", async (t) => {
  const root = fixture(t);
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  fs.mkdirSync(project);
  fs.mkdirSync(otherProject);
  const alias = path.join(root, "project-alias");
  fs.symlinkSync(project, alias, "dir");
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const older = store.create(fs.realpathSync(project));
  store.update(older.sessionId, { threadId: "codex-private-thread-old" });
  const other = store.create(fs.realpathSync(otherProject));
  const newer = store.create(fs.realpathSync(project));
  store.update(newer.sessionId, { threadId: "codex-private-thread-new" });
  const output = capture();
  const errors = capture();

  const status = await runVesper(["sessions", "list", alias], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
  });

  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.ok(output.text().indexOf(newer.sessionId) < output.text().indexOf(older.sessionId));
  assert.match(output.text(), new RegExp(newer.sessionId));
  assert.match(output.text(), new RegExp(older.sessionId));
  assert.doesNotMatch(output.text(), new RegExp(other.sessionId));
  assert.doesNotMatch(output.text(), /codex-private-thread/u);
  assert.match(output.text(), /UPDATED \(UTC\)/u);
});

test("sessions new starts a separate local-first session and preserves the prior session", async (t) => {
  const root = fixture(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const previous = store.create(fs.realpathSync(project));
  store.update(previous.sessionId, { threadId: "codex-existing-thread" });
  const output = capture();
  const errors = capture();

  const status = await runVesper(["sessions", "new", project], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["What Git branch am I on?", ":quit"]),
    runGit: async () => "feature/session-new\n",
    clientOptions: { spawnProcess: () => assert.fail("A local request must not start Codex.") },
  });

  const createdId = output.text().match(/Vesper session: ([0-9a-f-]+)/u)?.[1];
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.notEqual(createdId, previous.sessionId);
  assert.equal(store.load(previous.sessionId).threadId, "codex-existing-thread");
  assert.equal(store.load(createdId).cwd, fs.realpathSync(project));
  assert.equal(store.listByCwd(fs.realpathSync(project)).length, 2);
  assert.match(output.text(), /Current Git branch: feature\/session-new/u);
});

test("sessions resume uses the saved id only after the existing Codex reconnect verification", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const saved = store.create(fs.realpathSync(root));
  store.update(saved.sessionId, { threadId: "codex-saved-thread" });
  const clients = [];
  const output = capture();
  const errors = capture();

  const status = await runVesper(["sessions", "resume", saved.sessionId, root], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["Continue this task", ":quit"]),
    clientFactory: clientFactoryFor(clients),
  });

  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.equal(clients[0].initialThreadId, "codex-saved-thread");
  assert.deepEqual(clients[0].events.slice(0, 3), [
    ["resume", fs.realpathSync(root)], ["history"], ["turn"],
  ]);
  assert.equal(store.load(saved.sessionId).threadId, "codex-saved-thread");
});

test("sessions resume rejects unknown ids and a different project before starting Codex", async (t) => {
  const root = fixture(t);
  const firstProject = path.join(root, "first");
  const secondProject = path.join(root, "second");
  fs.mkdirSync(firstProject);
  fs.mkdirSync(secondProject);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const saved = store.create(fs.realpathSync(firstProject));
  const errors = capture();
  let clientsCreated = 0;

  const unknownStatus = await runVesper(["sessions", "resume", "00000000-0000-4000-8000-000000000000", firstProject], {
    store,
    output: capture().stream,
    errorOutput: errors.stream,
    clientFactory: () => { clientsCreated += 1; return assert.fail("Unknown ids must not start Codex."); },
  });
  assert.equal(unknownStatus, 1);
  assert.match(errors.text(), /was not found/u);

  const mismatchErrors = capture();
  const mismatchStatus = await runVesper(["sessions", "resume", saved.sessionId, secondProject], {
    store,
    output: capture().stream,
    errorOutput: mismatchErrors.stream,
    clientFactory: () => { clientsCreated += 1; return assert.fail("Project mismatches must not start Codex."); },
  });
  assert.equal(mismatchStatus, 1);
  assert.match(mismatchErrors.text(), /belongs to .* selected project/u);
  assert.equal(clientsCreated, 0);
});

test("read-only discovery commands dispatch from the selected project without creating a session", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  fs.mkdirSync(path.join(root, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "local",
    plugins: [{ name: "read-only-plugin", policy: { installation: "AVAILABLE" } }],
  }));
  const pluginOutput = capture();
  const status = await runVesper(["plugins", root], {
    store,
    output: pluginOutput.stream,
    errorOutput: capture().stream,
    discoveryOptions: { codexHome: path.join(root, "codex-home"), home: root },
  });
  assert.equal(status, 0);
  assert.match(pluginOutput.text(), /read-only-plugin · available/u);
  assert.equal(fs.existsSync(store.directory), false);

  let commandCwd;
  const mcpOutput = capture();
  const mcpStatus = await runVesper(["mcp", root], {
    store,
    output: mcpOutput.stream,
    errorOutput: capture().stream,
    codexCommandRunner: async (_command, _args, options) => {
      commandCwd = options.cwd;
      return JSON.stringify([{ name: "configured-mcp", enabled: true }]);
    },
  });
  assert.equal(mcpStatus, 0);
  assert.equal(commandCwd, fs.realpathSync(root));
  assert.match(mcpOutput.text(), /configured-mcp · installed/u);
  assert.equal(fs.existsSync(store.directory), false);
});

test("local request returns without invoking Codex or creating a Codex thread", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const output = capture();
  const errors = capture();
  let appServerSpawnCount = 0;
  const status = await runVesper(["--new", root], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["What Git branch am I on?", ":quit"]),
    runGit: async (args, cwd) => {
      assert.deepEqual(args, ["branch", "--show-current"]);
      assert.equal(cwd, root);
      return "feature/local\n";
    },
    clientOptions: {
      spawnProcess: () => {
        appServerSpawnCount += 1;
        throw new Error("The local route must not launch Codex.");
      },
    },
  });

  const sessionId = output.text().match(/Vesper session: ([0-9a-f-]+)/u)?.[1];
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /Current Git branch: feature\/local/u);
  assert.match(output.text(), /\[Route · local · current_git_branch · handler status confirmed\]/u);
  assert.match(output.text(), /Session status: new · no Codex thread yet/u);
  assert.equal(appServerSpawnCount, 0);
  assert.equal(store.load(sessionId).threadId, null);
});

test("a launch without a project argument uses the current working directory", async (t) => {
  const cwd = fs.realpathSync(process.cwd());
  const store = new SessionStore({ directory: path.join(fixture(t), "sessions") });
  const output = capture();
  let gitCwd;

  const status = await runVesper(["--new"], {
    store,
    output: output.stream,
    errorOutput: capture().stream,
    lineIO: new FakeLineIO(["What Git branch am I on?", ":quit"]),
    runGit: async (_args, selectedCwd) => {
      gitCwd = selectedCwd;
      return "feature/cwd\n";
    },
    clientOptions: { spawnProcess: () => assert.fail("A local request must not start Codex.") },
  });

  assert.equal(status, 0);
  assert.equal(gitCwd, cwd);
  assert.ok(output.text().includes(`Project: ${cwd}\n`));
});

test("bare vesper launch enters the interactive workspace in the current project", async (t) => {
  const cwd = fs.realpathSync(process.cwd());
  const store = new SessionStore({ directory: path.join(fixture(t), "sessions") });
  const output = capture();
  const errors = capture();
  let codexStarts = 0;

  const status = await runVesper([], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["What Git branch am I on?", ":sessions", ":help", ":quit"]),
    runGit: async () => "feature/interactive\n",
    clientOptions: { spawnProcess: () => { codexStarts += 1; throw new Error("local routing must not start Codex"); } },
  });

  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.equal(codexStarts, 0);
  assert.ok(output.text().includes(`Project: ${cwd}\n`));
  assert.match(output.text(), /feature\/interactive/u);
  assert.match(output.text(), /:switch SESSION_ID/u);
  assert.match(output.text(), /Workspace commands: .*:routing/u);
});

test("Codex fallback persists a thread id in a fresh Vesper session", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const clients = [];
  const output = capture();
  const errors = capture();
  const status = await runVesper(["--new", root], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["Build a website", ":quit"]),
    clientFactory: clientFactoryFor(clients),
  });

  const sessionId = output.text().match(/Vesper session: ([0-9a-f-]+)/u)?.[1];
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), /Mocked Codex answer\./u);
  assert.equal(clients[0].turns[0].cwd, root);
  assert.equal(store.load(sessionId).threadId, "codex-thread-1");
  const sessionJson = fs.readFileSync(path.join(store.directory, `${sessionId}.json`), "utf8");
  assert.equal(sessionJson.includes("Build a website"), false);
  assert.equal(sessionJson.includes("Mocked Codex answer"), false);
});

test("resuming a Vesper session passes its saved Codex thread id to the frontend", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const saved = store.create(root);
  store.update(saved.sessionId, { threadId: "codex-saved-thread" });
  const clients = [];
  const output = capture();
  const errors = capture();

  const status = await runVesper(["--resume", saved.sessionId], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["Continue the task", ":quit"]),
    clientFactory: clientFactoryFor(clients),
  });

  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.equal(clients[0].initialThreadId, "codex-saved-thread");
  assert.equal(clients[0].turns.length, 1);
  assert.equal(clients[0].turns[0].cwd, root);
  assert.match(output.text(), new RegExp(saved.sessionId));
  assert.equal(store.load(saved.sessionId).cwd, root);
  assert.match(output.text(), /Vesper session: /u);
  assert.match(output.text(), /\[Vesper history · empty\]/u);
  assert.deepEqual(clients[0].events.slice(0, 3), [
    ["resume", root], ["history"], ["turn"],
  ]);
  assert.equal(fs.readdirSync(store.directory).filter((name) => name.endsWith(".json")).length, 1);
});

test("a project launch reuses its latest Vesper session and restores bounded Codex history before the next turn", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const saved = store.create(root);
  store.update(saved.sessionId, { threadId: "codex-saved-thread" });
  const clients = [];
  const output = capture();
  const errors = capture();
  const history = [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Prior question" }] },
      { id: "answer-1", type: "agentMessage", text: "Prior answer" },
    ],
  }];

  const status = await runVesper([root], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO(["Continue this project", ":quit"]),
    clientFactory: clientFactoryFor(clients, history),
  });

  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.match(output.text(), new RegExp(`Vesper session: ${saved.sessionId}`, "u"));
  assert.match(output.text(), /Session status: resumed · saved Codex thread/u);
  assert.match(output.text(), /Prior question/u);
  assert.match(output.text(), /Prior answer/u);
  assert.equal(store.load(saved.sessionId).threadId, "codex-saved-thread");
  assert.equal(fs.readdirSync(store.directory).filter((name) => name.endsWith(".json")).length, 1);
  assert.deepEqual(clients[0].events.slice(0, 3), [
    ["resume", root], ["history"], ["turn"],
  ]);
});

test("a failed saved-thread reconnect keeps the session and the next prompt can recover it", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const saved = store.create(root);
  store.update(saved.sessionId, { threadId: "codex-saved-thread" });
  const output = capture();
  let resumeAttempts = 0;
  let turnCount = 0;

  const status = await runVesper([root], {
    store,
    output: output.stream,
    errorOutput: capture().stream,
    lineIO: new FakeLineIO(["Continue", "Try again", ":quit"]),
    clientFactory: (options) => {
      assert.equal(options.initialThreadId, "codex-saved-thread");
      const client = new EventEmitter();
      client.resumeThread = async () => {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw new Error("temporary reconnect failure");
        return "codex-saved-thread";
      };
      client.readThreadHistory = async () => ({ threadId: "codex-saved-thread", turns: [], truncated: false });
      client.runTurn = async ({ onDelta }) => {
        turnCount += 1;
        onDelta("Recovered answer.");
        return { status: "completed" };
      };
      client.interrupt = async () => false;
      client.dispose = () => {};
      return client;
    },
  });

  assert.equal(status, 0);
  assert.equal(resumeAttempts, 2);
  assert.equal(turnCount, 1);
  assert.match(output.text(), /Codex error .* temporary reconnect failure/u);
  assert.match(output.text(), /Recovered answer\./u);
  assert.equal(store.load(saved.sessionId).threadId, "codex-saved-thread");
  assert.equal(fs.readdirSync(store.directory).filter((name) => name.endsWith(".json")).length, 1);
});

test("interactive session switching lists only this project, verifies reconnect, and recovers without losing sessions", async (t) => {
  const root = fixture(t);
  const otherProject = path.join(root, "other-project");
  fs.mkdirSync(otherProject);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const first = store.create(root);
  store.update(first.sessionId, { threadId: "codex-thread-first" });
  const second = store.create(root);
  store.update(second.sessionId, { threadId: "codex-thread-second" });
  const isolated = store.create(fs.realpathSync(otherProject));
  store.update(isolated.sessionId, { threadId: "codex-thread-other-project" });
  const clients = [];
  const output = capture();
  const errors = capture();

  const clientFactory = (options) => {
    const client = new EventEmitter();
    client.options = options;
    client.events = [];
    client.turns = [];
    client.resumeThread = async (cwd) => {
      client.events.push(["resume", cwd]);
      if (options.initialThreadId === "codex-thread-second" && client.events.filter(([kind]) => kind === "resume").length === 1) {
        throw new Error("temporary reconnect failure");
      }
      return options.initialThreadId;
    };
    client.readThreadHistory = async () => {
      client.events.push(["history"]);
      return { threadId: options.initialThreadId, turns: [], truncated: false };
    };
    client.runTurn = async (request) => {
      client.turns.push(request);
      client.events.push(["turn"]);
      request.onDelta(`Answer from ${options.initialThreadId}.`);
      return { status: "completed" };
    };
    client.interrupt = async () => false;
    client.dispose = () => { client.disposed = true; };
    clients.push(client);
    return client;
  };

  const status = await runVesper(["--resume", first.sessionId], {
    store,
    output: output.stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO([
      ":routing",
      ":sessions",
      `:switch ${isolated.sessionId}`,
      ":switch 00000000-0000-4000-8000-000000000000",
      `:switch ${second.sessionId}`,
      "Continue the second session",
      ":routing",
      `:switch ${first.sessionId}`,
      ":routing",
      "Continue the first session",
      ":routing",
      ":new",
      ":routing",
      ":sessions",
      ":quit",
    ]),
    clientFactory,
  });

  const visible = output.text();
  const createdId = visible.match(/\[Vesper\] New session: ([0-9a-f-]+)/u)?.[1];
  const routingReports = visible.split("Routing outcomes · current in-memory Vesper session").slice(1);
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  const initialList = visible.split("Use :switch SESSION_ID to resume one.")[0];
  assert.match(initialList, new RegExp(first.sessionId, "u"));
  assert.match(initialList, new RegExp(second.sessionId, "u"));
  assert.doesNotMatch(initialList, new RegExp(isolated.sessionId, "u"));
  assert.match(visible, /belongs to .* Vesper is running in/u);
  assert.match(visible, /was not found/u);
  assert.match(visible, /temporary reconnect failure/u);
  assert.match(visible, /Vesper history · empty/u);
  assert.match(visible, /Answer from codex-thread-second/u);
  assert.match(visible, /Answer from codex-thread-first/u);
  assert.ok(routingReports[0].startsWith(` ${first.sessionId}\n`));
  assert.ok(routingReports[1].startsWith(` ${second.sessionId}\n`));
  assert.ok(routingReports[2].startsWith(` ${first.sessionId}\n`));
  assert.ok(routingReports[3].startsWith(` ${first.sessionId}\n`));
  assert.deepEqual(routingReports.map((report) => Number(report.match(/Total tasks routed: (\d+)/u)?.[1])), [0, 1, 0, 1, 0]);
  assert.ok(createdId);
  assert.ok(routingReports[4].startsWith(` ${createdId}\n`));
  assert.notEqual(createdId, first.sessionId);
  assert.notEqual(createdId, second.sessionId);
  assert.equal(store.load(first.sessionId).threadId, "codex-thread-first");
  assert.equal(store.load(second.sessionId).threadId, "codex-thread-second");
  assert.equal(store.load(isolated.sessionId).threadId, "codex-thread-other-project");
  assert.equal(store.load(createdId).cwd, root);
  assert.equal(clients.length, 4);
  assert.deepEqual(clients[1].events.slice(0, 3), [["resume", root], ["resume", root], ["history"]]);
  assert.equal(clients[1].turns.length, 1);
  assert.deepEqual(clients[2].events.slice(0, 3), [["resume", root], ["history"], ["turn"]]);
  assert.equal(clients[0].disposed, true);
  assert.equal(clients[1].disposed, true);
  assert.equal(clients[2].disposed, true);
});

test("history retrieval failure is visible but does not prevent a verified saved thread from continuing", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const saved = store.create(root);
  store.update(saved.sessionId, { threadId: "codex-saved-thread" });
  const output = capture();
  let turnCount = 0;

  const status = await runVesper(["--resume", saved.sessionId], {
    store,
    output: output.stream,
    errorOutput: capture().stream,
    lineIO: new FakeLineIO(["Continue without restored history", ":quit"]),
    clientFactory: (options) => {
      const client = new EventEmitter();
      client.resumeThread = async () => options.initialThreadId;
      client.readThreadHistory = async () => { throw new Error("history endpoint unavailable"); };
      client.runTurn = async ({ onDelta }) => {
        turnCount += 1;
        onDelta("The saved thread remains usable.");
        return { status: "completed" };
      };
      client.interrupt = async () => false;
      client.dispose = () => {};
      return client;
    },
  });

  assert.equal(status, 0);
  assert.equal(turnCount, 1);
  assert.match(output.text(), /Vesper history · unavailable/u);
  assert.match(output.text(), /not treated it as empty/u);
  assert.match(output.text(), /The saved thread remains usable\./u);
  assert.equal(store.load(saved.sessionId).threadId, "codex-saved-thread");
});

test("resume rejects a different project directory before starting the app-server", async (t) => {
  const root = fixture(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-other-project-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const saved = store.create(root);
  const clients = [];
  const errors = capture();

  const status = await runVesper(["--resume", saved.sessionId, other], {
    store,
    output: capture().stream,
    errorOutput: errors.stream,
    lineIO: new FakeLineIO([":quit"]),
    clientFactory: clientFactoryFor(clients),
  });

  assert.equal(status, 1);
  assert.match(errors.text(), /does not match this saved Vesper session/u);
  assert.equal(clients.length, 0);
});

test("project path is canonicalized and must be a directory", (t) => {
  const root = fixture(t);
  const file = path.join(root, "file.txt");
  fs.writeFileSync(file, "temporary fixture");
  assert.equal(resolveProjectDirectory(root), fs.realpathSync(root));
  assert.equal(resolveProjectDirectory(), fs.realpathSync(process.cwd()));
  assert.throws(() => resolveProjectDirectory(path.join(root, "missing")), /does not exist/u);
  assert.throws(() => resolveProjectDirectory(file), /not a directory/u);
});

test("resumed CLI forwards file-review context while preserving session metadata and project", async (t) => {
  const root = fixture(t);
  const store = new SessionStore({ directory: path.join(root, ".vesper", "sessions") });
  const saved = store.create(root);
  const before = store.update(saved.sessionId, { threadId: "saved-codex-thread" });
  const output = capture();
  const errors = capture();
  let approval;
  const status = await runVesper(["--resume", saved.sessionId], {
    store, output: output.stream, errorOutput: errors.stream,
    lineIO: new FakeLineIO(["Edit a file", "yes", ":quit"]),
    clientFactory: (options) => {
      assert.equal(options.initialThreadId, before.threadId);
      const client = new EventEmitter();
      client.resumeThread = async () => before.threadId;
      client.readThreadHistory = async () => ({ threadId: before.threadId, turns: [], truncated: false });
      client.runTurn = async ({ cwd }) => {
        assert.equal(cwd, root);
        const params = { threadId: before.threadId, turnId: "resumed-turn", itemId: "patch-1", startedAtMs: 1 };
        const changes = new FileChangeApprovalStore(params.threadId);
        changes.record("item/fileChange/patchUpdated", {
          ...params, changes: [{ path: path.join(root, "example.txt"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n-before\n+after" }],
        }, params.turnId);
        approval = await options.onApproval("item/fileChange/requestApproval", params, changes.capture(params));
        changes.close();
        return { status: "completed" };
      };
      client.dispose = () => {};
      return client;
    },
  });
  assert.equal(status, 0);
  assert.equal(errors.text(), "");
  assert.deepEqual(approval, { decision: "accept" });
  assert.match(output.text(), /\| -before\n\| \+after/u);
  const after = store.load(saved.sessionId);
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.cwd, before.cwd);
  assert.equal(after.threadId, before.threadId);
  assert.ok(Date.parse(after.updatedAt) >= Date.parse(before.updatedAt));
  assert.equal(fs.readdirSync(store.directory).filter((file) => file.endsWith(".json")).length, 1);
  assert.equal(fs.existsSync(path.join(root, "example.txt")), false, "the mock approval never performs a real file operation");
});
