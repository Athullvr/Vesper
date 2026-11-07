const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { DEFAULT_PROVIDER_ID, NVIDIA_PROVIDER_ID, OPENAI_PROVIDER_ID, createExecutionProvider, getProviderStatus, listProviders, resolveDefaultProviderId } = require("./execution-provider");
const { createLocalHandlers } = require("./local-handlers");
const { RouteMetrics, classifyRequest, routeRequest } = require("./routing-core");
const { SessionStore, defaultSessionDirectory } = require("./session-store");
const { resolveProjectDirectory } = require("./cli");
const { createCapabilityProvider } = require("./capability-catalog");
const { createCodexRuntimeStatusAdapter } = require("./codex-runtime-status");
const { createCapabilityPlan, getPlanningMetadata, renderCapabilityPlan } = require("./capability-planner");
const { MAX_HISTORY_MESSAGES, MAX_HISTORY_TEXT_LENGTH, unavailableHistory } = require("./conversation-history");
const { createPermissionedToolRuntime, renderToolApproval } = require("./permissioned-tool-runtime");
const { createRepositoryIntelligence } = require("./repository-intelligence");
const { createSystemModel, isComplexInvestigation, isModelAssistedEnabled, renderSystemModelReport, shouldInvestigateTask } = require("./system-model");
const { TaskLifecycle, understandTask, captureWorkspaceDiff, taskStageLabel, taskStatusLabel, selectVerificationCandidates, parseVerificationArgv } = require("./task-workflow");
const { redactSensitiveText } = require("./command-activity");

const MAX_PROMPT_LENGTH = 32 * 1024;
const MAX_PREFLIGHT_CONTEXT_LENGTH = 7_000;
const MAX_PREFLIGHT_SUMMARY_LENGTH = 1_400;
const MAX_PANEL_APPROVAL_REVIEW_LENGTH = 32 * 1024;
const TOOL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY_PAGES = 8;

let output;
let executionProvider;
let executionProviderSessionId;
let permissionedToolRuntime;
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
let activeRepositoryPreflight;
let activeRepositoryInspection;
let activeVerification;
let lastTaskLifecycle;
let lastTaskGeneration;
let activeHistoryPage;
let providerLiveStatus = new Map();
let pendingToolApprovals = new Map();
let repositoryToolRuntimeFactory = createPermissionedToolRuntime;
const capabilityProviders = new Map();

function activate(context, dependencies = {}) {
  repositoryToolRuntimeFactory = typeof dependencies.repositoryToolRuntimeFactory === "function"
    ? dependencies.repositoryToolRuntimeFactory : createPermissionedToolRuntime;
  output = vscode.window.createOutputChannel("Vesper");
  sessionStore = new SessionStore();
  localHandlers = createLocalHandlers({ runGit: runGitCommand });
  routeMetrics = new RouteMetrics();

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("fastLane.inspectRepository", () => runInspectionCommand(context, "inspect")),
    vscode.commands.registerCommand("fastLane.assessChangeImpact", () => runInspectionCommand(context, "impact")),
    vscode.commands.registerCommand("fastLane.switchSession", () => runSessionCommand(context)),
    vscode.commands.registerCommand("fastLane.newSessionWithProvider", () => runProviderSessionCommand(context)),
    vscode.commands.registerCommand("fastLane.openPanel", () => openPanel(context)),
    { dispose: () => disposeCurrentAppServer() }
  );
}

function deactivate() {
  cancelActiveRepositoryInspection();
  cancelActiveRepositoryPreflight();
  cancelActiveVerification("extension-deactivated");
  cancelPendingToolApprovals("cancelled");
  disposeCurrentAppServer();
  repositoryToolRuntimeFactory = createPermissionedToolRuntime;
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return panel;
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
    if (panel === currentPanel) {
      panel = undefined;
      if (activeRepositoryInspection) cancelActiveRepositoryInspection();
      cancelPanelToolApprovals(currentPanel);
      if (activeVerification) cancelActiveVerification("panel-closed");
    }
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
      postCurrentTaskState(currentPanel);
      for (const approval of pendingToolApprovals.values()) postToolApproval(approval);
      if (activeVerification) postToPanel(currentPanel, { type: "verification-start", requestId: activeVerification.requestId, operation: activeVerification.kind });
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

    if (message?.type === "repository-inspection" && typeof message.task === "string") {
      await runRepositoryInspection(message.task, message.intent, currentPanel);
      return;
    }

    if (message?.type === "switch-session") {
      await switchSavedSession(currentPanel);
      return;
    }

    if (message?.type === "new-session-with-provider") {
      await createSessionWithProvider(currentPanel);
      return;
    }

    if (message?.type === "load-older-history") {
      await loadOlderHistory(currentPanel);
      return;
    }

    if (message?.type === "tool-approval-response") {
      decideToolApproval(currentPanel, message);
      return;
    }

    if (message?.type === "refresh-verification" && typeof message.requestId === "string") {
      await refreshVerificationSuggestions(message.requestId, currentPanel);
      return;
    }

    if (message?.type === "run-verification" && typeof message.requestId === "string" && Number.isSafeInteger(message.index)) {
      await runVerification(message.requestId, message.index, currentPanel);
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
  return currentPanel;
}

async function handlePrompt(prompt, targetPanel = panel) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    postToPanel(targetPanel, { type: "input-error", text: `Enter a task between 1 and ${MAX_PROMPT_LENGTH.toLocaleString()} characters.` });
    return;
  }
  if (hasActiveOperation()) return;
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
      const providerId = selectedProviderForNewSession();
      selectedSession = createProviderSession(cwd, providerId);
      sessionView = {
        state: "new",
        text: `New Vesper session created for ${providerDisplayName(providerId)}.`,
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
  const lifecycle = new TaskLifecycle({ requestId: String(requestId), sessionId: session.sessionId, providerId: session.providerId, projectRoot: cwd, task: prompt });
  lastTaskLifecycle = lifecycle;
  lastTaskGeneration = generation;
  activeCodexRequestId = requestId;
  activeRequestType = "turn";
  let client;
  try {
    client = executionProviderForSession(session, cwd, generation);
  } catch (error) {
    lifecycle.complete({ error });
    postToPanel(targetPanel, { type: "assistant-start", requestId, providerId: session.providerId });
    postCurrentTaskState(targetPanel);
    postToPanel(targetPanel, { type: "assistant-error", requestId, state: "failed", providerId: session.providerId,
      text: `${providerSessionName(session.providerId)} could not start this task: ${safeMessage(error)}`, elapsedMs: 0 });
    setProviderLiveStatus(session.sessionId, { text: `last provider task could not start (${safeErrorCode(error)})` });
    activeCodexRequestId = undefined;
    activeRequestType = undefined;
    postSessionView(targetPanel);
    return;
  }
  const postWorkflowState = () => {
    if (!isCurrentRequest(requestId, client, session.sessionId, generation)) return;
    const { projectRoot: _projectRoot, ...state } = lifecycle.snapshot();
    const workflow = { ...state, stageLabel: taskStageLabel(state.stage), statusLabel: taskStatusLabel(state.status) };
    postToPanel(targetPanel, { type: "workflow-state", requestId, workflow });
    postToPanel(targetPanel, { type: "task-state", workflow });
  };
  postToPanel(targetPanel, { type: "assistant-start", requestId, providerId: session.providerId });
  postCurrentTaskState(targetPanel);
  const providerName = providerSessionName(session.providerId);
  if (session.providerConversationId && !client.getState().conversationReady) {
    setSessionView(targetPanel, {
      state: "restoring",
      text: `Restoring the saved ${providerName} conversation…`,
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
      text: `Connecting to ${providerName} for this Vesper session…`,
      blocked: false,
    });
  }

  const onExecutionEvent = (event) => {
    const accepted = lifecycle.observe(event);
    if (accepted && isCurrentRequest(requestId, client, session.sessionId, generation)) postWorkflowState();
    if (event?.type === "text-delta" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      postToPanel(targetPanel, { type: "assistant-delta", requestId, text: event.text });
    } else if (["tool-call", "tool-result"].includes(event?.type) && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      postToPanel(targetPanel, {
        type: "tool-activity",
        requestId,
        state: event.state,
        toolId: event.toolId,
        verified: event.verified === true,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
      });
    } else if (event?.type === "task-progress" && event.kind === "workflow-stage" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      postToPanel(targetPanel, { type: "workflow-stage", requestId, stage: event.stage });
    } else if (event?.type === "task-progress" && event.kind === "workflow-report" && typeof event.report === "string" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      postToPanel(targetPanel, { type: "assistant-delta", requestId, text: `\n\n${event.report}\n` });
    } else if (event?.type === "file-change" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      const activity = event.activity || {};
      const workflow = lifecycle.snapshot();
      postToPanel(targetPanel, {
        type: "file-change-activity", requestId,
        state: activity.state || "unavailable",
        files: workflow.proposedFiles,
        note: "Codex-reported proposal metadata; disk state is not verified by this summary.",
      });
    } else if (event?.type === "task-progress" && event.kind === "aggregate-diff" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      postToPanel(targetPanel, { type: "turn-diff", requestId, activity: normalizeTurnDiffForPanel(event.activity) });
    } else if (event?.type === "approval-required" && isCurrentRequest(requestId, client, session.sessionId, generation)) {
      if (session.providerId === DEFAULT_PROVIDER_ID) postCodexApprovalRequest(targetPanel, event.request, session, requestId);
    } else if (event?.type === "approval-decided" && isCurrentRequest(requestId, client, session.sessionId, generation) && session.providerId === DEFAULT_PROVIDER_ID) {
      postCodexApprovalDecision(targetPanel, event);
    }
  };
  client.on("event", onExecutionEvent);
  let routingDecision;
  let repositoryEvidence = null;
  let providerTask = prompt;
  let preflightController;
  try {
    if (shouldInvestigateTask(prompt)) {
      activeRequestType = "preflight";
      postToPanel(targetPanel, { type: "repository-preflight", requestId, state: "running" });
      writeLog(`request=${requestId} preflight=started provider=${session.providerId}`);
      const controller = new AbortController();
      preflightController = controller;
      let runtime;
      let systemModel;
      const preflight = { requestId, controller, systemModel, sessionId: session.sessionId, projectPath: cwd, generation };
      activeRepositoryPreflight = preflight;
      let preparation;
      try {
        runtime = repositoryToolRuntimeFactory({
          projectRoot: cwd,
          sessionId: session.sessionId,
          commandExecutionEnabled: false,
          commandWorkspaceWriteEnabled: false,
        });
        if (!runtime || runtime.sessionId !== session.sessionId) throw new Error("Inspection runtime session mismatch.");
        const getConversationId = () => client.getState?.().conversationId || session.providerConversationId || null;
        const repositoryIntelligence = createRepositoryIntelligence({
          toolRuntime: runtime,
          projectRoot: cwd,
          sessionId: session.sessionId,
          providerId: session.providerId,
          getConversationId,
        });
        systemModel = createSystemModel({ repositoryIntelligence, planner: client });
        preflight.systemModel = systemModel;
        preparation = await understandTask({
          task: prompt, routeDecision: decision, systemModel, projectRoot: cwd, sessionId: session.sessionId,
          providerId: session.providerId,
          conversationId: client.getState?.().conversationId || session.providerConversationId || null,
          signal: controller.signal,
          maximumTaskLength: MAX_PROMPT_LENGTH,
          maximumContextLength: MAX_PREFLIGHT_CONTEXT_LENGTH,
        });
      } catch (error) {
        preparation = await understandTask({
          task: prompt, routeDecision: decision, systemModel: null, projectRoot: cwd, sessionId: session.sessionId,
          providerId: session.providerId, conversationId: client.getState?.().conversationId || session.providerConversationId || null,
          signal: controller.signal, maximumTaskLength: MAX_PROMPT_LENGTH, maximumContextLength: MAX_PREFLIGHT_CONTEXT_LENGTH,
        });
        writeLog(`request=${requestId} preflight=fallback code=${safeErrorCode(error)}`);
      } finally {
        try { await runtime?.dispose?.(); } catch { /* Inspection cleanup must not trigger another provider submission. */ }
      }
      lifecycle.setUnderstanding(preparation);
      if (preparation.state === "cancelled" || controller.signal.aborted) {
        lifecycle.cancelBeforeSubmission(preparation.note);
        lifecycle.complete();
        postWorkflowState();
        recordRouteMetrics(requestId, decision, Math.round(performance.now() - startedAt), false);
        postToPanel(targetPanel, {
          type: "assistant-error", requestId, state: "interrupted", preflight: true, providerId: session.providerId,
          text: "Repository inspection was cancelled. The provider task was not submitted.",
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        writeLog(`request=${requestId} preflight=cancelled task_submitted=false`);
        return;
      }
      repositoryEvidence = preparation.repositoryEvidence;
      providerTask = preparation.providerTask;
      const included = preparation.evidenceIncluded;
      const state = preparation.state === "not-needed" ? "complete" : preparation.state;
      const text = included
        ? summarizeRepositoryPreflight(preparation.investigation, true)
        : preparation.note || "Repository evidence was not attached to this task.";
      postToPanel(targetPanel, {
        type: "repository-preflight", requestId,
        state: preparation.state === "fallback" ? "fallback" : state,
        evidenceIncluded: included,
        text,
      });
      writeLog(`request=${requestId} preflight=${preparation.state} evidence_attached=${included}`);
      if (!isCurrentRequest(requestId, client, session.sessionId, generation)) {
        lifecycle.cancelBeforeSubmission("The selected project or session changed during repository inspection.");
        lifecycle.complete();
        postToPanel(targetPanel, {
          type: "assistant-error", requestId, state: "interrupted", preflight: true, providerId: session.providerId,
          text: "The selected project or session changed during repository inspection. The provider task was not submitted.",
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
    } else {
      lifecycle.setUnderstanding({ state: "not-needed", evidenceIncluded: false });
    }
    postWorkflowState();
    const planning = await getPlanningMetadata({
      task: prompt,
      capabilityProvider: capabilityProviderFor(cwd),
      routeDecision: decision,
      projectContext: { cwd },
    });
    if (preflightController?.signal.aborted) throw createPreflightCancelledError();
    const routed = await routeRequest(prompt, {
      decision,
      handlers: localHandlers,
      context: { cwd, capabilities: capabilityProviderFor(cwd), planning },
      onRoutingDecision: (record) => { routingDecision = record; },
      fallback: () => {
        if (preflightController?.signal.aborted) throw createPreflightCancelledError();
        if (activeRepositoryPreflight?.requestId === requestId) activeRepositoryPreflight = undefined;
        activeRequestType = "turn";
        postToPanel(targetPanel, { type: "task-submission", requestId, state: "submitting", providerId: session.providerId });
        return client.submitTask({ task: providerTask, projectPath: cwd, repositoryEvidence }).then((result) => {
          postToPanel(targetPanel, { type: "task-submission", requestId, state: result?.status || "provider-error", providerId: session.providerId });
          return result;
        });
      },
    });
    const result = routed.fallbackResult;
    if (!result || !["completed", "interrupted", "timeout"].includes(result.status)) {
      throw new Error("The provider did not return a confirmed task outcome.");
    }
    setProviderLiveStatus(session.sessionId, { text: `last live task ${result.status} ${formatTimestamp(new Date().toISOString())}` });
    if (result.status === "completed") lifecycle.setStage("review");
    postWorkflowState();
    await captureWorkspaceDiff(lifecycle, permissionedToolRuntime, {
      isCurrent: () => isCurrentRequest(requestId, client, session.sessionId, generation),
    });
    lifecycle.complete({ result });
    postWorkflowState();
    const elapsedMs = Math.round(performance.now() - startedAt);
    recordRouteMetrics(requestId, decision, elapsedMs, false, routed.routingDecision);
    writeLog(`request=${requestId} fallback=completed elapsed_ms=${elapsedMs} status=${result.status}`);
    if (result.status === "interrupted" || result.status === "timeout") {
      postToPanel(targetPanel, {
        type: "assistant-error", requestId, state: result.status,
        providerId: session.providerId,
        text: result.status === "timeout" ? `${providerName} task timed out.` : isTextOnlyProvider(session.providerId)
          ? "The request was interrupted locally. The remote service may have completed it; Vesper did not resubmit it. Start a new conversation to continue."
          : "Turn interrupted.", elapsedMs,
      });
    } else {
      postToPanel(targetPanel, {
        type: "assistant-done", requestId, elapsedMs, usage: "session saved",
        providerId: session.providerId,
        model: client.getState().model || null,
        generatedTextOnly: isTextOnlyProvider(session.providerId),
        truncated: Boolean(result.truncated),
        workflowStatus: lifecycle.snapshot().status,
        providerStatus: lifecycle.snapshot().providerStatus,
        verificationState: lifecycle.snapshot().verification.state,
        verifiedFiles: lifecycle.snapshot().verifiedFiles,
        diskVerifiedFiles: lifecycle.snapshot().diskVerifiedFiles,
        proposedFiles: lifecycle.snapshot().proposedFiles,
      });
    }
    const uncertainInterrupt = result.status === "interrupted" && result.recoveryCode === "submission-outcome-uncertain";
    try {
      sessionStore.update(session.sessionId, uncertainInterrupt
        ? { status: "recovery-required", recovery: { code: "submission-outcome-uncertain" } }
        : { status: "active", recovery: null });
      selectedSession = sessionStore.touch(session.sessionId);
    } catch { /* Keep the task result visible if metadata could not be refreshed. */ }
    if (isCurrentRequest(requestId, client, session.sessionId, generation)) {
      setSessionView(targetPanel, uncertainInterrupt
        ? { state: "recovery-required", text: "The remote request may have completed. Its transcript is retained, and this conversation cannot be submitted again safely.", blocked: true, canStartNew: true }
        : { state: "connected", text: isTextOnlyProvider(session.providerId)
          ? `${providerSessionName(session.providerId)} · this Vesper session is saved.`
          : "Connected · this Vesper session is saved.", blocked: false });
      postSessionView(targetPanel);
    }
  } catch (error) {
    const outcome = lifecycle.snapshot();
    setProviderLiveStatus(session.sessionId, {
      text: outcome.submitted
        ? `last live task failed (${safeErrorCode(error)})`
        : `last task ended before provider completion (${safeErrorCode(error)})`,
    });
    lifecycle.setStage("review");
    postWorkflowState();
    await captureWorkspaceDiff(lifecycle, permissionedToolRuntime, {
      isCurrent: () => isCurrentRequest(requestId, client, session.sessionId, generation),
    });
    if (error.code === "PREFLIGHT_CANCELLED") {
      lifecycle.cancelBeforeSubmission("Repository inspection was cancelled; the provider task was not submitted.");
      lifecycle.complete();
    } else {
      lifecycle.complete({ error });
    }
    postWorkflowState();
    const elapsedMs = Math.round(performance.now() - startedAt);
    recordRouteMetrics(requestId, decision, elapsedMs, false, routingDecision);
    if (error.code === "PREFLIGHT_CANCELLED") {
      postToPanel(targetPanel, {
        type: "assistant-error", requestId, state: "interrupted", preflight: true, providerId: session.providerId,
        text: "Repository inspection was cancelled. The provider task was not submitted.", elapsedMs,
      });
      writeLog(`request=${requestId} preflight=cancelled task_submitted=false`);
      return;
    }
    writeLog(`request=${requestId} fallback=failed elapsed_ms=${elapsedMs} code=${error.code || "TASK_FAILED"}`);
    postToPanel(targetPanel, {
      type: "task-submission", requestId,
      state: error.code === "SUBMISSION_OUTCOME_UNCERTAIN" ? "outcome-uncertain" : "provider-error",
      providerId: session.providerId,
    });
    const interrupted = error.code === "TASK_INTERRUPTED";
    const terminalTurnState = ["TASK_FAILED", "TASK_INTERRUPTED"].includes(error.code);
    if (!terminalTurnState) {
      const recoveryCode = error.code === "SUBMISSION_OUTCOME_UNCERTAIN"
        ? "submission-outcome-uncertain"
        : error.code === "UNSUPPORTED_OPERATION" ? "unsupported-operation"
          : error.code === "RESUME_FAILED" ? "resume-failed" : "connection-lost";
      try { selectedSession = sessionStore.update(session.sessionId, { status: "recovery-required", recovery: { code: recoveryCode } }); } catch { /* Recovery UI remains available if metadata is not writable. */ }
      const canRetry = Boolean(session.providerConversationId && client.capabilities.recovery);
      setSessionView(targetPanel, {
        state: "recovery-required",
        text: error.code === "UNSUPPORTED_OPERATION"
          ? `${providerName} returned an operation Vesper does not execute. This conversation is blocked; start a new conversation to continue.`
          : canRetry
          ? `Connection failed before Vesper could confirm whether the ${providerName} task completed. The saved session identity was kept; reconnect before sending another task.`
          : `${providerName} did not confirm the new conversation. Start a new conversation explicitly before sending another task.`,
        blocked: true,
        canRetry,
        canStartNew: true,
      });
    } else if (terminalTurnState) {
      try { selectedSession = sessionStore.touch(session.sessionId); } catch { /* The task error remains visible if session metadata cannot be refreshed. */ }
      setSessionView(targetPanel, { state: "connected", text: "Connected · the saved conversation remains available.", blocked: false });
    }
    postToPanel(targetPanel, {
      type: "assistant-error",
      requestId,
      state: interrupted ? "interrupted" : "failed",
      providerId: session.providerId,
      text: interrupted ? "Turn interrupted." : `${providerName} task failed: ${safeMessage(error)}`,
      elapsedMs,
    });
    if (selectedSession?.sessionId === session.sessionId && projectGeneration === generation) postSessionView(targetPanel);
  } finally {
    client.off("event", onExecutionEvent);
    if (activeRepositoryPreflight?.requestId === requestId) activeRepositoryPreflight = undefined;
    if (activeCodexRequestId === requestId) {
      activeCodexRequestId = undefined;
      activeRequestType = undefined;
    }
    if (deferredHistoryRestore && !hasActiveOperation()) {
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
    postToPanel(targetPanel, { type: "plan-preview", text: `${renderCapabilityPlan(plan)}\n\n${renderCapabilityStatusSummary(catalog)}`, error: false });
  } catch {
    postToPanel(targetPanel, { type: "plan-preview", text: "Capability discovery did not complete; Vesper could not build a plan. No task was executed.", error: true });
  }
}

function renderCapabilityStatusSummary(catalog) {
  const capabilities = Array.isArray(catalog?.capabilities) ? catalog.capabilities : [];
  const lines = [`Discovered capability status · ${capabilities.length} item(s). Discovery is separate from installation, configuration, connection, runtime loading, and successful use.`];
  for (const item of capabilities.slice(0, 16)) {
    lines.push(`- ${safeCapabilityText(item.type)} ${safeCapabilityText(item.id)} · discovery ${safeCapabilityText(item.discoveryStatus)} · installation ${safeCapabilityText(item.installationStatus)} · configuration ${safeCapabilityText(item.configurationStatus)} · availability ${safeCapabilityText(item.availabilityStatus)} · runtime ${safeCapabilityText(item.runtimeLoadedStatus)} · operation ${safeCapabilityText(item.operationalStatus)}`);
  }
  if (capabilities.length > 16) lines.push(`… ${capabilities.length - 16} additional discovered capabilities omitted.`);
  for (const diagnostic of (Array.isArray(catalog?.diagnostics) ? catalog.diagnostics : []).slice(0, 4)) {
    lines.push(`Discovery note · ${safeCapabilityText(diagnostic.type)} · ${safeCapabilityText(diagnostic.message).slice(0, 240)}`);
  }
  return lines.join("\n");
}

function safeCapabilityText(value) {
  if (typeof value !== "string") return "unknown";
  return redactSensitiveText(value).replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu, " ").slice(0, 160) || "unknown";
}

async function runInspectionCommand(context, mode) {
  const targetPanel = openPanel(context);
  ensureInitialProjectSelection();
  postToPanel(targetPanel, projectMessage());
  const project = selectedProjectContext();
  if (!project.available) {
    postToPanel(targetPanel, { type: "status", text: "Open or choose an available workspace folder before investigating it." });
    return;
  }
  if (typeof vscode.window.showInputBox !== "function") {
    postToPanel(targetPanel, { type: "status", text: "Repository investigation input is unavailable in this VS Code version." });
    return;
  }
  const selection = vscode.window.activeTextEditor?.document?.getText?.(vscode.window.activeTextEditor.selection)?.trim() || "";
  const isImpact = mode === "impact";
  let value;
  try {
    value = await vscode.window.showInputBox({
      prompt: isImpact ? "Describe the proposed change or symbol to assess" : "Ask a read-only question about this repository",
      placeHolder: isImpact ? "Rename parseConfig and identify likely callers, tests, and dependencies" : "Explain this repository, locate an entry point, or trace a function",
      value: selection ? (isImpact ? `Assess the change impact of ${selection}` : `Trace ${selection}`) : "",
      ignoreFocusOut: true,
    });
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Could not open repository investigation input: ${safeMessage(error)}` });
    return;
  }
  if (typeof value !== "string" || !value.trim()) return;
  if (panel !== targetPanel) return;
  const latestProject = selectedProjectContext();
  if (!latestProject.available || latestProject.path !== project.path) {
    postToPanel(targetPanel, { type: "status", text: "The selected workspace changed. Repository investigation was not started." });
    return;
  }
  const task = isImpact && !/\bimpact\b/iu.test(value) ? `Assess the change impact of ${value.trim()}` : value.trim();
  await runRepositoryInspection(task, isImpact ? "impact" : "inspect", targetPanel);
}

async function runRepositoryInspection(task, mode = "inspect", targetPanel = panel) {
  if (typeof task !== "string" || !task.trim() || task.length > MAX_PROMPT_LENGTH) {
    postToPanel(targetPanel, { type: "repository-inspection-error", text: `Enter a repository question between 1 and ${MAX_PROMPT_LENGTH.toLocaleString()} characters.` });
    return;
  }
  if (hasActiveOperation()) {
    postToPanel(targetPanel, { type: "status", text: "Wait for the active Vesper operation to finish before starting another." });
    return;
  }
  const project = selectedProjectContext();
  if (!project.available) {
    postToPanel(targetPanel, { type: "repository-inspection-error", text: "Choose an available workspace folder before starting a repository investigation." });
    return;
  }

  const query = mode === "impact" && !/\bimpact\b/iu.test(task) ? `Assess the change impact of ${task.trim()}` : task.trim();
  const requestId = ++requestSequence;
  const generation = projectGeneration;
  const controller = new AbortController();
  const inspection = { requestId, controller, systemModel: null, projectPath: project.path, generation };
  activeRepositoryInspection = inspection;
  postToPanel(targetPanel, { type: "repository-inspection-start", requestId, mode: mode === "impact" ? "impact" : "inspect" });
  writeLog(`request=${requestId} repository_inspection=started mode=${mode === "impact" ? "impact" : "inspect"}`);

  let runtime;
  let planner;
  let ownsPlanner = false;
  try {
    const session = selectedSession?.cwd === project.path ? selectedSession : null;
    const providerId = session?.providerId || resolveDefaultProviderId(process.env);
    const sessionId = randomUUID();
    const runtimeOptions = {
      projectRoot: project.path,
      sessionId,
      commandExecutionEnabled: false,
      commandWorkspaceWriteEnabled: false,
    };
    runtime = await repositoryToolRuntimeFactory(runtimeOptions);
    if (!runtime || runtime.sessionId !== sessionId) throw new Error("Vesper could not bind the read-only inspection runtime to its session.");

    const modelPlanningRequested = isModelAssistedEnabled(process.env) && isComplexInvestigation(query) &&
      [OPENAI_PROVIDER_ID, NVIDIA_PROVIDER_ID].includes(providerId);
    if (modelPlanningRequested) {
      try {
        planner = createExecutionProvider({
          providerId,
          environment: process.env,
          ...(session?.modelId ? { modelId: session.modelId } : {}),
        });
        ownsPlanner = true;
        if (typeof planner?.planInvestigation !== "function") {
          try { await planner?.dispose?.(); } catch { /* Provider discovery must not hide the local investigation. */ }
          planner = null;
          ownsPlanner = false;
        }
      } catch {
        planner = null;
      }
    }

    const repositoryIntelligence = createRepositoryIntelligence({
      toolRuntime: runtime,
      projectRoot: project.path,
      sessionId,
      providerId,
      getConversationId: () => session?.providerConversationId || null,
    });
    const systemModel = createSystemModel({
      repositoryIntelligence,
      planner,
      plannerUnavailableReason: modelPlanningRequested && !planner ? "selected-provider-setup-unavailable" : null,
      environment: process.env,
    });
    inspection.systemModel = systemModel;
    const result = await systemModel.investigate({ task: query, signal: controller.signal });
    if (!isCurrentInspection(inspection)) {
      if (activeRepositoryInspection === inspection) {
        postToPanel(targetPanel, {
          type: "repository-inspection-error",
          requestId,
          state: controller.signal.aborted ? "cancelled" : "stale",
          text: controller.signal.aborted
            ? "Repository investigation cancelled. No project files were changed and no provider coding task was submitted."
            : "The selected project changed during investigation. Vesper discarded the stale report; no provider coding task was submitted.",
        });
      }
      return;
    }
    const renderedReport = renderSystemModelReport(result);
    const report = renderedReport.length > 32 * 1024
      ? renderedReport.slice(0, 32 * 1024 - 32) + "\n[report display truncated by Vesper]\n"
      : renderedReport;
    postToPanel(targetPanel, {
      type: "repository-inspection-result",
      requestId,
      mode: mode === "impact" ? "impact" : "inspect",
      status: result.status || "unknown",
      report,
    });
    writeLog(`request=${requestId} repository_inspection=${result.status || "unknown"} findings=${result.findings?.length || 0}`);
  } catch (error) {
    if (activeRepositoryInspection !== inspection) return;
    const cancelled = controller.signal.aborted || error?.name === "AbortError";
    postToPanel(targetPanel, {
      type: "repository-inspection-error",
      requestId,
      state: cancelled ? "cancelled" : "failed",
      text: cancelled ? "Repository investigation cancelled. No project files were changed and no provider coding task was submitted." : `Repository investigation failed: ${safeMessage(error)}`,
    });
    writeLog(`request=${requestId} repository_inspection=${cancelled ? "cancelled" : "failed"} code=${safeErrorCode(error)}`);
  } finally {
    try { await runtime?.dispose?.(); } catch { /* Inspection cleanup does not alter its report. */ }
    if (ownsPlanner) {
      try { await planner?.dispose?.(); } catch { /* Planner cleanup does not alter local findings. */ }
    }
    if (activeRepositoryInspection === inspection) activeRepositoryInspection = undefined;
  }
}

function isCurrentInspection(inspection) {
  const project = selectedProjectContext();
  return activeRepositoryInspection === inspection && projectGeneration === inspection.generation &&
    project.available && project.path === inspection.projectPath;
}

function cancelActiveRepositoryInspection() {
  const inspection = activeRepositoryInspection;
  if (!inspection) return false;
  inspection.controller.abort("repository-inspection-cancelled");
  try { Promise.resolve(inspection.systemModel?.interrupt?.()).catch(() => undefined); } catch { /* Cancellation remains best-effort. */ }
  return true;
}

function runSessionCommand(context) {
  const targetPanel = openPanel(context);
  ensureInitialProjectSelection();
  postToPanel(targetPanel, projectMessage());
  return switchSavedSession(targetPanel);
}

function runProviderSessionCommand(context) {
  const targetPanel = openPanel(context);
  ensureInitialProjectSelection();
  postToPanel(targetPanel, projectMessage());
  return createSessionWithProvider(targetPanel);
}

async function switchSavedSession(targetPanel = panel) {
  if (hasActiveOperation()) {
    postToPanel(targetPanel, { type: "status", text: "Wait for the active Vesper operation to finish before switching sessions." });
    return;
  }
  const project = selectedProjectContext();
  if (!project.available) {
    postToPanel(targetPanel, { type: "status", text: "Choose an available workspace folder before switching sessions." });
    return;
  }
  if (typeof vscode.window.showQuickPick !== "function") {
    postToPanel(targetPanel, { type: "status", text: "Saved session selection is unavailable in this VS Code version." });
    return;
  }
  let sessions;
  try {
    sessions = sessionStore.listByCwd(project.path);
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Could not list saved sessions: ${safeMessage(error)}` });
    return;
  }
  if (!sessions.length) {
    postToPanel(targetPanel, { type: "status", text: "This project has no saved Vesper sessions yet." });
    return;
  }
  const items = sessions.map((session) => ({
    label: `${session.sessionId === selectedSession?.sessionId ? "● Current · " : ""}${providerDisplayName(session.providerId)}${session.modelId ? ` · ${session.modelId}` : ""}`,
    description: `${session.status === "recovery-required" ? "recovery required" : session.providerConversationId ? "saved conversation" : "new conversation"} · updated ${formatTimestamp(session.updatedAt) || "time unavailable"}`,
    detail: session.sessionId,
    sessionId: session.sessionId,
  }));
  let picked;
  try {
    picked = await vscode.window.showQuickPick(items, { placeHolder: "Choose a saved Vesper session for this project", matchOnDetail: true });
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Session selection failed: ${safeMessage(error)}` });
    return;
  }
  if (!picked) return;
  try {
    const currentProject = selectedProjectContext();
    if (panel !== targetPanel || !currentProject.available || currentProject.path !== project.path || hasActiveOperation()) {
      postToPanel(targetPanel, { type: "status", text: "The project or active task changed while the session picker was open. No session was switched." });
      return;
    }
    const session = sessionStore.load(picked.sessionId);
    if (session.cwd !== project.path) throw new Error("The selected session belongs to a different project.");
    invalidateHistoryLoad();
    disposeCurrentAppServer();
    selectedSession = session;
    sessionLookupError = undefined;
    sessionView = session.providerConversationId
      ? { state: "saved", text: `Saved ${providerDisplayName(session.providerId)} conversation selected. Vesper will verify it before continuing.`, blocked: false }
      : { state: "new", text: `Saved Vesper session selected for ${providerDisplayName(session.providerId)}.`, blocked: false };
    postSessionView(targetPanel);
    await restoreSelectedHistory(targetPanel);
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Could not switch sessions: ${safeMessage(error)}` });
    postSessionView(targetPanel);
  }
}

async function createSessionWithProvider(targetPanel = panel) {
  if (hasActiveOperation()) {
    postToPanel(targetPanel, { type: "status", text: "Wait for the active Vesper operation to finish before creating a provider session." });
    return;
  }
  const project = selectedProjectContext();
  if (!project.available) {
    postToPanel(targetPanel, { type: "status", text: "Choose an available workspace folder before creating a provider session." });
    return;
  }
  if (typeof vscode.window.showQuickPick !== "function") {
    postToPanel(targetPanel, { type: "status", text: "Provider selection is unavailable in this VS Code version." });
    return;
  }
  const defaultProviderId = resolveDefaultProviderId(process.env);
  const items = listProviders().map((provider) => {
    const status = getProviderStatus(provider.id, process.env);
    const readiness = provider.id === DEFAULT_PROVIDER_ID
      ? "Codex CLI authentication is managed by Codex"
      : status.configured ? `configured · ${status.model || "model unknown"} · not live-verified` : "configuration required";
    return {
      label: provider.name,
      description: `${provider.id}${provider.id === defaultProviderId ? " · default for new sessions" : ""}`,
      detail: `${readiness}. ${provider.description}`,
      providerId: provider.id,
      status,
    };
  });
  let picked;
  try {
    picked = await vscode.window.showQuickPick(items, { placeHolder: "Choose a provider for a new Vesper session", matchOnDescription: true, matchOnDetail: true });
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Provider selection failed: ${safeMessage(error)}` });
    return;
  }
  if (!picked) return;
  const status = picked.status || getProviderStatus(picked.providerId, process.env);
  if (picked.providerId !== DEFAULT_PROVIDER_ID && status.configured !== true) {
    const remediation = picked.providerId === OPENAI_PROVIDER_ID
      ? "Set OPENAI_API_KEY (or VESPER_OPENAI_API_KEY) and VESPER_OPENAI_MODEL."
      : "Set VESPER_NVIDIA_API_KEY (or NVIDIA_API_KEY) and VESPER_NVIDIA_MODEL.";
    const text = `${picked.label} needs configuration. ${remediation} Then reload the VS Code window and select it again.`;
    postToPanel(targetPanel, { type: "status", text });
    if (typeof vscode.window.showWarningMessage === "function") await vscode.window.showWarningMessage(text);
    return;
  }
  let modelId = status.model || null;
  if (picked.providerId !== DEFAULT_PROVIDER_ID) {
    if (typeof vscode.window.showInputBox !== "function") {
      postToPanel(targetPanel, { type: "status", text: "Model selection is unavailable in this VS Code version; use the configured provider model from the process environment." });
      return;
    }
    let requestedModel;
    try {
      requestedModel = await vscode.window.showInputBox({
        prompt: `Model ID for this ${picked.label} session (saved with this session; provider support is not verified here)`,
        value: status.model || "",
        placeHolder: "Enter the exact model ID configured with the provider",
        ignoreFocusOut: true,
      });
    } catch (error) {
      postToPanel(targetPanel, { type: "status", text: `Model selection failed: ${safeMessage(error)}` });
      return;
    }
    if (typeof requestedModel !== "string") return;
    modelId = requestedModel.trim();
    if (!modelId || modelId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(modelId)) {
      postToPanel(targetPanel, { type: "status", text: "Enter a model ID from 1 to 200 characters without control characters. The existing session was kept." });
      return;
    }
  }
  const currentProject = selectedProjectContext();
  if (panel !== targetPanel || !currentProject.available || currentProject.path !== project.path || hasActiveOperation()) {
    postToPanel(targetPanel, { type: "status", text: "The project or active task changed while provider selection was open. No session was created." });
    return;
  }
  startNewSession(targetPanel, { providerId: picked.providerId, modelId });
}

function capabilityProviderFor(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  if (!capabilityProviders.has(cwd)) capabilityProviders.set(cwd, createCapabilityProvider({
    cwd,
    runtimeStatusAdapter: createCodexRuntimeStatusAdapter({
      getRuntimeClient: () => selectedSession?.cwd === cwd && executionProviderSessionId === selectedSession.sessionId ? executionProvider : null,
    }),
  }));
  return capabilityProviders.get(cwd);
}

async function selectProject(targetPanel) {
  if (hasActiveOperation()) return;
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
  if (hasActiveOperation() || !sessionView.canRetry) return;
  const project = selectedProjectContext();
  if (!project.available || !selectedSession?.providerConversationId) return;

  const requestId = ++requestSequence;
  const session = selectedSession;
  const generation = projectGeneration;
  let client;
  try {
    client = executionProviderForSession(session, project.path, generation);
  } catch (error) {
    setSessionView(targetPanel, { state: "recovery-required", text: `Could not start the saved ${providerSessionName(session.providerId)} session: ${safeMessage(error)}. Fix configuration or start a new provider session.`, blocked: true, canStartNew: true });
    postHistoryState(targetPanel, unavailableHistory(safeMessage(error)));
    return;
  }
  const historyLoadId = ++historyLoadSequence;
  historyLoadingSessionId = session.sessionId;
  activeCodexRequestId = requestId;
  activeRequestType = "recovery";
  postToPanel(targetPanel, { type: "recovery-start" });
  setSessionView(targetPanel, { state: "restoring", text: "Verifying the saved Codex thread…", blocked: true });
  postHistoryState(targetPanel, { state: "loading", text: `Restoring saved ${providerSessionName(session.providerId)} conversation history…`, entries: [], truncated: false });
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
    if (deferredHistoryRestore && !hasActiveOperation()) {
      deferredHistoryRestore = false;
      if (panel && selectedSession?.sessionId === session.sessionId) void restoreSelectedHistory(panel);
    }
  }
}

function startNewSession(targetPanel, { providerId = null, modelId = undefined } = {}) {
  if (hasActiveOperation()) return;
  const project = selectedProjectContext();
  if (!project.available) {
    postToPanel(targetPanel, { type: "status", text: "The selected workspace folder is unavailable; no session was changed." });
    return;
  }
  try {
    const previousSessionId = selectedSession?.sessionId;
    invalidateHistoryLoad();
    disposeCurrentAppServer();
    const selectedProviderId = providerId || selectedProviderForNewSession();
    selectedSession = createProviderSession(project.path, selectedProviderId, modelId);
    sessionLookupError = undefined;
    sessionView = {
      state: "new",
      text: previousSessionId
        ? "A new Vesper session was created. The previous saved session was retained."
        : `New Vesper session created for ${providerDisplayName(selectedSession.providerId)}.`,
      blocked: false,
    };
    postSessionView(targetPanel);
    postHistoryState(targetPanel, {
      state: "empty",
      text: "This new Vesper session has no saved provider conversation history yet.",
      entries: [],
      truncated: false,
    });
  } catch (error) {
    postToPanel(targetPanel, { type: "status", text: `Could not create a new Vesper session: ${safeMessage(error)}` });
    postSessionView(targetPanel);
  }
}

async function interruptRequest(requestId, targetPanel) {
  if (activeVerification?.requestId === requestId) {
    cancelActiveVerification("user-interrupt");
    postToPanel(targetPanel, { type: "interrupt-requested", requestId, phase: "verification" });
    return;
  }
  if (activeRepositoryInspection?.requestId === requestId) {
    cancelActiveRepositoryInspection();
    postToPanel(targetPanel, { type: "interrupt-requested", requestId, phase: "inspection" });
    return;
  }
  if (requestId !== activeCodexRequestId) return;
  if (activeRepositoryPreflight?.requestId === requestId) {
    cancelActiveRepositoryPreflight();
    postToPanel(targetPanel, { type: "interrupt-requested", requestId, phase: "preflight" });
    return;
  }
  if (!executionProvider) return;
  try {
    const accepted = await executionProvider.interrupt();
    if (accepted && requestId === activeCodexRequestId) {
      postToPanel(targetPanel, { type: "interrupt-requested", requestId });
    }
  } catch (error) {
    if (requestId === activeCodexRequestId) {
      postToPanel(targetPanel, { type: "assistant-interrupt-error", requestId, text: safeMessage(error) });
    }
  }
}

async function refreshVerificationSuggestions(workflowRequestId, targetPanel = panel) {
  if (hasActiveOperation()) {
    postToPanel(targetPanel, { type: "verification-error", text: "Wait for the active Vesper operation to finish before refreshing verification suggestions." });
    return;
  }
  const scope = currentTaskScope(workflowRequestId);
  if (!scope) {
    postToPanel(targetPanel, { type: "verification-error", text: "The selected task no longer matches this project and session. Start a task in the current session before refreshing verification." });
    return;
  }
  const requestId = ++requestSequence;
  const controller = new AbortController();
  const operation = { requestId, kind: "verification-refresh", controller, systemModel: null,
    sessionId: scope.sessionId, projectPath: scope.projectPath, generation: scope.generation };
  activeVerification = operation;
  scope.lifecycle.setVerificationCandidates(scope.lifecycle.snapshot().verificationCandidates, { fresh: false });
  postCurrentTaskState(targetPanel);
  postToPanel(targetPanel, { type: "verification-refresh-start", requestId, text: "Refreshing bounded project verification evidence. No command will run." });

  let runtime;
  try {
    runtime = await repositoryToolRuntimeFactory({ projectRoot: scope.projectPath, sessionId: scope.sessionId,
      commandExecutionEnabled: false, commandWorkspaceWriteEnabled: false });
    if (!runtime || runtime.sessionId !== scope.sessionId) throw new Error("Verification inspection runtime did not match the selected session.");
    const client = executionProviderSessionId === scope.sessionId ? executionProvider : null;
    const repositoryIntelligence = createRepositoryIntelligence({
      toolRuntime: runtime,
      projectRoot: scope.projectPath,
      sessionId: scope.sessionId,
      providerId: scope.providerId,
      getConversationId: () => client?.getState?.().conversationId || selectedSession?.providerConversationId || null,
    });
    const systemModel = createSystemModel({ repositoryIntelligence, planner: client, environment: process.env });
    operation.systemModel = systemModel;
    const result = await systemModel.investigate({ task: "", intent: "overview", signal: controller.signal });
    if (!isCurrentVerification(operation)) return;
    const candidates = selectVerificationCandidates(result?.project?.commands || []);
    scope.lifecycle.setVerificationCandidates(candidates, { fresh: true, observedAt: new Date().toISOString() });
    scope.lifecycle.setVerificationSuggestions(result?.verificationRequirements || []);
    postCurrentTaskState(targetPanel);

    let commandAvailability = { state: "disabled", text: "Command execution is disabled. No suggested command was run." };
    let statusRuntime;
    try {
      if (process.env.VESPER_ENABLE_ISOLATED_COMMANDS === "1") {
        statusRuntime = await repositoryToolRuntimeFactory({ projectRoot: scope.projectPath, sessionId: scope.sessionId,
          approvalHandler: async () => "cancel", commandExecutionEnabled: true, commandWorkspaceWriteEnabled: false });
        const status = await statusRuntime.getCommandExecutionStatus();
        commandAvailability = status?.available && status?.enabled
          ? { state: "available", text: "Isolated command runtime is available; each command still requires one-time approval." }
          : { state: "unavailable", text: `Isolated command runtime unavailable${status?.reasonCode ? ` (${status.reasonCode})` : ""}. No command was run.` };
      } else {
        commandAvailability.text = "Host opt-in VESPER_ENABLE_ISOLATED_COMMANDS=1 is required before an isolated command can be reviewed.";
      }
    } catch (error) {
      commandAvailability = { state: "unavailable", text: `Isolated command status could not be checked (${safeErrorCode(error)}). No command was run.` };
    } finally {
      try { await statusRuntime?.dispose?.(); } catch { /* Status probe has no execution side effect. */ }
    }
    postToPanel(targetPanel, { type: "verification-refresh-result", requestId,
      state: candidates.length ? "available" : "empty",
      suggestions: scope.lifecycle.snapshot().verificationSuggestions,
      candidates,
      commandAvailability,
      text: candidates.length ? `${candidates.length} bounded project command suggestion(s) found. None have been executed.`
        : "No supported manifest command candidates were found in the refreshed project evidence. No command was executed." });
  } catch (error) {
    if (activeVerification !== operation) return;
    const cancelled = controller.signal.aborted || error?.name === "AbortError";
    postToPanel(targetPanel, { type: "verification-refresh-result", requestId, state: cancelled ? "cancelled" : "failed",
      text: cancelled ? "Verification evidence refresh was cancelled. No command was run." : `Verification suggestions could not be refreshed: ${safeMessage(error)}. No command was run.` });
  } finally {
    try { await runtime?.dispose?.(); } catch { /* Inspection cleanup does not alter verification evidence. */ }
    if (activeVerification === operation) {
      activeVerification = undefined;
      postCurrentTaskState(panel);
    }
  }
}

async function runVerification(workflowRequestId, index, targetPanel = panel) {
  if (hasActiveOperation()) {
    postToPanel(targetPanel, { type: "verification-error", text: "Wait for the active Vesper operation to finish before requesting a verification command." });
    return;
  }
  const scope = currentTaskScope(workflowRequestId);
  const state = scope?.lifecycle.snapshot();
  const candidate = Number.isSafeInteger(index) ? state?.verificationCandidates?.[index] : null;
  if (!scope || !state?.verificationCandidatesFresh || !candidate) {
    postToPanel(targetPanel, { type: "verification-error", text: "This command suggestion is stale or unavailable. Refresh verification evidence before requesting approval." });
    return;
  }
  const argv = parseVerificationArgv(candidate.command);
  if (!argv) {
    postToPanel(targetPanel, { type: "verification-error", text: "This suggested command uses shell syntax outside Vesper's supported argv format. It remains a suggestion and was not run." });
    return;
  }
  scope.lifecycle.setVerificationCandidates(state.verificationCandidates, { fresh: false });
  if (process.env.VESPER_ENABLE_ISOLATED_COMMANDS !== "1") {
    scope.lifecycle.recordVerification({ state: "unavailable", errorCode: "UNSUPPORTED_OPERATION" }, argv);
    postCurrentTaskState(targetPanel);
    postToPanel(targetPanel, { type: "verification-result", state: "unavailable", executed: false,
      text: "Command execution is disabled by the host. Set VESPER_ENABLE_ISOLATED_COMMANDS=1, reload Vesper, refresh evidence, then request approval. No command was run." });
    return;
  }
  const requestId = ++requestSequence;
  const controller = new AbortController();
  const operation = { requestId, kind: "verification-run", controller, runtime: null,
    sessionId: scope.sessionId, projectPath: scope.projectPath, generation: scope.generation };
  activeVerification = operation;
  scope.lifecycle.setStage("verification");
  postCurrentTaskState(targetPanel);
  postToPanel(targetPanel, { type: "verification-run-start", requestId,
    text: "Command selected. Vesper will show its exact argv for one-time approval before invoking the isolated runtime." });
  let runtime;
  try {
    runtime = await repositoryToolRuntimeFactory({
      projectRoot: scope.projectPath,
      sessionId: scope.sessionId,
      approvalHandler: (snapshot, approvalOptions) => requestPanelToolApproval(snapshot, approvalOptions, {
        sessionId: scope.sessionId,
        projectPath: scope.projectPath,
        generation: scope.generation,
        kind: "verification",
        requestId,
      }),
      commandExecutionEnabled: true,
      commandWorkspaceWriteEnabled: false,
    });
    operation.runtime = runtime;
    if (!runtime || runtime.sessionId !== scope.sessionId) throw new Error("Verification runtime did not match the selected session.");
    const availability = await runtime.getCommandExecutionStatus();
    if (controller.signal.aborted) throw createVerificationCancelledError();
    if (!availability?.available || !availability?.enabled) {
      const result = { state: "unavailable", executed: false,
        error: { code: availability?.reasonCode || "ISOLATION_UNAVAILABLE", message: availability?.message || "The isolated command runtime is unavailable." } };
      scope.lifecycle.recordVerification(result, argv);
      postCurrentTaskState(targetPanel);
      postToPanel(targetPanel, { type: "verification-result", requestId, state: "unavailable", executed: false,
        text: `The isolated runtime is unavailable${availability?.reasonCode ? ` (${availability.reasonCode})` : ""}. No command was run.` });
      return;
    }
    if (!isCurrentVerification(operation)) return;
    if (controller.signal.aborted) throw createVerificationCancelledError();
    const result = await runtime.invoke({
      toolId: "run_command",
      input: { argv, workspaceAccess: "read-only" },
      context: { projectRoot: scope.projectPath, sessionId: scope.sessionId },
      requestId: randomUUID(),
    }, { signal: controller.signal });
    if (!isCurrentVerification(operation)) return;
    scope.lifecycle.recordVerification(result, argv);
    scope.lifecycle.setStage("report");
    postCurrentTaskState(targetPanel);
    const executed = result?.executed === true;
    const commandResult = executed ? result.result || {} : null;
    const outputText = executed
      ? [commandResult.stdout ? `stdout:\n${commandResult.stdout}` : "", commandResult.stderr ? `stderr:\n${commandResult.stderr}` : ""]
        .filter(Boolean).join("\n\n").slice(0, 32 * 1024)
      : "";
    postToPanel(targetPanel, { type: "verification-result", requestId, state: result?.state || "unknown", executed,
      exitCode: Number.isInteger(commandResult?.exitCode) ? commandResult.exitCode : null,
      signal: typeof commandResult?.signal === "string" ? commandResult.signal : null,
      output: outputText,
      text: executed
        ? `Command execution completed with exit ${commandResult?.exitCode ?? "unknown"}${commandResult?.signal ? ` · signal ${commandResult.signal}` : ""}.`
        : result?.error?.message || "Command was not executed." });
  } catch (error) {
    if (activeVerification !== operation) return;
    const cancelled = controller.signal.aborted || error?.name === "AbortError";
    const result = { state: cancelled ? "interrupted" : "unavailable", executed: false,
      error: { code: cancelled ? "COMMAND_INTERRUPTED" : safeErrorCode(error) } };
    scope.lifecycle.recordVerification(result, argv);
    scope.lifecycle.setStage("report");
    postCurrentTaskState(targetPanel);
    postToPanel(targetPanel, { type: "verification-result", requestId, state: cancelled ? "cancelled" : "failed", executed: false,
      text: cancelled ? "Verification command was cancelled. Its execution outcome was not confirmed." : `Verification command failed before Vesper could confirm execution: ${safeMessage(error)}` });
  } finally {
    try { await runtime?.dispose?.(); } catch { /* Runtime cleanup does not change the recorded outcome. */ }
    if (activeVerification === operation) {
      activeVerification = undefined;
      postCurrentTaskState(panel);
    }
  }
}

function currentTaskScope(workflowRequestId) {
  const lifecycle = lastTaskLifecycle;
  if (!lifecycle) return null;
  const state = lifecycle.snapshot();
  const project = selectedProjectContext();
  if (!state.finished || !state.submitted || state.providerStatus !== "completed" || state.requestId !== workflowRequestId || !project.available || project.path !== state.projectRoot ||
      projectGeneration !== lastTaskGeneration || selectedSession?.sessionId !== state.sessionId || selectedSession?.providerId !== state.providerId) return null;
  return { lifecycle, state, sessionId: state.sessionId, providerId: state.providerId,
    projectPath: project.path, generation: projectGeneration };
}

function isCurrentVerification(operation) {
  const project = selectedProjectContext();
  return activeVerification === operation && project.available && project.path === operation.projectPath &&
    selectedSession?.sessionId === operation.sessionId && projectGeneration === operation.generation;
}

function cancelActiveVerification(reason = "cancelled") {
  const operation = activeVerification;
  if (!operation) return false;
  operation.controller?.abort(reason);
  try { operation.runtime?.interrupt?.(); } catch { /* Cancellation remains best-effort. */ }
  try { Promise.resolve(operation.systemModel?.interrupt?.()).catch(() => undefined); } catch { /* Cancellation remains best-effort. */ }
  return true;
}

function createVerificationCancelledError() {
  const error = new Error("Verification was cancelled before command execution.");
  error.name = "AbortError";
  error.code = "COMMAND_INTERRUPTED";
  return error;
}

function executionProviderForSession(session, cwd, generation) {
  if (executionProvider && executionProviderSessionId === session.sessionId) return executionProvider;
  disposeCurrentAppServer();
  const sessionId = session.sessionId;
  if (!listProviders().some((provider) => provider.id === session.providerId)) {
    throw new Error(`This Vesper session belongs to unsupported provider ${safeMessage(session.providerId)}. Vesper kept its provider mapping; select a supported provider in a new session.`);
  }
  const providerOptions = {
    providerId: session.providerId,
    environment: process.env,
    sessionId,
    ...(session.modelId ? { modelId: session.modelId } : {}),
    onConversationId: async (conversationId) => {
      const latest = sessionStore.load(sessionId);
      if (latest.cwd !== cwd || latest.providerId !== session.providerId) throw new Error("The Vesper session project or provider identity changed.");
      if (latest.providerConversationId && latest.providerConversationId !== conversationId) {
        throw new Error("This Vesper session is already bound to another provider conversation.");
      }
      const saved = sessionStore.update(sessionId, {
        providerConversationId: conversationId,
        status: "active",
        recovery: null,
      });
      if (selectedSession?.sessionId === sessionId && projectGeneration === generation) selectedSession = saved;
    },
  };
  if (isTextOnlyProvider(session.providerId)) {
    providerOptions.conversationDirectory = path.join(sessionStore.directory || defaultSessionDirectory(), "provider-conversations");
  } else {
    providerOptions.clientOptions = {
      initialThreadId: session.providerConversationId,
      sandbox: "read-only",
    };
  }
  const client = createExecutionProvider(providerOptions);
  if (client.getState?.().toolCallingEnabled === true && typeof client.setToolRuntime === "function") {
    permissionedToolRuntime = createPermissionedToolRuntime({
      projectRoot: cwd,
      sessionId,
      approvalHandler: (snapshot, approvalOptions) => requestPanelToolApproval(snapshot, approvalOptions, {
        sessionId,
        projectPath: cwd,
        generation,
        kind: "file-change",
      }),
      commandExecutionEnabled: false,
      commandWorkspaceWriteEnabled: false,
    });
    client.setToolRuntime(permissionedToolRuntime);
  }
  if (client.capabilities.approvalEvents) client.setApprovalHandler(async () => ({ choice: "decline" }));
  client.on("event", (event) => {
    if (executionProvider !== client || executionProviderSessionId !== sessionId || projectGeneration !== generation ||
        selectedSession?.sessionId !== sessionId) return;
    if (event.type === "conversation-state" && event.state === "resuming") {
      setSessionView(panel, {
        state: "restoring",
        text: historyLoadingSessionId === sessionId ? "Restoring the saved conversation and history…" : `Restoring the saved ${providerDisplayName(session.providerId)} conversation…`,
        blocked: historyLoadingSessionId === sessionId,
      });
    } else if (event.type === "conversation-state" && event.state === "resumed") {
      if (historyLoadingSessionId === sessionId) {
        setSessionView(panel, { state: "restoring", text: "Saved thread verified; loading conversation history…", blocked: true });
      } else {
        setSessionView(panel, { state: "connected", text: isTextOnlyProvider(session.providerId)
          ? `${providerSessionName(session.providerId)} · saved conversation restored.`
          : "Connected · saved conversation restored.", blocked: false });
      }
    } else if (event.type === "conversation-state" && event.state === "starting") {
      setSessionView(panel, { state: "connecting", text: `Starting a new ${providerDisplayName(session.providerId)} conversation…`, blocked: false });
    } else if (event.type === "conversation-state" && event.state === "created") {
      setSessionView(panel, { state: "connected", text: "Connected · new conversation started.", blocked: false });
    } else if (event.type === "connection-lost") {
      setSessionView(panel, {
        state: "disconnected",
        text: `${providerDisplayName(session.providerId)} disconnected. The saved session is kept; reconnect before sending another task.`,
        blocked: true,
        canRetry: Boolean(client.getState().conversationId),
        canStartNew: true,
      });
    } else if (event.type === "task-started" && event.conversationId === client.getState().conversationId && isSafeProtocolIdentity(event.taskId) &&
        activeCodexRequestId !== undefined) {
      postToPanel(panel, {
        type: "assistant-running",
        requestId: activeCodexRequestId,
        conversationId: event.conversationId,
        taskId: event.taskId,
        threadId: event.conversationId,
        turnId: event.taskId,
        status: "inProgress",
      });
    }
  });
  executionProvider = client;
  executionProviderSessionId = sessionId;
  return client;
}

function disposeCurrentAppServer() {
  cancelActiveRepositoryPreflight();
  cancelPendingToolApprovals("session-changed");
  const previous = executionProvider;
  const previousTools = permissionedToolRuntime;
  executionProvider = undefined;
  executionProviderSessionId = undefined;
  permissionedToolRuntime = undefined;
  previous?.dispose();
  void previousTools?.dispose?.();
}

function cancelActiveRepositoryPreflight() {
  const preflight = activeRepositoryPreflight;
  if (!preflight) return false;
  preflight.controller.abort("repository-preflight-cancelled");
  try { Promise.resolve(preflight.systemModel?.interrupt?.()).catch(() => undefined); } catch { /* Cancellation is best-effort; no provider task is submitted until inspection resolves. */ }
  return true;
}

function summarizeRepositoryPreflight(result, evidenceIncluded) {
  const status = result?.status === "complete" ? "complete" : "partial";
  const lines = [
    `${status} · ${Number.isSafeInteger(result?.project?.fileCount) ? result.project.fileCount : 0} files discovered · ${Array.isArray(result?.findings) ? result.findings.length : 0} findings.`,
    evidenceIncluded ? "Bounded findings attached to this provider task only." : "No repository evidence attached to the provider task.",
  ];
  if (result?.modelPlanning) {
    const planning = result.modelPlanning;
    lines.push(`Planning: ${planning.mode} · ${planning.calls} model calls · stop reason ${result.stopReason || "unknown"}.`);
    if (planning.tokenUsage?.reportedByProvider) lines.push(`Planner usage: ${planning.tokenUsage.inputTokens ?? 0} input and ${planning.tokenUsage.outputTokens ?? 0} output tokens.`);
    for (const hypothesis of (planning.hypotheses || []).slice(0, 2)) {
      const refs = (hypothesis.evidenceRefs || []).map((item) => `${item.path || "project-wide"}${item.lineStart ? `:${item.lineStart}` : ""}`).join(", ");
      lines.push(`Unverified model hypothesis: ${hypothesis.text}${refs ? ` [${refs}]` : ""}`);
    }
    lines.push(`Evidence coverage: ${result.findings?.length || 0} findings · ${result.inspectedPaths?.length || 0} cited paths · ${planning.sourceBytesSent || 0} source bytes sent to planner.`);
  }
  const impact = result?.impactReport;
  if (impact) lines.push(`Impact: ${impact.definitions.length} definitions · ${impact.callSites.length} call candidates · ${impact.dependencies.length} dependencies · ${impact.tests.length} test references.`);
  for (const item of (result?.plan || []).slice(0, 2)) lines.push(`Grounded plan: ${item}`);
  for (const finding of (result?.findings || []).slice(0, 3)) {
    const location = finding.path ? `${finding.path}${finding.lineStart ? `:${finding.lineStart}` : ""}` : finding.source || "project";
    const provenance = `${finding.observation || "observed"}${finding.sourceContextRead ? ", source read" : ""}`;
    lines.push(`- ${provenance} · ${location} · ${finding.description || finding.type || "finding"}`);
  }
  const gap = result?.incomplete?.[0] || impact?.gaps?.[0];
  if (gap) lines.push(`Coverage: ${gap}`);
  for (const question of (result?.unresolved || []).slice(0, 2)) lines.push(`Unresolved assumption: ${question}`);
  for (const item of (result?.verificationRequirements || []).slice(0, 2)) lines.push(`Suggested verification, not run: ${item}`);
  return redactSensitiveText(lines.join("\n")).slice(0, MAX_PREFLIGHT_SUMMARY_LENGTH);
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : "INSPECTION_UNAVAILABLE";
}

function createPreflightCancelledError() {
  const error = new Error("Repository inspection was cancelled before provider submission.");
  error.code = "PREFLIGHT_CANCELLED";
  return error;
}

function isCurrentRequest(requestId, client, sessionId, generation) {
  const project = selectedProjectContext();
  return activeCodexRequestId === requestId && executionProvider === client && executionProviderSessionId === sessionId &&
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
  lastTaskLifecycle = undefined;
  lastTaskGeneration = undefined;
  activeHistoryPage = undefined;
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
        text: `No saved conversation for this folder. A ${providerDisplayName(selectedProviderForNewSession())} session will be created when you send a task.`,
        blocked: false,
      };
    } else if (selectedSession.providerConversationId) {
      sessionView = executionProvider?.getState().conversationReady && executionProviderSessionId === selectedSession.sessionId
        ? { state: "connected", text: "Connected · this Vesper session is saved.", blocked: false }
        : {
          state: "saved",
          text: `Saved ${providerDisplayName(selectedSession.providerId)} conversation found. Vesper will resume that provider conversation before continuing.`,
          blocked: false,
        };
    } else {
      sessionView = {
        state: "new",
        text: `Saved Vesper session found without a provider conversation. Sending a task will start its first ${providerDisplayName(selectedSession.providerId)} conversation.`,
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
  activeHistoryPage = undefined;

  if (!project.available) {
    postHistoryState(targetPanel, unavailableHistory("Conversation history cannot be checked because the selected workspace is unavailable."));
    return;
  }
  if (sessionLookupError) {
    postHistoryState(targetPanel, unavailableHistory("Saved session metadata could not be checked, so conversation history was not treated as empty."));
    return;
  }
  if (hasActiveOperation()) {
    deferredHistoryRestore = true;
    postHistoryState(targetPanel, {
      state: "loading",
      entries: [],
      truncated: false,
      text: "Saved history will be restored after the active Vesper operation finishes.",
    });
    return;
  }
  if (!session?.providerConversationId) {
    postHistoryState(targetPanel, {
      state: "empty",
      entries: [],
      truncated: false,
      text: session
        ? `This saved Vesper session has no ${providerSessionName(session.providerId)} conversation or saved history yet.`
        : "No saved Vesper conversation exists for this project yet.",
    });
    return;
  }

  const generation = projectGeneration;
  let client;
  try {
    client = executionProviderForSession(session, project.path, generation);
  } catch (error) {
    postHistoryState(targetPanel, unavailableHistory(`Saved ${providerSessionName(session.providerId)} history could not be loaded: ${safeMessage(error)}. The session was kept.`));
    setSessionView(targetPanel, { state: "recovery-required", text: `Could not connect to the saved ${providerSessionName(session.providerId)} session: ${safeMessage(error)}. Start a new provider session or retry after fixing configuration.`, blocked: true, canStartNew: true });
    return;
  }
  historyLoadingSessionId = session.sessionId;
  postHistoryState(targetPanel, {
    state: "loading",
    entries: [],
    truncated: false,
    text: `Checking the saved ${providerSessionName(session.providerId)} conversation history…`,
  });
  setSessionView(targetPanel, {
    state: "restoring",
    text: `Verifying the saved ${providerDisplayName(session.providerId)} conversation and loading its history…`,
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
  const cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
  activeHistoryPage = {
    sessionId: session.sessionId,
    projectPath,
    conversationId: session.providerConversationId,
    generation,
    cursor,
    hasOlder: Boolean(result?.hasOlder && cursor),
    pages: 1,
    seenCursors: new Set(),
    state: result?.state || "unavailable",
    text: result?.text || "Conversation history status unavailable.",
  };
  const { nextCursor: _nextCursor, ...visibleResult } = result || {};
  postHistoryState(targetPanel, visibleResult);
  setSessionView(targetPanel, {
    state: "connected",
    text: result.state === "unavailable"
      ? "Connected to the saved conversation; its history is unavailable. New tasks are available."
      : `Connected · saved ${providerSessionName(session.providerId)} conversation restored.`,
    blocked: false,
  });
  return true;
}

async function loadOlderHistory(targetPanel = panel) {
  const page = activeHistoryPage;
  const project = selectedProjectContext();
  const session = selectedSession;
  if (hasActiveOperation()) {
    postToPanel(targetPanel, { type: "history-load-error", text: "Wait for the active Vesper operation to finish before loading older history." });
    return;
  }
  if (!page?.hasOlder || !page.cursor || page.sessionId !== session?.sessionId || page.projectPath !== project.path ||
      page.generation !== projectGeneration || !project.available || !session?.providerConversationId) {
    postToPanel(targetPanel, { type: "history-load-error", text: "Older history is unavailable for the selected session." });
    return;
  }
  if (page.pages >= MAX_HISTORY_PAGES) {
    page.hasOlder = false;
    postHistoryState(targetPanel, { pageMode: "status", state: page.state, hasOlder: false,
      text: `History display limit reached after ${page.pages} pages. The existing transcript was kept.` });
    return;
  }
  const cursor = page.cursor;
  if (page.seenCursors.has(cursor)) {
    page.hasOlder = false;
    postHistoryState(targetPanel, { pageMode: "status", state: page.state, hasOlder: false,
      text: "The provider repeated a history cursor. Vesper stopped paging and kept the transcript already shown." });
    return;
  }
  page.seenCursors.add(cursor);
  const historyLoadId = historyLoadSequence;
  postHistoryState(targetPanel, { pageMode: "loading-older", state: page.state, hasOlder: true, text: "Loading older conversation messages…" });
  try {
    const client = executionProviderForSession(session, project.path, page.generation);
    const result = await client.readConversationHistory({ cursor });
    const current = activeHistoryPage;
    if (current !== page || selectedSession?.sessionId !== page.sessionId || projectGeneration !== page.generation ||
        !selectedProjectContext().available || selectedProjectContext().path !== page.projectPath || historyLoadSequence !== historyLoadId) return;
    if (result?.state === "unavailable") {
      page.seenCursors.delete(cursor);
      postToPanel(targetPanel, { type: "history-load-error", text: result.text || "Older conversation history is unavailable. The existing transcript was kept; you can retry." });
      return;
    }
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    const entryText = entries.reduce((total, entry) => total + String(entry?.label || "").length + String(entry?.text || "").length, 0);
    if (entries.length > MAX_HISTORY_MESSAGES || entryText > MAX_HISTORY_TEXT_LENGTH) {
      page.hasOlder = false;
      postHistoryState(targetPanel, { pageMode: "status", state: page.state, hasOlder: false,
        text: "The provider returned an oversized history page. Vesper kept the transcript already shown." });
      return;
    }
    const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    const cursorRepeated = Boolean(nextCursor && page.seenCursors.has(nextCursor));
    page.cursor = cursorRepeated ? null : nextCursor;
    page.hasOlder = Boolean(result?.hasOlder && nextCursor && !cursorRepeated);
    page.pages += 1;
    page.state = result?.state || page.state;
    page.text = cursorRepeated
      ? "The provider repeated a history cursor. Vesper stopped paging and kept the transcript already shown."
      : result?.text || page.text;
    const { nextCursor: _nextCursor, ...visibleResult } = result || {};
    postHistoryState(targetPanel, { ...visibleResult, pageMode: "prepend", hasOlder: page.hasOlder,
      text: page.text || "Older conversation messages loaded." });
  } catch (error) {
    if (activeHistoryPage !== page || selectedSession?.sessionId !== page.sessionId || projectGeneration !== page.generation) return;
    page.seenCursors.delete(cursor);
    postToPanel(targetPanel, { type: "history-load-error", text: `Older conversation messages could not be loaded: ${safeMessage(error)}. The existing transcript was kept; you can retry.` });
  }
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
    ? `The saved ${providerSessionName(session.providerId)} conversation is connected, but its history could not be retrieved: ${historyError}. Vesper has not treated it as empty.`
    : `Conversation history could not be retrieved because the saved ${providerSessionName(session.providerId)} conversation is not connected: ${historyError}. Vesper has not treated it as empty.`));
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
      canRetry: Boolean(session.providerConversationId && client.capabilities.recovery),
      canStartNew: true,
    });
  }
}

function isCurrentHistoryLoad({ client, session, projectPath, generation, historyLoadId, requestId } = {}) {
  const project = selectedProjectContext();
  return historyLoadSequence === historyLoadId &&
    (requestId === undefined || activeCodexRequestId === requestId) &&
    executionProvider === client && executionProviderSessionId === session?.sessionId &&
    selectedSession?.sessionId === session?.sessionId && projectGeneration === generation &&
    project.available && project.path === projectPath;
}

function postHistoryState(targetPanel, state) {
  postToPanel(targetPanel, { type: "conversation-history", ...state });
}

function hasActiveOperation() {
  return activeCodexRequestId !== undefined || Boolean(activeRepositoryInspection) || Boolean(activeVerification);
}

function postCurrentTaskState(targetPanel = panel) {
  const lifecycle = lastTaskLifecycle;
  if (!lifecycle) return;
  const state = lifecycle.snapshot();
  const project = selectedProjectContext();
  if (!project.available || projectGeneration !== lastTaskGeneration || selectedSession?.sessionId !== state.sessionId ||
      project.path !== state.projectRoot) return;
  postToPanel(targetPanel, { type: "task-state", workflow: { ...state,
    stageLabel: taskStageLabel(state.stage), statusLabel: taskStatusLabel(state.status),
    verificationOperationActive: Boolean(activeVerification) } });
}

function postCodexApprovalRequest(targetPanel, request, session, requestId) {
  const approval = request && typeof request === "object" ? request : {};
  const body = typeof approval.reviewBody === "string" ? approval.reviewBody.slice(0, MAX_PANEL_APPROVAL_REVIEW_LENGTH) : "Codex did not provide a bounded approval preview.";
  postToPanel(targetPanel, {
    type: "codex-approval",
    requestId,
    providerId: session.providerId,
    operation: typeof approval.type === "string" ? approval.type : "unknown",
    title: typeof approval.reviewTitle === "string" ? approval.reviewTitle.slice(0, 120) : "Approval request",
    body,
    truncated: approval.reviewTruncated === true || body.length >= MAX_PANEL_APPROVAL_REVIEW_LENGTH,
    text: "Vesper's VS Code panel keeps Codex approvals decline-only. No approval was granted. Continue in the Vesper terminal to use its existing Codex approval flow.",
  });
}

function postCodexApprovalDecision(targetPanel, event) {
  const status = typeof event?.status === "string" ? event.status : "unknown";
  const explanation = status === "declined" || status === "rejected"
    ? "The Codex approval request was declined by the VS Code panel."
    : status === "approved" || status === "accepted"
      ? "Codex reported an approval decision. Vesper did not create or modify that decision."
      : `Codex reported approval state: ${status}.`;
  postToPanel(targetPanel, { type: "codex-approval-decision", text: explanation });
}

function requestPanelToolApproval(snapshot, { signal } = {}, scope = {}) {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.approvalId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(snapshot.approvalId) ||
      !["apply_file_change", "run_command"].includes(snapshot.toolId)) return Promise.resolve("decline");
  if (scope.kind === "file-change" && (snapshot.toolId !== "apply_file_change" || activeCodexRequestId === undefined ||
      lastTaskLifecycle?.snapshot().sessionId !== scope.sessionId)) return Promise.resolve("cancel");
  if (scope.kind === "verification" && (snapshot.toolId !== "run_command" || activeVerification?.requestId !== scope.requestId)) return Promise.resolve("cancel");
  if (!isApprovalScopeCurrent(scope, snapshot)) return Promise.resolve("cancel");
  if (!panel?.webview || pendingToolApprovals.size >= 8) return Promise.resolve("cancel");
  if (typeof signal?.aborted === "boolean" && signal.aborted) return Promise.resolve("cancel");

  const operation = scope.kind === "verification" ? "command" : "file-change";
  const request = { type: operation, approvalId: snapshot.approvalId, requestId: snapshot.requestId };
  const lifecycle = lastTaskLifecycle;
  if (lifecycle && lifecycle.snapshot().sessionId === scope.sessionId && lastTaskGeneration === scope.generation) {
    lifecycle.observe({ type: "approval-required", request });
    postCurrentTaskState(panel);
  }
  return new Promise((resolve) => {
    const entry = {
      snapshot,
      panel,
      scope,
      operation,
      resolve,
      signal,
      timer: setTimeout(() => settleToolApproval(entry, "cancel", "Approval timed out; nothing was executed."), TOOL_APPROVAL_TIMEOUT_MS),
      onAbort: null,
      settled: false,
    };
    entry.onAbort = () => settleToolApproval(entry, "cancel", "Approval was cancelled; nothing was executed.");
    signal?.addEventListener?.("abort", entry.onAbort, { once: true });
    pendingToolApprovals.set(snapshot.approvalId, entry);
    postToolApproval(entry);
  });
}

function isApprovalScopeCurrent(entryOrScope, snapshot) {
  const scope = entryOrScope?.scope || entryOrScope || {};
  const project = selectedProjectContext();
  if (!project.available || project.path !== scope.projectPath || projectGeneration !== scope.generation ||
      selectedSession?.sessionId !== scope.sessionId || selectedSession?.cwd !== scope.projectPath ||
      snapshot.sessionId !== scope.sessionId || snapshot.projectRoot !== scope.projectPath) return false;
  if (scope.kind === "file-change") {
    return activeCodexRequestId !== undefined && lastTaskGeneration === scope.generation &&
      lastTaskLifecycle?.snapshot().sessionId === scope.sessionId;
  }
  if (scope.kind === "verification") return activeVerification?.requestId === scope.requestId;
  return false;
}

function postToolApproval(entry) {
  if (!entry || entry.settled || !isApprovalScopeCurrent(entry, entry.snapshot)) return;
  const body = renderToolApproval(entry.snapshot).slice(0, MAX_PANEL_APPROVAL_REVIEW_LENGTH);
  postToPanel(entry.panel, {
    type: "tool-approval",
    approvalId: entry.snapshot.approvalId,
    requestId: entry.scope.requestId || null,
    operation: entry.operation,
    title: entry.scope.kind === "verification" ? "Run this verification command?" : "Apply this proposed file change?",
    body,
    kind: entry.scope.kind,
    oneTime: true,
  });
}

function decideToolApproval(targetPanel, message) {
  const approvalId = typeof message.approvalId === "string" ? message.approvalId : "";
  const entry = pendingToolApprovals.get(approvalId);
  const choice = message.choice === "approve-once" ? "approve-once" : message.choice === "decline" ? "decline" : null;
  if (!entry || entry.panel !== targetPanel || !choice) return;
  if (!isApprovalScopeCurrent(entry, entry.snapshot)) {
    settleToolApproval(entry, "cancel", "The session, project, or task changed before the decision. Nothing was executed.");
    return;
  }
  settleToolApproval(entry, choice, choice === "approve-once" ? "Approved once; Vesper is rechecking the reviewed operation." : "Rejected; nothing was executed.");
}

function settleToolApproval(entry, choice, message) {
  if (!entry || entry.settled) return false;
  entry.settled = true;
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener?.("abort", entry.onAbort);
  pendingToolApprovals.delete(entry.snapshot.approvalId);
  const status = choice === "approve-once" ? "authorized" : choice === "decline" ? "rejected" : "cancelled";
  const lifecycle = lastTaskLifecycle;
  if (lifecycle && lifecycle.snapshot().sessionId === entry.scope.sessionId && lastTaskGeneration === entry.scope.generation) {
    lifecycle.observe({ type: "approval-decided", operation: entry.operation, status,
      approvalId: entry.snapshot.approvalId, requestId: entry.snapshot.requestId });
    postCurrentTaskState(entry.panel);
  }
  postToPanel(entry.panel, { type: "tool-approval-settled", approvalId: entry.snapshot.approvalId,
    status, text: message || "Approval request ended." });
  entry.resolve(choice);
  return true;
}

function cancelPendingToolApprovals(reason = "cancelled") {
  for (const entry of pendingToolApprovals.values()) {
    settleToolApproval(entry, "cancel", reason === "session-changed"
      ? "The selected Vesper session changed. The operation was cancelled without execution."
      : "The approval request was cancelled without execution.");
  }
}

function cancelPanelToolApprovals(targetPanel) {
  for (const entry of pendingToolApprovals.values()) {
    if (entry.panel === targetPanel) settleToolApproval(entry, "cancel", "The VS Code panel closed. The operation was cancelled without execution.");
  }
}

function invalidateHistoryLoad() {
  historyLoadSequence += 1;
  historyLoadingSessionId = undefined;
  deferredHistoryRestore = false;
}

function postSessionView(targetPanel) {
  postToPanel(targetPanel, { type: "session-state", ...sessionView });
  const project = selectedProjectContext();
  let projectSessions = [];
  let totalProjectSessions = 0;
  if (project.available && sessionStore) {
    try {
      const sessions = sessionStore.listByCwd(project.path);
      totalProjectSessions = sessions.length;
      projectSessions = sessions.slice(0, 8).map((session) => ({
        sessionId: session.sessionId,
        providerId: session.providerId,
        modelId: session.modelId || null,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        current: session.sessionId === selectedSession?.sessionId,
      }));
    } catch {
      projectSessions = [];
    }
  }
  postToPanel(targetPanel, {
    type: "session-details",
    sessionId: selectedSession?.sessionId || null,
    providerId: selectedSession?.providerId || null,
    modelId: selectedSession?.modelId || null,
    status: selectedSession?.status || sessionView.state,
    createdAt: selectedSession?.createdAt || null,
    updatedAt: selectedSession?.updatedAt || null,
    sessions: projectSessions,
    totalSessions: totalProjectSessions,
  });
  const providerId = selectedSession?.providerId ||
    (typeof process.env.VESPER_PROVIDER === "string" && process.env.VESPER_PROVIDER.trim()) || DEFAULT_PROVIDER_ID;
  const providerStatus = listProviders().some((provider) => provider.id === providerId) ? getProviderStatus(providerId, process.env) : null;
  const configuredModel = providerStatus?.model || null;
  const activeState = executionProviderSessionId === selectedSession?.sessionId ? executionProvider?.getState?.() : null;
  const supported = listProviders().some((provider) => provider.id === providerId);
  const configured = providerId === DEFAULT_PROVIDER_ID ? null : providerStatus?.configured === true;
  const authentication = providerId === DEFAULT_PROVIDER_ID
    ? "managed by Codex CLI; not checked by this panel"
    : configured ? "not verified; an API key is configuration only" : "not available until provider configuration is valid";
  const liveAvailability = activeState?.availability || "not checked";
  const readiness = !supported ? "unavailable: unsupported provider id"
    : providerId === DEFAULT_PROVIDER_ID ? "Codex app-server integration supported; CLI authentication is separate"
      : configured ? "configured; reachability depends on a live provider request" : "configuration required";
  const liveResult = selectedSession?.sessionId ? providerLiveStatus.get(selectedSession.sessionId) : null;
  postToPanel(targetPanel, {
    type: "provider-info",
    providerId,
    displayName: providerDisplayName(providerId),
    model: selectedSession?.modelId || configuredModel,
    supported,
    configured,
    authentication,
    availability: liveAvailability,
    liveResult: liveResult?.text || null,
    readiness,
    modelFreshness: selectedSession?.modelId ? "pinned to this Vesper session; provider support is not verified"
      : configuredModel ? "provider default configured; support is not verified" : "not configured or not exposed",
    toolCallingEnabled: activeState?.toolCallingEnabled === true,
    toolCallingConfigured: providerStatus?.toolCallingEnabled === true,
    toolCallingAvailability: isTextOnlyProvider(providerId)
      ? activeState
        ? activeState.toolCallingEnabled === true ? "available for the active session; model compatibility is unverified" : "disabled for the active session"
        : "not checked for this session"
      : "Codex tools are provider-managed; VS Code approval requests remain decline-only",
  });
}

function setProviderLiveStatus(sessionId, status) {
  if (typeof sessionId !== "string" || !sessionId || !status || typeof status.text !== "string") return;
  providerLiveStatus.delete(sessionId);
  providerLiveStatus.set(sessionId, status);
  while (providerLiveStatus.size > 100) providerLiveStatus.delete(providerLiveStatus.keys().next().value);
}

function formatTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : null;
}

function selectedProviderForNewSession() {
  const providerId = resolveDefaultProviderId(process.env);
  if (!listProviders().some((provider) => provider.id === providerId)) throw new Error(`Unsupported provider ${safeMessage(providerId)}. Run vesper providers to see supported providers.`);
  return providerId;
}

function providerDisplayName(providerId) {
  const provider = listProviders().find((entry) => entry.id === providerId);
  const name = provider?.name || safeMessage(providerId || "unknown provider");
  return isTextOnlyProvider(providerId) ? `${name} (remote model)` : name;
}

function providerSessionName(providerId) {
  if (providerId === OPENAI_PROVIDER_ID) return "OpenAI";
  if (providerId === NVIDIA_PROVIDER_ID) return "NVIDIA NIM";
  return providerId === DEFAULT_PROVIDER_ID ? "Codex" : providerDisplayName(providerId);
}

function isTextOnlyProvider(providerId) {
  return providerId === OPENAI_PROVIDER_ID || providerId === NVIDIA_PROVIDER_ID;
}

function createProviderSession(cwd, providerId, requestedModelId = undefined) {
  const modelId = requestedModelId === undefined ? getProviderStatus(providerId, process.env).model : requestedModelId;
  return sessionStore.create(cwd, { providerId, modelId });
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
    #provider-info { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
    #project-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    #project-details { min-width: 0; flex: 1; }
    #project-name { font-weight: 600; }
    #project-path { color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
    #session-state { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
    #session-details, #task-status, #verification-status { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
    #history-state { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
    #history-actions { margin-top: 4px; }
    #load-older-history[hidden] { display: none; }
    #task-status strong { color: var(--vscode-foreground); }
    #session-actions, #workspace-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    #session-actions { margin-top: 8px; }
    #workspace-actions { margin-top: 2px; }
    #recovery-actions { display: flex; gap: 8px; margin-top: 8px; }
    #recovery-actions[hidden], #retry-resume[hidden], #start-new-session[hidden] { display: none; }
    #messages { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    article { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    article.user { background: var(--vscode-textBlockQuote-background); }
    article.tool, article.activity { border-style: dashed; }
    article.error { border-color: var(--vscode-errorForeground); }
    article.approval { border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); }
    .approval-preview { max-height: 320px; overflow: auto; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .approval-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .approval-actions button { min-height: 28px; }
    #verification-panel { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; max-height: 210px; overflow: auto; }
    #verification-panel h2 { font-size: 12px; margin: 0 0 4px; }
    #verification-suggestions { margin: 6px 0; padding-left: 20px; }
    #verification-suggestions li { margin: 4px 0; overflow-wrap: anywhere; }
    .verification-command { font-family: var(--vscode-editor-font-family); }
    .verification-command button { margin-left: 6px; min-height: 24px; padding: 0 8px; }
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
      <div id="provider-info">Execution provider: Codex app-server</div>
      <div id="project-row">
        <div id="project-details"><div id="project-name">Loading project…</div><div id="project-path"></div></div>
        <button id="choose-project" type="button">Choose project</button>
      </div>
      <div id="status">Starting…</div>
      <div id="session-state" role="status">Checking saved Vesper sessions…</div>
      <div id="session-details" aria-live="polite">Session details unavailable.</div>
      <div id="history-state" role="status">Conversation history has not been checked.</div>
      <div id="history-actions"><button id="load-older-history" type="button" hidden>Load older history</button></div>
      <div id="task-status" role="status">No task lifecycle is available for this session.</div>
      <div id="session-actions">
        <button id="switch-session" type="button">Switch session</button>
        <button id="new-provider-session" type="button">New provider session</button>
      </div>
      <div id="recovery-actions" hidden>
        <button id="retry-resume" type="button" hidden>Retry connection</button>
        <button id="start-new-session" type="button" hidden>Start new conversation</button>
      </div>
    </header>
    <section id="messages" aria-live="polite"></section>
    <section id="verification-panel" aria-label="Verification">
      <h2>Verification</h2>
      <div id="verification-status" role="status">Suggested commands are not run automatically.</div>
      <ul id="verification-suggestions"></ul>
      <button id="refresh-verification" type="button">Refresh verification evidence</button>
    </section>
    <div id="workspace-actions">
      <button id="inspect-repository" type="button">Inspect repository</button>
      <button id="assess-impact" type="button">Change impact</button>
      <button id="preview-plan" type="button">Capabilities</button>
    </div>
    <form id="form">
      <textarea id="prompt" aria-label="Prompt" placeholder="Ask a developer question…" maxlength="32768" required></textarea>
      <button id="send" type="submit">Send</button>
      <button id="stop" type="button" hidden>Stop</button>
    </form>
    <footer>
      <div>Local routing and project checks stay local.</div>
      <div id="provider-privacy">Codex uses a read-only sandbox; Vesper declines approval requests.</div>
    </footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const status = document.getElementById('status');
    const providerInfo = document.getElementById('provider-info');
    const providerPrivacy = document.getElementById('provider-privacy');
    const form = document.getElementById('form');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const previewPlan = document.getElementById('preview-plan');
    const inspectRepository = document.getElementById('inspect-repository') || { disabled: false, addEventListener() {} };
    const assessImpact = document.getElementById('assess-impact') || { disabled: false, addEventListener() {} };
    const stop = document.getElementById('stop');
    const chooseProject = document.getElementById('choose-project');
    const switchSession = document.getElementById('switch-session') || { disabled: false, addEventListener() {} };
    const newProviderSession = document.getElementById('new-provider-session') || { disabled: false, addEventListener() {} };
    const projectName = document.getElementById('project-name');
    const projectPath = document.getElementById('project-path');
    const sessionState = document.getElementById('session-state');
    const historyState = document.getElementById('history-state');
    const sessionDetails = document.getElementById('session-details');
    const loadOlderHistory = document.getElementById('load-older-history');
    const taskStatus = document.getElementById('task-status');
    const verificationStatus = document.getElementById('verification-status');
    const verificationSuggestions = document.getElementById('verification-suggestions');
    const refreshVerification = document.getElementById('refresh-verification');
    const recoveryActions = document.getElementById('recovery-actions');
    const retryResume = document.getElementById('retry-resume');
    const startNewSession = document.getElementById('start-new-session');
    let activeAssistant;
    let activeDiff;
    let activeRequestId;
    let activeActionType;
    let currentProviderId = 'codex-app-server';
    let currentProviderName = 'Codex app-server';
    let sessionBlocked = false;
    let recoveryLoading = false;
    let activeSessionId = '';
    let currentWorkflow;
    let verificationAvailability = { state: 'unknown', text: 'Refresh evidence to check the isolated command runtime.' };
    let verificationNotice = '';
    let historyEntryCount = 0;
    let historyTextLength = 0;

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

    function addHistoryEntry(entry, parent = messages) {
      const article = document.createElement('article');
      article.className = new Set(['user', 'assistant', 'tool', 'activity', 'error', 'availability', 'turn']).has(entry.kind) ? entry.kind : 'activity';
      article.dataset.historyEntry = String(entry.id || 'history-entry');
      const title = document.createElement('div');
      title.className = 'label';
      const timestamp = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
        ? ' · ' + new Date(entry.timestamp).toLocaleString() : '';
      title.textContent = String(entry.label || 'Conversation message') + timestamp;
      const body = document.createElement('div');
      body.className = 'answer';
      body.textContent = String(entry.text || '');
      article.append(title, body);
      parent.append(article);
      return article;
    }

    function renderTaskState(workflow) {
      if (!workflow || typeof workflow !== 'object') return;
      if (currentWorkflow && currentWorkflow.requestId !== workflow.requestId) verificationNotice = '';
      currentWorkflow = workflow;
      const stage = workflow.stageLabel || workflow.stage || 'Task state unavailable';
      const state = workflow.statusLabel || workflow.status || 'Status unavailable';
      const started = typeof workflow.startedAt === 'string' && Number.isFinite(Date.parse(workflow.startedAt))
        ? new Date(workflow.startedAt).toLocaleString() : 'time unavailable';
      const finished = typeof workflow.completedAt === 'string' && Number.isFinite(Date.parse(workflow.completedAt))
        ? ' · finished ' + new Date(workflow.completedAt).toLocaleString() : '';
      const pending = Array.isArray(workflow.approvals) ? workflow.approvals.filter((item) => item && item.status === 'pending') : [];
      const approvalText = pending.length ? ' · waiting for ' + pending.length + ' approval(s)' : '';
      const files = Array.isArray(workflow.proposedFiles) ? workflow.proposedFiles.slice(0, 8) : [];
      const fileText = files.length ? '\nFiles: ' + files.map((item) => item.path + ' (' + item.state + ')').join(', ') + (workflow.proposedFiles.length > files.length ? ', …' : '') : '';
      taskStatus.textContent = 'Task ' + state + ' · ' + stage + approvalText + ' · started ' + started + finished + fileText;

      const suggestions = Array.isArray(workflow.verificationSuggestions) ? workflow.verificationSuggestions : [];
      const candidates = Array.isArray(workflow.verificationCandidates) ? workflow.verificationCandidates : [];
      verificationSuggestions.replaceChildren();
      if (workflow.verification && workflow.verification.state && workflow.verification.state !== 'not-run') {
        const result = document.createElement('li');
        result.textContent = workflow.verification.executed === true
          ? 'Executed verification · ' + workflow.verification.state + (workflow.verification.command ? ' · ' + workflow.verification.command : '') + (Number.isInteger(workflow.verification.exitCode) ? ' · exit ' + workflow.verification.exitCode : '')
          : 'Verification request · ' + workflow.verification.state + ' · no execution confirmed' + (workflow.verification.command ? ' · ' + workflow.verification.command : '');
        verificationSuggestions.append(result);
      }
      for (const suggestion of suggestions.slice(0, 8)) {
        const item = document.createElement('li');
        item.textContent = 'Suggested by investigation · not run: ' + suggestion;
        verificationSuggestions.append(item);
      }
      candidates.slice(0, 8).forEach((candidate, index) => {
        const item = document.createElement('li');
        item.className = 'verification-command';
        const evidence = candidate.inferred ? 'inferred' : 'manifest observed';
        item.textContent = (workflow.verificationCandidatesFresh ? 'Fresh ' : 'Unrefreshed ') + evidence + ' candidate · not run · ' + candidate.name + ' · ' + candidate.path + ' · ' + candidate.command;
        if (workflow.verificationCandidatesFresh && verificationAvailability.state === 'available' && workflow.finished === true && workflow.verificationOperationActive !== true) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Request approval';
          button.dataset.verificationIndex = String(index);
          button.dataset.workflowRequestId = String(workflow.requestId || '');
          button.setAttribute('aria-label', 'Request one-time approval to run ' + candidate.command);
          button.addEventListener('click', () => {
            button.disabled = true;
            vscode.postMessage({ type: 'run-verification', requestId: String(workflow.requestId || ''), index });
          });
          item.append(button);
        }
        verificationSuggestions.append(item);
      });
      const freshness = workflow.verificationCandidatesFresh
        ? 'Fresh command candidates observed ' + (workflow.verificationCandidatesObservedAt ? new Date(workflow.verificationCandidatesObservedAt).toLocaleString() : 'just now') + '.'
        : 'Command candidates must be refreshed before they can be run.';
      verificationStatus.textContent = [freshness, verificationAvailability.text || '', verificationNotice].filter(Boolean).join(' ');
      refreshVerification.disabled = activeRequestId !== undefined || workflow.finished !== true || workflow.submitted !== true || workflow.providerStatus !== 'completed';
    }

    function setBusy(busy) {
      send.disabled = busy || sessionBlocked || recoveryLoading;
      previewPlan.disabled = busy;
      inspectRepository.disabled = busy;
      assessImpact.disabled = busy;
      prompt.disabled = busy || sessionBlocked || recoveryLoading;
      chooseProject.disabled = busy;
      switchSession.disabled = busy;
      newProviderSession.disabled = busy;
      loadOlderHistory.disabled = busy;
      refreshVerification.disabled = busy || !currentWorkflow || currentWorkflow.finished !== true || currentWorkflow.submitted !== true || currentWorkflow.providerStatus !== 'completed';
      for (const button of verificationSuggestions.querySelectorAll('button[data-verification-index]')) button.disabled = busy;
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

    inspectRepository.addEventListener('click', () => {
      const task = prompt.value.trim() || 'Explain this repository, identify likely entry points, and summarize its major modules.';
      vscode.postMessage({ type: 'repository-inspection', intent: 'inspect', task });
    });

    assessImpact.addEventListener('click', () => {
      const task = prompt.value.trim() || 'Assess the change impact of the current working-tree changes.';
      vscode.postMessage({ type: 'repository-inspection', intent: 'impact', task });
    });

    switchSession.addEventListener('click', () => vscode.postMessage({ type: 'switch-session' }));
    newProviderSession.addEventListener('click', () => vscode.postMessage({ type: 'new-session-with-provider' }));
    loadOlderHistory.addEventListener('click', () => {
      if (loadOlderHistory.disabled) return;
      loadOlderHistory.disabled = true;
      vscode.postMessage({ type: 'load-older-history' });
    });
    refreshVerification.addEventListener('click', () => {
      if (!currentWorkflow || currentWorkflow.finished !== true || currentWorkflow.submitted !== true || currentWorkflow.providerStatus !== 'completed' || refreshVerification.disabled) return;
      vscode.postMessage({ type: 'refresh-verification', requestId: String(currentWorkflow.requestId || '') });
    });

    messages.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('button[data-approval-choice]') : null;
      if (!button || button.disabled) return;
      const approvalId = button.dataset.approvalId;
      const choice = button.dataset.approvalChoice;
      if (!approvalId || !['approve-once', 'decline'].includes(choice)) return;
      for (const sibling of button.parentElement.querySelectorAll('button')) sibling.disabled = true;
      vscode.postMessage({ type: 'tool-approval-response', approvalId, choice });
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
      status.textContent = activeActionType === 'inspection'
        ? 'Interrupt requested · waiting for the repository investigation to stop…'
        : 'Interrupt requested · waiting for ' + currentProviderName + ' task state…';
      vscode.postMessage({ type: 'interrupt', requestId: activeRequestId });
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'status') status.textContent = message.text;
      if (message.type === 'provider-info') {
        currentProviderId = typeof message.providerId === 'string' ? message.providerId : 'codex-app-server';
        currentProviderName = typeof message.displayName === 'string' ? message.displayName : currentProviderId;
        const configuredText = message.configured === null ? 'configuration: Codex CLI-managed' : 'configured: ' + (message.configured ? 'yes' : 'no');
        providerInfo.textContent = currentProviderName + (message.model ? ' · model ' + message.model : ' · model not configured/exposed') +
          ' · supported by Vesper: ' + (message.supported ? 'yes' : 'no') + ' · ' + configuredText +
          ' · authentication: ' + (message.authentication || 'not checked') + ' · session availability: ' + (message.availability || 'not checked') +
          (message.liveResult ? ' · ' + message.liveResult : '') + (message.modelFreshness ? ' · ' + message.modelFreshness : '') +
          (message.toolCallingConfigured ? ' · structured tool opt-in configured for provider defaults' : '') +
          (message.toolCallingAvailability ? ' · structured tools: ' + message.toolCallingAvailability : '') +
          (message.toolCallingEnabled ? ' · Vesper file-change tools require one-time approval; commands are unavailable to provider tools' : '');
        providerPrivacy.textContent = currentProviderId === 'openai-chat-completions'
          ? (message.toolCallingEnabled ? 'OpenAI receives the task, saved conversation, bounded local repository summaries for code tasks, and bounded results from Vesper project inspection and proposal tools. File writes require a one-time review here; provider tools cannot run commands.' : 'For code-oriented tasks, OpenAI receives the task, saved conversation, and a bounded local repository summary; Vesper does not send full project files by default. Generated text is not executed, applied, or validated.')
          : currentProviderId === 'nvidia-nim'
            ? (message.toolCallingEnabled ? 'NVIDIA NIM receives the task, saved conversation, bounded local repository summaries for code tasks, and bounded results from Vesper project inspection and proposal tools. Model support is unverified. File writes require a one-time review here; provider tools cannot run commands.' : 'For code-oriented tasks, NVIDIA NIM receives the task, saved conversation, and a bounded local repository summary; Vesper does not send full project files by default. Generated text is not executed, applied, or validated.')
          : 'Codex uses a read-only sandbox; Vesper declines approval requests.';
      }
      if (message.type === 'project') {
        if ((projectPath.dataset.currentPath || '') !== (message.path || '')) {
          messages.replaceChildren();
          activeAssistant = undefined;
          activeDiff = undefined;
          activeRequestId = undefined;
          activeActionType = undefined;
          stop.hidden = true;
          historyState.textContent = 'Checking this project’s saved conversation history…';
          activeSessionId = '';
          currentWorkflow = undefined;
          taskStatus.textContent = 'No task lifecycle is available for this project.';
          verificationSuggestions.replaceChildren();
          verificationStatus.textContent = 'Suggested commands are not run automatically.';
          verificationNotice = '';
          verificationAvailability = { state: 'unknown', text: 'Refresh evidence to check the isolated command runtime.' };
        }
        projectPath.dataset.currentPath = message.path || '';
        projectName.textContent = message.available ? (message.name || 'Workspace folder') : (message.name ? message.name + ' · unavailable' : 'No workspace folder selected');
        projectPath.textContent = message.path || 'Open a folder in VS Code to start a provider task.';
        projectPath.title = message.path || '';
      }
      if (message.type === 'session-details') {
        const incomingSessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (activeSessionId && incomingSessionId !== activeSessionId) {
          messages.replaceChildren();
          historyEntryCount = 0;
          historyTextLength = 0;
          activeAssistant = undefined;
          activeDiff = undefined;
          currentWorkflow = undefined;
          taskStatus.textContent = 'No task lifecycle is available for this session.';
          verificationSuggestions.replaceChildren();
          verificationAvailability = { state: 'unknown', text: 'Refresh evidence to check the isolated command runtime.' };
          verificationNotice = '';
        }
        activeSessionId = incomingSessionId;
        const created = typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toLocaleString() : 'unknown';
        const updated = typeof message.updatedAt === 'string' && Number.isFinite(Date.parse(message.updatedAt)) ? new Date(message.updatedAt).toLocaleString() : 'unknown';
        const sessions = Array.isArray(message.sessions) ? message.sessions.slice(0, 8) : [];
        const summary = incomingSessionId
          ? 'Active session ' + incomingSessionId + ' · ' + (message.status || 'unknown') + ' · created ' + created + ' · updated ' + updated
          : 'No active session. A session will be created when a task is sent.';
        const recent = sessions.map((item) => (item.current ? '● ' : '○ ') + item.sessionId + ' · ' + item.providerId + (item.modelId ? ' / ' + item.modelId : '') + ' · ' + item.status + ' · updated ' + (Number.isFinite(Date.parse(item.updatedAt || '')) ? new Date(item.updatedAt).toLocaleString() : 'unknown')).join('\n');
        sessionDetails.textContent = summary + '\n' + (recent || 'No sessions saved for this project.') + (message.totalSessions > sessions.length ? '\nShowing the 8 most recent of ' + message.totalSessions + ' sessions. Use Switch session to choose.' : '');
      }
      if (message.type === 'conversation-history') {
        const mode = message.pageMode || 'replace';
        historyState.textContent = typeof message.text === 'string' ? message.text : 'Conversation history status unavailable.';
        if (mode === 'loading-older') {
          loadOlderHistory.disabled = true;
          return;
        }
        if (mode === 'status') {
          loadOlderHistory.hidden = !message.hasOlder;
          loadOlderHistory.disabled = false;
          return;
        }
        if (mode === 'prepend') {
          const entries = Array.isArray(message.entries) ? message.entries : [];
          const validEntries = entries.filter((entry) => entry && typeof entry === 'object' && typeof entry.label === 'string' && typeof entry.text === 'string');
          const addedText = validEntries.reduce((total, entry) => total + entry.label.length + entry.text.length, 0);
          if (historyEntryCount + validEntries.length > 240 || historyTextLength + addedText > 128000) {
            loadOlderHistory.hidden = true;
            loadOlderHistory.disabled = true;
            historyState.textContent = 'Vesper history display limit reached. Older messages remain in provider storage.';
            return;
          }
          const fragment = document.createDocumentFragment();
          for (const entry of validEntries) addHistoryEntry(entry, fragment);
          const firstEntry = messages.querySelector('[data-history-entry]');
          messages.insertBefore(fragment, firstEntry || messages.firstChild);
          historyEntryCount += validEntries.length;
          historyTextLength += addedText;
          loadOlderHistory.hidden = !message.hasOlder;
          loadOlderHistory.disabled = false;
          return;
        }
        activeDiff = undefined;
        loadOlderHistory.hidden = true;
        loadOlderHistory.disabled = false;
        if (message.state === 'loading') {
          if (activeRequestId === undefined) messages.replaceChildren();
          historyEntryCount = 0;
          historyTextLength = 0;
          return;
        }
        messages.replaceChildren();
        historyEntryCount = 0;
        historyTextLength = 0;
        activeAssistant = undefined;
        activeRequestId = undefined;
        stop.hidden = true;
        if (message.state === 'unavailable') return;
        if (Array.isArray(message.entries)) {
          for (const entry of message.entries) {
            if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string' || typeof entry.text !== 'string') continue;
            addHistoryEntry(entry);
            historyEntryCount += 1;
            historyTextLength += entry.label.length + entry.text.length;
          }
        }
        loadOlderHistory.hidden = !message.hasOlder;
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
      if (message.type === 'task-state') renderTaskState(message.workflow || {});
      if (message.type === 'tool-approval') {
        const card = document.createElement('article');
        card.className = 'approval';
        card.dataset.approvalId = String(message.approvalId || '');
        const title = document.createElement('div');
        title.className = 'label';
        title.textContent = (message.title || 'Vesper approval required') + ' · one operation only';
        const preview = document.createElement('div');
        preview.className = 'answer approval-preview';
        preview.textContent = message.body || 'No safe review preview is available.';
        const actions = document.createElement('div');
        actions.className = 'approval-actions';
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.textContent = message.kind === 'verification' ? 'Approve this command once' : 'Approve this file change once';
        approve.dataset.approvalId = String(message.approvalId || '');
        approve.dataset.approvalChoice = 'approve-once';
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.textContent = 'Reject';
        reject.dataset.approvalId = String(message.approvalId || '');
        reject.dataset.approvalChoice = 'decline';
        actions.append(approve, reject);
        card.append(title, preview, actions);
        messages.append(card);
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'tool-approval-settled') {
        for (const card of messages.querySelectorAll('article[data-approval-id]')) {
          if (card.dataset.approvalId !== message.approvalId) continue;
          for (const button of card.querySelectorAll('button')) button.disabled = true;
          const outcome = document.createElement('div');
          outcome.className = 'label';
          outcome.textContent = message.text || ('Approval ' + (message.status || 'ended') + '.');
          card.append(outcome);
        }
      }
      if (message.type === 'codex-approval') {
        const card = document.createElement('article');
        card.className = 'approval';
        const title = document.createElement('div');
        title.className = 'label';
        title.textContent = 'Codex requested ' + (message.title || 'approval') + ' · VS Code decline-only';
        const preview = document.createElement('div');
        preview.className = 'answer approval-preview';
        preview.textContent = message.body || 'Codex did not provide a review preview.';
        const note = document.createElement('div');
        note.className = 'label';
        note.textContent = message.text || 'Vesper did not approve this request.';
        card.append(title, preview, note);
        messages.append(card);
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'codex-approval-decision') addMessage('activity', 'Codex approval outcome', message.text || 'Codex reported an approval outcome.');
      if (message.type === 'verification-start') {
        activeRequestId = message.requestId;
        activeActionType = 'verification';
        setBusy(true);
        stop.hidden = false;
        stop.disabled = false;
        verificationStatus.textContent = message.operation === 'verification-run'
          ? 'Waiting for isolated command approval or execution…'
          : 'Refreshing project verification evidence…';
        verificationNotice = verificationStatus.textContent;
      }
      if (message.type === 'verification-refresh-start' || message.type === 'verification-run-start') {
        activeRequestId = message.requestId;
        activeActionType = 'verification';
        setBusy(true);
        stop.hidden = false;
        stop.disabled = false;
        verificationStatus.textContent = message.text || 'Verification operation started.';
        verificationNotice = verificationStatus.textContent;
      }
      if (message.type === 'verification-refresh-result' && message.requestId === activeRequestId) {
        verificationAvailability = message.commandAvailability || verificationAvailability;
        if (currentWorkflow) renderTaskState(currentWorkflow);
        verificationNotice = message.text || (message.state === 'failed' || message.state === 'cancelled'
          ? 'Verification evidence refresh did not complete.' : 'Verification evidence refreshed.');
        verificationStatus.textContent = verificationNotice + ' ' + (verificationAvailability.text || '');
        activeRequestId = undefined;
        activeActionType = undefined;
        stop.hidden = true;
        setBusy(false);
        if (currentWorkflow) renderTaskState(currentWorkflow);
      }
      if (message.type === 'verification-result' && message.requestId === activeRequestId) {
        if (message.executed === true && typeof message.output === 'string' && message.output) {
          addMessage(message.exitCode === 0 ? 'activity' : 'error', 'Verification output · executed · exit ' + (message.exitCode === null ? 'unknown' : message.exitCode), message.output);
        }
        verificationNotice = message.text || 'Verification outcome reported.';
        verificationStatus.textContent = verificationNotice;
        activeRequestId = undefined;
        activeActionType = undefined;
        stop.hidden = true;
        setBusy(false);
        status.textContent = 'Vesper · verification ' + (message.state || 'finished') + (message.executed ? ' · command executed' : ' · no confirmed execution');
        if (currentWorkflow) renderTaskState(currentWorkflow);
      }
      if (message.type === 'verification-error') {
        verificationNotice = message.text || 'Verification operation failed.';
        verificationStatus.textContent = verificationNotice;
        addMessage('error', 'Verification unavailable', message.text || 'No verification outcome is available.');
      }
      if (message.type === 'history-load-error') {
        historyState.textContent = message.text || 'Older conversation messages could not be loaded.';
        loadOlderHistory.disabled = false;
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
        activeActionType = message.kind || 'turn';
        setBusy(true);
        if (message.kind === 'preflight') {
          activeAssistant = addMessage('activity', 'Vesper · inspecting repository…', 'The provider task has not been submitted.');
          stop.hidden = false;
          stop.disabled = false;
          status.textContent = 'Vesper · inspecting bounded local repository evidence';
        } else if (message.kind === 'turn') {
          activeAssistant = addMessage('assistant', currentProviderName + ' · task continued after panel reopen…', '');
          stop.hidden = false;
          stop.disabled = false;
        }
      }
      if (message.type === 'user-message') return;
      if (message.type === 'plan-preview') {
        const capabilityNote = '\n\nCapability discovery does not prove installation, configuration, connection, runtime loading, or successful use.';
        addMessage(message.error ? 'error' : 'assistant', 'Vesper capability plan · advisory · not executed', (message.text || 'No capability plan output is available.') + capabilityNote);
        previewPlan.disabled = false;
      }
      if (message.type === 'repository-inspection-start') {
        activeRequestId = message.requestId;
        activeActionType = 'inspection';
        activeAssistant = addMessage('activity', message.mode === 'impact' ? 'Vesper · assessing change impact…' : 'Vesper · inspecting repository…', 'Read-only bounded evidence collection. No coding task has been submitted.');
        stop.hidden = false;
        stop.disabled = false;
        setBusy(true);
        status.textContent = 'Vesper · collecting bounded read-only repository evidence';
      }
      if (message.type === 'repository-inspection-result' && message.requestId === activeRequestId) {
        if (activeAssistant) {
          activeAssistant.title.textContent = 'Vesper ' + (message.mode === 'impact' ? 'change impact' : 'repository investigation') + ' · ' + (message.status || 'unknown') + ' · read-only';
          activeAssistant.body.textContent = message.report || 'No investigation report is available.';
          activeAssistant = undefined;
        } else {
          addMessage('activity', 'Vesper ' + (message.mode === 'impact' ? 'change impact' : 'repository investigation') + ' · ' + (message.status || 'unknown') + ' · read-only', message.report || 'No investigation report is available.');
        }
        activeRequestId = undefined;
        activeActionType = undefined;
        stop.hidden = true;
        setBusy(false);
        status.textContent = 'Vesper · repository investigation ' + (message.status || 'finished');
      }
      if (message.type === 'repository-inspection-error') {
        if (message.requestId !== undefined && message.requestId !== activeRequestId) return;
        if (activeAssistant && message.requestId === activeRequestId) {
          activeAssistant.title.textContent = message.state === 'cancelled' ? 'Vesper repository investigation · cancelled' : message.state === 'stale' ? 'Vesper repository investigation · stale report discarded' : 'Vesper repository investigation · failed';
          activeAssistant.body.textContent = message.text || 'Repository investigation failed.';
          activeAssistant = undefined;
        } else {
          const label = message.state === 'cancelled' ? 'Repository investigation cancelled' : message.state === 'stale' ? 'Repository investigation discarded' : 'Repository investigation unavailable';
          addMessage('error', label, message.text || 'No report was produced.');
        }
        if (message.requestId === undefined || message.requestId === activeRequestId) {
          activeRequestId = undefined;
          activeActionType = undefined;
          stop.hidden = true;
          setBusy(false);
          status.textContent = message.text || 'Repository investigation failed.';
        }
      }
      if (message.type === 'repository-preflight' && message.requestId === activeRequestId) {
        if (message.state === 'running') {
          status.textContent = 'Vesper · inspecting bounded local repository evidence';
          if (activeAssistant) activeAssistant.title.textContent = 'Vesper · inspecting repository…';
        } else {
          const stateLabel = message.state === 'fallback' ? 'fallback · original task only'
            : message.state === 'partial' ? 'partial coverage' : 'bounded evidence';
          const evidenceLabel = message.evidenceIncluded ? ' · attached to this task' : ' · not sent to provider';
          addMessage(message.state === 'fallback' ? 'error' : 'activity', 'Repository preflight · ' + stateLabel + evidenceLabel, message.text || 'No repository summary is available.');
          status.textContent = message.state === 'fallback' ? 'Vesper · preflight limited; submitting original task' : currentProviderName + ' · submitting task';
          if (activeAssistant) activeAssistant.title.textContent = currentProviderName + ' · submitting task…';
        }
      }
      if (message.type === 'task-submission' && message.requestId === activeRequestId) {
        if (message.state === 'submitting') status.textContent = currentProviderName + ' · submitting task…';
        else if (message.state === 'completed') status.textContent = currentProviderName + ' · task completed';
        else if (message.state === 'interrupted') status.textContent = currentProviderName + ' · task interrupted';
        else if (message.state === 'outcome-uncertain') status.textContent = currentProviderName + ' · task outcome uncertain; do not resubmit';
        else if (message.state === 'provider-error') status.textContent = currentProviderName + ' · provider did not confirm completion';
      }
      if (message.type === 'local-answer') {
        const state = message.result?.status || 'confirmed';
        addMessage('assistant', 'Vesper local · ' + state + ' · no provider task · ' + message.elapsedMs + ' ms', message.text);
        setBusy(false);
      }
      if (message.type === 'error') {
        addMessage('assistant', (message.label || 'Vesper') + ' · ' + message.elapsedMs + ' ms', message.text);
        setBusy(false);
      }
      if (message.type === 'input-error') {
        addMessage('assistant', 'Task not sent', message.text);
        status.textContent = message.text;
        setBusy(false);
      }
      if (message.type === 'assistant-start') {
        activeRequestId = message.requestId;
        activeActionType = 'turn';
        activeDiff = undefined;
        if (typeof message.providerId === 'string') currentProviderId = message.providerId;
        activeAssistant = addMessage('assistant', currentProviderName + ' · connecting…', '');
        stop.hidden = false;
        stop.disabled = false;
        setBusy(true);
        status.textContent = currentProviderName + ' · connecting…';
      }
      if (message.type === 'assistant-running' && message.requestId === activeRequestId) {
        status.textContent = currentProviderName + ' · running';
        if (activeAssistant) activeAssistant.title.textContent = currentProviderName + ' · running…';
      }
      if (message.type === 'assistant-delta' && message.requestId === activeRequestId && activeAssistant) {
        activeAssistant.body.textContent += message.text;
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'tool-activity' && message.requestId === activeRequestId) {
        const state = message.state || 'unknown';
        const title = 'Vesper tool · ' + (message.toolId || 'unknown') + ' · ' + state + (message.verified ? ' · verified' : ' · not verified') + (message.errorCode ? ' · ' + message.errorCode : '');
        addMessage('activity', title, message.summary || 'No result preview is available.');
      }
      if (message.type === 'workflow-stage' && message.requestId === activeRequestId) {
        const labels = { understanding: 'Understanding task', inspection: 'Inspecting project', planning: 'Planning from evidence', proposal: 'Preparing file proposal', approval: 'Waiting for approval', verification: 'Verifying file change', report: 'Preparing evidence report' };
        const label = labels[message.stage];
        if (label) {
          status.textContent = currentProviderName + ' · ' + label.toLowerCase();
          if (activeAssistant) activeAssistant.title.textContent = currentProviderName + ' · ' + label.toLowerCase() + '…';
        }
      }
      if (message.type === 'workflow-state' && message.requestId === activeRequestId) {
        const workflow = message.workflow || {};
        renderTaskState(workflow);
        const verification = workflow.verification && workflow.verification.state ? ' · verification ' + workflow.verification.state : '';
        status.textContent = currentProviderName + ' · workflow ' + (workflow.status || 'running') + ' · ' + (workflow.stage || 'understanding') + verification;
        if (workflow.diff && workflow.diff.source === 'workspace') {
          const diff = workflow.diff;
          const readBackFiles = [...new Set([...(workflow.verifiedFiles || []), ...(workflow.diskVerifiedFiles || [])])].join(', ');
          const heading = 'Vesper working-tree diff · ' + (diff.evidenceState || 'unavailable') + (readBackFiles ? ' · read-back: ' + readBackFiles : '') + ' · may include earlier edits';
          let body = diff.evidenceState === 'available' && typeof diff.diff === 'string' ? diff.diff : 'Workspace diff unavailable: ' + (diff.evidenceState || 'unknown') + '.';
          if (diff.truncated) body += '\\n[diff display omitted after Vesper limit]';
          if (!activeDiff) activeDiff = addMessage('activity', heading, body);
          else {
            activeDiff.title.textContent = heading;
            activeDiff.body.textContent = body;
          }
        }
      }
      if (message.type === 'file-change-activity' && message.requestId === activeRequestId) {
        const files = Array.isArray(message.files) ? message.files.map((entry) => entry && entry.path).filter((item) => typeof item === 'string').slice(0, 16) : [];
        const body = files.length ? files.map((item) => '• ' + item).join('\\n') + '\\n\\n' + (message.note || '') : (message.note || 'No safe file paths are available.');
        addMessage('activity', 'Codex file-change evidence · ' + (message.state || 'unknown') + ' · disk state unverified', body);
      }
      if (message.type === 'turn-diff' && message.requestId === activeRequestId) {
        const activity = message.activity || {};
        const heading = 'Codex aggregate diff · ' + (activity.closeReason || 'unknown') + ' · server-reported; disk state unverified';
        let body = 'Aggregate diff unavailable: ' + (activity.evidenceReason || activity.evidenceState || 'unknown') + '.';
        if (activity.evidenceState === 'empty') body = 'The latest aggregate snapshot is empty; no diff lines were supplied.';
        else if (activity.evidenceState === 'available' && typeof activity.diff === 'string') body = activity.diff || '(empty diff)';
        if (activity.truncated) body += '\\n[diff display omitted after Vesper limit]';
        if (!activeDiff) activeDiff = addMessage('activity', heading, body);
        else {
          activeDiff.title.textContent = heading;
          activeDiff.body.textContent = body;
        }
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'interrupt-requested' && message.requestId === activeRequestId) {
        status.textContent = message.phase === 'inspection'
          ? 'Vesper · cancelling repository investigation…'
          : message.phase === 'preflight'
          ? 'Vesper · cancelling repository inspection; provider task has not been submitted…'
          : 'Interrupt sent · waiting for ' + currentProviderName + ' to stop…';
      }
      if (message.type === 'assistant-interrupt-error' && message.requestId === activeRequestId) {
        status.textContent = 'Interrupt was not confirmed · the turn may still be running.';
        stop.disabled = false;
        if (activeAssistant) activeAssistant.title.textContent = currentProviderName + ' · running (interrupt not confirmed)';
      }
      if (message.type === 'assistant-done' && message.requestId === activeRequestId && activeAssistant) {
        const generated = message.generatedTextOnly || message.providerId === 'openai-chat-completions';
        const generatedName = message.providerId === 'nvidia-nim' ? 'NVIDIA NIM' : 'OpenAI';
        const verifiedFiles = Array.isArray(message.verifiedFiles) ? message.verifiedFiles.length : 0;
        const diskVerifiedFiles = Array.isArray(message.diskVerifiedFiles) ? message.diskVerifiedFiles.length : 0;
        const proposedFiles = Array.isArray(message.proposedFiles) ? message.proposedFiles.length : 0;
        const fileOutcome = verifiedFiles ? ' · ' + verifiedFiles + ' file(s) applied and read-back verified'
          : diskVerifiedFiles ? ' · ' + diskVerifiedFiles + ' approved path(s) confirmed in working-tree diff'
          : proposedFiles ? ' · ' + proposedFiles + ' path(s) reported; disk state unverified'
            : generated ? ' · files unchanged' : ' · no file changes reported';
        activeAssistant.title.textContent = (generated ? generatedName + ' · generated text · not executed' + fileOutcome : 'Codex provider response completed' + fileOutcome) + ' · workflow ' + (message.workflowStatus || 'completed') + ' · verification ' + (message.verificationState || 'not-run') + (message.truncated ? ' · response truncated' : '') + ' · ' + message.elapsedMs + ' ms · ' + message.usage + (message.model ? ' · ' + message.model : '');
        activeAssistant = undefined;
      }
      if (message.type === 'assistant-done' && message.requestId === activeRequestId) {
        activeRequestId = undefined;
        activeActionType = undefined;
        status.textContent = (message.generatedTextOnly || message.providerId === 'openai-chat-completions'
          ? (message.providerId === 'nvidia-nim' ? 'NVIDIA NIM' : 'OpenAI') + ' · text generated, not executed'
          : 'Codex provider response completed') + ' · workflow ' + (message.workflowStatus || 'completed') + ' · verification ' + (message.verificationState || 'not-run') + (message.truncated ? ' · response truncated' : '');
        stop.hidden = true;
        setBusy(false);
      }
      if (message.type === 'assistant-error' && message.requestId === activeRequestId) {
        if (activeAssistant) {
          const interrupted = message.state === 'interrupted';
          activeAssistant.title.textContent = message.preflight ? 'Vesper preflight cancelled · task not submitted'
            : interrupted ? currentProviderName + ' · interrupted' : currentProviderName + ' · failed · ' + message.elapsedMs + ' ms';
          activeAssistant.body.textContent += (activeAssistant.body.textContent ? '\\n\\n' : '') + message.text;
          activeAssistant = undefined;
        } else {
          const label = message.state === 'interrupted' ? currentProviderName + ' · interrupted' : currentProviderName + ' error · ' + message.elapsedMs + ' ms';
          addMessage('assistant', label, message.text);
        }
        activeRequestId = undefined;
        activeActionType = undefined;
        status.textContent = message.preflight ? 'Vesper · provider task not submitted'
          : message.state === 'interrupted' ? currentProviderName + ' · interrupted' : currentProviderName + ' · failed; the conversation remains visible in this panel.';
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

function normalizeTurnDiffForPanel(activity) {
  const evidenceState = ["available", "empty", "unavailable"].includes(activity?.evidenceState) ? activity.evidenceState : "unavailable";
  const rawDiff = evidenceState === "available" && typeof activity?.diff === "string" ? activity.diff : "";
  const safeDiff = redactSensitiveText(rawDiff).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
  const truncated = safeDiff.length > 32 * 1024;
  return Object.freeze({
    evidenceState: truncated ? "unavailable" : evidenceState,
    evidenceReason: typeof activity?.evidenceReason === "string" && /^[a-z_]{1,80}$/u.test(activity.evidenceReason)
      ? activity.evidenceReason : truncated ? "oversized" : null,
    closeReason: ["completed", "interrupted", "failed", "disconnected", "timeout", "client_closed", "unknown"].includes(activity?.closeReason)
      ? activity.closeReason : "inProgress",
    diff: truncated ? "" : safeDiff,
    truncated,
  });
}

function isSafeProtocolIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(value);
}

function writeLog(message) {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

module.exports = { activate, deactivate };
