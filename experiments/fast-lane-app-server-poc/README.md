# Fast Lane app-server PoC

Disposable VS Code extension prototype with a small, testable routing core. Explicit deterministic questions about the current branch, working-tree status, configured upstream, commits ahead of the last fetched upstream reference, and the most recent recorded Fast Lane test run are answered locally. Ambiguous and unsupported requests use the existing Codex app-server fallback and stream into the panel.

The extension uses only the VS Code Extension API, Node.js built-ins, the installed `git` command, and the documented Codex app-server JSON-RPC protocol. Its tests use Node's built-in test runner; there are no npm runtime dependencies.

## Run locally

Requirements: VS Code 1.85 or newer, Node.js 18 or newer, Git, and Codex CLI on `PATH`.

1. Open this repository in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In that window, run **Fast Lane: Open Panel** from the Command Palette.
4. Choose **View → Output → Fast Lane PoC** to inspect routing and RPC logs.

Alternatively, open this folder as an extension development path:

```sh
code --new-window --extensionDevelopmentPath="$(pwd)/experiments/fast-lane-app-server-poc" "$(pwd)"
```

For an isolated VS Code profile, add `--user-data-dir /tmp/fast-lane-vscode-profile --extensions-dir /tmp/fast-lane-vscode-extensions`. This profile is separate from VS Code settings; the spawned `codex app-server` uses the installed Codex CLI configuration and normal Codex sign-in flow. The PoC never reads, copies, or logs authentication files or tokens.

## Manual validation

Run the routing-core tests from this folder with `npm test`. The command records only the test summary, exit code, timestamps, and source fingerprint in an ignored local file. A later local test-result answer is confirmed only while that fingerprint matches the routing-core test sources.

Try these local requests:

- `What Git branch am I on?`
- `Is my working tree clean?`
- `Does this branch have an upstream?`
- `How many local commits are ahead of upstream?`
- `Did the last test run pass?`

Each local answer includes its status and structured evidence. The upstream ahead count uses local tracking refs only, checks the tracking-ref reflog for age, and always warns that the remote was not contacted. An old ref is marked stale; an unavailable reflog produces unknown freshness. A branch name alone never establishes that it is pushed. If no trustworthy test record exists, the answer is unknown; changed routing-core sources make the record stale.

In **Output → Fast Lane PoC**, confirm local requests produce `route=local`, `reason=local_exact_match`, and a route metric, without an app-server spawn or `turn/start`. Requests such as `Is this branch pushed?` are ambiguous and should go to Codex with reason `local_ambiguous`. Submit `Explain what a Git rebase does in one sentence.` to exercise the normal fallback stream. The log includes route counts, latency, and local handler failures without storing prompt or answer text.

If the active workspace is not a Git repository, Git is missing, a handler fails, or Git returns no branch name, the panel shows unavailable or unknown instead of inventing an answer. Local checks still work if app-server cannot start. A fallback prompt displays an explicit error if app-server is unavailable or the Codex turn fails.

## Evidence and limitations

- Routing, structured local results, local handlers, fallback selection, and privacy-safe route metrics are split into testable modules. The Git handlers use argv arrays with `execFile`; they never invoke a shell.
- The upstream ahead check compares `HEAD` with `@{upstream}` and never fetches. Its freshness estimate uses the local upstream reflog and a seven-day threshold; it is not proof of current remote state.
- The test-result handler trusts only the local `npm test` runner's record and verifies its source fingerprint. It reports the Fast Lane routing-core suite, not unrelated project tests.
- The local route never launches Codex. The app-server starts lazily for a Codex fallback.
- The extension logs each app-server RPC method and ID, routing choice, request latency, turn state, and any `thread/tokenUsage/updated` payload. Prompt text is not included in logs.
- A successful fallback demonstrates the working signed-in Codex configuration. This prototype does not manage authentication or expose authentication material.
- The panel owns its own conversation display. Local replies are not inserted into the built-in Codex UI. The app-server CLI is marked experimental in the installed Codex version, so protocol maturity remains a product risk.
- Remove `experiments/fast-lane-app-server-poc/` to discard the prototype. It creates no project configuration, dependencies, or Git changes at runtime.
