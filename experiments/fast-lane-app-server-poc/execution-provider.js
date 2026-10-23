"use strict";

const { createExecutionError } = require("./execution-interface");
const { CODEX_CAPABILITIES, CODEX_PROVIDER_ID, createCodexExecutionProvider } = require("./codex-execution-provider");
const { OPENAI_CAPABILITIES, OPENAI_PROVIDER_ID, createOpenAIChatCompletionsProvider, resolveOpenAIConfig } = require("./openai-chat-completions-provider");
const { NVIDIA_PROVIDER_ID, NVIDIA_NIM_CAPABILITIES, createNvidiaNimExecutionProvider, resolveNvidiaNimConfig } = require("./nvidia-nim-provider");

const DEFAULT_PROVIDER_ID = CODEX_PROVIDER_ID;
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: CODEX_PROVIDER_ID,
    name: "Codex app-server",
    description: "Local Codex execution with the existing app-server approval and file-change safeguards.",
    capabilities: CODEX_CAPABILITIES,
    modelFeatures: Object.freeze({
      streaming: "Codex app-server events",
      toolCalling: "Codex-managed execution",
      conversationResume: "Codex threads",
      fileChanges: "native events with existing review safeguards",
      commandExecution: "native approvals and Codex command policy",
    }),
  }),
  Object.freeze({
    id: OPENAI_PROVIDER_ID,
    name: "OpenAI Chat Completions API",
    description: "Remote text generation with locally stored conversation history; no tools or project files are sent.",
    capabilities: OPENAI_CAPABILITIES,
    modelFeatures: Object.freeze({
      streaming: "Vesper consumes SSE text streams",
      toolCalling: "not enabled in Vesper; model support is not queried",
      conversationResume: "Vesper local transcript",
      fileChanges: "unsupported",
      commandExecution: "unsupported",
    }),
  }),
  Object.freeze({
    id: NVIDIA_PROVIDER_ID,
    name: "NVIDIA NIM Chat Completions",
    description: "NVIDIA NIM-compatible remote text generation with a local transcript; no tools or project files are sent.",
    capabilities: NVIDIA_NIM_CAPABILITIES,
    modelFeatures: Object.freeze({
      streaming: "Vesper consumes documented-compatible SSE text streams",
      toolCalling: "not enabled in Vesper; model support is not queried",
      conversationResume: "Vesper local transcript",
      fileChanges: "unsupported",
      commandExecution: "unsupported",
    }),
  }),
]);

function createExecutionProvider({ providerId, environment = process.env, onConversationId, clientOptions, ...options } = {}) {
  const selectedProviderId = providerId || resolveDefaultProviderId(environment);
  if (selectedProviderId === OPENAI_PROVIDER_ID) {
    return createOpenAIChatCompletionsProvider({ ...options, environment, onConversationId });
  }
  if (selectedProviderId === NVIDIA_PROVIDER_ID) {
    return createNvidiaNimExecutionProvider({ ...options, environment, onConversationId });
  }
  if (selectedProviderId === CODEX_PROVIDER_ID) {
    return createCodexExecutionProvider({
      ...options,
      clientOptions: {
        ...(clientOptions || {}),
        ...(typeof onConversationId === "function" ? { onThreadId: onConversationId } : {}),
      },
    });
  }
  {
    throw createExecutionError("UNSUPPORTED_OPERATION", `Vesper has no active execution adapter for provider ${String(selectedProviderId).slice(0, 80)}.`, { providerId: selectedProviderId });
  }
}

function resolveDefaultProviderId(environment = process.env) {
  const selected = environment && typeof environment.VESPER_PROVIDER === "string" ? environment.VESPER_PROVIDER.trim() : "";
  return selected || DEFAULT_PROVIDER_ID;
}

function listProviders() {
  return PROVIDERS;
}

function getProviderStatus(providerId, environment = process.env) {
  const descriptor = PROVIDERS.find((provider) => provider.id === providerId);
  if (!descriptor) throw createExecutionError("UNSUPPORTED_OPERATION", `Vesper has no provider named ${String(providerId).slice(0, 80)}.`, { providerId });
  if (providerId === OPENAI_PROVIDER_ID) {
    const config = resolveOpenAIConfig(environment);
    return Object.freeze({
      ...descriptor,
      configured: config.errors.length === 0,
      apiKeyConfigured: config.apiKeyConfigured,
      apiKeyEnvVar: config.apiKeyEnvVar,
      model: config.modelId || null,
      modelFreshness: config.modelId ? "configured; not verified" : "not configured",
      baseUrl: safeEndpoint(config.baseUrl),
      requestTimeoutMs: config.requestTimeoutMs,
      configurationMessages: config.errors,
      reachability: "not checked",
    });
  }
  if (providerId === NVIDIA_PROVIDER_ID) {
    const config = resolveNvidiaNimConfig(environment);
    return Object.freeze({
      ...descriptor,
      configured: config.errors.length === 0,
      apiKeyConfigured: config.apiKeyConfigured,
      apiKeyEnvVar: config.apiKeyEnvVar,
      model: config.modelId || null,
      modelFreshness: config.modelId ? "configured; not verified" : "not configured",
      baseUrl: safeEndpoint(config.baseUrl),
      requestTimeoutMs: config.requestTimeoutMs,
      configurationMessages: config.errors,
      reachability: "not checked",
    });
  }
  return Object.freeze({
    ...descriptor,
    configured: null,
    apiKeyConfigured: null,
    model: null,
    configurationMessages: Object.freeze(["Uses the locally installed Codex CLI; runtime availability was not checked."]),
    reachability: "not checked",
  });
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/u, "")}`.slice(0, 300);
  } catch {
    return "invalid";
  }
}

module.exports = {
  DEFAULT_PROVIDER_ID,
  NVIDIA_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  createExecutionProvider,
  getProviderStatus,
  listProviders,
  resolveDefaultProviderId,
};
