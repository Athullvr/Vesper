"use strict";

const fs = require("node:fs");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { AppServerClient } = require("./app-server-client");
const { createLocalHandlers } = require("./local-handlers");
const { MAX_SESSION_LIST_ENTRIES, SessionStore } = require("./session-store");
const { discoverMcp, discoverPlugins, discoverSkills, renderDiscovery } = require("./integration-discovery");
const { TerminalFrontend, safeTerminalText } = require("./terminal-frontend");

const USAGE = `Vesper terminal frontend

Usage:
  vesper [run] [PROJECT_DIRECTORY]
  vesper [run] --new [PROJECT_DIRECTORY]
  vesper [run] --resume SESSION_ID [PROJECT_DIRECTORY]
  vesper sessions list [PROJECT_DIRECTORY]
  vesper sessions resume SESSION_ID [PROJECT_DIRECTORY]
  vesper sessions new [PROJECT_DIRECTORY]
  vesper plugins [PROJECT_DIRECTORY]
  vesper mcp [PROJECT_DIRECTORY]
  vesper skills [PROJECT_DIRECTORY]
  vesper --help

Without --new or --resume, Vesper resumes the most recently updated session for the selected project,
or creates one when no session exists. The default project is the current working directory.
Session listings are project-scoped and show at most ${MAX_SESSION_LIST_ENTRIES} recent metadata records.
Inside Vesper, use :sessions to list this project's sessions, :switch SESSION_ID to resume one,
:new to start another session, :routing to inspect current-session routing counts, and :quit to exit.
Ctrl+C interrupts an active turn and returns to the prompt when the turn ends.

Discovery commands are read-only. They show local sources and report unknown state when Codex does not
expose it. Vesper does not install or change integrations.
`;

const SESSIONS_USAGE = `Vesper session management

Usage:
  vesper sessions list [PROJECT_DIRECTORY]
  vesper sessions resume SESSION_ID [PROJECT_DIRECTORY]
  vesper sessions new [PROJECT_DIRECTORY]

The default project is the current working directory. Session resume requires the selected project to
match the saved session's canonical project path.
`;

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "sessions") return parseSessionsArgs(args.slice(1));
  if (["plugins", "mcp", "skills"].includes(args[0])) return parseDiscoveryArgs(args[0], args.slice(1));
  if (args[0] === "modules") throw new Error("The vesper modules command is not implemented. Run vesper --help for supported commands.");
  return parseRunArgs(args);
}

function parseRunArgs(argv) {
  const args = [...argv];
  if (args[0] === "run") args.shift();

  let newSession = false;
  let resumeId = null;
  let help = false;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--new") newSession = true;
    else if (arg === "--resume") {
      if (resumeId !== null) throw new Error("Use --resume only once.");
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--resume requires a Vesper session id.");
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
  return { command: "run", newSession, resumeId, help, projectDirectory: positional[0] || null };
}

function parseSessionsArgs(args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    return { command: "sessions", action: null, help: true };
  }
  const [action, ...rest] = args;
  if (!["list", "resume", "new"].includes(action)) {
    throw new Error(`Unknown sessions command: ${safeTerminalText(action)}. Run vesper sessions --help.`);
  }
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { command: "sessions", action, help: true };
  }
  if (rest.some((arg) => arg.startsWith("-"))) throw new Error(`Unexpected option for sessions ${action}.`);
  if (action === "resume") {
    if (rest.length < 1) throw new Error("vesper sessions resume requires a Vesper session id.");
    if (rest.length > 2) throw new Error("Usage: vesper sessions resume SESSION_ID [PROJECT_DIRECTORY].");
    return { command: "sessions", action, sessionId: rest[0], projectDirectory: rest[1] || null, help: false };
  }
  if (rest.length > 1) throw new Error(`Usage: vesper sessions ${action} [PROJECT_DIRECTORY].`);
  return { command: "sessions", action, projectDirectory: rest[0] || null, help: false };
}

function parseDiscoveryArgs(command, args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { command, help: true };
  }
  if (args.some((arg) => arg.startsWith("-"))) throw new Error(`Unknown option for vesper ${command}.`);
  if (args.length > 1) throw new Error(`Usage: vesper ${command} [PROJECT_DIRECTORY].`);
  return { command, projectDirectory: args[0] || null, help: false };
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
    output.write(options.command === "sessions" ? SESSIONS_USAGE : options.command === "run" ? USAGE : discoveryUsage(options.command));
    return 0;
  }

  if (options.command === "sessions") {
    if (options.action === "list") return runSessionsList(options, dependencies, output, errorOutput);
    if (options.action === "new") {
      const projectDirectory = options.projectDirectory || process.cwd();
      return runInteractiveVesper({ command: "run", newSession: true, resumeId: null, projectDirectory }, dependencies, output, errorOutput);
    }
    if (options.action === "resume") {
      try {
        const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
        const store = dependencies.store || new SessionStore();
        const saved = store.load(options.sessionId);
        const savedCwd = resolveProjectDirectory(saved.cwd);
        if (cwd !== savedCwd) {
          throw new Error(`Vesper session ${saved.sessionId} belongs to ${savedCwd}; selected project is ${cwd}. Run the command from the saved project or pass its path.`);
        }
        return runInteractiveVesper({ command: "run", newSession: false, resumeId: saved.sessionId, projectDirectory: cwd }, { ...dependencies, store }, output, errorOutput);
      } catch (error) {
        errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
        return 1;
      }
    }
  }

  if (["plugins", "mcp", "skills"].includes(options.command)) {
    return runDiscovery(options, dependencies, output, errorOutput);
  }

  return runInteractiveVesper(options, dependencies, output, errorOutput);
}

function discoveryUsage(command) {
  return `Vesper ${command} discovery (read-only)\n\nUsage:\n  vesper ${command} [PROJECT_DIRECTORY]\n\nNo integration is installed, enabled, disabled, downloaded, or modified.\n`;
}

async function runSessionsList(options, dependencies, output, errorOutput) {
  try {
    const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    const store = dependencies.store || new SessionStore();
    const sessions = store.listByCwd(cwd, MAX_SESSION_LIST_ENTRIES);
    output.write(`Vesper sessions for ${safeCliField(cwd)} (updated, newest first; maximum ${MAX_SESSION_LIST_ENTRIES})\n`);
    if (!sessions.length) {
      output.write("No Vesper sessions found for this project.\n");
      return 0;
    }
    output.write("SESSION ID                               UPDATED (UTC)\n");
    for (const session of sessions) {
      output.write(`${session.sessionId}  ${safeCliField(session.updatedAt)}\n`);
    }
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  }
}

async function runDiscovery(options, dependencies, output, errorOutput) {
  try {
    const cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
    let result;
    if (options.command === "plugins") {
      result = discoverPlugins({ cwd, ...(dependencies.discoveryOptions || {}) });
    } else if (options.command === "skills") {
      result = discoverSkills({ cwd, ...(dependencies.discoveryOptions || {}) });
    } else {
      result = await discoverMcp({
        cwd,
        commandRunner: dependencies.codexCommandRunner,
      });
    }
    output.write(renderDiscovery(result));
    if (result.failed) {
      errorOutput.write("[Vesper error] MCP discovery status is unknown. Check the Codex CLI installation and retry.\n");
      return 1;
    }
    return 0;
  } catch (error) {
    errorOutput.write(`[Vesper error] ${safeTerminalText(error?.message || error)}\n`);
    return 1;
  }
}

async function runInteractiveVesper(options, dependencies, output, errorOutput) {
  let appServer;
  try {
    const store = dependencies.store || new SessionStore();
    let session;
    let cwd;
    let resumed = false;
    if (options.resumeId) {
      session = store.load(options.resumeId);
      const storedCwd = resolveProjectDirectory(session.cwd);
      const selectedCwd = options.projectDirectory ? resolveProjectDirectory(options.projectDirectory) : storedCwd;
      if (selectedCwd !== storedCwd) throw new Error("The selected directory does not match this saved Vesper session.");
      cwd = storedCwd;
      resumed = true;
    } else {
      cwd = resolveProjectDirectory(options.projectDirectory || process.cwd());
      session = options.newSession ? null : store.findLatestByCwd(cwd);
      resumed = Boolean(session);
      if (!session) session = store.create(cwd);
    }

    output.write(`Vesper session: ${session.sessionId}\n`);
    const sessionStatus = resumed ? "resumed" : "new";
    const threadStatus = session.threadId ? "saved Codex thread" : "no Codex thread yet";
    output.write(`Session status: ${sessionStatus} · ${threadStatus}\n`);
    output.write(`Project: ${safeCliField(cwd)}\n`);

    let terminal;
    const clientFactory = dependencies.clientFactory || ((clientOptions) => new AppServerClient(clientOptions));
    const createClient = (selectedSession) => clientFactory({
      ...(dependencies.clientOptions || {}),
      initialThreadId: selectedSession.threadId,
      onThreadId: async (threadId) => {
        const updated = store.update(selectedSession.sessionId, { threadId });
        if (session.sessionId === selectedSession.sessionId) session = updated;
      },
      onApproval: (method, params, context) => terminal.requestApproval(method, params, context),
    });
    appServer = createClient(session);

    const activateSession = async (selectedSession, action) => {
      const nextClient = createClient(selectedSession);
      const previousClient = appServer;
      try {
        terminal.replaceAppServer(nextClient, {
          sessionId: selectedSession.sessionId,
          savedThreadId: selectedSession.threadId,
        });
      } catch (error) {
        nextClient.dispose?.();
        throw error;
      }
      session = selectedSession;
      appServer = nextClient;
      previousClient?.dispose?.();
      output.write(`\n[Vesper] ${action}: ${safeCliField(session.sessionId)} · ${session.threadId ? "saved Codex thread" : "no Codex thread yet"}\n`);
      output.write(`Project: ${safeCliField(cwd)}\n`);
      if (session.threadId) {
        try {
          await terminal.restoreSavedHistory();
        } catch (error) {
          output.write(`[Vesper reconnect error] ${safeTerminalText(error?.message || error)}. The session remains selected; retry with another prompt.\n`);
        }
      }
    };

    const handleWorkspaceCommand = async (command) => {
      const [name, ...args] = command.trim().split(/\s+/u);
      if (name === ":help" && args.length === 0) {
        output.write("Workspace commands: :sessions, :switch SESSION_ID, :new, :routing, :quit\n");
        return true;
      }
      if (name === ":sessions" && args.length === 0) {
        const sessions = store.listByCwd(cwd, MAX_SESSION_LIST_ENTRIES);
        output.write(`\n[Vesper sessions · ${safeCliField(cwd)} · newest first · maximum ${MAX_SESSION_LIST_ENTRIES}]\n`);
        if (!sessions.length) output.write("No Vesper sessions found for this project.\n");
        for (const item of sessions) {
          const current = item.sessionId === session.sessionId ? " · current" : "";
          const thread = item.threadId ? "saved Codex thread" : "no Codex thread";
          output.write(`${safeCliField(item.sessionId)}  ${safeCliField(item.updatedAt)}  ${thread}${current}\n`);
        }
        output.write("Use :switch SESSION_ID to resume one.\n");
        return true;
      }
      if (name === ":new" && args.length === 0) {
        await activateSession(store.create(cwd), "New session");
        return true;
      }
      if (name === ":switch" && args.length === 1) {
        const selected = store.load(args[0]);
        const savedCwd = resolveProjectDirectory(selected.cwd);
        if (savedCwd !== cwd) {
          throw new Error(`Vesper session ${selected.sessionId} belongs to ${savedCwd}; Vesper is running in ${cwd}. Choose a session listed by :sessions.`);
        }
        if (selected.sessionId === session.sessionId) {
          output.write(`[Vesper] ${safeCliField(selected.sessionId)} is already the current session.\n`);
          return true;
        }
        await activateSession(selected, "Session switched");
        return true;
      }
      output.write("Usage: :sessions | :switch SESSION_ID | :new | :routing | :help | :quit\n");
      return true;
    };

    const handlers = dependencies.handlers || createLocalHandlers({ runGit: dependencies.runGit || runGitCommand });
    terminal = new TerminalFrontend({
      cwd,
      handlers,
      appServer,
      input: dependencies.input || process.stdin,
      output,
      lineIO: dependencies.lineIO,
      metrics: dependencies.metrics,
      savedThreadId: session.threadId,
      sessionId: session.sessionId,
      onWorkspaceCommand: handleWorkspaceCommand,
      onTask: () => {
        session = store.touch(session.sessionId);
      },
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

function safeCliField(value) {
  return safeTerminalText(value);
}

module.exports = {
  SESSIONS_USAGE,
  USAGE,
  parseArgs,
  resolveProjectDirectory,
  runGitCommand,
  runVesper,
};
