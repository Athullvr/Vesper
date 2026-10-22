const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { AppServerClient } = require("./app-server-client");
const { createExecutionProvider } = require("./execution-provider");
const { createLocalHandlers } = require("./local-handlers");
const { RouteMetrics, classifyRequest, routeRequest } = require("./routing-core");
const { SessionStore } = require("./session-store");
const { resolveProjectDirectory } = require("./cli");
const { createCapabilityProvider } = require("./capability-catalog");
const { createCodexRuntimeStatusAdapter } = require("./codex-runtime-status");
const { createCapabilityPlan, getPlanningMetadata, renderCapabilityPlan } = require("./capability-planner");
const { unavailableHistory } = require("./conversation-history");

const MAX_PROMPT_LENGTH = 32 * 1024;

let output;
let appServer;
let appServerSessionId;
let panel;
let requestSequence = 0;
let localHandlers;
let routeMetrics;
let sessionStore;
let selectedWorkspacePath;
let selectedWorkspaceName;
let selectedSession;
let sessionLookupError;
let sessionView = { state: "unavailable", text: "Select an available workspace folder.", blocked: true };
let projectGeneration = 0;
let activeCodexRequestId;
let activeRequestType;
let historyLoadSequence = 0;
let historyLoadingSessionId;
let deferredHistoryRestore = false;
const capabilityProviders = new Map();

function activate(context) {
  output = vscode.window.createOutputChannel("Vesper");
  sessionStore = new SessionStore();
  localHandlers = createLocalHandlers({ runGit: runGitCommand });
  routeMetrics = new RouteMetrics();

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("fastLane.openPanel", () => openPanel(context)),
    { dispose: () => disposeCurrentAppServer() }
  );
}

function deactivate() {
  disposeCurrentAppServer();
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "fastLanePanel",
    "Vesper",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false }
  );
  const currentPanel = panel;
  panel.webview.html = getHtml(panel.webview);

  panel.onDidDispose(() => {
    if (panel === currentPanel) panel = undefined;
  }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "ready") {
      ensureInitialProjectSelection();
      postToPanel(currentPanel, projectMessage());
      loadSelectedSession();
      postSessionView(currentPanel);
      if (activeCodexRequestId !== undefined) {
        postToPanel(currentPanel, { type: "status", text: "A Vesper task is still active for this project." });
        postToPanel(currentPanel, { type: "active-request", requestId: activeCodexRequestId, kind: activeRequestType });
      }
      await restoreSelectedHistory(currentPanel);
      return;
    }

    if (message?.type === "submit" && typeof message.text === "string") {
      await handlePrompt(message.text, currentPanel);
      return;
    }

    if (message?.type === "plan-preview" && typeof message.text === "string") {
      await previewPlan(message.text, currentPanel);
      return;
    }

    if (message?.type === "select-project") {
      await selectProject(currentPanel);
      return;
    }

    if (message?.type === "retry-resume") {
      await retryResume(currentPanel);
      return;
    }

    if (message?.type === "start-new-session") {
      startNewSession(currentPanel);
      return;
    }

    if (message?.type === "interrupt" && Number.isSafeInteger(message.requestId)) {
      await interruptRequest(message.requestId, currentPanel);
    }
  }, undefined, context.subscriptions);
}

async function handlePrompt(prompt, targetPanel = panel) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    postToPanel(targetPanel, { type: "input-error", text: `Enter a task between 1 and ${MAX_PROMPT_LENGTH.toLocaleString()} characters.` });
    return;
  }
  if (activeCodexRequestId !== undefined) return;
  const requestId = ++requestSequence;
  const startedAt = performance.now();
  const project = selectedProjectContext();
  const cwd = project.available ? project.path : undefined;
  const decision = classifyRequest(prompt);

  postToPanel(targetPanel, { type: "user-message", text: prompt });
  writeLog(`request=${requestId} route=${decision.route} reason=${decision.reason} intent=${decision.intent || "none"}`);

  if (decision.route === "local") {
    const routed = await routeRequest(prompt, {
      decision,
      handlers: localHandlers,
      context: { cwd, capabilities: capabilityProviderFor(cwd) },
    });
    const result = routed.result;
    const elapsedMs = Math.round(performance.now() - startedAt);
    recordRouteMetrics(requestId, decision, elapsedMs, result.status === "unavailable", routed.routingDecision);
    if (result.status === "unavailable") {
      postToPanel(targetPanel, {
        type: "error", label: "Local check unavailable", text: result.summary, result, elapsedMs,
      });
    } else {
      postToPanel(targetPanel, { type: "local-answer", text: result.summary, result, elapsedMs });
    }
    return;
  }

  writeLog(`request=${requestId} event=request_submitted reason=${decision.reason}`);
  if (!project.available) {
    setSessionView(targetPanel, {
      state: "unavailable",
      text: "The selected workspace folder is unavailable. Its saved session was kept; choose that folder again if it returns.",
      blocked: true,
    });
    postToPanel(targetPanel, {
      type: "input-error",
      text: "The selected workspace folder is unavailable. Choose an open folder before sending a Codex task.",
    });
    return;
  }
  if (sessionLookupError) {
    postToPanel(targetPanel, {
      type: "input-error",
      text: `Saved sessions could not be checked: ${safeMessage(sessionLookupError)}. The saved session was left unchanged.`,
    });
    return;
  }
  if (sessionView.blocked) {
    postToPanel(targetPanel, { type: "input-error", text: sessionView.text });
    return;
  }

  try {
    if (!selectedSession) {
      selectedSession = sessionStore.create(cwd);
      sessionView = {
        state: "new",
        text: "New Vesper session created. Codex will start a read-only thread for this folder.",
        blocked: false,
      };
      postSessionView(targetPanel);
    }
  } catch (error) {
    postToPanel(targetPanel, { type: "input-error", text: `Vesper could not save session metadata: ${safeMessage(error)}` });
    return;
  }

  const session = selectedSession;
  const generation = projectGeneration;
  const client = appServerForSession(session, cwd, generation);
  activeCodexRequestId = requestId;
  activeRequestType = "turn";
  postToPanel(targetPanel, { type: "assistant-start", requestId });
  if (session.providerConversationId && !client.getState().conversationReady) {
    setSessionView(targetPanel, {
      state: "restoring",
      text: "Restoring the saved Codex thread…",
      blocked: false,
    });
  } else if (client.getState().conversationReady) {
    setSessionView(targetPanel, {
      state: "connected",
      text: "Connected · using the active Vesper session.",
      blocked: false,
    });
  } else {
    setSessionView(targetPanel, {
      state: "connecting",
      text: "Connecting to Codex and starting this Vesper session…",
      blocked: false,
    });
  }

  const onExecutionEvent = (event) => {
    if (event?.type === "text-delta" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      postToPanel(targetPanel, { type: "assistant-delta", requestId, text: event.text });
    }
  };
  client.on("event", onExecutionEvent);
  let routingDecision;
  try {
    const planning = await getPlanningMetadata({
      task: prompt,
      capabilityProvider: capabilityProviderFor(cwd),
      routeDecision: decision,
      projectContext: { cwd },
    });
    const routed = await routeRequest(prompt, {
      decision,
      handlers: localHandlers,
      context: { cwd, capabilities: capabilityProviderFor(cwd), planning },
      onRoutingDecision: (record) => { routingDecision = record; },
      fallback: () => client.submitTask({ task: prompt, projectPath: cwd }),
    });
    const result = routed.fallbackResult;
    const elapsedMs = Math.round(performance.now() - startedAt);
    recordRouteMetrics(requestId, decision, elapsedMs, false, routed.routingDecision);
    writeLog(`request=${requestId} fallback=completed elapsed_ms=${elapsedMs} status=${result.status}`);
    if (result.status === "interrupted" || result.status === "timeout") {
      postToPanel(targetPanel, {
        type: "assistant-error", requestId, state: result.status,
        text: result.status === "timeout" ? "Codex turn timed out." : "Turn interrupted.", elapsedMs,
      });
    } else {
      postToPanel(targetPanel, { type: "assistant-done", requestId, elapsedMs, usage: "session saved" });
    }
    try { sessionStore.update(session.sessionId, { status: "active", recovery: null }); } catch { /* Keep the completed task result visible if metadata could not be refreshed. */ }
    if (isCurrentRequest(requestId, client, session.sessionId, generation)) {
      setSessionView(targetPanel, { state: "connected", text: "Connected · this Vesper session is saved.", blocked: false });
    }
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    recordRouteMetrics(requestId, decision, elapsedMs, false, routingDecision);
    writeLog(`request=${requestId} fallback=failed elapsed_ms=${elapsedMs} code=${error.code || "TASK_FAILED"}`);
    const interrupted = error.code === "TASK_INTERRUPTED";
    const terminalTurnState = ["TASK_FAILED", "TASK_INTERRUPTED"].includes(error.code);
    if (!terminalTurnState) {
      const recoveryCode = error.code === "SUBMISSION_OUTCOME_UNCERTAIN"
        ? "submission-outcome-uncertain"
        : error.code === "RESUME_FAILED" ? "resume-failed" : "connection-lost";
      try { sessionStore.update(session.sessionId, { status: "recovery-required", recovery: { code: recoveryCode } }); } catch { /* Recovery UI remains available if metadata is not writable. */ }
      const canRetry = Boolean(session.providerConversationId);
      setSessionView(targetPanel, {
        state: "recovery-required",
        text: canRetry
          ? "Connection failed before Vesper could confirm whether the task completed. The saved session identity was kept; reconnect before sending another task."
          : "Codex did not confirm the new thread. Start a new conversation explicitly before sending another task.",
        blocked: true,
        canRetry,
        canStartNew: true,
      });
    } else if (terminalTurnState) {
      setSessionView(targetPanel, { state: "connected", text: "Connected · the saved conversation remains available.", blocked: false });
    }
    postToPanel(targetPanel, {
      type: "assistant-error",
      requestId,
      state: interrupted ? "interrupted" : "failed",
      text: interrupted ? "Turn interrupted." : `Codex fallback failed: ${safeMessage(error)}`,
      elapsedMs,
    });
  } finally {
    client.off("event", onExecutionEvent);
    if (activeCodexRequestId === requestId) {
      activeCodexRequestId = undefined;
      activeRequestType = undefined;
    }
    if (deferredHistoryRestore && activeCodexRequestId === undefined) {
      deferredHistoryRestore = false;
      if (panel && selectedSession?.sessionId === session.sessionId) void restoreSelectedHistory(panel);
    }
  }
}

async function previewPlan(task, targetPanel = panel) {
  if (!task.trim() || task.length > MAX_PROMPT_LENGTH) {
    postToPanel(targetPanel, {
      type: "plan-preview",
      text: `Enter a task between 1 and ${MAX_PROMPT_LENGTH.toLocaleString()} characters to preview a plan.`,
      error: true,
    });
    return;
  }
  const project = selectedProjectContext();
  if (!project.available || typeof project.path !== "string") {
    postToPanel(targetPanel, { type: "plan-preview", text: "Choose an available project folder before previewing a capability plan.", error: true });
    return;
  }
  try {
    const provider = capabilityProviderFor(project.path);
    const catalog = await provider.getCatalog({ refresh: true });
    const decision = classifyRequest(task);
    const plan = createCapabilityPlan({ task, catalog, routeDecision: decision, projectContext: { cwd: project.path } });
    postToPanel(targetPanel, { type: "plan-preview", text: renderCapabilityPlan(plan), error: false });
  } catch {
    postToPanel(targetPanel, { type: "plan-preview", text: "Capability discovery did not complete; Vesper could not build a plan. No task was executed.", error: true });
  }
}

function capabilityProviderFor(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  if (!capabilityProviders.has(cwd)) capabilityProviders.set(cwd, createCapabilityProvider({
    cwd,
    runtimeStatusAdapter: createCodexRuntimeStatusAdapter({
      getRuntimeClient: () => selectedSession?.cwd === cwd && appServerSessionId === selectedSession.sessionId ? appServer : null,
    }),
  }));
  return capabilityProviders.get(cwd);
}

async function selectProject(targetPanel) {
  if (activeCodexRequestId !== undefined) return;
  if (typeof vscode.window.showWorkspaceFolderPick !== "function") {
    postToPanel(targetPanel, { type: "status", text: "Project selection is unavailable in this VS Code version." });
    return;
  }

  let picked;
  try {
    picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the project for this conversation" });
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Project selection failed: ${safeMessage(error)}` });
    return;
  }
  if (!picked) return;
  const folder = workspaceFolders().find((candidate) => candidate === picked || candidate?.uri?.fsPath === picked?.uri?.fsPath);
  if (!folder) {
    postToPanel(targetPanel, { type: "status", text: "That folder is no longer in the open VS Code workspace." });
    postToPanel(targetPanel, projectMessage());
    return;
  }

  selectWorkspaceFolder(folder);
  postToPanel(targetPanel, projectMessage());
  loadSelectedSession();
  postSessionView(targetPanel);
  await restoreSelectedHistory(targetPanel);
}

async function retryResume(targetPanel) {
  if (activeCodexRequestId !== undefined || !sessionView.canRetry) return;
  const project = selectedProjectContext();
  if (!project.available || !selectedSession?.providerConversationId) return;

  const requestId = ++requestSequence;
  const session = selectedSession;
  const generation = projectGeneration;
  const client = appServerForSession(session, project.path, generation);
  const historyLoadId = ++historyLoadSequence;
  historyLoadingSessionId = session.sessionId;
  activeCodexRequestId = requestId;
  activeRequestType = "recovery";
  postToPanel(targetPanel, { type: "recovery-start" });
  setSessionView(targetPanel, { state: "restoring", text: "Verifying the saved Codex thread…", blocked: true });
  postHistoryState(targetPanel, { state: "loading", text: "Restoring saved conversation history…", entries: [], truncated: false });
  try {
    await client.recover({ projectPath: project.path, conversationId: session.providerConversationId });
    await loadHistoryForSession(targetPanel, { client, session, projectPath: project.path, generation, historyLoadId, requestId });
  } catch (error) {
    if (isCurrentRequest(requestId, client, session.sessionId, generation)) {
      showHistoryFailure(targetPanel, { client, session, projectPath: project.path, requestId, generation, historyLoadId, error });
    }
  } finally {
    if (activeCodexRequestId === requestId) {
      activeCodexRequestId = undefined;
      activeRequestType = undefined;
    }
    if (historyLoadingSessionId === session.sessionId && historyLoadSequence === historyLoadId) historyLoadingSessionId = undefined;
    postToPanel(targetPanel, { type: "recovery-finished" });
    if (deferredHistoryRestore && activeCodexRequestId === undefined) {
      deferredHistoryRestore = false;
      if (panel && selectedSession?.sessionId === session.sessionId) void restoreSelectedHistory(panel);
    }
  }
}

function startNewSession(targetPanel) {
  if (activeCodexRequestId !== undefined) return;
  const project = selectedProjectContext();
  if (!project.available) {
    postToPanel(targetPanel, { type: "status", text: "The selected workspace folder is unavailable; no session was changed." });
    return;
  }
  try {
    const previousSessionId = selectedSession?.sessionId;
    invalidateHistoryLoad();
    disposeCurrentAppServer();
    selectedSession = sessionStore.create(project.path);
    sessionLookupError = undefined;
    sessionView = {
      state: "new",
      text: previousSessionId
        ? "A new Vesper session was created. The previous saved session was retained."
        : "New Vesper session created. Codex will start a read-only thread for this folder.",
      blocked: false,
    };
    postSessionView(targetPanel);
    postHistoryState(targetPanel, {
      state: "empty",
      text: "This new Vesper session has no saved Codex conversation history yet.",
      entries: [],
      truncated: false,
    });
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Could not create a new Vesper session: ${safeMessage(error)}` });
    postSessionView(targetPanel);
  }
}

async function interruptRequest(requestId, targetPanel) {
  if (requestId !== activeCodexRequestId || !appServer) return;
  try {
    const accepted = await appServer.interrupt();
    if (accepted && requestId === activeCodexRequestId) {
      postToPanel(targetPanel, { type: "interrupt-requested", requestId });
    }
  } catch (error) {
    if (requestId === activeCodexRequestId) {
      postToPanel(targetPanel, { type: "assistant-interrupt-error", requestId, text: safeMessage(error) });
    }
  }
}

function appServerForSession(session, cwd, generation) {
  if (appServer && appServerSessionId === session.sessionId) return appServer;
  disposeCurrentAppServer();
  const sessionId = session.sessionId;
  if (session.providerId !== "codex-app-server") {
    throw new Error(`This Vesper session belongs to unsupported provider ${safeMessage(session.providerId)}. Start a new conversation explicitly to use Codex.`);
  }
  const client = createExecutionProvider({
    providerId: session.providerId,
    clientFactory: (options) => new AppServerClient(options),
    clientOptions: {
      initialThreadId: session.providerConversationId,
      sandbox: "read-only",
      onThreadId: async (threadId) => {
        const latest = sessionStore.load(sessionId);
        if (latest.cwd !== cwd) throw new Error("The Vesper session belongs to a different project folder.");
        if (latest.providerConversationId && latest.providerConversationId !== threadId) {
          throw new Error("This Vesper session is already bound to another Codex thread.");
        }
        const saved = sessionStore.update(sessionId, {
          providerConversationId: threadId,
          status: "active",
          recovery: null,
        });
        if (selectedSession?.sessionId === sessionId && projectGeneration === generation) selectedSession = saved;
      },
    },
  });
  client.setApprovalHandler(async () => ({ choice: "decline" }));
  client.on("event", (event) => {
    if (appServer !== client || appServerSessionId !== sessionId || projectGeneration !== generation ||
        selectedSession?.sessionId !== sessionId) return;
    if (event.type === "conversation-state" && event.state === "resuming") {
      setSessionView(panel, {
        state: "restoring",
        text: historyLoadingSessionId === sessionId ? "Restoring the saved thread and conversation history…" : "Restoring the saved Codex thread…",
        blocked: historyLoadingSessionId === sessionId,
      });
    } else if (event.type === "conversation-state" && event.state === "resumed") {
      if (historyLoadingSessionId === sessionId) {
        setSessionView(panel, { state: "restoring", text: "Saved thread verified; loading conversation history…", blocked: true });
      } else {
        setSessionView(panel, { state: "connected", text: "Connected · saved conversation restored.", blocked: false });
      }
    } else if (event.type === "conversation-state" && event.state === "starting") {
      setSessionView(panel, { state: "connecting", text: "Starting a new read-only Codex thread…", blocked: false });
    } else if (event.type === "conversation-state" && event.state === "created") {
      setSessionView(panel, { state: "connected", text: "Connected · new conversation started.", blocked: false });
    } else if (event.type === "connection-lost") {
      setSessionView(panel, {
        state: "disconnected",
        text: "Codex disconnected. The saved session is kept; reconnect before sending another task.",
        blocked: true,
        canRetry: Boolean(client.getState().conversationId),
        canStartNew: true,
      });
    } else if (event.type === "task-started" && event.conversationId === client.getState().conversationId && isSafeProtocolIdentity(event.taskId) &&
        activeCodexRequestId !== undefined) {
      postToPanel(panel, {
        type: "assistant-running",
        requestId: activeCodexRequestId,
        threadId: event.conversationId,
        turnId: event.taskId,
        status: "inProgress",
      });
    }
  });
  appServer = client;
  appServerSessionId = sessionId;
  return client;
}

function disposeCurrentAppServer() {
  const previous = appServer;
  appServer = undefined;
  appServerSessionId = undefined;
  previous?.dispose();
}

function isCurrentRequest(requestId, client, sessionId, generation) {
  const project = selectedProjectContext();
  return activeCodexRequestId === requestId && appServer === client && appServerSessionId === sessionId &&
    projectGeneration === generation && selectedSession?.sessionId === sessionId && project.available;
}

function ensureInitialProjectSelection() {
  if (selectedWorkspacePath !== undefined) return;
  const folders = workspaceFolders();
  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const folder = folders.includes(activeFolder) ? activeFolder : folders[0];
  if (folder) selectWorkspaceFolder(folder);
}

function selectWorkspaceFolder(folder) {
  const rawPath = folder?.uri?.fsPath;
  if (typeof rawPath !== "string" || !rawPath) return;
  invalidateHistoryLoad();
  disposeCurrentAppServer();
  projectGeneration += 1;
  selectedWorkspaceName = typeof folder.name === "string" ? folder.name : "";
  try {
    selectedWorkspacePath = resolveProjectDirectory(rawPath);
  } catch {
    selectedWorkspacePath = path.resolve(rawPath);
  }
  selectedSession = undefined;
  sessionLookupError = undefined;
}

function selectedProjectContext() {
  ensureInitialProjectSelection();
  if (!selectedWorkspacePath) return { path: "", name: "", available: false };
  const folder = workspaceFolders().find((candidate) => {
    try {
      return resolveProjectDirectory(candidate?.uri?.fsPath) === selectedWorkspacePath;
    } catch {
      return false;
    }
  });
  if (!folder) {
    return { path: selectedWorkspacePath, name: selectedWorkspaceName || path.basename(selectedWorkspacePath), available: false };
  }
  return {
    path: selectedWorkspacePath,
    name: typeof folder.name === "string" ? folder.name : selectedWorkspaceName || path.basename(selectedWorkspacePath),
    folder,
    available: true,
  };
}

function projectMessage() {
  const project = selectedProjectContext();
  return {
    type: "project",
    name: project.name,
    path: project.path,
    available: project.available,
  };
}

function loadSelectedSession() {
  const project = selectedProjectContext();
  selectedSession = undefined;
  sessionLookupError = undefined;
  if (!project.available) {
    sessionView = {
      state: "unavailable",
      text: "This workspace folder is unavailable. Choose the same folder again if it returns, or select another project explicitly.",
      blocked: true,
    };
    return;
  }
  try {
    selectedSession = sessionStore.findLatestByCwd(project.path);
    if (!selectedSession) {
      sessionView = {
        state: "new",
        text: "No saved conversation for this folder. A Vesper session will be created when you send a Codex task.",
        blocked: false,
      };
    } else if (selectedSession.providerConversationId) {
      sessionView = appServer?.getState().conversationReady && appServerSessionId === selectedSession.sessionId
        ? { state: "connected", text: "Connected · this Vesper session is saved.", blocked: false }
        : {
          state: "saved",
          text: "Saved conversation found. Vesper will verify the same Codex thread before continuing.",
          blocked: false,
        };
    } else {
      sessionView = {
        state: "new",
        text: "Saved Vesper session found without a Codex thread. Sending a task will start its first read-only thread.",
        blocked: false,
      };
    }
  } catch (error) {
    sessionLookupError = error;
    sessionView = {
      state: "unavailable",
      text: `Saved sessions could not be checked: ${safeMessage(error)}. No replacement was created.`,
      blocked: true,
      canStartNew: true,
    };
  }
}

async function restoreSelectedHistory(targetPanel) {
  const project = selectedProjectContext();
  const session = selectedSession;
  const historyLoadId = ++historyLoadSequence;
  deferredHistoryRestore = false;

  if (!project.available) {
    postHistoryState(targetPanel, unavailableHistory("Conversation history cannot be checked because the selected workspace is unavailable."));
    return;
  }
  if (sessionLookupError) {
    postHistoryState(targetPanel, unavailableHistory("Saved session metadata could not be checked, so conversation history was not treated as empty."));
    return;
  }
  if (activeCodexRequestId !== undefined) {
    deferredHistoryRestore = true;
    postHistoryState(targetPanel, {
      state: "loading",
      entries: [],
      truncated: false,
      text: "Saved history will be restored after the active Codex task finishes.",
    });
    return;
  }
  if (!session?.providerConversationId) {
    postHistoryState(targetPanel, {
      state: "empty",
      entries: [],
      truncated: false,
      text: session
        ? "This saved Vesper session has no Codex thread or saved conversation history yet."
        : "No saved Vesper conversation exists for this project yet.",
    });
    return;
  }

  const generation = projectGeneration;
  const client = appServerForSession(session, project.path, generation);
  historyLoadingSessionId = session.sessionId;
  postHistoryState(targetPanel, {
    state: "loading",
    entries: [],
    truncated: false,
    text: "Checking the saved Codex conversation history…",
  });
  setSessionView(targetPanel, {
    state: "restoring",
    text: "Verifying the saved Codex thread and loading its history…",
    blocked: true,
  });

  try {
    if (!client.getState().conversationReady) await client.resumeConversation({
      projectPath: project.path,
      conversationId: session.providerConversationId,
    });
    await loadHistoryForSession(targetPanel, {
      client,
      session,
      projectPath: project.path,
      generation,
      historyLoadId,
    });
  } catch (error) {
    showHistoryFailure(targetPanel, { client, session, generation, historyLoadId, projectPath: project.path, error });
  } finally {
    if (historyLoadingSessionId === session.sessionId && historyLoadSequence === historyLoadId) historyLoadingSessionId = undefined;
  }
}

async function loadHistoryForSession(targetPanel, { client, session, projectPath, generation, historyLoadId, requestId } = {}) {
  if (!isCurrentHistoryLoad({ client, session, projectPath, generation, historyLoadId, requestId })) return false;
  const result = await client.readConversationHistory();
  if (!isCurrentHistoryLoad({ client, session, projectPath, generation, historyLoadId, requestId })) return false;
  postHistoryState(targetPanel, result);
  setSessionView(targetPanel, {
    state: "connected",
    text: result.state === "unavailable"
      ? "Connected to the saved conversation; its history is unavailable. New tasks are available."
      : "Connected · saved Codex conversation restored.",
    blocked: false,
  });
  return true;
}

function showHistoryFailure(targetPanel, { client, session, generation, historyLoadId, projectPath, requestId, error } = {}) {
  const isCurrent = requestId === undefined
    ? isCurrentHistoryLoad({ client, session, projectPath, generation, historyLoadId })
    : isCurrentRequest(requestId, client, session.sessionId, generation) &&
      isCurrentHistoryLoad({ client, session, projectPath, generation, historyLoadId, requestId });
  if (!isCurrent) return;

  const providerState = client.getState();
  const threadVerified = providerState.conversationReady && providerState.conversationId === session.providerConversationId;
  const historyError = unavailableHistory(safeMessage(error)).text;
  postHistoryState(targetPanel, unavailableHistory(threadVerified
    ? `The saved Codex thread is connected, but conversation history could not be retrieved: ${historyError}. Vesper has not treated it as empty.`
    : `Conversation history could not be retrieved because the saved thread is not connected: ${historyError}. Vesper has not treated it as empty.`));
  if (threadVerified) {
    setSessionView(targetPanel, {
      state: "connected",
      text: "Connected to the saved conversation; its history is unavailable. New tasks are available.",
      blocked: false,
    });
  } else {
    setSessionView(targetPanel, {
      state: "recovery-required",
      text: `Could not reconnect to the saved conversation: ${historyError}. The saved session was kept. Retry or explicitly start a new conversation.`,
      blocked: true,
      canRetry: Boolean(session.providerConversationId),
      canStartNew: true,
    });
  }
}

function isCurrentHistoryLoad({ client, session, projectPath, generation, historyLoadId, requestId } = {}) {
  const project = selectedProjectContext();
  return historyLoadSequence === historyLoadId &&
    (requestId === undefined || activeCodexRequestId === requestId) &&
    appServer === client && appServerSessionId === session?.sessionId &&
    selectedSession?.sessionId === session?.sessionId && projectGeneration === generation &&
    project.available && project.path === projectPath;
}

function postHistoryState(targetPanel, state) {
  postToPanel(targetPanel, { type: "conversation-history", ...state });
}

function invalidateHistoryLoad() {
  historyLoadSequence += 1;
  historyLoadingSessionId = undefined;
  deferredHistoryRestore = false;
}

function postSessionView(targetPanel) {
  postToPanel(targetPanel, { type: "session-state", ...sessionView });
}

function setSessionView(targetPanel, view) {
  sessionView = view;
  postSessionView(targetPanel);
}

function workspaceFolders() {
  return vscode.workspace.workspaceFolders || [];
}

function postToPanel(targetPanel, message) {
  const destination = panel || targetPanel;
  if (!destination?.webview) return;
  try {
    void Promise.resolve(destination.webview.postMessage(message)).catch(() => {});
  } catch {
    // The webview may have been disposed during a panel close or reload.
  }
}

function recordRouteMetrics(requestId, decision, elapsedMs, handlerFailed = false, routingDecision) {
  const metrics = routeMetrics.record(decision, elapsedMs, { handlerFailed, routingDecision });
  writeLog(`request=${requestId} event=route_metric outcome=${routingDecision?.outcome || "unknown"} outcome_reason=${routingDecision?.outcomeReasonCode || "unknown"} route=${decision.route} reason=${decision.reason} intent=${decision.intent || "none"} route_latency_ms=${metrics.routeLatencyMs} local_routes=${metrics.localRouteCount} fallback_routes=${metrics.fallbackCount} handler_failures=${metrics.handlerFailureCount}`);
}

function runGitCommand(args, cwd) {
  if (!cwd) {
    const error = new Error("No workspace is open.");
    error.code = "WORKSPACE_NOT_FOUND";
    return Promise.reject(error);
  }

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

function getHtml(webview) {
  const nonce = randomBytes(16).toString("hex");
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Vesper</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); padding: 16px; }
    main { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 32px); gap: 12px; }
    header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #project-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    #project-details { min-width: 0; flex: 1; }
    #project-name { font-weight: 600; }
    #project-path { color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
    #session-state { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
    #history-state { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
    #recovery-actions { display: flex; gap: 8px; margin-top: 8px; }
    #recovery-actions[hidden], #retry-resume[hidden], #start-new-session[hidden] { display: none; }
    #messages { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    article { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    article.user { background: var(--vscode-textBlockQuote-background); }
    article.tool, article.activity { border-style: dashed; }
    article.error { border-color: var(--vscode-errorForeground); }
    article.turn { border: 0; padding: 2px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .label { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 5px; }
    .answer { line-height: 1.45; }
    form { display: flex; gap: 8px; align-items: stretch; }
    textarea { flex: 1; min-height: 56px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 8px; font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 0 14px; cursor: pointer; }
    #stop { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); min-height: 40px; }
    #stop[hidden] { display: none; }
    button:disabled { opacity: 0.6; cursor: default; }
    footer { color: var(--vscode-descriptionForeground); font-size: 11px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Vesper</h1>
      <div id="project-row">
        <div id="project-details"><div id="project-name">Loading project…</div><div id="project-path"></div></div>
        <button id="choose-project" type="button">Choose project</button>
      </div>
      <div id="status">Starting…</div>
      <div id="session-state" role="status">Checking saved Vesper sessions…</div>
      <div id="history-state" role="status">Conversation history has not been checked.</div>
      <div id="recovery-actions" hidden>
        <button id="retry-resume" type="button" hidden>Retry connection</button>
        <button id="start-new-session" type="button" hidden>Start new conversation</button>
      </div>
    </header>
    <section id="messages" aria-live="polite"></section>
    <form id="form">
      <textarea id="prompt" aria-label="Prompt" placeholder="Ask a developer question…" maxlength="32768" required></textarea>
      <button id="preview-plan" type="button">Plan</button>
      <button id="send" type="submit">Send</button>
      <button id="stop" type="button" hidden>Stop</button>
    </form>
    <footer>Local Git and test checks stay local. Codex uses a read-only sandbox; Vesper declines approval requests.</footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const status = document.getElementById('status');
    const form = document.getElementById('form');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const previewPlan = document.getElementById('preview-plan');
    const stop = document.getElementById('stop');
    const chooseProject = document.getElementById('choose-project');
    const projectName = document.getElementById('project-name');
    const projectPath = document.getElementById('project-path');
    const sessionState = document.getElementById('session-state');
    const historyState = document.getElementById('history-state');
    const recoveryActions = document.getElementById('recovery-actions');
    const retryResume = document.getElementById('retry-resume');
    const startNewSession = document.getElementById('start-new-session');
    let activeAssistant;
    let activeRequestId;
    let sessionBlocked = false;
    let recoveryLoading = false;

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
      send.disabled = busy || sessionBlocked || recoveryLoading;
      previewPlan.disabled = busy;
      prompt.disabled = busy || sessionBlocked || recoveryLoading;
      chooseProject.disabled = busy;
      if (!busy && !sessionBlocked) prompt.focus();
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

    previewPlan.addEventListener('click', () => {
      const text = prompt.value.trim();
      if (!text || previewPlan.disabled) return;
      previewPlan.disabled = true;
      vscode.postMessage({ type: 'plan-preview', text });
    });

    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit();
    });

    chooseProject.addEventListener('click', () => {
      if (chooseProject.disabled) return;
      vscode.postMessage({ type: 'select-project' });
    });

    retryResume.addEventListener('click', () => {
      if (retryResume.disabled) return;
      retryResume.disabled = true;
      vscode.postMessage({ type: 'retry-resume' });
    });

    startNewSession.addEventListener('click', () => {
      if (startNewSession.disabled) return;
      startNewSession.disabled = true;
      vscode.postMessage({ type: 'start-new-session' });
    });

    stop.addEventListener('click', () => {
      if (activeRequestId === undefined || stop.disabled) return;
      stop.disabled = true;
      status.textContent = 'Interrupt requested · waiting for Codex turn state…';
      vscode.postMessage({ type: 'interrupt', requestId: activeRequestId });
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'status') status.textContent = message.text;
      if (message.type === 'project') {
        if ((projectPath.dataset.currentPath || '') !== (message.path || '')) {
          messages.replaceChildren();
          activeAssistant = undefined;
          activeRequestId = undefined;
          stop.hidden = true;
          historyState.textContent = 'Checking this project’s saved conversation history…';
        }
        projectPath.dataset.currentPath = message.path || '';
        projectName.textContent = message.available ? (message.name || 'Workspace folder') : (message.name ? message.name + ' · unavailable' : 'No workspace folder selected');
        projectPath.textContent = message.path || 'Open a folder in VS Code to start a Codex task.';
        projectPath.title = message.path || '';
      }
      if (message.type === 'conversation-history') {
        historyState.textContent = typeof message.text === 'string' ? message.text : 'Conversation history status unavailable.';
        if (message.state === 'loading') {
          if (activeRequestId === undefined) messages.replaceChildren();
          return;
        }
        messages.replaceChildren();
        activeAssistant = undefined;
        activeRequestId = undefined;
        stop.hidden = true;
        if (message.state === 'unavailable') return;
        const historyKinds = new Set(['user', 'assistant', 'tool', 'activity', 'error', 'availability', 'turn']);
        if (Array.isArray(message.entries)) {
          for (const entry of message.entries) {
            if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string' || typeof entry.text !== 'string') continue;
            const kind = historyKinds.has(entry.kind) ? entry.kind : 'activity';
            addMessage(kind, entry.label, entry.text);
          }
        }
      }
      if (message.type === 'session-state') {
        sessionBlocked = Boolean(message.blocked);
        sessionState.textContent = message.text || '';
        retryResume.hidden = !message.canRetry;
        startNewSession.hidden = !message.canStartNew;
        recoveryActions.hidden = !message.canRetry && !message.canStartNew;
        retryResume.disabled = false;
        startNewSession.disabled = false;
        if (activeRequestId === undefined && !recoveryLoading) {
          send.disabled = sessionBlocked;
          prompt.disabled = sessionBlocked;
        }
      }
      if (message.type === 'recovery-start') {
        recoveryLoading = true;
        setBusy(true);
      }
      if (message.type === 'recovery-finished') {
        recoveryLoading = false;
        setBusy(false);
      }
      if (message.type === 'active-request') {
        activeRequestId = message.requestId;
        setBusy(true);
        if (message.kind === 'turn') {
          activeAssistant = addMessage('assistant', 'Codex · task continued after panel reopen…', '');
          stop.hidden = false;
          stop.disabled = false;
        }
      }
      if (message.type === 'user-message') return;
      if (message.type === 'plan-preview') {
        addMessage(message.error ? 'error' : 'assistant', 'Vesper plan · advisory · not executed', message.text || 'No plan output is available.');
        previewPlan.disabled = false;
      }
      if (message.type === 'local-answer') {
        const state = message.result?.status || 'confirmed';
        addMessage('assistant', 'Fast Lane local · ' + state + ' · no Codex turn · ' + message.elapsedMs + ' ms', message.text);
        setBusy(false);
      }
      if (message.type === 'error') {
        addMessage('assistant', (message.label || 'Fast Lane') + ' · ' + message.elapsedMs + ' ms', message.text);
        setBusy(false);
      }
      if (message.type === 'input-error') {
        addMessage('assistant', 'Task not sent', message.text);
        status.textContent = message.text;
        setBusy(false);
      }
      if (message.type === 'assistant-start') {
        activeRequestId = message.requestId;
        activeAssistant = addMessage('assistant', 'Codex · connecting…', '');
        stop.hidden = false;
        stop.disabled = false;
        setBusy(true);
        status.textContent = 'Codex · connecting to the selected project…';
      }
      if (message.type === 'assistant-running' && message.requestId === activeRequestId) {
        status.textContent = 'Codex · running';
        if (activeAssistant) activeAssistant.title.textContent = 'Codex · running…';
      }
      if (message.type === 'assistant-delta' && message.requestId === activeRequestId && activeAssistant) {
        activeAssistant.body.textContent += message.text;
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'interrupt-requested' && message.requestId === activeRequestId) {
        status.textContent = 'Interrupt sent · waiting for Codex to stop…';
      }
      if (message.type === 'assistant-interrupt-error' && message.requestId === activeRequestId) {
        status.textContent = 'Interrupt was not confirmed · the turn may still be running.';
        stop.disabled = false;
        if (activeAssistant) activeAssistant.title.textContent = 'Codex · running (interrupt not confirmed)';
      }
      if (message.type === 'assistant-done' && message.requestId === activeRequestId && activeAssistant) {
        activeAssistant.title.textContent = 'Codex · ' + message.elapsedMs + ' ms · ' + message.usage;
        activeAssistant = undefined;
      }
      if (message.type === 'assistant-done' && message.requestId === activeRequestId) {
        activeRequestId = undefined;
        status.textContent = 'Codex · completed';
        stop.hidden = true;
        setBusy(false);
      }
      if (message.type === 'assistant-error' && message.requestId === activeRequestId) {
        if (activeAssistant) {
          const interrupted = message.state === 'interrupted';
          activeAssistant.title.textContent = interrupted ? 'Codex · interrupted' : 'Codex · failed · ' + message.elapsedMs + ' ms';
          activeAssistant.body.textContent += (activeAssistant.body.textContent ? '\\n\\n' : '') + message.text;
          activeAssistant = undefined;
        } else {
          const label = message.state === 'interrupted' ? 'Codex · interrupted' : 'Codex fallback error · ' + message.elapsedMs + ' ms';
          addMessage('assistant', label, message.text);
        }
        activeRequestId = undefined;
        status.textContent = message.state === 'interrupted' ? 'Codex · interrupted' : 'Codex · failed; the conversation remains visible in this panel.';
        stop.hidden = true;
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
  const message = typeof error.message === "string" ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 800);
}

function isSafeProtocolIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function writeLog(message) {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

module.exports = { activate, deactivate };
