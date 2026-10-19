"use strict";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MAX_FRAME_COLUMNS = 200;
const MAX_FRAME_ROWS = 40;
const REDRAW_DELAY_MS = 60;

class LiveTurnDiffView {
  constructor({ output, enabled = false, renderActivity } = {}) {
    if (!output || typeof output.write !== "function") throw new TypeError("A terminal output stream is required.");
    if (typeof renderActivity !== "function") throw new TypeError("A turn diff renderer is required.");
    this.output = output;
    this.enabled = Boolean(enabled);
    this.renderActivity = renderActivity;
    this.active = false;
    this.closed = true;
    this.failed = false;
    this.suspended = 0;
    this.latest = null;
    this.drawnRows = 0;
    this.drawnLines = [];
    this.timer = undefined;
    this.resizeAttached = false;
    this.handleResize = this.handleResize.bind(this);
  }

  begin() {
    if (this.active) return;
    this.clearTimer();
    this.active = true;
    this.closed = false;
    this.failed = false;
    this.suspended = 0;
    this.latest = null;
    this.drawnRows = 0;
    this.drawnLines = [];
    if (this.enabled && typeof this.output.on === "function") {
      this.output.on("resize", this.handleResize);
      this.resizeAttached = true;
    }
  }

  update(activity) {
    if (!this.active || this.closed) return;
    this.latest = activity;
    if (this.enabled && !this.failed && this.suspended === 0) this.scheduleRender();
  }

  beforeExternalWrite() {
    if (!this.active || this.closed || this.failed || this.suspended > 0 || !this.drawnRows) return;
    this.clearRendered();
  }

  afterExternalWrite() {
    if (!this.active || this.closed || this.failed || this.suspended > 0 || !this.latest) return;
    if (this.enabled) this.scheduleRender();
  }

  suspend() {
    if (!this.active || this.closed) return;
    this.suspended += 1;
    if (this.suspended === 1) {
      this.clearTimer();
      this.clearRendered();
    }
  }

  resume() {
    if (!this.active || this.closed || this.suspended === 0) return;
    this.suspended -= 1;
    if (this.suspended === 0 && this.latest && this.enabled && !this.failed) this.scheduleRender(0);
  }

  close(activity) {
    if (!this.active || this.closed) return false;
    if (activity) this.latest = activity;
    this.clearTimer();
    let retainedInPlace = false;
    if (this.enabled && !this.failed && this.suspended === 0 && this.latest) {
      retainedInPlace = this.renderNow();
      if (retainedInPlace) {
        try {
          this.output.write("\r\n");
        } catch {
          this.fail();
          retainedInPlace = false;
        }
      }
    } else {
      this.clearRendered();
    }
    this.active = false;
    this.closed = true;
    this.suspended = 0;
    // The final frame becomes ordinary terminal output. Forget its dimensions
    // so end() or later lifecycle cleanup cannot erase the closed snapshot.
    if (retainedInPlace) {
      this.drawnRows = 0;
      this.drawnLines = [];
    }
    this.detachResize();
    return retainedInPlace;
  }

  end() {
    this.clearTimer();
    this.clearRendered();
    this.active = false;
    this.closed = true;
    this.suspended = 0;
    this.latest = null;
    this.detachResize();
  }

  scheduleRender(delay = REDRAW_DELAY_MS) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.renderNow();
    }, delay);
    this.timer.unref?.();
  }

  renderNow() {
    if (!this.active || this.closed || this.failed || this.suspended > 0 || !this.latest || !this.enabled) return false;
    if (this.drawnRows && !this.clearRendered()) return false;
    try {
      const lines = layoutLiveTurnDiff(
        this.renderActivity(this.latest),
        this.output.columns,
        this.output.rows,
      );
      const frame = `\r\n${lines.join("\r\n")}`;
      this.output.write(frame);
      this.drawnLines = lines;
      this.drawnRows = physicalRows(lines, terminalColumns(this.output.columns));
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  clearRendered() {
    if (!this.drawnRows) return true;
    const lines = this.drawnLines;
    const columns = terminalColumns(this.output.columns);
    const visibleRows = Math.max(1, terminalRows(this.output.rows) - 1);
    const rows = Math.min(visibleRows, Math.max(this.drawnRows, physicalRows(lines, columns)));
    this.drawnRows = 0;
    this.drawnLines = [];
    try {
      // The live frame is always the last output block, so erase only that
      // block and leave prior response/command text in scrollback.
      const up = rows > 1 ? `\u001b[${rows - 1}A` : "";
      this.output.write(`${up}\r\u001b[J`);
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  handleResize() {
    if (!this.active || this.closed || this.failed || this.suspended > 0 || !this.latest) return;
    this.clearTimer();
    this.clearRendered();
    if (!this.failed) this.scheduleRender(0);
  }

  fail() {
    this.failed = true;
    this.clearTimer();
    this.detachResize();
    this.active = false;
    this.closed = true;
    this.drawnRows = 0;
    this.drawnLines = [];
    // If a stream throws after writing part of a frame, reset SGR and leave
    // the cursor at a clean line before the frontend's bounded static fallback.
    try {
      this.output.write("\u001b[0m\r\n");
    } catch {
      // The output stream itself may be unavailable; callers still recover.
    }
  }

  clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  detachResize() {
    if (!this.resizeAttached) return;
    if (typeof this.output.off === "function") this.output.off("resize", this.handleResize);
    else this.output.removeListener?.("resize", this.handleResize);
    this.resizeAttached = false;
  }
}

function layoutLiveTurnDiff(rendered, columns, rows) {
  const width = Math.max(1, Math.min(MAX_FRAME_COLUMNS, terminalColumns(columns) - 1));
  const height = Math.max(1, Math.min(MAX_FRAME_ROWS, terminalRows(rows) - 1));
  const content = String(rendered ?? "").replace(/^\n/u, "").replace(/\n$/u, "");
  const logicalLines = content ? content.split("\n") : ["[Turn-level diff unavailable]"];
  const wrapped = logicalLines.flatMap((line) => wrapTerminalLine(line, width));
  if (wrapped.length <= height) return wrapped;
  const omitted = wrapped.length - height + 1;
  const marker = `[diff view truncated; ${omitted} rows omitted]`;
  const visibleMarker = wrapTerminalLine(marker, width)[0];
  if (height === 1) return [visibleMarker];
  return [...wrapped.slice(0, height - 1), visibleMarker];
}

function wrapTerminalLine(line, maxCells) {
  const result = [];
  let current = "";
  let cells = 0;
  for (const character of String(line)) {
    const width = characterCellWidth(character);
    if (current && cells + width > maxCells) {
      result.push(current);
      current = "";
      cells = 0;
    }
    current += character;
    cells += width;
  }
  result.push(current);
  return result;
}

function characterCellWidth(character) {
  if (/\p{M}/u.test(character)) return 0;
  const code = character.codePointAt(0);
  if (
    (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) return 2;
  return 1;
}

function terminalColumns(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_COLUMNS;
}

function terminalRows(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ROWS;
}

function physicalRows(lines, columns) {
  const width = Math.max(1, columns - 1);
  return lines.reduce((sum, line) => sum + Math.max(1, wrapTerminalLine(line, width).length), 0);
}

module.exports = {
  LiveTurnDiffView,
  layoutLiveTurnDiff,
  wrapTerminalLine,
  REDRAW_DELAY_MS,
};
