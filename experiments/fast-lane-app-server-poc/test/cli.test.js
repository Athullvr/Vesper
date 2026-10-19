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

function clientFactoryFor(calls) {
  return (options) => {
    const client = new EventEmitter();
    client.initialThreadId = options.initialThreadId;
    client.turns = [];
    client.runTurn = async (request) => {
      client.turns.push(request);
      if (!client.initialThreadId) {
        client.initialThreadId = "codex-thread-1";
        await options.onThreadId(client.initialThreadId);
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
    newSession: true, resumeId: null, help: false, projectDirectory: "/workspace",
  });
  assert.deepEqual(parseArgs(["--resume", "00000000-0000-4000-8000-000000000000"]), {
    newSession: false, resumeId: "00000000-0000-4000-8000-000000000000", help: false, projectDirectory: null,
  });
  assert.throws(() => parseArgs(["--new", "--resume", "00000000-0000-4000-8000-000000000000"]), /either --new or --resume/u);
  assert.throws(() => parseArgs(["--skip-approval"]), /Unknown option/u);
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
  assert.match(output.text(), /no Codex turn/u);
  assert.match(output.text(), /Session status: new · no Codex thread yet/u);
  assert.equal(appServerSpawnCount, 0);
  assert.equal(store.load(sessionId).threadId, null);
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
  assert.equal(fs.readdirSync(store.directory).filter((name) => name.endsWith(".json")).length, 1);
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
  assert.equal(resolveProjectDirectory(root), fs.realpathSync(root));
  assert.throws(() => resolveProjectDirectory(path.join(root, "missing")), /does not exist/u);
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
  assert.deepEqual(store.load(saved.sessionId), before);
  assert.equal(fs.readdirSync(store.directory).filter((file) => file.endsWith(".json")).length, 1);
  assert.equal(fs.existsSync(path.join(root, "example.txt")), false, "the mock approval never performs a real file operation");
});
