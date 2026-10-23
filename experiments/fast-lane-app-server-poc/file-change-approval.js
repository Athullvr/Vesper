"use strict";

// Match the terminal's existing review limits. Never retain an oversized patch
// and offer approval of a truncated representation.
const MAX_FIELD_LENGTH = 8_000;
const MAX_SNAPSHOT_LENGTH = 20_000;
const MAX_ITEMS_PER_TURN = 64;
const MAX_SUMMARY_PATH_LENGTH = 1_024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function isPath(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function createFileChangeSnapshot({ threadId, turnId, itemId, changes } = {}) {
  if (![threadId, turnId, itemId].every(isIdentity)) return null;
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_ITEMS_PER_TURN) return null;
  const paths = new Set();
  const copy = [];
  let size = 0;
  for (const change of changes) {
    if (!isObject(change) || Object.keys(change).some((key) => !["path", "kind", "diff"].includes(key))) return null;
    if (!isPath(change.path) || paths.has(change.path)) return null;
    paths.add(change.path);
    if (typeof change.diff !== "string" || !change.diff.trim() || change.diff.length > MAX_FIELD_LENGTH) return null;
    const kind = change.kind;
    if (!isObject(kind) || !["add", "delete", "update"].includes(kind.type)) return null;
    const keys = kind.type === "update" ? ["type", "move_path"] : ["type"];
    if (Object.keys(kind).some((key) => !keys.includes(key))) return null;
    if (kind.move_path !== undefined && kind.move_path !== null && !isPath(kind.move_path)) return null;
    const entry = Object.freeze({ path: change.path, kind: Object.freeze({ ...kind }), diff: change.diff });
    size += JSON.stringify(entry).length;
    if (size > MAX_SNAPSHOT_LENGTH) return null;
    copy.push(entry);
  }
  return Object.freeze({ threadId, turnId, itemId, changes: Object.freeze(copy) });
}

class FileChangeApprovalStore {
  constructor(threadId) {
    this.threadId = threadId;
    this.items = new Map();
    this.closed = false;
    this.nextNumber = 1;
  }

  record(method, params, acknowledgedTurnId) {
    const patch = method === "item/fileChange/patchUpdated";
    const lifecycle = method === "item/started" || method === "item/completed";
    if (this.closed || (!patch && !lifecycle)) return [];
    const itemId = patch ? params?.itemId : params?.item?.id;
    // Other tool items do not supply file-change evidence.
    if (!patch && params?.item?.type !== "fileChange") {
      const key = JSON.stringify([params?.threadId, params?.turnId, itemId]);
      const previous = this.items.get(key);
      if (previous) {
        previous.controller?.abort();
        const invalidated = {
          ...previous,
          snapshot: null,
          terminal: true,
          state: "invalidated",
        };
        this.items.set(key, invalidated);
        return [this.activitySnapshot(invalidated)];
      }
      return [];
    }
    if (isIdentity(params?.threadId) && params.threadId !== this.threadId) return [];
    if (acknowledgedTurnId && isIdentity(params?.turnId) && params.turnId !== acknowledgedTurnId) return [];
    if (![params?.threadId, params?.turnId, itemId].every(isIdentity)) {
      // An unscoped update cannot safely be assigned to an existing item.
      return this.close();
    }
    const key = JSON.stringify([params.threadId, params.turnId, itemId]);
    const previous = this.items.get(key);
    if (!previous && this.items.size >= MAX_ITEMS_PER_TURN) {
      return this.close();
    }
    previous?.controller?.abort();
    const terminal = previous?.terminal || method === "item/completed" ||
      (!patch && params.item.status !== "inProgress");
    const snapshot = terminal ? null : createFileChangeSnapshot({
      threadId: params.threadId, turnId: params.turnId, itemId,
      changes: patch ? params.changes : params.item.changes,
    });
    // Replace even invalid updates, so an older valid diff cannot authorize
    // newer malformed data. Item IDs cannot be reused after a request/completion.
    const hasValidLifecycleStatus = patch || method === "item/completed" ||
      ["inProgress", "completed", "failed", "declined"].includes(params.item?.status);
    const state = !hasValidLifecycleStatus || (!terminal && !snapshot)
      ? "invalidated"
      : terminal ? "completed" : patch ? "updated" : "pending";
    const entry = {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId,
      number: previous?.number || this.nextNumber++,
      sourceEventType: method,
      snapshot,
      terminal,
      requested: previous?.requested || false,
      state,
    };
    const fingerprint = JSON.stringify([state, snapshot]);
    const changed = previous?.fingerprint !== fingerprint;
    entry.fingerprint = fingerprint;
    this.items.set(key, entry);
    return changed ? [this.activitySnapshot(entry)] : [];
  }

  capture(params) {
    if (![params?.threadId, params?.turnId, params?.itemId].every(isIdentity)) return null;
    const key = JSON.stringify([params.threadId, params.turnId, params.itemId]);
    const entry = this.items.get(key);
    if (this.closed || !entry?.snapshot || entry.terminal || entry.requested) return null;
    entry.requested = true;
    entry.controller = new AbortController();
    return Object.freeze({
      fileChange: entry.snapshot,
      signal: entry.controller.signal,
      isCurrent: () => !this.closed && this.items.get(key) === entry && !entry.controller.signal.aborted,
    });
  }

  activities(threadId, turnId) {
    if (this.closed || threadId !== this.threadId || !isIdentity(threadId) || !isIdentity(turnId)) return [];
    return [...this.items.values()]
      .filter((entry) => entry.threadId === threadId && entry.turnId === turnId)
      .sort((left, right) => left.number - right.number)
      .map((entry) => this.activitySnapshot(entry));
  }

  activitySnapshot(entry) {
    const changes = entry.snapshot?.changes.map((change) => {
      const lineCounts = summarizeDiffLineCounts(change.diff);
      return Object.freeze({
        path: limitSummaryPath(change.path),
        pathTruncated: change.path.length > MAX_SUMMARY_PATH_LENGTH,
        kind: change.kind.type,
        movePath: change.kind.move_path ? limitSummaryPath(change.kind.move_path) : null,
        movePathTruncated: Boolean(change.kind.move_path && change.kind.move_path.length > MAX_SUMMARY_PATH_LENGTH),
        addedLines: lineCounts?.added ?? null,
        removedLines: lineCounts?.removed ?? null,
      });
    }) || [];
    return Object.freeze({
      threadId: entry.threadId,
      turnId: entry.turnId,
      itemId: entry.itemId,
      number: entry.number,
      state: entry.state,
      sourceEventType: entry.sourceEventType,
      changes: Object.freeze(changes),
      incomplete: entry.state === "invalidated" || changes.some((change) => change.addedLines === null),
    });
  }

  close() {
    const invalidated = [];
    this.closed = true;
    for (const entry of this.items.values()) {
      entry.controller?.abort();
      if (entry.snapshot && !entry.terminal) {
        const closedEntry = { ...entry, snapshot: null, terminal: true, state: "invalidated" };
        invalidated.push(this.activitySnapshot(closedEntry));
      }
    }
    this.items.clear();
    return invalidated;
  }
}

function summarizeDiffLineCounts(diff) {
  const lines = diff.split(/\r?\n/u);
  let added = 0;
  let removed = 0;
  let hunk = null;
  let sawHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) return null;
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
      if (!match) return null;
      hunk = {
        oldRemaining: match[2] === undefined ? 1 : Number(match[2]),
        newRemaining: match[4] === undefined ? 1 : Number(match[4]),
      };
      sawHunk = true;
      continue;
    }
    if (hunk && hunk.oldRemaining === 0 && hunk.newRemaining === 0) hunk = null;
    if (!hunk || line === "" || line.startsWith("\\")) continue;
    if (line.startsWith(" ")) {
      hunk.oldRemaining -= 1;
      hunk.newRemaining -= 1;
    } else if (line.startsWith("+")) {
      hunk.newRemaining -= 1;
      added += 1;
    } else if (line.startsWith("-")) {
      hunk.oldRemaining -= 1;
      removed += 1;
    } else {
      return null;
    }
    if (hunk.oldRemaining < 0 || hunk.newRemaining < 0) return null;
  }
  if (!sawHunk || (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0))) return null;
  return { added, removed };
}

function limitSummaryPath(value) {
  if (value.length <= MAX_SUMMARY_PATH_LENGTH) return value;
  return `${value.slice(0, MAX_SUMMARY_PATH_LENGTH - 18)} … [path truncated]`;
}

module.exports = { FileChangeApprovalStore, createFileChangeSnapshot };
