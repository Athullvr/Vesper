"use strict";

const { createExecutionError } = require("./execution-interface");
const { CODEX_PROVIDER_ID, createCodexExecutionProvider } = require("./codex-execution-provider");

function createExecutionProvider({ providerId = CODEX_PROVIDER_ID, ...options } = {}) {
  if (providerId !== CODEX_PROVIDER_ID) {
    throw createExecutionError("UNSUPPORTED_OPERATION", `Vesper has no active execution adapter for provider ${String(providerId).slice(0, 80)}.`, { providerId });
  }
  return createCodexExecutionProvider(options);
}

module.exports = { createExecutionProvider };
