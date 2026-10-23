"use strict";

const {
  CHAT_COMPLETIONS_CAPABILITIES,
  createCompatibleChatCompletionsProvider,
  resolveCompatibleChatCompletionsConfig,
} = require("./openai-chat-completions-provider");

const NVIDIA_PROVIDER_ID = "nvidia-nim";
const DEFAULT_NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

// NIM exposes OpenAI-compatible chat-completions endpoints, but model support varies.
// Vesper requests text streaming only and never sends function definitions or executes
// returned tool calls through this adapter.
function resolveNvidiaNimConfig(environment = process.env, overrides = {}) {
  return resolveCompatibleChatCompletionsConfig(environment, {
    providerId: NVIDIA_PROVIDER_ID,
    providerName: "NVIDIA NIM",
    apiKeyEnvVars: ["VESPER_NVIDIA_API_KEY", "NVIDIA_API_KEY"],
    modelEnvVar: "VESPER_NVIDIA_MODEL",
    baseUrlEnvVar: "VESPER_NVIDIA_BASE_URL",
    timeoutEnvVar: "VESPER_NVIDIA_TIMEOUT_MS",
    defaultBaseUrl: DEFAULT_NVIDIA_NIM_BASE_URL,
    ...overrides,
  });
}

function createNvidiaNimExecutionProvider(options = {}) {
  const environment = options.environment || process.env;
  const config = options.config || resolveNvidiaNimConfig(environment, options.modelId ? { modelId: options.modelId } : {});
  return createCompatibleChatCompletionsProvider({
    ...options,
    providerId: NVIDIA_PROVIDER_ID,
    conversationPrefix: "nim",
    config,
  });
}

module.exports = {
  DEFAULT_NVIDIA_NIM_BASE_URL,
  NVIDIA_PROVIDER_ID,
  NVIDIA_NIM_CAPABILITIES: CHAT_COMPLETIONS_CAPABILITIES,
  createNvidiaNimExecutionProvider,
  resolveNvidiaNimConfig,
};
