"use strict";

// Match the terminal's existing review limits. Never retain an oversized patch
// and offer approval of a truncated representation.
const MAX_FIELD_LENGTH = 8_000;
const MAX_SNAPSHOT_LENGTH = 20_000;
const MAX_ITEMS_PER_TURN = 64;

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
  }

  record(method, params, acknowledgedTurnId) {
    const patch = method === "item/fileChange/patchUpdated";
    const lifecycle = method === "item/started" || method === "item/completed";
    if (this.closed || (!patch && !lifecycle)) return;
    const itemId = patch ? params?.itemId : params?.item?.id;
    // Other tool items do not supply file-change evidence.
    if (!patch && params?.item?.type !== "fileChange") {
      const key = JSON.stringify([params?.threadId, params?.turnId, itemId]);
      const previous = this.items.get(key);
      if (previous) {
        previous.controller?.abort();
        this.items.set(key, { terminal: true });
      }
      return;
    }
    if (isIdentity(params?.threadId) && params.threadId !== this.threadId) return;
    if (acknowledgedTurnId && isIdentity(params?.turnId) && params.turnId !== acknowledgedTurnId) return;
    if (![params?.threadId, params?.turnId, itemId].every(isIdentity)) {
      // An unscoped update cannot safely be assigned to an existing item.
      this.close();
      return;
    }
    const key = JSON.stringify([params.threadId, params.turnId, itemId]);
    const previous = this.items.get(key);
    if (!previous && this.items.size >= MAX_ITEMS_PER_TURN) {
      this.close();
      return;
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
    this.items.set(key, { snapshot, terminal, requested: previous?.requested || false });
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

  close() {
    this.closed = true;
    for (const entry of this.items.values()) entry.controller?.abort();
    this.items.clear();
  }
}

module.exports = { FileChangeApprovalStore, createFileChangeSnapshot };
