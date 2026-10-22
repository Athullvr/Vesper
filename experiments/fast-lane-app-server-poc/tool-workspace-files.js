"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
const FILE_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const TEMP_WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
const MAX_RELATIVE_PATH_LENGTH = 1_024;
const RESERVED_WINDOWS_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

function openProjectRoot(projectRoot) {
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd") || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) {
    throw toolFsError("UNSUPPORTED_PLATFORM", "Race-resistant project file access is unavailable on this platform.");
  }
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(projectRoot); } catch {
    throw toolFsError("INVALID_PROJECT", "The selected project directory could not be resolved.");
  }
  let fd;
  try {
    fd = fs.openSync(canonicalRoot, DIRECTORY_FLAGS);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) throw new Error("not-directory");
    const openedPath = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (openedPath !== canonicalRoot) throw new Error("root-changed");
    return {
      fd,
      path: canonicalRoot,
      device: stat.dev,
      inode: stat.ino,
      close() { try { fs.closeSync(fd); } catch { /* The descriptor may already be closed. */ } },
    };
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Ignore close errors during rejection. */ }
    throw toolFsError("INVALID_PROJECT", "The selected project root is not a stable, accessible directory.");
  }
}

function parseProjectPath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string" || value.length > MAX_RELATIVE_PATH_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw toolFsError("INVALID_PATH", "A bounded project-relative path is required.");
  }
  const portable = value.replace(/\\/gu, "/");
  if (portable.startsWith("/") || /^[a-z]:/iu.test(portable) || portable.startsWith("//")) {
    throw toolFsError("INVALID_PATH", "Absolute paths are not allowed; use a project-relative path.");
  }
  const rawParts = portable.split("/");
  if (rawParts.some((part) => part === ".." || part.includes(":"))) {
    throw toolFsError("INVALID_PATH", "Path traversal and alternate stream components are not allowed.");
  }
  const components = rawParts.filter((part) => part && part !== ".");
  if (components.some((part) => part.endsWith(".") || part.endsWith(" ") || RESERVED_WINDOWS_NAME.test(part))) {
    throw toolFsError("INVALID_PATH", "The path contains a non-portable or reserved component.");
  }
  if (!allowRoot && components.length === 0) throw toolFsError("INVALID_PATH", "A file path is required.");
  return Object.freeze({ components: Object.freeze(components), relativePath: components.join("/") });
}

function openProjectDirectory(root, components) {
  const opened = [];
  let fd = root.fd;
  try {
    for (const component of components) {
      const next = fs.openSync(`${fdPath(fd)}/${component}`, DIRECTORY_FLAGS);
      opened.push(next);
      const stat = fs.fstatSync(next, { bigint: true });
      if (!stat.isDirectory() || stat.dev !== root.device) throw toolFsError("PATH_REJECTED", "A project path contains a non-directory or mounted boundary.");
      const canonical = fs.realpathSync(fdPath(next));
      if (!isContained(root.path, canonical)) throw toolFsError("PATH_REJECTED", "A project path resolves outside the selected project.");
      fd = next;
    }
    return {
      fd,
      close() {
        for (let index = opened.length - 1; index >= 0; index -= 1) try { fs.closeSync(opened[index]); } catch { /* Ignore close errors. */ }
      },
    };
  } catch (error) {
    for (let index = opened.length - 1; index >= 0; index -= 1) try { fs.closeSync(opened[index]); } catch { /* Ignore close errors. */ }
    if (error?.code === "ENOENT") throw toolFsError("NOT_FOUND", "The requested project path does not exist.");
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw toolFsError("PATH_REJECTED", "The requested project path contains a symbolic link or non-directory component.");
    throw error;
  }
}

function openProjectParent(root, relativePath) {
  const parsed = parseProjectPath(relativePath);
  const parentComponents = parsed.components.slice(0, -1);
  const parent = openProjectDirectory(root, parentComponents);
  return { ...parent, basename: parsed.components.at(-1), relativePath: parsed.relativePath, device: root.device };
}

function readFileAt(parentFd, basename, maxBytes, { allowMissing = false, expectedDevice } = {}) {
  const filePath = `${fdPath(parentFd)}/${basename}`;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, FILE_READ_FLAGS);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) throw toolFsError("UNSUPPORTED_FILE_TYPE", "Only regular project files can be read.");
    if (expectedDevice !== undefined && stat.dev !== expectedDevice) throw toolFsError("PATH_REJECTED", "A project file is on a mounted filesystem boundary.");
    if (stat.nlink > 1n) throw toolFsError("PATH_REJECTED", "Hard-linked files are not read or changed by this runtime.");
    if (stat.size > BigInt(maxBytes)) throw toolFsError("INPUT_TOO_LARGE", "The project file exceeds Vesper's configured file limit.");
    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw toolFsError("INPUT_TOO_LARGE", "The project file grew beyond Vesper's configured file limit.");
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw toolFsError("INPUT_TOO_LARGE", "The project file grew beyond Vesper's configured file limit.");
      chunks.push(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) {
      throw toolFsError("STALE_FILE", "The project file changed while Vesper was reading it.");
    }
    const buffer = Buffer.concat(chunks, total);
    return { buffer, stat: statSummary(stat) };
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw toolFsError("PATH_REJECTED", "Symbolic links and non-file paths are not allowed.");
    if (error?.code === "ENOENT") throw toolFsError("NOT_FOUND", "The requested project file does not exist.");
    throw error;
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Ignore close errors. */ }
  }
}

function lstatAt(parentFd, basename) {
  try { return statSummary(fs.lstatSync(`${fdPath(parentFd)}/${basename}`, { bigint: true })); } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw toolFsError("PATH_REJECTED", "The requested path changed or contains a symbolic link.");
    throw error;
  }
}

function createTemporaryFile(parentFd, basename, content, mode = 0o600) {
  const filePath = `${fdPath(parentFd)}/${basename}`;
  const descriptor = fs.openSync(filePath, TEMP_WRITE_FLAGS, mode);
  try {
    let offset = 0;
    while (offset < content.length) {
      const written = fs.writeSync(descriptor, content, offset, content.length - offset);
      if (!written) throw toolFsError("WRITE_FAILED", "Vesper could not complete the staged file write.");
      offset += written;
    }
    fs.fchmodSync(descriptor, mode & 0o777);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    return filePath;
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* The descriptor may already be closed. */ }
    try { fs.unlinkSync(filePath); } catch { /* Remove partial staging files when possible. */ }
    throw error;
  }
}

function listDirectory(parentFd, { maximum = 100 } = {}) {
  const listing = readDirectoryNames(parentFd, maximum);
  const visible = [];
  let skipped = false;
  for (const name of listing.entries) {
    if (name === "." || name === "..") continue;
    let stat;
    try { stat = fs.lstatSync(`${fdPath(parentFd)}/${name}`, { bigint: true }); } catch { skipped = true; continue; }
    visible.push(Object.freeze({
      name: safeDisplayName(name),
      type: stat.isSymbolicLink() ? "symbolic-link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      sizeBytes: stat.isFile() ? boundedNumber(stat.size) : null,
    }));
  }
  return { entries: visible, truncated: listing.truncated || skipped };
}

function listRawDirectory(parentFd, { maximum = 2_000 } = {}) {
  return readDirectoryNames(parentFd, maximum);
}

function readDirectoryNames(parentFd, maximum) {
  const directory = fs.opendirSync(fdPath(parentFd));
  const names = [];
  try {
    while (names.length <= maximum) {
      const entry = directory.readSync();
      if (!entry) break;
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  names.sort((left, right) => left.localeCompare(right));
  return { entries: names.slice(0, maximum), truncated: names.length > maximum };
}

function statAt(parentFd, name) {
  try { return fs.lstatSync(`${fdPath(parentFd)}/${name}`, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function fdPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function isContained(rootPath, candidate) {
  const relative = path.relative(rootPath, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function statSummary(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs) * 1_000_000))),
    ctimeNs: String(stat.ctimeNs ?? BigInt(Math.trunc(Number(stat.ctimeMs) * 1_000_000))),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
  });
}

function safeDisplayName(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, "�").slice(0, 255);
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER;
}

function toolFsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  MAX_RELATIVE_PATH_LENGTH,
  createTemporaryFile,
  fdPath,
  isContained,
  listDirectory,
  listRawDirectory,
  lstatAt,
  openProjectDirectory,
  openProjectParent,
  openProjectRoot,
  parseProjectPath,
  readFileAt,
  statAt,
  statSummary,
  toolFsError,
};
