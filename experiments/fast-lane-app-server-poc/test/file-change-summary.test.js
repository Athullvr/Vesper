"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FileChangeApprovalStore } = require("../file-change-approval");
const { TerminalFrontend, renderFileChangeActivity, MAX_FILE_ACTIVITY_OUTPUT_LENGTH } = require("../terminal-frontend");

const THREAD = "thread-summary";
const TURN = "turn-summary";

function params(itemId = "file-1", changes = [change()]) {
  return { threadId: THREAD, turnId: TURN, itemId, changes };
}

function change(path = "/workspace/example.txt", diff = "--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n") {
  return { path, kind: { type: "update" }, diff };
}

function storeWithChanges(changes = [change()], itemId = "file-1") {
  const store = new FileChangeApprovalStore(THREAD);
  const eventParams = params(itemId, changes);
  const updates = store.record("item/fileChange/patchUpdated", eventParams, TURN);
  return { store, eventParams, updates };
}

test("matching cached evidence produces immutable, identity-scoped summaries with diff line counts", () => {
  const { store, updates } = storeWithChanges();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    threadId: THREAD,
    turnId: TURN,
    itemId: "file-1",
    number: 1,
    state: "updated",
    changes: [{ path: "/workspace/example.txt", pathTruncated: false, kind: "update", movePath: null, movePathTruncated: false, addedLines: 1, removedLines: 1 }],
    incomplete: false,
  });
  assert.ok(Object.isFrozen(updates[0]));
  assert.ok(Object.isFrozen(updates[0].changes));
  assert.deepEqual(store.activities(THREAD, TURN), updates);
  assert.deepEqual(store.activities("another-thread", TURN), []);
  assert.deepEqual(store.activities(THREAD, "another-turn"), []);
  assert.equal(Object.hasOwn(updates[0], "approvalStatus"), false);
  assert.equal(store.capture({ threadId: THREAD, turnId: TURN, itemId: "file-1" }).fileChange.changes[0].path, "/workspace/example.txt");
});

test("malformed, missing and oversized evidence is omitted and cannot expose an older summary", () => {
  const invalidCases = [
    { changes: undefined },
    { changes: [{ path: "/workspace/bad.txt", kind: { type: "execute" }, diff: "+bad" }] },
    { changes: [change("/workspace/large.txt", "x".repeat(8_001))] },
    { changes: [change("/workspace/large.txt".repeat(401), "+x")] },
  ];
  for (const [index, invalid] of invalidCases.entries()) {
    const { store } = storeWithChanges();
    const eventParams = { ...params(), ...invalid };
    const result = store.record("item/fileChange/patchUpdated", eventParams, TURN);
    assert.equal(result.length, 1, `case ${index} updates summary state`);
    assert.equal(result[0].state, "invalidated");
    assert.deepEqual(result[0].changes, []);
    assert.equal(result[0].incomplete, true);
    assert.equal(store.capture({ threadId: THREAD, turnId: TURN, itemId: "file-1" }), null);
  }

  const missingIdentity = storeWithChanges();
  const closed = missingIdentity.store.record("item/fileChange/patchUpdated", { itemId: "file-1", changes: [change()] }, TURN);
  assert.equal(closed[0].state, "invalidated");
  assert.deepEqual(closed[0].changes, []);

  const malformedLifecycle = new FileChangeApprovalStore(THREAD);
  const lifecycleUpdate = malformedLifecycle.record("item/started", {
    threadId: THREAD,
    turnId: TURN,
    startedAtMs: 1,
    item: { id: "missing-status", type: "fileChange", changes: [change()] },
  }, TURN);
  assert.equal(lifecycleUpdate[0].state, "invalidated");
  assert.deepEqual(lifecycleUpdate[0].changes, []);
});

test("multiple items remain separate and duplicate paths invalidate only their own evidence", () => {
  const store = new FileChangeApprovalStore(THREAD);
  store.record("item/fileChange/patchUpdated", params("file-1", [change()]), TURN);
  store.record("item/fileChange/patchUpdated", params("file-2", [change()]), TURN);
  assert.equal(store.activities(THREAD, TURN).length, 2);

  const duplicate = store.record("item/fileChange/patchUpdated", params("file-1", [change(), change()]), TURN);
  assert.equal(duplicate[0].state, "invalidated");
  assert.deepEqual(duplicate[0].changes, []);
  assert.equal(store.activities(THREAD, TURN).find((item) => item.itemId === "file-2").state, "updated");
  assert.equal(store.capture({ threadId: THREAD, turnId: TURN, itemId: "file-1" }), null);
});

test("evidence replacements update summaries and invalidation removes prior path details", () => {
  const { store, eventParams } = storeWithChanges();
  const firstContext = store.capture(eventParams);
  assert.ok(firstContext);
  const replacement = store.record("item/fileChange/patchUpdated", {
    ...eventParams,
    changes: [change("/workspace/new.txt", "--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+added\n")],
  }, TURN);
  assert.equal(firstContext.signal.aborted, true);
  assert.equal(replacement[0].state, "updated");
  assert.deepEqual(replacement[0].changes.map((item) => item.path), ["/workspace/new.txt"]);
  assert.equal(replacement[0].changes[0].addedLines, 1);
  assert.equal(replacement[0].changes[0].removedLines, 0);

  const invalidated = store.record("item/fileChange/patchUpdated", { ...eventParams, changes: [] }, TURN);
  assert.equal(invalidated[0].state, "invalidated");
  assert.deepEqual(invalidated[0].changes, []);
  assert.doesNotMatch(JSON.stringify(invalidated[0]), /new\.txt/u);
});

test("pre-ack, cross-thread and cross-turn notifications cannot enter another summary scope", () => {
  const store = new FileChangeApprovalStore(THREAD);
  store.record("item/fileChange/patchUpdated", { ...params("other-turn"), turnId: "other-turn" }, null);
  store.record("item/fileChange/patchUpdated", { ...params("other-thread"), threadId: "another-thread" }, null);
  store.record("item/fileChange/patchUpdated", params("file-current"), TURN);
  assert.deepEqual(store.activities(THREAD, "other-turn").map((item) => item.itemId), ["other-turn"]);
  assert.deepEqual(store.activities(THREAD, TURN).map((item) => item.itemId), ["file-current"]);
  store.record("item/fileChange/patchUpdated", { ...params("late-other-turn"), turnId: "other-turn" }, TURN);
  assert.deepEqual(store.activities(THREAD, TURN).map((item) => item.itemId), ["file-current"]);
});

test("duplicate notifications are idempotent while item completion removes path details", () => {
  const { store, eventParams, updates } = storeWithChanges();
  assert.deepEqual(store.record("item/fileChange/patchUpdated", eventParams, TURN), []);
  const completed = store.record("item/completed", {
    threadId: THREAD,
    turnId: TURN,
    completedAtMs: 10,
    item: { id: "file-1", type: "fileChange", status: "completed", changes: [change()] },
  }, TURN);
  assert.equal(completed[0].state, "completed");
  assert.deepEqual(completed[0].changes, []);
  assert.doesNotMatch(JSON.stringify(completed[0]), /example\.txt/u);
  const latePatch = store.record("item/fileChange/patchUpdated", {
    ...eventParams,
    changes: [change("/workspace/late.txt", "@@ -0,0 +1 @@\n+late\n")],
  }, TURN);
  assert.deepEqual(latePatch, [], "late patch notifications cannot reopen completed evidence");
  assert.equal(store.activities(THREAD, TURN)[0].state, "completed");
  assert.deepEqual(store.activities(THREAD, TURN)[0].changes, []);
  assert.ok(updates[0].changes.length, "the starting evidence was available before completion");
});

test("non-hunk and binary-style diffs do not get invented line counts", () => {
  const { updates } = storeWithChanges([change("/workspace/image.bin", "Binary files a/image.bin and b/image.bin differ")]);
  assert.equal(updates[0].changes[0].addedLines, null);
  assert.equal(updates[0].changes[0].removedLines, null);
  assert.equal(updates[0].incomplete, true);
  assert.match(renderFileChangeActivity(updates[0]), /line counts unavailable/u);
  assert.match(renderFileChangeActivity(updates[0]), /summary incomplete/u);

  const addedHeaderLikeText = storeWithChanges([change("/workspace/text.txt", "@@ -0,0 +1 @@\n+++ this is file content\n")]);
  assert.equal(addedHeaderLikeText.updates[0].changes[0].addedLines, 1);
  assert.equal(addedHeaderLikeText.updates[0].changes[0].removedLines, 0);
});

test("turn close and interruption invalidate current evidence without claiming a disk change", () => {
  const { store } = storeWithChanges();
  const closed = store.close();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].state, "invalidated");
  const rendered = renderFileChangeActivity(closed[0]);
  assert.match(rendered, /evidence invalidated/u);
  assert.match(rendered, /no file paths are shown/u);
  assert.doesNotMatch(rendered, /written|write succeeded|applied successfully/u);
  assert.deepEqual(store.activities(THREAD, TURN), []);
});

test("approval refusal and cancellation remain separate from the cached summary state", async () => {
  for (const [answer, decision, label] of [["no", "decline", "decline"], ["cancel", "cancel", "cancel"]]) {
    const { store, eventParams } = storeWithChanges();
    const context = store.capture(eventParams);
    let text = "";
    const frontend = new TerminalFrontend({
      cwd: "/workspace",
      handlers: {},
      appServer: { runTurn() {} },
      output: { write: (value) => { text += String(value); } },
      lineIO: { question: async () => answer },
    });
    frontend.handleProgress({ type: "file_change_activity", activity: store.activities(THREAD, TURN)[0] });
    assert.deepEqual(await frontend.requestApproval("item/fileChange/requestApproval", eventParams, context), { decision });
    assert.match(text, /evidence updated/u);
    assert.match(text, new RegExp(`Approval choice: ${label}`, "u"));
    assert.equal(store.activities(THREAD, TURN)[0].state, "updated");
    assert.doesNotMatch(text, /approval approved|file written|write succeeded|applied successfully/u);
  }
});

test("summary rendering escapes terminal controls, redacts common secrets and bounds path and item output", () => {
  const rendered = renderFileChangeActivity({
    threadId: THREAD,
    turnId: TURN,
    itemId: "file-unsafe",
    number: 1,
    state: "updated",
    incomplete: false,
    changes: [{
      path: `/workspace/name\u001b[2J\r\u0000‮ --token=secret-value ${"x".repeat(4_000)}`,
      kind: "update",
      addedLines: 2,
      removedLines: 1,
    }],
  });
  assert.doesNotMatch(rendered, /[\u001b\r\u0000‮]/u);
  assert.match(rendered, /\\x1b\[2J\\r\\u0000/u);
  assert.match(rendered, /--token=\[redacted\]/u);
  assert.match(rendered, /path truncated|summary incomplete/u);
  assert.ok(rendered.length < 2_500);

  const manyItems = Array.from({ length: 65 }, (_, index) => ({
    threadId: THREAD,
    turnId: TURN,
    itemId: `item-${index}`,
    number: index + 1,
    state: "updated",
    incomplete: false,
    changes: [change(`/workspace/${index}.txt`)].map((entry) => ({
      path: entry.path, kind: "update", addedLines: 1, removedLines: 1,
    })),
  }));
  const { TerminalFrontend } = require("../terminal-frontend");
  const frontend = new TerminalFrontend({ cwd: "/workspace", handlers: {}, appServer: { runTurn() {} }, output: { write() {} }, lineIO: {} });
  frontend.renderFileChangeActivities(manyItems);
  assert.ok(frontend.fileActivityOutputLength <= MAX_FILE_ACTIVITY_OUTPUT_LENGTH);
  assert.equal(frontend.fileActivityLimitReported, true);

  const manyPaths = renderFileChangeActivity({
    threadId: THREAD, turnId: TURN, itemId: "many-paths", number: 1, state: "updated", incomplete: false,
    changes: Array.from({ length: 10 }, (_, index) => ({
      path: `/workspace/${index}.txt`, kind: "add", addedLines: 1, removedLines: 0,
    })),
  });
  assert.match(manyPaths, /summary truncated: 2 change entries omitted/u);
  assert.match(manyPaths, /summary incomplete or truncated/u);
});

