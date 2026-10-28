# Opt-in OpenAI and NVIDIA provider validation

This procedure makes one minimal completion request to exactly one provider selected by the developer. It is not part of `npm test` or `release:check`. The call may incur provider charges. Do not run it unless you intend to make that request.

## Before the request

1. Choose a provider you explicitly configured. Do not change `VESPER_PROVIDER` and do not rely on fallback selection.
2. Inject that provider's key and model through a secret manager or secure process environment. Never put a key in command arguments, shell history, source files, screenshots, or logs.
3. Use an empty disposable project and a temporary Vesper home. Do not use a private repository for this check.
4. Confirm local configuration without a network request:

   ```sh
   vesper providers status --provider openai-chat-completions
   # or
   vesper providers status --provider nvidia-nim
   ```

   Do not add `--check`; it makes a separate authenticated network request and is not required for the completion smoke test. Leave structured tool calling disabled for this text-only check.

## One request and response

Open a clean project and set `VESPER_HOME` to an empty temporary directory. Start the explicitly selected provider with `--new`:

```sh
export VESPER_HOME="$(mktemp -d)"
vesper --provider openai-chat-completions --new /path/to/empty-project
# Or, in a separate run:
vesper --provider nvidia-nim --new /path/to/empty-project
```

Submit exactly this non-coding prompt:

> Reply with exactly: Vesper provider smoke test passed.

Verify that one response arrives in the same session, contains the expected phrase, and the session reports completion. Stop after that one turn. Do not switch providers automatically, repeat a request with an uncertain outcome, or send private repository content. The test sends this prompt and normal provider protocol metadata to the selected provider.

## Failure checks and evidence

The offline tests cover missing-key configuration and simulated rejected HTTP responses for both API providers. Run them from the source checkout:

```sh
node --test test/openai-chat-completions-provider.test.js test/nvidia-nim-provider.test.js
```

Those are mock tests; they do not authenticate or contact either provider. Do not test a rejected request by pasting an invalid or real key into a command. A local `API key is present` status does not establish that the key works. Vesper withholds raw API error bodies and does not print credential values.

For preview reporting, record only provider name, model identifier if safe to share, approximate time, success/failure, and redacted error code/message. Do not attach headers, provider response dumps, credentials, or private project content. See [PREVIEW-FEEDBACK.md](PREVIEW-FEEDBACK.md).
