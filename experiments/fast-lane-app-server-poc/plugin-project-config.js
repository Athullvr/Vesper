"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

function inspectProjectPluginConfig(cwd, filesystem = fs) {
  const directoryPath = path.join(cwd, ".codex");
  const configPath = path.join(directoryPath, "config.toml");
  const directory = inspectPath(directoryPath, filesystem);
  if (directory.status === "missing") {
    return { status: "ok", exists: false, directoryExists: false, configPath, directoryPath, settings: new Map(), safeToEdit: true, notes: [] };
  }
  if (directory.status !== "ok" || !directory.stat.isDirectory() || directory.stat.isSymbolicLink()) {
    return unknownConfig(configPath, directoryPath, "project .codex is not a readable, regular directory");
  }

  const inspected = inspectPath(configPath, filesystem);
  if (inspected.status === "missing") {
    return { status: "ok", exists: false, directoryExists: true, configPath, directoryPath, settings: new Map(), safeToEdit: true, notes: [] };
  }
  if (inspected.status !== "ok" || !inspected.stat.isFile() || inspected.stat.isSymbolicLink()) {
    return unknownConfig(configPath, directoryPath, "project .codex/config.toml is not a regular file");
  }
  if (inspected.stat.size > MAX_CONFIG_BYTES) {
    return unknownConfig(configPath, directoryPath, `project .codex/config.toml exceeds the ${MAX_CONFIG_BYTES} byte inspection limit`);
  }

  let descriptor;
  try {
    const noFollow = filesystem.constants?.O_NOFOLLOW || 0;
    descriptor = filesystem.openSync(configPath, filesystem.constants.O_RDONLY | noFollow);
    const current = filesystem.fstatSync(descriptor);
    if (!current.isFile() || current.size > MAX_CONFIG_BYTES) {
      return unknownConfig(configPath, directoryPath, "project .codex/config.toml changed while it was inspected");
    }
    const bytes = filesystem.readFileSync(descriptor);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const analysis = analyzeConfig(content);
    return {
      status: analysis.safeToEdit ? "ok" : "unknown",
      exists: true,
      directoryExists: true,
      configPath,
      directoryPath,
      content,
      mode: current.mode & 0o777,
      fingerprint: fingerprint(current, bytes),
      settings: analysis.settings,
      blockedIdentities: analysis.blockedIdentities,
      safeToEdit: analysis.safeToEdit,
      notes: analysis.safeToEdit ? [] : ["project plugin settings could not be parsed safely"],
    };
  } catch {
    return unknownConfig(configPath, directoryPath, "project .codex/config.toml could not be read safely");
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
}

function setProjectPluginEnabled(cwd, identity, enabled, filesystem = fs, expectedSnapshot = null) {
  if (!isSafePluginIdentity(identity)) throw new Error("The plugin identity cannot be represented safely in project config.");
  if (typeof enabled !== "boolean") throw new TypeError("The requested plugin setting must be enabled or disabled.");

  const before = inspectProjectPluginConfig(cwd, filesystem);
  if (before.status !== "ok" || !before.safeToEdit) throw new Error("Project config cannot be edited safely; it was left unchanged.");
  if (expectedSnapshot && (expectedSnapshot.missing ? before.exists : !before.exists || before.fingerprint !== expectedSnapshot.fingerprint)) {
    throw new Error("Project config changed after its backup was created; no file was overwritten.");
  }
  const currentState = before.settings.get(identity);
  if (currentState === (enabled ? "enabled_project" : "disabled_project")) {
    throw new Error(`The project plugin setting is already ${enabled ? "enabled" : "disabled"}; no change was made.`);
  }

  const content = before.exists ? before.content : "";
  const lines = splitConfigLines(content);
  const analysis = analyzeConfig(content);
  if (!analysis.safeToEdit) throw new Error("Project config contains a table header Vesper cannot safely edit; it was left unchanged.");
  if (analysis.blockedIdentities.has(identity)) throw new Error("The project plugin table is nested or ambiguous; config was left unchanged.");
  const target = analysis.sections.get(identity) || [];
  if (target.length > 1) throw new Error("The project plugin table appears more than once; config was left unchanged.");

  const replacement = enabled ? "true" : "false";
  if (target.length === 1) {
    const section = target[0];
    if (section.enabledLines.length > 1) throw new Error("The project plugin table has duplicate enabled settings; config was left unchanged.");
    if (section.enabledLines.length === 1) {
      const entry = section.enabledLines[0];
      if (entry.value === null) throw new Error("The project plugin enabled setting is not a simple boolean; config was left unchanged.");
      if (entry.value === replacement) throw new Error(`The project plugin setting is already ${enabled ? "enabled" : "disabled"}; no change was made.`);
      lines[entry.lineIndex].text = lines[entry.lineIndex].text.replace(/(=\s*)(true|false)(\s*(?:#.*)?)$/u, `$1${replacement}$3`);
    } else {
      const newline = lines[section.headerLine]?.eol || defaultNewline(content);
      if (lines[section.headerLine]) lines[section.headerLine].eol = newline;
      lines.splice(section.headerLine + 1, 0, { text: `enabled = ${replacement}`, eol: newline });
    }
  } else {
    if (/^\s*(?:"plugins"|plugins)\s*=/mu.test(content)) {
      throw new Error("Project config uses an inline plugins value; Vesper will not create a competing plugin table.");
    }
    const newline = defaultNewline(content);
    const header = `[plugins.${JSON.stringify(identity)}]`;
    const hasContent = content.length > 0;
    const hasTrailingBlankLine = /(?:\r?\n){2}$/u.test(content);
    const separator = hasContent
      ? `${content.endsWith("\n") || content.endsWith("\r") ? "" : newline}${hasTrailingBlankLine ? "" : newline}`
      : "";
    const body = `${content}${separator}${header}${newline}enabled = ${replacement}${newline}`;
    return writeConfigAtomically(before, body, filesystem);
  }

  return writeConfigAtomically(before, lines.map((line) => `${line.text}${line.eol}`).join(""), filesystem);
}

function writeConfigAtomically(before, content, filesystem) {
  const directoryPath = before.directoryPath;
  ensureProjectConfigDirectory(directoryPath, filesystem);
  assertConfigUnchanged(before, filesystem);

  const tempPath = path.join(directoryPath, `config.toml.vesper-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    const mode = before.exists ? before.mode : 0o600;
    descriptor = filesystem.openSync(tempPath, "wx", mode);
    filesystem.writeFileSync(descriptor, content, "utf8");
    filesystem.fchmodSync(descriptor, mode);
    filesystem.fsyncSync(descriptor);
    filesystem.closeSync(descriptor);
    descriptor = undefined;
    assertConfigUnchanged(before, filesystem);
    filesystem.renameSync(tempPath, before.configPath);
    try {
      const directoryFd = filesystem.openSync(directoryPath, filesystem.constants.O_RDONLY);
      try { filesystem.fsyncSync(directoryFd); } finally { filesystem.closeSync(directoryFd); }
    } catch {
      // The rename is already durable enough for the caller to verify from disk.
    }
    return { configPath: before.configPath, changed: true };
  } catch (error) {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
    try { filesystem.unlinkSync(tempPath); } catch { /* No temporary file remains. */ }
    throw error;
  }
}

function assertConfigUnchanged(before, filesystem) {
  const directory = inspectPath(before.directoryPath, filesystem);
  if (directory.status !== "ok" || !directory.stat.isDirectory() || directory.stat.isSymbolicLink()) {
    throw new Error("Project .codex changed or is not a regular directory; config was left unchanged.");
  }
  const current = inspectPath(before.configPath, filesystem);
  if (!before.exists) {
    if (current.status !== "missing") throw new Error("Project config appeared after confirmation; no file was overwritten.");
    return;
  }
  if (current.status !== "ok" || current.stat.isSymbolicLink() || !current.stat.isFile()) {
    throw new Error("Project config changed after confirmation; no file was overwritten.");
  }
  let descriptor;
  try {
    descriptor = filesystem.openSync(before.configPath, filesystem.constants.O_RDONLY | (filesystem.constants.O_NOFOLLOW || 0));
    const stat = filesystem.fstatSync(descriptor);
    const bytes = filesystem.readFileSync(descriptor);
    if (!stat.isFile() || fingerprint(stat, bytes) !== before.fingerprint) {
      throw new Error("Project config changed after confirmation; no file was overwritten.");
    }
  } catch {
    throw new Error("Project config changed after confirmation; no file was overwritten.");
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
}

function ensureProjectConfigDirectory(directoryPath, filesystem) {
  const current = inspectPath(directoryPath, filesystem);
  if (current.status === "missing") {
    try { filesystem.mkdirSync(directoryPath, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const created = inspectPath(directoryPath, filesystem);
  if (created.status !== "ok" || !created.stat.isDirectory() || created.stat.isSymbolicLink()) {
    throw new Error("Project .codex is not a regular directory; config was left unchanged.");
  }
}

function analyzeConfig(content) {
  const lines = splitConfigLines(content).map((line) => line.text);
  const sections = new Map();
  const nestedSections = new Set();
  const blockedIdentities = new Set();
  const safeToEdit = { value: !content.startsWith("\uFEFF") };
  let current = null;
  let hasTableHeader = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[")) {
      const header = parseTableHeader(line);
      if (!header) {
        safeToEdit.value = false;
        current = null;
        continue;
      }
      hasTableHeader = true;
      if (header.nestedPluginIdentity) nestedSections.add(header.nestedPluginIdentity);
      current = header.pluginIdentity;
      if (current !== null) {
        const section = { headerLine: lineIndex, enabledLines: [] };
        const existing = sections.get(current) || [];
        existing.push(section);
        sections.set(current, existing);
      }
      continue;
    }
    if (!hasTableHeader && /^\s*(?:"plugins"|plugins)\s*(?:=|\.)/u.test(line)) safeToEdit.value = false;
    if (current === null) continue;
    if (/^\s*(?:enabled|"enabled"|'enabled')\s*=/u.test(line)) {
      const match = line.match(/^\s*(?:enabled|"enabled"|'enabled')\s*=\s*(true|false)\s*(?:#.*)?$/u);
      sections.get(current).at(-1).enabledLines.push({
        lineIndex,
        line,
        value: match ? match[1] : null,
      });
    }
  }

  const settings = new Map();
  for (const [identity, occurrences] of sections) {
    const malformed = occurrences.length !== 1 || occurrences.some((section) =>
      section.enabledLines.length > 1 || section.enabledLines.some((entry) => entry.value === null));
    if (malformed) {
      safeToEdit.value = false;
      blockedIdentities.add(identity);
    }
    if (occurrences.length !== 1 || occurrences[0].enabledLines.length !== 1 || occurrences[0].enabledLines[0].value === null) {
      settings.set(identity, "unknown");
    } else {
      settings.set(identity, occurrences[0].enabledLines[0].value === "true" ? "enabled_project" : "disabled_project");
    }
  }
  for (const identity of nestedSections) {
    if (!sections.has(identity)) blockedIdentities.add(identity);
  }
  return { safeToEdit: safeToEdit.value, sections, settings, blockedIdentities };
}

function splitConfigLines(content) {
  const lines = [];
  let offset = 0;
  while (offset < content.length) {
    let index = content.indexOf("\n", offset);
    const carriageReturn = content.indexOf("\r", offset);
    if (index < 0 || (carriageReturn >= 0 && carriageReturn < index)) index = carriageReturn;
    if (index < 0) {
      lines.push({ text: content.slice(offset), eol: "" });
      break;
    }
    const eol = content[index] === "\r" && content[index + 1] === "\n" ? "\r\n" : content[index];
    lines.push({ text: content.slice(offset, index), eol });
    offset = index + eol.length;
  }
  return lines;
}

function defaultNewline(content) {
  const match = content.match(/\r\n|\n|\r/u);
  return match ? match[0] : "\n";
}

function parseTableHeader(line) {
  const trimmed = line.trimStart();
  const arrayTable = trimmed.startsWith("[[");
  if (!trimmed.startsWith("[")) return null;
  const openingLength = arrayTable ? 2 : 1;
  let quote = null;
  let escaped = false;
  let closingIndex = -1;
  for (let index = openingLength; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return null;
    if (character === "]") {
      if (arrayTable && trimmed[index + 1] !== "]") return null;
      closingIndex = index;
      break;
    }
  }
  if (quote !== null || closingIndex < 0) return null;
  const afterHeader = trimmed.slice(closingIndex + (arrayTable ? 2 : 1)).trim();
  if (afterHeader && !afterHeader.startsWith("#")) return null;
  const inner = trimmed.slice(openingLength, closingIndex).trim();
  const plugin = inner.match(/^(?:plugins|"plugins"|'plugins')\s*\.\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*.+)?$/u);
  if (!plugin) return { pluginIdentity: null };
  const key = plugin[1];
  let identity;
  try {
    if (key.startsWith('"')) identity = JSON.parse(key);
    else if (key.startsWith("'")) identity = key.slice(1, -1);
    else identity = key;
  } catch {
    return null;
  }
  if (typeof identity !== "string") return null;
  const isNested = /^\s*(?:plugins|"plugins"|'plugins')\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*\./u.test(inner);
  return isNested || arrayTable
    ? { pluginIdentity: null, nestedPluginIdentity: identity }
    : { pluginIdentity: identity, nestedPluginIdentity: null };
}

function isSafePluginIdentity(identity) {
  return typeof identity === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}@[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(identity);
}

function inspectPath(filePath, filesystem) {
  try {
    return { status: "ok", stat: filesystem.lstatSync(filePath) };
  } catch (error) {
    return error.code === "ENOENT" ? { status: "missing" } : { status: "error" };
  }
}

function fingerprint(stat, content) {
  const digest = createHash("sha256").update(content).digest("hex");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode & 0o777, digest].join(":");
}

function unknownConfig(configPath, directoryPath, note) {
  return { status: "unknown", exists: false, directoryExists: false, configPath, directoryPath, settings: new Map(), safeToEdit: false, notes: [note] };
}

module.exports = {
  MAX_CONFIG_BYTES,
  analyzeConfig,
  configFingerprint: fingerprint,
  inspectProjectPluginConfig,
  isSafePluginIdentity,
  setProjectPluginEnabled,
};
