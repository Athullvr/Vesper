"use strict";

const { redactSensitiveText } = require("./command-activity");

const MAX_TURN_DIFF_LENGTH = 32_768;
const MAX_PENDING_TURN_DIFFS = 4;
const CLOSE_REASONS = new Set([
  "completed",
  "interrupted",
  "failed",
  "disconnected",
  "timeout",
  "client_closed",
  "unknown",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function sameEvidence(left, right) {
  return left?.evidenceState === right.evidenceState &&
    left?.evidenceReason === right.evidenceReason &&
    left?.diff === right.diff &&
    left?.sourceLength === right.sourceLength &&
    left?.redacted === right.redacted;
}

class TurnDiffActivityStore {
  constructor(threadId, { maxPendingTurns = MAX_PENDING_TURN_DIFFS } = {}) {
    this.threadId = threadId;
    this.maxPendingTurns = Number.isInteger(maxPendingTurns) && maxPendingTurns > 0
      ? Math.min(maxPendingTurns, MAX_PENDING_TURN_DIFFS)
      : MAX_PENDING_TURN_DIFFS;
    this.turnId = null;
    this.current = null;
    this.pending = new Map();
    this.pendingOverflowed = false;
    this.revision = 0;
    this.closed = false;
  }

  bindTurn(threadId, turnId) {
    if (this.closed || !isIdentity(this.threadId) || threadId !== this.threadId || !isIdentity(turnId)) return null;
    if (this.turnId) return this.turnId === turnId ? this.snapshot() : null;

    this.turnId = turnId;
    this.current = this.pending.get(turnId) || null;
    if (!this.current && this.pendingOverflowed) {
      this.current = this.makeState("unavailable", "pre_ack_overflow", "", 0, false);
    }
    this.pending.clear();
    this.pendingOverflowed = false;
    return this.snapshot();
  }

  record(params) {
    if (this.closed) return null;
    if (!isObject(params)) return this.turnId ? this.invalidate("malformed") : null;

    // A valid foreign thread is unrelated evidence and must not invalidate the
    // active turn's latest snapshot.
    if (isIdentity(params.threadId) && params.threadId !== this.threadId) return null;

    if (!isIdentity(params.threadId)) {
      if (!this.turnId) return null;
      if (isIdentity(params.turnId) && params.turnId !== this.turnId) return null;
      return this.invalidate("malformed");
    }
    if (!isIdentity(params.turnId)) return this.turnId ? this.invalidate("malformed") : null;
    if (this.turnId && params.turnId !== this.turnId) return null;

    let next;
    if (typeof params.diff !== "string") {
      next = this.makeState("unavailable", "malformed", "", 0, false, params.turnId);
    } else if (params.diff.length > MAX_TURN_DIFF_LENGTH) {
      next = this.makeState("unavailable", "oversized", "", params.diff.length, false, params.turnId);
    } else {
      const safeDiff = redactSensitiveText(params.diff);
      if (safeDiff.length > MAX_TURN_DIFF_LENGTH) {
        next = this.makeState("unavailable", "redaction_expanded", "", params.diff.length, true, params.turnId);
      } else {
        next = this.makeState(params.diff.length === 0 ? "empty" : "available", null, safeDiff, params.diff.length, safeDiff !== params.diff, params.turnId);
      }
    }

    if (this.turnId) return this.replaceCurrent(next);
    return this.replacePending(params.turnId, next);
  }

  snapshot() {
    return this.current ? Object.freeze({ ...this.current }) : null;
  }

  close(reason = "unknown") {
    if (this.closed || !isIdentity(this.threadId) || !isIdentity(this.turnId)) return null;
    const evidence = this.current || this.makeState("unavailable", "no_snapshot", "", 0, false);
    const activity = Object.freeze({
      threadId: this.threadId,
      turnId: this.turnId,
      evidenceState: evidence.evidenceState,
      evidenceReason: evidence.evidenceReason,
      closeReason: CLOSE_REASONS.has(reason) ? reason : "unknown",
      diff: evidence.evidenceState === "available" ? evidence.diff : "",
      sourceLength: evidence.sourceLength,
      redacted: evidence.redacted,
      revision: evidence.revision,
    });
    this.closed = true;
    this.current = null;
    this.pending.clear();
    return activity;
  }

  replaceCurrent(next) {
    if (sameEvidence(this.current, next)) return null;
    this.revision += 1;
    this.current = Object.freeze({ ...next, revision: this.revision });
    return this.snapshot();
  }

  replacePending(turnId, next) {
    const previous = this.pending.get(turnId);
    if (sameEvidence(previous, next)) return null;
    this.revision += 1;
    const entry = Object.freeze({ ...next, revision: this.revision });
    if (!previous && this.pending.size >= this.maxPendingTurns) {
      const oldestTurnId = this.pending.keys().next().value;
      this.pending.delete(oldestTurnId);
      this.pendingOverflowed = true;
    }
    this.pending.delete(turnId);
    this.pending.set(turnId, entry);
    return Object.freeze({ ...entry });
  }

  invalidate(reason) {
    const next = this.makeState("unavailable", reason, "", 0, false);
    return this.replaceCurrent(next);
  }

  makeState(evidenceState, evidenceReason, diff, sourceLength, redacted, turnId = this.turnId) {
    return {
      threadId: this.threadId,
      turnId,
      evidenceState,
      evidenceReason,
      diff,
      sourceLength,
      redacted,
      revision: this.revision,
    };
  }
}

module.exports = {
  TurnDiffActivityStore,
  MAX_TURN_DIFF_LENGTH,
  MAX_PENDING_TURN_DIFFS,
};
