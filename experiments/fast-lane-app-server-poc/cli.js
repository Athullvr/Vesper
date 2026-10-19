"use strict";

const fs = require("node:fs");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { AppServerClient } = require("./app-server-client");
const { createLocalHandlers } = require("./local-handlers");
const { SessionStore } = require("./session-store");
const { TerminalFrontend, safeTerminalText } = require("./terminal-frontend");

const USAGE = `Vesper terminal frontend

Usage:
  vesper [--new] [PROJECT_DIRECTORY]
  vesper --resume SESSION_ID [PROJECT_DIRECTORY]

Start a new Vesper session with --new, or resume a saved session with --resume.
Without either option, Vesper starts a new session in the current directory.
The optional project directory must match the saved directory when resuming.
Inside Vesper, enter :quit to exit. Session ids are printed at startup.

For this checkout, run: node ./bin/vesper.js --new [PROJECT_DIRECTORY]
`;

function parseArgs(argv) {
  let newSession = false;
  let resumeId = null;
  let help = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--new") newSession = true;
    else if (arg === "--resume") {
      if (resumeId !== null) throw new Error("Use --resume only once.");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--resume requires a Vesper session id.");
      resumeId = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${safeTerminalText(arg)}`);
    } else {
      positional.push(arg);
    }
  }

  if (newSession && resumeId) throw new Error("Use either --new or --resume, not both.");
  if (positional.length > 1) throw new Error("Provide at most one project directory.");
  return { newSession, resumeId, help, projectDirectory: positional[0] || null };
}

function resolveProjectDirectory(directory) {
  const requested = path.resolve(directory || process.cwd());
  let realPath;
  try {
    realPath = fs.realpathSync(requested);
  } catch {
    throw new Error(`Project directory does not exist: ${safeTerminalText(requested)}`);
  }
  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch {
    throw new Error(`Project directory is unavailable: ${safeTerminalText(realPath)}`);
  }
  if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${safeTerminalText(realPath)}`);
  return realPath;
}

async function runVesper(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error.message)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    output.write(USAGE);
    return 0;
  }

  let appServer;
  try {
    const store = dependencies.store || new SessionStore();
    let session;
    let cwd;
    if (options.resumeId) {
      session = store.load(options.resumeId);
      const storedCwd = resolveProjectDirectory(session.cwd);
      const selectedCwd = options.projectDirectory ? resolveProjectDirectory(options.projectDirectory) : storedCwd;
      if (selectedCwd !== storedCwd) throw new Error("The selected directory does not match this saved Vesper session.");
      cwd = storedCwd;
    } else {
      cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
      session = store.create(cwd);
    }

    output.write(`Vesper session: ${session.sessionId}\n`);
    const sessionStatus = options.resumeId ? "resumed" : "new";
    const threadStatus = session.threadId ? "saved Codex thread" : "no Codex thread yet";
    output.write(`Session status: ${sessionStatus} · ${threadStatus}\n`);
    output.write(`Project: ${cwd}\n`);

    let terminal;
    const clientFactory = dependencies.clientFactory || ((clientOptions) => new AppServerClient(clientOptions));
    appServer = clientFactory({
      initialThreadId: session.threadId,
      onThreadId: async (threadId) => {
        session = store.update(session.sessionId, { threadId });
      },
      onApproval: (method, params, context) => terminal.requestApproval(method, params, context),
      ...(dependencies.clientOptions || {}),
    });

    const handlers = dependencies.handlers || createLocalHandlers({ runGit: dependencies.runGit || runGitCommand });
    terminal = new TerminalFrontend({
      cwd,
      handlers,
      appServer,
      input: dependencies.input || process.stdin,
      output,
      lineIO: dependencies.lineIO,
      metrics: dependencies.metrics,
    });
    await terminal.run();
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  } finally {
    appServer?.dispose?.();
  }
}

function runGitCommand(args, cwd) {
  if (!cwd) return Promise.reject(new Error("No project directory is available for the Git check."));
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      timeout: 5_000,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

module.exports = {
  USAGE,
  parseArgs,
  resolveProjectDirectory,
  runGitCommand,
  runVesper,
};
