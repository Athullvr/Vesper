const vscode = require("vscode");
const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const SUPPORTED_PROMPT = "what git branch am i on";
const APP_SERVER_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 5 * 60_000;

let output;
let appServer;
let panel;
let requestSequence = 0;

function activate(context) {
  output = vscode.window.createOutputChannel("Fast Lane PoC");
  appServer = new AppServerClient(writeLog);

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("fastLane.openPanel", () => openPanel(context))
  );

  context.subscriptions.push({
    dispose: () => appServer.dispose(),
  });
}

function deactivate() {
  if (appServer) appServer.dispose();
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "fastLanePanel",
    "Fast Lane PoC",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    }
  );
  panel.webview.html = getHtml(panel.webview);

  panel.onDidDispose(() => {
    panel = undefined;
  }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "ready") {
      panel?.webview.postMessage({ type: "status", text: "Connecting to Codex app-server…" });
      appServer.connect().then(
        () => panel?.webview.postMessage({ type: "status", text: "Codex app-server connected" }),
        (error) => {
          writeLog(`app-server connection unavailable: ${safeMessage(error)}`);
          panel?.webview.postMessage({ type: "status", text: "Codex app-server unavailable; local checks still work" });
        }
      );
      return;
    }

    if (message?.type === "submit" && typeof message.text === "string") {
      await handlePrompt(message.text);
    }
  }, undefined, context.subscriptions);
}

async function handlePrompt(prompt) {
  const requestId = ++requestSequence;
  const startedAt = performance.now();
  const cwd = activeWorkspacePath();
  const normalized = normalizePrompt(prompt);

  panel?.webview.postMessage({ type: "user-message", text: prompt });

  if (normalized === SUPPORTED_PROMPT) {
    writeLog(`request=${requestId} route=local intent=current_git_branch cwd=${cwd || "<no-workspace>"}`);
    if (!cwd) {
      finishLocalError(requestId, startedAt, "Open a workspace folder before asking about its Git branch.");
      return;
    }

    runCurrentGitBranch(cwd, (error, branch) => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (error) {
        writeLog(`request=${requestId} local-check=failed elapsed_ms=${elapsedMs} reason=${safeMessage(error)}`);
        panel?.webview.postMessage({
          type: "error",
          label: "Local check failed",
          text: safeMessage(error),
          elapsedMs,
        });
        return;
      }

      if (!branch) {
        const text = "Git returned no branch name (the repository may be in detached HEAD state).";
        writeLog(`request=${requestId} local-check=empty-branch elapsed_ms=${elapsedMs}`);
        panel?.webview.postMessage({ type: "local-answer", text, elapsedMs });
        return;
      }

      const text = `Current Git branch: ${branch}`;
      writeLog(`request=${requestId} local-check=success elapsed_ms=${elapsedMs} branch=${JSON.stringify(branch)} codex_turns_started=0`);
      panel?.webview.postMessage({ type: "local-answer", text, elapsedMs });
    });
    return;
  }

  writeLog(`request=${requestId} route=codex_fallback intent=unsupported cwd=${cwd || "<no-workspace>"}`);
  if (!cwd) {
    finishLocalError(requestId, startedAt, "Open a workspace folder before sending a prompt to Codex.");
    return;
  }

  panel?.webview.postMessage({ type: "assistant-start" });
  const onDelta = (delta) => panel?.webview.postMessage({ type: "assistant-delta", text: delta });
  try {
    const result = await appServer.runCodexTurn(prompt, cwd, requestId, onDelta);
    const elapsedMs = Math.round(performance.now() - startedAt);
    writeLog(`request=${requestId} fallback=completed elapsed_ms=${elapsedMs} status=${result.status} usage=${result.usageSeen ? "reported" : "not-reported"}`);
    panel?.webview.postMessage({
      type: "assistant-done",
      elapsedMs,
      usage: result.usageSeen ? "usage reported in Output" : "usage not reported",
    });
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    writeLog(`request=${requestId} fallback=failed elapsed_ms=${elapsedMs} reason=${safeMessage(error)}`);
    panel?.webview.postMessage({
      type: "assistant-error",
      text: `Codex fallback failed: ${safeMessage(error)}`,
      elapsedMs,
    });
  }
}

function finishLocalError(requestId, startedAt, text) {
  const elapsedMs = Math.round(performance.now() - startedAt);
  writeLog(`request=${requestId} route=local-error elapsed_ms=${elapsedMs}`);
  panel?.webview.postMessage({ type: "error", label: "Fast Lane", text, elapsedMs });
}

function activeWorkspacePath() {
  const folders = vscode.workspace.workspaceFolders || [];
  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const folder = activeFolder || folders[0];
  return folder?.uri?.fsPath;
}

function normalizePrompt(prompt) {
  return prompt.toLocaleLowerCase().trim().replace(/[?!.\s]+$/u, "").replace(/\s+/gu, " ");
}

function runCurrentGitBranch(cwd, callback) {
  execFile("git", ["branch", "--show-current"], {
    cwd,
    timeout: 3_000,
    encoding: "utf8",
    maxBuffer: 4_096,
  }, (error, stdout, stderr) => {
    if (error) {
      const diagnostic = (stderr || "").trim();
      if (error.code === "ENOENT") {
        callback(new Error("Git is not available on PATH."));
      } else if (error.code === 128 && /not a git repository/iu.test(diagnostic)) {
        callback(new Error("The active workspace is not inside a Git repository."));
      } else if (error.killed) {
        callback(new Error("The Git branch check timed out."));
      } else {
        callback(new Error(diagnostic || `Git exited with code ${error.code ?? "unknown"}.`));
      }
      return;
    }

    callback(null, stdout.trim());
  });
}

class AppServerClient {
  constructor(log) {
    this.log = log;
    this.child = undefined;
    this.readyPromise = undefined;
    this.threadId = undefined;
    this.nextRpcId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.activeTurn = undefined;
    this.disposed = false;
  }

  connect() {
    if (this.readyPromise) return this.readyPromise;
    if (this.disposed) return Promise.reject(new Error("App-server client is disposed."));

    this.log("app-server spawn codex app-server --listen stdio://");
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log(`app-server stderr: ${text}`);
    });
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("close", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited (code=${code}, signal=${signal || "none"}).`));
    });

    this.readyPromise = this.request("initialize", {
      clientInfo: {
        name: "fast_lane_vscode_poc",
        title: "Fast Lane VS Code PoC",
        version: "0.1.0",
      },
    }, APP_SERVER_TIMEOUT_MS).then(() => {
      this.write({ method: "initialized", params: {} }, "initialized");
      this.log("app-server initialized");
      return true;
    }).catch((error) => {
      this.readyPromise = undefined;
      throw error;
    });

    return this.readyPromise;
  }

  async runCodexTurn(prompt, cwd, requestId, onDelta) {
    await this.connect();

    if (!this.threadId) {
      this.log(`request=${requestId} rpc=thread/start`);
      const result = await this.request("thread/start", {
        cwd,
        sandbox: "read-only",
      }, APP_SERVER_TIMEOUT_MS);
      this.threadId = result?.thread?.id;
      if (!this.threadId) throw new Error("App-server did not return a thread id.");
    }

    let completeResolve;
    let completeReject;
    const completion = new Promise((resolve, reject) => {
      completeResolve = resolve;
      completeReject = reject;
    });
    const timer = setTimeout(() => {
      if (this.activeTurn) {
        this.activeTurn = undefined;
        completeReject(new Error("Codex turn timed out."));
      }
    }, TURN_TIMEOUT_MS);

    this.activeTurn = {
      requestId,
      threadId: this.threadId,
      onDelta,
      resolve: (value) => {
        clearTimeout(timer);
        this.activeTurn = undefined;
        completeResolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        this.activeTurn = undefined;
        completeReject(error);
      },
      usageSeen: false,
    };

    this.log(`request=${requestId} rpc=turn/start`);
    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        cwd,
        input: [{ type: "text", text: prompt }],
      }, APP_SERVER_TIMEOUT_MS);
    } catch (error) {
      this.activeTurn?.reject(error);
      throw error;
    }

    return completion;
  }

  request(method, params, timeoutMs) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }

    const id = this.nextRpcId++;
    const timeout = setTimeout(() => {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        entry.reject(new Error(`Timed out waiting for app-server response to ${method}.`));
      }
    }, timeoutMs);

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    this.write({ method, id, params }, `request id=${id} method=${method}`);
    return promise;
  }

  write(message, label) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is unavailable.");
    if (label) this.log(`rpc --> ${label}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`app-server emitted non-JSON stdout: ${line.slice(0, 300)}`);
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          this.log(`rpc <-- id=${message.id} method=${pending.method} ok`);
          pending.resolve(message.result || {});
        }
        continue;
      }

      this.handleNotification(message.method, message.params || {});
    }
  }

  handleNotification(method, params) {
    if (method === "turn/started") {
      this.log(`rpc <-- turn/started turn=${params.turn?.id || "unknown"}`);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (this.activeTurn && delta) this.activeTurn.onDelta(delta);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      if (this.activeTurn) this.activeTurn.usageSeen = true;
      this.log(`rpc <-- thread/tokenUsage/updated ${JSON.stringify(params)}`);
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn || {};
      this.log(`rpc <-- turn/completed status=${turn.status || "unknown"}`);
      if (!this.activeTurn) return;
      if (turn.status === "completed") {
        this.activeTurn.resolve({ status: turn.status, usageSeen: this.activeTurn.usageSeen });
      } else {
        this.activeTurn.reject(new Error(turn.error?.message || `Codex turn ended with status ${turn.status || "unknown"}.`));
      }
      return;
    }

    if (method) this.log(`rpc <-- notification method=${method}`);
  }

  handleExit(error) {
    const message = safeMessage(error);
    if (!this.disposed) this.log(`app-server connection ended: ${message}`);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
    this.activeTurn?.reject(error);
    this.child = undefined;
    this.readyPromise = undefined;
  }

  dispose() {
    this.disposed = true;
    if (this.child && !this.child.killed) {
      this.log("stopping Codex app-server");
      this.child.kill();
    }
  }
}

function getHtml(webview) {
  const nonce = randomBytes(16).toString("hex");
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Fast Lane PoC</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); padding: 16px; }
    main { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 32px); gap: 12px; }
    header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #messages { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    article { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    article.user { background: var(--vscode-textBlockQuote-background); }
    .label { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 5px; }
    .answer { line-height: 1.45; }
    form { display: flex; gap: 8px; align-items: stretch; }
    textarea { flex: 1; min-height: 56px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 8px; font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 0 14px; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: default; }
    footer { color: var(--vscode-descriptionForeground); font-size: 11px; }
  </style>
</head>
<body>
  <main>
    <header><h1>Fast Lane</h1><div id="status">Starting…</div></header>
    <section id="messages" aria-live="polite"></section>
    <form id="form">
      <textarea id="prompt" aria-label="Prompt" placeholder="Ask a developer question…" required></textarea>
      <button id="send" type="submit">Send</button>
    </form>
    <footer>Exact local route: “What Git branch am I on?” · Other prompts go to Codex.</footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const status = document.getElementById('status');
    const form = document.getElementById('form');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    let activeAssistant;

    function addMessage(kind, label, text) {
      const article = document.createElement('article');
      article.className = kind;
      const title = document.createElement('div');
      title.className = 'label';
      title.textContent = label;
      const body = document.createElement('div');
      body.className = 'answer';
      body.textContent = text || '';
      article.append(title, body);
      messages.append(article);
      messages.scrollTop = messages.scrollHeight;
      return { article, title, body };
    }

    function setBusy(busy) {
      send.disabled = busy;
      prompt.disabled = busy;
      if (!busy) prompt.focus();
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text || send.disabled) return;
      addMessage('user', 'You', text);
      prompt.value = '';
      setBusy(true);
      vscode.postMessage({ type: 'submit', text });
    });

    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit();
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'status') status.textContent = message.text;
      if (message.type === 'user-message') return;
      if (message.type === 'local-answer') {
        addMessage('assistant', 'Fast Lane local · no Codex turn · ' + message.elapsedMs + ' ms', message.text);
        setBusy(false);
      }
      if (message.type === 'error') {
        addMessage('assistant', (message.label || 'Fast Lane') + ' · ' + message.elapsedMs + ' ms', message.text);
        setBusy(false);
      }
      if (message.type === 'assistant-start') {
        activeAssistant = addMessage('assistant', 'Codex · generating…', '');
      }
      if (message.type === 'assistant-delta' && activeAssistant) {
        activeAssistant.body.textContent += message.text;
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'assistant-done' && activeAssistant) {
        activeAssistant.title.textContent = 'Codex · ' + message.elapsedMs + ' ms · ' + message.usage;
        activeAssistant = undefined;
        setBusy(false);
      }
      if (message.type === 'assistant-error') {
        if (activeAssistant) {
          activeAssistant.title.textContent = 'Codex fallback error · ' + message.elapsedMs + ' ms';
          activeAssistant.body.textContent = message.text;
          activeAssistant = undefined;
        } else {
          addMessage('assistant', 'Codex fallback error · ' + message.elapsedMs + ' ms', message.text);
        }
        setBusy(false);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function safeMessage(error) {
  if (!error) return "Unknown error.";
  return typeof error.message === "string" ? error.message : String(error);
}

function writeLog(message) {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

module.exports = { activate, deactivate };
