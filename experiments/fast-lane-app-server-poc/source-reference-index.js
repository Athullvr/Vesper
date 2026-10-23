"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const MAX_INDEX_FILES = 12;
const MAX_INDEX_FILE_BYTES = 64 * 1024;
const MAX_INDEX_TOTAL_BYTES = 512 * 1024;
const MAX_INDEX_LINES = 2_000;
const MAX_INDEX_PARSE_MS = 750;
const MAX_TOKENS_PER_FILE = 24_000;
const MAX_RELATIONSHIPS_PER_FILE = 400;
const MAX_RELATIONSHIPS = 2_400;
const MAX_MATCHES_PER_SYMBOL = 40;
const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const CONTROL_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "with", "function", "return", "throw", "new", "typeof", "void",
  "delete", "await", "yield", "import", "export", "class", "interface", "type", "enum", "extends", "implements",
  "instanceof", "in", "of", "else", "do", "try", "finally", "super", "this", "const", "let", "var",
]);
const DECLARATION_WORDS = new Set(["function", "class", "interface", "type", "enum"]);

class SourceReferenceIndex {
  constructor({ maxFiles = MAX_INDEX_FILES, maxBytes = MAX_INDEX_TOTAL_BYTES, maxParseMs = MAX_INDEX_PARSE_MS } = {}) {
    this.maxFiles = clampInteger(maxFiles, 1, MAX_INDEX_FILES, MAX_INDEX_FILES);
    this.maxBytes = clampInteger(maxBytes, 1, MAX_INDEX_TOTAL_BYTES, MAX_INDEX_TOTAL_BYTES);
    this.maxParseMs = clampNumber(maxParseMs, 1, MAX_INDEX_PARSE_MS, MAX_INDEX_PARSE_MS);
    this.files = new Map();
    this.relationshipCount = 0;
    this.byteCount = 0;
    this.parseTimeMs = 0;
    this.truncated = false;
    this.unsupportedFiles = 0;
    this.malformedFiles = 0;
  }

  addFile(filePath, source, digest = null, { querySymbols = [] } = {}) {
    const relativePath = normalizeRelativePath(filePath);
    if (!relativePath || typeof source !== "string") return { indexed: false, reason: "invalid-path-or-content" };
    if (isExcludedSourcePath(relativePath)) return { indexed: false, reason: "excluded-path" };
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      this.unsupportedFiles += 1;
      return { indexed: false, reason: "unsupported-language" };
    }
    const bytes = Buffer.byteLength(source, "utf8");
    if (source.includes("\0")) {
      this.unsupportedFiles += 1;
      return { indexed: false, reason: "binary-content" };
    }
    if (bytes > MAX_INDEX_FILE_BYTES || source.split("\n").length > MAX_INDEX_LINES) {
      this.truncated = true;
      return { indexed: false, reason: "file-limit" };
    }
    const prior = this.files.get(relativePath);
    if (!prior && this.files.size >= this.maxFiles || this.byteCount - (prior?.bytes || 0) + bytes > this.maxBytes) {
      this.truncated = true;
      return { indexed: false, reason: "index-budget" };
    }
    const hash = /^[a-f0-9]{64}$/iu.test(digest || "") ? digest.toLowerCase() : sha256(source);
    const remainingParseMs = this.maxParseMs - this.parseTimeMs;
    if (remainingParseMs < 1) {
      this.truncated = true;
      return { indexed: false, reason: "parse-budget" };
    }
    const parseStarted = performance.now();
    const parsed = parseJavaScriptLike(source, relativePath, { querySymbols, maxDurationMs: remainingParseMs });
    this.parseTimeMs += Math.max(0, performance.now() - parseStarted);
    if (parsed.malformed) this.malformedFiles += 1;
    const remainingRelations = Math.min(MAX_RELATIONSHIPS_PER_FILE, MAX_RELATIONSHIPS - (this.relationshipCount - (prior?.relationships.length || 0)));
    const relationships = parsed.relationships.slice(0, Math.max(0, remainingRelations));
    if (relationships.length < parsed.relationships.length || parsed.truncated || parsed.malformed || parsed.timeLimit) this.truncated = true;
    const record = Object.freeze({
      path: relativePath,
      bytes,
      sha256: hash,
      language: extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts" ? "typescript" : "javascript",
      lines: Math.min(source.split("\n").length, MAX_INDEX_LINES),
      relationships: Object.freeze(relationships.map((item) => Object.freeze(item))),
      truncated: parsed.truncated || parsed.malformed || parsed.timeLimit || relationships.length < parsed.relationships.length,
    });
    this.files.set(relativePath, record);
    this.byteCount = this.byteCount - (prior?.bytes || 0) + bytes;
    this.relationshipCount = this.relationshipCount - (prior?.relationships.length || 0) + relationships.length;
    return { indexed: true, record };
  }

  matches(symbol, { limit = MAX_MATCHES_PER_SYMBOL } = {}) {
    if (typeof symbol !== "string" || !/^[\p{L}_$][\p{L}\p{N}_$]{0,119}$/u.test(symbol)) return [];
    const maximum = clampInteger(limit, 1, MAX_MATCHES_PER_SYMBOL, MAX_MATCHES_PER_SYMBOL);
    const matches = [];
    for (const file of this.files.values()) {
      for (const relation of file.relationships) {
        if (relation.symbol !== symbol && relation.importedName !== symbol) continue;
        matches.push(Object.freeze({ path: file.path, ...relation }));
        if (matches.length >= maximum) return matches;
      }
    }
    return matches;
  }

  definitions(symbols = []) {
    const names = new Set(symbols.filter((value) => typeof value === "string"));
    const out = [];
    for (const file of this.files.values()) {
      for (const relation of file.relationships) {
        if (relation.type !== "symbol-definition" || names.size && !names.has(relation.symbol)) continue;
        out.push(Object.freeze({ path: file.path, ...relation }));
        if (out.length >= 40) return out;
      }
    }
    return out;
  }

  suggestFiles(symbols, candidates, readPaths, { limit = 8 } = {}) {
    const read = readPaths instanceof Set ? readPaths : new Set(readPaths || []);
    const scored = new Map();
    const definitions = this.definitions(symbols);
    for (const definition of definitions) {
      const definitionDir = path.posix.dirname(definition.path);
      const definitionBase = path.posix.basename(definition.path).replace(/\.(?:[cm]?[jt]sx?)$/iu, "");
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const candidatePath = normalizeRelativePath(candidate?.path);
        if (!candidatePath || read.has(candidatePath) || !SUPPORTED_EXTENSIONS.has(path.posix.extname(candidatePath).toLowerCase())) continue;
        const basename = path.posix.basename(candidatePath).toLowerCase();
        const candidateBase = basename.replace(/\.(?:[cm]?[jt]sx?)$/iu, "").replace(/\.(?:test|spec)$/u, "");
        let score = 0;
        let reason = "same-directory source candidate as a matched definition";
        if (isTestPath(candidatePath) && candidateBase === definitionBase.toLowerCase()) {
          score = 100;
          reason = "likely test file matching the definition's source basename";
        } else if (isTestPath(candidatePath)) {
          score = 45;
          reason = "test source candidate that may reference the matched symbol";
        } else if (path.posix.dirname(candidatePath) === definitionDir) {
          score = 60;
        } else if (candidatePath.toLowerCase().includes(definitionBase.toLowerCase())) {
          score = 35;
          reason = "source path resembles the matched definition's module name";
        }
        if (score <= 0) continue;
        const existing = scored.get(candidatePath);
        if (!existing || score > existing.score) scored.set(candidatePath, { path: candidatePath, score, reason, symbol: definition.symbol, definitionPath: definition.path });
      }
    }
    return [...scored.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, clampInteger(limit, 1, 8, 8));
  }

  summary() {
    return Object.freeze({
      language: "JavaScript/TypeScript (bounded lexical analysis)",
      indexedFiles: this.files.size,
      indexedBytes: this.byteCount,
      parseTimeMs: Math.min(MAX_INDEX_PARSE_MS, Math.ceil(this.parseTimeMs)),
      relationships: this.relationshipCount,
      unsupportedFiles: this.unsupportedFiles,
      malformedFiles: this.malformedFiles,
      truncated: this.truncated,
      partial: this.truncated || this.unsupportedFiles > 0 || this.malformedFiles > 0,
    });
  }
}

function parseJavaScriptLike(source, filePath = "source.js", { querySymbols = [], maxDurationMs = MAX_INDEX_PARSE_MS, clock = () => performance.now() } = {}) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_INDEX_FILE_BYTES || source.split("\n").length > MAX_INDEX_LINES) {
    return { relationships: [], truncated: true, malformed: false, timeLimit: false };
  }
  querySymbols = Array.isArray(querySymbols) ? querySymbols.filter((item) => typeof item === "string" && /^[\p{L}_$][\p{L}\p{N}_$]{0,119}$/u.test(item)).slice(0, 6) : [];
  const parseClock = typeof clock === "function" ? clock : () => performance.now();
  const deadline = parseClock() + clampNumber(maxDurationMs, 1, MAX_INDEX_PARSE_MS, MAX_INDEX_PARSE_MS);
  let timeLimit = false;
  const expired = () => {
    if (parseClock() < deadline) return false;
    timeLimit = true;
    return true;
  };
  const tokenResult = tokenize(source, expired);
  const tokens = tokenResult.tokens;
  const relationships = [];
  const seen = new Set();
  const definitionPositions = new Set();
  const importPositions = new Set();
  const exportPositions = new Set();
  const importAliases = new Map();
  const add = (type, symbol, token, extra = {}) => {
    if (!symbol || !/^[\p{L}_$][\p{L}\p{N}_$]{0,119}$/u.test(symbol) || !token || relationships.length >= MAX_RELATIONSHIPS_PER_FILE + 1) return;
    const relation = {
      type,
      symbol,
      lineStart: token.line,
      lineEnd: token.line,
      confidence: extra.confidence || "high",
      observation: extra.observation || "observed",
      discoveryMethod: extra.discoveryMethod || "javascript-token-scan",
      sourceContextRead: true,
      ...(extra.definitionKind ? { definitionKind: extra.definitionKind } : {}),
      ...(extra.importedName ? { importedName: extra.importedName } : {}),
      ...(extra.moduleSpecifier ? { moduleSpecifier: extra.moduleSpecifier } : {}),
      ...(extra.route ? { route: extra.route } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    };
    const key = `${type}:${symbol}:${token.line}:${extra.moduleSpecifier || ""}:${extra.route || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    relationships.push(relation);
  };

  const classRanges = findClassRanges(tokens, expired);
  if (tokenResult.timeLimit || timeLimit) return { relationships, truncated: true, malformed: tokenResult.malformed, timeLimit: true };
  for (let index = 0; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    let nextIndex = index + 1;
    if (token.value === "function" && tokens[nextIndex]?.value === "*") nextIndex += 1;
    const next = tokens[nextIndex];
    if (DECLARATION_WORDS.has(token.value) && next?.type === "identifier") {
      const definitionKind = token.value === "function" ? "function" : token.value === "class" ? "class" : "type";
      add("symbol-definition", next.value, next, { definitionKind, discoveryMethod: "javascript-declaration-scan" });
      definitionPositions.add(nextIndex);
      continue;
    }
    if (["const", "let", "var"].includes(token.value) && next?.type === "identifier") {
      const end = findStatementEnd(tokens, index + 1, 80);
      const expression = tokens.slice(index + 2, end);
      if (expression.some((item) => item.value === "=>") || expression.some((item) => item.value === "function")) {
        add("symbol-definition", next.value, next, { definitionKind: "function", discoveryMethod: "javascript-function-expression-scan" });
        definitionPositions.add(index + 1);
      }
    }
  }

  for (const range of classRanges) {
    for (let index = range.start; index <= range.end && index < tokens.length; index += 1) {
      if ((index & 255) === 0 && expired()) break;
      const token = tokens[index];
      if (token.type !== "identifier" || CONTROL_WORDS.has(token.value)) continue;
      if (tokens[index + 1]?.value !== "(") continue;
      const close = matchingToken(tokens, index + 1, "(", ")", expired);
      if (close < 0 || tokens[close + 1]?.value !== "{") continue;
      if (index > range.start && ["function", "new"].includes(tokens[index - 1]?.value)) continue;
      add("symbol-definition", token.value, token, { definitionKind: "method", discoveryMethod: "class-method-scan", confidence: "medium" });
      definitionPositions.add(index);
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    const token = tokens[index];
    if (token.type !== "identifier" || token.value !== "import" || tokens[index + 1]?.value === "(" || tokens[index + 1]?.value === ".") continue;
    const end = findImportEnd(tokens, index + 1);
    const statement = tokens.slice(index + 1, end);
    const fromIndex = statement.findIndex((item) => item.value === "from");
    const moduleToken = fromIndex >= 0 ? statement.slice(fromIndex + 1).find((item) => item.type === "string") : statement.find((item) => item.type === "string");
    const moduleSpecifier = moduleToken?.value;
    const bindings = fromIndex >= 0 ? statement.slice(0, fromIndex) : [];
    for (let item = 0; item < bindings.length; item += 1) {
      if (bindings[item].type !== "identifier" || ["type", "as"].includes(bindings[item].value)) continue;
      let localName = bindings[item].value;
      let importedName = localName;
      if (bindings[item + 1]?.value === "as" && bindings[item + 2]?.type === "identifier") {
        localName = bindings[item + 2].value;
        item += 2;
      } else if (bindings[item - 1]?.value === "{" || bindings[item - 1]?.value === ",") {
        if (bindings[item + 1]?.value === "," || bindings[item + 1]?.value === "}") importedName = localName;
      }
      if (moduleSpecifier) add("symbol-import", localName, bindings[item], { importedName, moduleSpecifier, discoveryMethod: "javascript-import-scan" });
      importAliases.set(localName, importedName);
      importPositions.add(index + 1 + item);
    }
    for (let cursor = index; cursor < end; cursor += 1) importPositions.add(cursor);
    index = Math.max(index, end - 1);
  }

  for (let index = 0; index < tokens.length - 2; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    if (tokens[index].type !== "identifier" || tokens[index].value !== "require" || tokens[index + 1]?.value !== "(") continue;
    const moduleToken = tokens[index + 2]?.type === "string" ? tokens[index + 2] : null;
    if (!moduleToken) continue;
    const boundary = findStatementStart(tokens, index);
    let assignment = -1;
    for (let cursor = boundary; cursor < index; cursor += 1) if (tokens[cursor].value === "=") assignment = cursor;
    const left = assignment >= 0 ? tokens.slice(boundary, assignment) : [];
    const bindings = [];
    if (left.at(-1)?.type === "identifier") bindings.push({ local: left.at(-1).value, imported: left.at(-1).value, token: left.at(-1) });
    else if (left.at(-1)?.value === "}") {
      const open = matchingBackward(tokens, left.at(-1).index ?? (boundary + left.length - 1), "{", "}", expired);
      const openIndex = open >= boundary ? open : left.findIndex((item) => item.value === "{") + boundary;
      for (let cursor = openIndex + 1; cursor < boundary + left.length - 1; cursor += 1) {
        const original = tokens[cursor];
        if (original.type !== "identifier" || ["as", "type"].includes(original.value)) continue;
        const alias = tokens[cursor + 1]?.value === ":" && tokens[cursor + 2]?.type === "identifier" ? tokens[cursor + 2] : original;
        bindings.push({ local: alias.value, imported: original.value, token: alias });
        if (alias !== original) cursor += 2;
      }
    }
    for (const binding of bindings) {
      add("symbol-import", binding.local, binding.token, { importedName: binding.imported, moduleSpecifier: moduleToken.value, discoveryMethod: "commonjs-require-scan" });
      importAliases.set(binding.local, binding.imported);
      const bindingPosition = tokens.indexOf(binding.token);
      if (bindingPosition >= 0) importPositions.add(bindingPosition);
    }
    importPositions.add(index);
    importPositions.add(index + 1);
    importPositions.add(index + 2);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    const token = tokens[index];
    if (token.type !== "identifier" || token.value !== "export") continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value === "default") cursor += 1;
    if (tokens[cursor]?.value === "{") {
      const close = matchingToken(tokens, cursor, "{", "}", expired);
      for (let item = cursor + 1; item > 0 && item < close;) {
        const original = tokens[item];
        if (original.type !== "identifier" || ["as", "type"].includes(original.value)) { item += 1; continue; }
        const exported = tokens[item + 1]?.value === "as" && tokens[item + 2]?.type === "identifier" ? tokens[item + 2] : original;
        add("symbol-export", exported.value, original, { importedName: original.value !== exported.value ? original.value : undefined, discoveryMethod: "javascript-export-scan" });
        exportPositions.add(item);
        if (exported !== original) exportPositions.add(item + 2);
        item += tokens[item + 1]?.value === "as" ? 3 : 1;
      }
    } else if (DECLARATION_WORDS.has(tokens[cursor]?.value)) {
      const declared = tokens[cursor + 1];
      if (declared?.type === "identifier") add("symbol-export", declared.value, declared, { discoveryMethod: "javascript-export-scan" });
    } else if (["const", "let", "var"].includes(tokens[cursor]?.value) && tokens[cursor + 1]?.type === "identifier") {
      add("symbol-export", tokens[cursor + 1].value, tokens[cursor + 1], { discoveryMethod: "javascript-export-scan" });
    }
  }

  for (let index = 0; index < tokens.length - 3; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    if (tokens[index].value === "module" && tokens[index + 1].value === "." && tokens[index + 2].value === "exports" && tokens[index + 3].value === "=") {
      const exported = tokens.slice(index + 4, index + 10).find((item) => item.type === "identifier" && !CONTROL_WORDS.has(item.value));
      if (exported) add("symbol-export", exported.value, exported, { discoveryMethod: "commonjs-export-scan" });
    }
    if (tokens[index].value === "exports" && tokens[index + 1].value === "." && tokens[index + 2].type === "identifier" && tokens[index + 3].value === "=") {
      add("symbol-export", tokens[index + 2].value, tokens[index + 2], { discoveryMethod: "commonjs-export-scan" });
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    const token = tokens[index];
    if (token.type !== "identifier" || CONTROL_WORDS.has(token.value) || definitionPositions.has(index) || importPositions.has(index) || exportPositions.has(index)) continue;
    const importedName = importAliases.get(token.value);
    if (tokens[index + 1]?.value === "(" && !["function", "if", "for", "while", "switch", "catch", "with"].includes(token.value)) {
      add("likely-call-site", token.value, token, { confidence: "medium", observation: "inferred", discoveryMethod: "identifier-followed-by-call-parens",
        ...(importedName ? { importedName } : {}),
        note: "Syntactic call shape; aliasing, dynamic dispatch, or framework behavior may change the runtime target." });
    } else {
      add("identifier-reference", token.value, token, { confidence: "medium", observation: "observed", discoveryMethod: "javascript-identifier-scan", ...(importedName ? { importedName } : {}) });
    }
  }

  if (!expired()) addRouteDeclarations(source, add, expired);
  if (!expired()) addTestReferences(source, filePath, relationships, seen, querySymbols, tokens, expired);
  if (!expired()) addTextualReferences(source, relationships, seen, querySymbols, expired);
  return { relationships, truncated: tokenResult.truncated || relationships.length > MAX_RELATIONSHIPS_PER_FILE || timeLimit, malformed: tokenResult.malformed, timeLimit };
}

function tokenize(source, expired = () => false) {
  const tokens = [];
  let line = 1;
  let index = 0;
  let truncated = false;
  let malformed = false;
  while (index < source.length) {
    if ((index & 1023) === 0 && expired()) return { tokens, truncated: true, malformed, timeLimit: true };
    const char = source[index];
    if (char === "\n") { line += 1; index += 1; continue; }
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        if ((index & 1023) === 0 && expired()) return { tokens, truncated: true, malformed, timeLimit: true };
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if ((index & 1023) === 0 && expired()) return { tokens, truncated: true, malformed, timeLimit: true };
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (index >= source.length) malformed = true;
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const startLine = line;
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if ((index & 1023) === 0 && expired()) return { tokens, truncated: true, malformed, timeLimit: true };
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === quote) { index += 1; closed = true; break; }
        if (source[index] === "\n") line += 1;
        if (value.length < 512) value += source[index];
        index += 1;
      }
      if (!closed) malformed = true;
      tokens.push({ type: "string", value, line: startLine });
    } else if (isIdentifierStart(char)) {
      const start = index;
      const startLine = line;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      tokens.push({ type: "identifier", value: source.slice(start, index).slice(0, 120), line: startLine });
    } else {
      const startLine = line;
      const pair = source.slice(index, index + 3);
      if (["===", "!==", "...", "=>*"].includes(pair)) { tokens.push({ type: "punct", value: pair, line: startLine }); index += 3; }
      else if (["=>", "?.", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "**"].includes(source.slice(index, index + 2))) {
        tokens.push({ type: "punct", value: source.slice(index, index + 2), line: startLine }); index += 2;
      } else { tokens.push({ type: "punct", value: char, line: startLine }); index += 1; }
    }
    if (tokens.length >= MAX_TOKENS_PER_FILE) { truncated = index < source.length; break; }
  }
  return { tokens, truncated, malformed, timeLimit: false };
}

function findClassRanges(tokens, expired = () => false) {
  const ranges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) break;
    if (ranges.length >= 100) break;
    if (tokens[index].type !== "identifier" || tokens[index].value !== "class") continue;
    let open = index + 1;
    while (open < tokens.length && tokens[open].value !== "{" && tokens[open].value !== ";") open += 1;
    if (tokens[open]?.value !== "{") continue;
    const close = matchingToken(tokens, open, "{", "}", expired);
    if (close >= 0) ranges.push({ start: open + 1, end: close - 1 });
  }
  return ranges;
}

function matchingToken(tokens, start, open, close, expired = () => false) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) return -2;
    if (tokens[index].value === open) depth += 1;
    else if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function findStatementEnd(tokens, start, maximum) {
  for (let index = start; index < tokens.length && index < start + maximum; index += 1) {
    if (tokens[index].value === ";" || tokens[index].line > tokens[start]?.line + 8) return index;
  }
  return Math.min(tokens.length, start + maximum);
}

function findImportEnd(tokens, start) {
  let nesting = 0;
  for (let index = start; index < tokens.length && index < start + 120; index += 1) {
    const token = tokens[index];
    if (["{", "[", "("].includes(token.value)) nesting += 1;
    if (["}", "]", ")"].includes(token.value)) nesting = Math.max(0, nesting - 1);
    if (token.value === ";") return index + 1;
    if (token.type === "string" && (tokens[index - 1]?.value === "from" || index === start)) return index + 1;
    if (index > start && nesting === 0 && token.line > tokens[index - 1].line && token.type === "identifier" && ["const", "let", "var", "function", "class", "import", "export"].includes(token.value)) return index;
  }
  return Math.min(tokens.length, start + 120);
}

function findStatementStart(tokens, before) {
  let start = before;
  while (start > 0) {
    if (tokens[start - 1].value === ";" || tokens[start - 1].line < tokens[before].line - 4) break;
    if (tokens[start - 1].type === "identifier" && ["const", "let", "var"].includes(tokens[start - 1].value)) { start -= 1; break; }
    start -= 1;
  }
  return start;
}

function matchingBackward(tokens, start, open, close, expired = () => false) {
  let depth = 0;
  for (let index = start; index >= 0; index -= 1) {
    if ((index & 255) === 0 && expired()) return -2;
    if (tokens[index].value === close) depth += 1;
    else if (tokens[index].value === open && --depth === 0) return index;
  }
  return -1;
}

function addRouteDeclarations(source, add, expired = () => false) {
  const pattern = /\b[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(\s*(['"])([^'"\n]{1,200})\1\s*,\s*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\b/gmu;
  let matches = 0;
  for (const match of source.matchAll(pattern)) {
    if (++matches > 100 || expired()) break;
    const line = source.slice(0, match.index + match[0].indexOf(match[3])).split("\n").length;
    add("route-handler", match[3], { line }, { route: match[2], confidence: "medium", observation: "inferred", discoveryMethod: "route-call-pattern",
      note: "Framework-like route registration pattern; framework semantics are not verified." });
  }
}

function addTestReferences(source, filePath, relationships, seen, querySymbols = [], tokens = [], expired = () => false) {
  if (!isTestPath(filePath)) return;
  const names = new Set(querySymbols.filter((item) => typeof item === "string"));
  const linesByName = new Map([...names].map((name) => [name, new Set()]));
  for (let index = 0; index < tokens.length; index += 1) {
    if ((index & 255) === 0 && expired()) return;
    const token = tokens[index];
    if (token.type === "identifier" && linesByName.has(token.value)) linesByName.get(token.value).add(token.line);
  }
  for (const name of names) {
    if (relationships.length >= MAX_RELATIONSHIPS_PER_FILE + 1) return;
    const identifierLines = linesByName.get(name) || new Set();
    for (const line of [...identifierLines].sort((a, b) => a - b)) {
      if (expired()) return;
      if (relationships.length >= MAX_RELATIONSHIPS_PER_FILE + 1) return;
      const key = `test-reference:${name}:${line}::`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({ type: "test-reference", symbol: name, lineStart: line, lineEnd: line, confidence: "medium", observation: "observed",
        discoveryMethod: "test-file-symbol-scan", sourceContextRead: true, note: "Symbol text appears in a test-path source file; assertion or execution coverage is not established." });
    }
  }
}

function addTextualReferences(source, relationships, seen, querySymbols = [], expired = () => false) {
  const names = [...new Set([...querySymbols, ...relationships.filter((item) => item.type === "symbol-definition").map((item) => item.symbol)])].slice(0, 64);
  const lines = source.split("\n");
  for (const name of names) {
    if (relationships.length >= MAX_RELATIONSHIPS_PER_FILE + 1) return;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gu");
    for (let line = 0; line < lines.length; line += 1) {
      if (expired()) return;
      if (relationships.length >= MAX_RELATIONSHIPS_PER_FILE + 1) return;
      if (!pattern.test(lines[line])) { pattern.lastIndex = 0; continue; }
      pattern.lastIndex = 0;
      if (relationships.some((item) => item.symbol === name && item.lineStart === line + 1)) continue;
      const key = `textual-reference:${name}:${line + 1}::`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({ type: "textual-reference", symbol: name, lineStart: line + 1, lineEnd: line + 1, confidence: "low", observation: "observed",
        discoveryMethod: "raw-line-text-match", sourceContextRead: true, note: "Text match may be in a comment or string and is not a code reference." });
    }
  }
}

function isTestPath(value) { return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(value); }
function isIdentifierStart(char) { return typeof char === "string" && /^[\p{L}_$]$/u.test(char); }
function isIdentifierPart(char) { return typeof char === "string" && /^[\p{L}\p{N}_$]$/u.test(char); }
function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(value);
  return normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0") ? null : normalized;
}
function isExcludedSourcePath(value) {
  const parts = value.toLowerCase().split("/");
  const base = parts.at(-1) || "";
  return parts.some((part) => [".git", ".vesper", "node_modules", "vendor", "dist", "build", "coverage", "target", "generated", "generated-files", "autogenerated", ".aws", ".ssh", ".config"].includes(part)) ||
    /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ed25519|ecdsa))$/u.test(base) ||
    /\.(?:pem|key|p12|pfx|keystore|tfstate)(?:\..*)?$/u.test(base);
}
function clampInteger(value, minimum, maximum, fallback) { return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback; }
function clampNumber(value, minimum, maximum, fallback) { return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

module.exports = {
  MAX_INDEX_FILE_BYTES,
  MAX_INDEX_FILES,
  MAX_INDEX_LINES,
  MAX_INDEX_TOTAL_BYTES,
  SourceReferenceIndex,
  parseJavaScriptLike,
};
