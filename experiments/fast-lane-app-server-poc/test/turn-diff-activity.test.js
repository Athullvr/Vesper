"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TurnDiffActivityStore,
  MAX_TURN_DIFF_LENGTH,
  MAX_PENDING_TURN_DIFFS,
} = require("../turn-diff-activity");
const {
  renderTurnDiffActivity,
  MAX_TURN_DIFF_RENDERED_LENGTH,
} = require("../terminal-frontend");

const THREAD = "thread-turn-diff";
const TURN = "turn-turn-diff";

function event(diff, overrides = {}) {
  return { threadId: THREAD, turnId: TURN, diff, ...overrides };
}

test("valid turn diff notifications replace the bounded aggregate snapshot and stay item-free", () => {
  const store = new TurnDiffActivityStore(THREAD);
  const first = store.record(event("--- a/old.txt\n+++ b/old.txt\n"));
  assert.equal(first.evidenceState, "available");
  assert.equal(first.diff, "--- a/old.txt\n+++ b/old.txt\n");
  assert.equal(Object.hasOwn(first, "itemId"), false);

  const duplicate = store.record(event("--- a/old.txt\n+++ b/old.txt\n"));
  assert.equal(duplicate, null, "identical complete snapshots are idempotent");
  const replacement = store.record(event("--- a/new.txt\n+++ b/new.txt\n"));
  assert.equal(replacement.diff, "--- a/new.txt\n+++ b/new.txt\n");
  assert.ok(Object.isFrozen(replacement));

  store.bindTurn(THREAD, TURN);
  assert.equal(store.snapshot().diff, replacement.diff);
  const final = store.close("completed");
  assert.equal(final.diff, replacement.diff);
  assert.equal(final.evidenceState, "available");
  assert.equal(final.closeReason, "completed");
  assert.equal(Object.hasOwn(final, "itemId"), false);
  assert.equal(store.record(event("late snapshot")), null);
});

test("pre-ack snapshots bind only to the authoritative turn and foreign identities are ignored", () => {
  const store = new TurnDiffActivityStore(THREAD);
  store.record(event("stale", { turnId: "stale-turn" }));
  store.record(event("foreign", { threadId: "other-thread", turnId: TURN }));
  store.record(event("current", { turnId: TURN }));
  const bound = store.bindTurn(THREAD, TURN);
  assert.equal(bound.diff, "current");
  assert.equal(store.record(event("late stale", { turnId: "stale-turn" })), null);
  assert.equal(store.record(event("foreign", { threadId: "other-thread" })), null);
  assert.equal(store.snapshot().diff, "current");
});

test("missing, malformed and oversized evidence clears the previous snapshot explicitly", () => {
  const malformed = new TurnDiffActivityStore(THREAD);
  malformed.bindTurn(THREAD, TURN);
  malformed.record(event("previous snapshot"));
  const invalidated = malformed.record(event(undefined));
  assert.equal(invalidated.evidenceState, "unavailable");
  assert.equal(invalidated.evidenceReason, "malformed");
  assert.equal(invalidated.diff, "");
  const closedMalformed = malformed.close("completed");
  assert.equal(closedMalformed.evidenceState, "unavailable");
  assert.equal(closedMalformed.evidenceReason, "malformed");
  assert.equal(closedMalformed.diff, "");

  const missingIdentity = new TurnDiffActivityStore(THREAD);
  missingIdentity.bindTurn(THREAD, TURN);
  missingIdentity.record(event("previous snapshot"));
  const missing = missingIdentity.record({ threadId: THREAD, diff: "unscoped" });
  assert.equal(missing.evidenceState, "unavailable");
  assert.equal(missing.evidenceReason, "malformed");

  const oversized = new TurnDiffActivityStore(THREAD);
  oversized.bindTurn(THREAD, TURN);
  oversized.record(event("previous snapshot"));
  const tooLarge = oversized.record(event("x".repeat(MAX_TURN_DIFF_LENGTH + 1)));
  assert.equal(tooLarge.evidenceState, "unavailable");
  assert.equal(tooLarge.evidenceReason, "oversized");
  assert.equal(tooLarge.diff, "");
  assert.equal(oversized.close("completed").diff, "");
});

test("empty aggregate snapshots remain valid and no notification is reported as unavailable", () => {
  const empty = new TurnDiffActivityStore(THREAD);
  empty.bindTurn(THREAD, TURN);
  assert.equal(empty.record(event("")).evidenceState, "empty");
  const emptyView = renderTurnDiffActivity(empty.close("completed"));
  assert.match(emptyView, /latest aggregate snapshot is empty/u);
  assert.match(emptyView, /turn-level aggregate diff/u);

  const noEvent = new TurnDiffActivityStore(THREAD);
  noEvent.bindTurn(THREAD, TURN);
  const unavailable = noEvent.close("completed");
  assert.equal(unavailable.evidenceState, "unavailable");
  assert.equal(unavailable.evidenceReason, "no_snapshot");
  assert.match(renderTurnDiffActivity(unavailable), /did not report a snapshot/u);
});

test("turn-level view escapes terminal controls, redacts common secrets, and marks render truncation", () => {
  const store = new TurnDiffActivityStore(THREAD);
  store.bindTurn(THREAD, TURN);
  store.record(event("diff\n+API_KEY=topsecret\n+title \u001b]0;owned\u0007\n+hidden \u202e"));
  const view = renderTurnDiffActivity(store.close("completed"));
  assert.equal(view.includes("\u001b"), false);
  assert.equal(view.includes("topsecret"), false);
  assert.match(view, /API_KEY=\[redacted\]/u);
  assert.match(view, /\\x1b\]0;owned\\u0007/u);
  assert.match(view, /\\u202e/u);
  assert.match(view, /disk write not verified/u);
  assert.match(view, /not mapped to file-change items/u);
  assert.equal(Object.hasOwn(store.snapshot() || {}, "itemId"), false);

  const largeStore = new TurnDiffActivityStore(THREAD);
  largeStore.bindTurn(THREAD, TURN);
  largeStore.record(event("x".repeat(MAX_TURN_DIFF_LENGTH)));
  const largeView = renderTurnDiffActivity(largeStore.close("completed"));
  assert.ok(largeView.length <= MAX_TURN_DIFF_RENDERED_LENGTH);
  assert.match(largeView, /display truncated at the terminal output limit/u);
});

test("pending turn retention is bounded and overflow is explicit for an unknown evicted turn", () => {
  const store = new TurnDiffActivityStore(THREAD);
  for (let index = 0; index <= MAX_PENDING_TURN_DIFFS; index += 1) {
    store.record(event(`snapshot-${index}`, { turnId: `turn-${index}` }));
  }
  assert.ok(store.pending.size <= MAX_PENDING_TURN_DIFFS);
  store.bindTurn(THREAD, "evicted-turn");
  assert.equal(store.snapshot().evidenceState, "unavailable");
  assert.equal(store.snapshot().evidenceReason, "pre_ack_overflow");
});
