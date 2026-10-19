"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SessionStore } = require("../session-store");

function temporaryRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-session-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("session metadata is private, atomic, and contains only Vesper session identifiers and project/thread metadata", (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ directory: path.join(root, "sessions"), now: () => new Date("2026-10-19T12:00:00.000Z") });
  const session = store.create("/workspace/project");
  const sessionPath = path.join(root, "sessions", `${session.sessionId}.json`);
  const directoryStat = fs.statSync(path.dirname(sessionPath));
  const fileStat = fs.statSync(sessionPath);

  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).sort(), [
    "createdAt", "cwd", "schemaVersion", "sessionId", "threadId", "updatedAt",
  ]);
  assert.deepEqual(store.load(session.sessionId), session);

  const updated = store.update(session.sessionId, { threadId: "codex-thread-123" });
  assert.equal(updated.threadId, "codex-thread-123");
  assert.equal(store.load(session.sessionId).threadId, "codex-thread-123");
  assert.throws(() => store.write({ ...session, prompt: "not stored" }), /Invalid Vesper session metadata/u);
  assert.throws(() => store.update(session.sessionId, { apiKey: "not stored" }), /Only the project directory/u);
});

test("session store rejects symlinked session files and directories", (t) => {
  const root = temporaryRoot(t);
  const directory = path.join(root, "sessions");
  const store = new SessionStore({ directory });
  const session = store.create("/workspace/project");
  const filePath = path.join(directory, `${session.sessionId}.json`);
  const target = path.join(root, "metadata-target.json");
  fs.writeFileSync(target, JSON.stringify(session));
  fs.unlinkSync(filePath);
  fs.symlinkSync(target, filePath);
  assert.throws(() => store.load(session.sessionId), /unsafe file type/u);

  const linkedDirectory = path.join(root, "linked-sessions");
  fs.symlinkSync(directory, linkedDirectory, "dir");
  const linkedStore = new SessionStore({ directory: linkedDirectory });
  assert.throws(() => linkedStore.load(session.sessionId), /private, non-symlink directory/u);
});

test("session ids, thread ids, and project paths are validated", (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  assert.throws(() => store.load("../../outside"), /session id must be a UUID/u);
  assert.throws(() => store.create("relative/project"), /must be absolute/u);

  const session = store.create("/workspace/project");
  assert.throws(() => store.update(session.sessionId, { threadId: "bad\nthread" }), /Invalid Vesper session metadata/u);
});

test("project lookup restores the most recently used exact canonical project session", (t) => {
  const root = temporaryRoot(t);
  let now = new Date("2026-10-19T12:00:00.000Z");
  const store = new SessionStore({ directory: path.join(root, "sessions"), now: () => now });
  const first = store.create("/workspace/project");
  const otherProject = store.create("/workspace/other");
  now = new Date("2026-10-19T12:01:00.000Z");
  const recent = store.create("/workspace/project");
  store.update(recent.sessionId, { threadId: "codex-thread-recent" });

  assert.equal(store.findLatestByCwd("/workspace/project").sessionId, recent.sessionId);
  assert.equal(store.findLatestByCwd("/workspace/project").threadId, "codex-thread-recent");
  assert.equal(store.findLatestByCwd("/workspace/other").sessionId, otherProject.sessionId);
  assert.equal(store.findLatestByCwd("/workspace/moved-project"), null);
  assert.equal(store.load(first.sessionId).threadId, null);
});

test("project lookup refuses malformed session metadata instead of silently creating a replacement", (t) => {
  const root = temporaryRoot(t);
  const directory = path.join(root, "sessions");
  const store = new SessionStore({ directory });
  const session = store.create("/workspace/project");
  fs.writeFileSync(path.join(directory, `${session.sessionId}.json`), "{ malformed", { mode: 0o600 });

  assert.throws(() => store.findLatestByCwd("/workspace/project"), /invalid JSON/u);
  assert.throws(() => store.findLatestByCwd("relative/project"), /absolute path/u);
});
