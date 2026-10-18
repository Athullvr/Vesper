# Fast Lane app-server PoC

Disposable VS Code extension prototype. It routes exactly `What Git branch am I on?` to a fixed, read-only local Git command. Every other prompt is sent to a Codex app-server thread and streamed back into the panel.

The extension uses only the VS Code Extension API, Node.js built-ins, the installed `git` command, and the documented Codex app-server JSON-RPC protocol. It has no npm runtime dependencies.

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

1. Submit the exact prompt `What Git branch am I on?`. The panel should show the branch with a **Fast Lane local · no Codex turn** label.
2. In **Output → Fast Lane PoC**, confirm a `route=local` line and `codex_turns_started=0`. App-server initialization may appear, but there must be no `thread/start` or `turn/start` RPC for this request.
3. Submit `Explain what a Git rebase does in one sentence.` It is deliberately outside the one-rule allowlist. The panel should show a streamed Codex answer. The log should show `route=codex_fallback`, `thread/start`, `turn/start`, and the `turn/started` / `turn/completed` notifications. Token usage is logged when app-server reports it; otherwise the panel and log state that usage was unavailable.

If the active workspace is not a Git repository, Git is missing, the command fails, or it returns no branch name, the panel reports that condition without inventing a branch. Local checks still work if app-server cannot start. A fallback prompt displays an explicit error if app-server is unavailable or the Codex turn fails.

## Evidence and limitations

- The local route calls only `git branch --show-current` through `execFile` with an argv array and the active workspace as `cwd`. It never invokes a shell and never sends `turn/start`.
- The extension logs each app-server RPC method and ID, routing choice, request latency, turn state, and any `thread/tokenUsage/updated` payload. Prompt text is not included in logs.
- A successful fallback demonstrates the working signed-in Codex configuration. This prototype does not manage authentication or expose authentication material.
- The panel owns its own conversation display. Local replies are not inserted into the built-in Codex UI. The app-server CLI is marked experimental in the installed Codex version, so protocol maturity remains a product risk.
- Remove `experiments/fast-lane-app-server-poc/` to discard the prototype. It creates no project configuration, dependencies, or Git changes at runtime.
