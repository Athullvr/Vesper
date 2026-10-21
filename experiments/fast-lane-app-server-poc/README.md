# Fast Lane and Vesper prototype

This prototype has two frontends over the same small routing core:

- A VS Code extension panel that answers explicit Git and test-evidence questions locally and sends other prompts to Codex app-server.
- A minimal terminal frontend named `vesper` with the same local-first routing and a persistent Codex app-server thread per Vesper session.

The prototype uses Node.js built-ins, Git, the VS Code Extension API for the panel, and the installed Codex CLI. It has no npm runtime dependencies.

The [reliability audit](RELIABILITY-AUDIT.md) records the verified fixes, test matrix, and offline runtime results. The [interface inventory and roadmap](INTERFACE-ROADMAP.md) maps the terminal's remaining features to the installed protocol and describes an incremental architecture.

The [TTY smoke and integration-readiness procedure](TTY-INTEGRATION-READINESS.md) documents the no-Codex CLI lifecycle PTY check, the synthetic-event PTY check, and a prepared disposable Git repository for a future explicitly authorized live test. Run `npm run test:pty` for the CLI lifecycle check.

## Terminal frontend

Requirements: Node.js 18 or newer, Git, and Codex CLI on `PATH`. From this folder, print help or run Vesper against a project:

```sh
npm run cli -- --help
npm run cli -- /path/to/project
```

Vesper resolves the selected project to its canonical real path. Without a path, it uses the current working directory. To make the `vesper` command available in the current npm environment, link this package once, then run it from any project directory:

```sh
cd experiments/fast-lane-app-server-poc
npm link
cd /path/to/project
vesper --help
vesper
```

The default launch resumes the most recently updated Vesper session for that exact canonical project, or creates one if none exists. Use `vesper --new` to create a separate session. `vesper run` is an explicit alias for the normal terminal workflow.

Project-scoped session commands are also available:

```sh
vesper sessions list
vesper sessions resume SESSION_ID
vesper sessions new
```

`list` shows at most the 50 newest sessions for the selected canonical project and prints only the Vesper id and update time. Session metadata does not retain a title or prompt preview. `resume` defaults to the current project and rejects a session saved for another project; it reconnects through the verified Codex `thread/resume` path. `new` creates a separate session and leaves existing sessions intact. Each command accepts an optional project directory.

Read-only integration discovery is available from the terminal. `vesper plugins` checks project and personal local marketplace manifests plus the local plugin cache; `vesper mcp` uses Codex's JSON listing command; and `vesper skills` checks project and user skill directories. These commands show only names, status, and source, never MCP command arguments, environment values, skill instructions, or conversation text. `vesper modules` is not implemented.

To run straight from the checkout without linking or opening VS Code, invoke the checked-in launcher from the project directory:

```sh
node /path/to/Vesper/experiments/fast-lane-app-server-poc/bin/vesper.js
```

Vesper prints the session id at startup. Resume that Vesper session and its saved Codex thread with:

```sh
vesper --resume SESSION_ID
```

An optional project path on resume must resolve to the same directory recorded for that session.

The interactive workspace shows the canonical project path and active Vesper session. Enter a task at `vesper> ` to use local-first routing or a streamed Codex turn. The workspace commands are:

```text
:sessions              list this project's recent sessions
:switch SESSION_ID     switch to a saved session in this project
:new                   create and select a separate session
:routing               show routing outcome counts for the active session
:help                  show workspace commands
:quit                  exit and keep saved sessions
```

Session lists show at most 50 ids, update times, and whether a saved Codex thread exists; they do not show prompts or conversation text. Switching verifies the saved thread through Codex `thread/resume` before restoring bounded history. A reconnect failure leaves that session selected and saved, reports the error, and retries on a later task. `Ctrl+C` during a Codex turn requests interruption and returns to the prompt when the turn ends; `Ctrl+C` at an idle prompt exits cleanly. EOF also exits. TTY output uses the existing bounded live diff view and cleans up its resize listener; redirected input/output stays line based with no cursor-mode changes.

Exact supported local questions are answered before the app-server starts. Other and ambiguous prompts use the installed Codex app-server. Vesper starts a Codex thread lazily on the first fallback, then sends later fallback prompts to that same thread. Resuming a saved session calls `thread/resume`; it will report an error if that thread or directory cannot be resumed rather than silently replacing it with a new conversation.

Each task prints one short `[Route · …]` indicator based on the router decision and, for local requests, the handler's returned status. `VESPER_ROUTING_DEBUG=1` adds a bounded JSON routing record with stable reason/outcome codes and a concise explanation; it omits the submitted prompt, handler summary, and evidence payload. A `confirmed` handler status describes the local result's status and does not independently verify its correctness. Unknown, stale, or unavailable local results remain local; local-handler failures do not fall back to Codex.

`:routing` shows counts for routing decisions recorded in the active in-memory Vesper session, grouped by stable router reason code. A Codex delegation is a routing outcome and does not mean its task succeeded. Counts are neither persisted nor restored when a saved session is resumed; they reset when switching sessions. The command reads only the bounded aggregate counters and does not display prompts, responses, evidence, or handler errors. Missing optional counters appear as `—`.

Before the first Codex task in a resumed Vesper session, the terminal verifies the saved thread and restores the latest 50 Codex turns through the existing bounded history projection. If history retrieval fails after the thread is verified, Vesper reports it as unavailable and keeps the thread usable. Local answers were never sent to Codex, so they are not part of that history. This does not attach to or import a conversation started directly with `codex`.

The terminal app-server client was implemented against the schema generated by the installed `codex-cli 0.162.1` (`codex app-server generate-json-schema --experimental`). It initializes JSON-RPC over stdio, uses `thread/start` or `thread/resume`, streams agent text deltas, and waits for a terminal turn state. It passes the selected project directory to the app-server process, thread creation, and each turn. It does not set a sandbox or approval-policy override, so the installed Codex configuration remains in effect.

## Boundary with the Codex CLI

The installed CLI reports `codex-cli 0.162.1`. Its help exposes fixed built-in commands, including `app-server`, `plugin`, and `mcp`; it does not expose a third-party command registration mechanism. Codex does support plugins in its own workflow: its plugin documentation covers skills and MCP-backed capabilities, and the CLI includes `codex plugin` management commands. The documented [CLI /plugins flow](https://developers.openai.com/learn/developers-codex-plugin) opens Codex's plugin browser. These integrations do not register new top-level `codex` commands or an arbitrary Vesper screen in the interactive terminal. The plugin package model and CLI marketplace commands are documented in [Package your plugin](https://developers.openai.com/plugins/build/plugins).

No supported in-process extension point for adding Vesper UI to the Codex CLI terminal was documented in the inspected CLI 0.162.1 help or plugin documentation. Codex's [app-server protocol](https://developers.openai.com/blog/codex-as-a-platform) is the documented integration surface for an application-owned frontend; the installed CLI labels it experimental. Vesper therefore runs as its own transparent terminal frontend and uses the installed Codex app-server/runtime for fallback turns. Running `codex` still launches Codex normally. Vesper does not replace or modify the `codex` executable, copy credentials, or reset Codex configuration.

The v0.2 discovery commands use bounded, read-only sources:

- `vesper plugins` reads `$PROJECT/.agents/plugins/marketplace.json`, `~/.agents/plugins/marketplace.json`, and plugin cache directory names under `$CODEX_HOME/plugins/cache` (default `~/.codex/plugins/cache`). A cached copy is reported as `installed`; a local marketplace entry with `policy.installation: "AVAILABLE"` is `available`. Other policy states, remote/universal marketplaces, and whether an item is enabled or loaded remain `unknown`. It does not run `codex plugin list --available`, because that can consult configured and remote marketplaces.
- `vesper mcp` runs the installed CLI's documented read-only `codex mcp list --json` command and projects only each server name and its `enabled` boolean. Vesper labels enabled servers `installed` (configured and enabled), disabled servers `available` (configured but disabled), and missing/failed state `unknown`. Codex has no list of unconfigured MCP servers, so Vesper cannot discover hypothetical servers.
- `vesper skills` recursively checks `$PROJECT/.agents/skills/` and `$CODEX_HOME/skills/` for `SKILL.md` files, with a five-level depth and 2,000-directory scan cap. A valid named manifest is `available`; missing, malformed, or other skill sources are `unknown`. Codex exposes no separate installed/enabled skill state through these sources, so runtime loading or activation remains unknown.

Codex's built-in plugin and MCP commands remain available independently (`codex plugin list --help`, `codex mcp list --help`). Vesper implements no integration installation, activation, removal, download, or user-configuration edits. Plugin list output is scoped to local files instead of the CLI's remote marketplace catalogue; plugin activation, managed sources, and Codex runtime-loaded status cannot be determined by this read-only local scan.

When Codex requests command, file, patch, or permission approval, Vesper shows the request in the terminal. Only typing `yes` grants a one-time approval; all other answers decline, except the explicit `cancel` answer. Permission-profile approval grants only the displayed requested profile for that turn. Vesper does not automatically approve commands or make session-wide grants. Unsupported request methods return a protocol error.

The terminal shows command activity only after the app-server confirms the active turn. It associates command items with the exact thread, turn, and item IDs; displays the supplied command, a valid working directory, lifecycle state, exit code when present, and bounded output; and keeps approval decisions separate from command execution results. Command text, working directories, and output payloads are limited to 4,096, 2,048, and 16,384 characters, with at most 50 retained command items per turn. Terminal controls are escaped and common credential patterns are redacted heuristically; this is not comprehensive secret detection. Output deltas are buffered until the command item or turn ends so redaction can span chunk boundaries; command start state remains visible while it runs.

Outside approval prompts, the terminal also shows bounded file-change summaries derived from the same in-memory snapshots used for file approval. Summaries are associated with the exact thread, turn, and item IDs; show proposed paths and change types, and include added/removed line counts only when a unified diff hunk is available. Later events report updated evidence; invalidation and completion markers state that earlier paths are no longer current. Summary paths are escaped and heuristically redacted, at most 50 file-change items and 8 paths per item are rendered, and total file-summary output is capped at 12,000 characters per turn. Summaries describe server evidence and do not establish that files were written to disk.

The app-server's separate `turn/diff/updated` event is shown as a turn-level aggregate diff. It is keyed only by the exact thread and turn IDs because this event has no item ID; it never becomes file-approval evidence or a per-file claim. Each accepted notification replaces the previous complete aggregate snapshot. When both input and output are interactive TTYs and `TERM` is not `dumb`, Vesper redraws one bounded live view in place, using a 60 ms debounce for snapshot updates. It erases the view before writing streamed text, command activity or other terminal output, then redraws the latest snapshot. The view suspends while an approval prompt is active and resumes afterward; terminal resize recalculates wrapping and the row cap. On turn closure, the final frame is left in place. Redirected or non-TTY output receives no live redraw and gets one bounded final summary instead.

The cached diff is capped at 32,768 characters and the escaped terminal view at 16,000 characters; the live frame is additionally limited to the terminal width and height, with an explicit truncation marker. Empty, unavailable, malformed, oversized, interrupted, failed, and disconnected states are labeled; incomplete last snapshots are marked as such. The header states that the server-reported diff does not verify a disk write. Terminal controls are escaped and common secrets are heuristically redacted. The protocol has no diff sequence number, so same-turn notifications are applied in stdio arrival order; this view cannot detect a producer that sends snapshots out of order.

File-change approval (`item/fileChange/requestApproval`) is shown only with a diff snapshot taken from `item/started`/`item/fileChange/patchUpdated` for the exact thread, turn and item IDs, printed before the prompt. Vesper declines, without asking, when the snapshot is missing, malformed, oversized, duplicated, for another thread/turn/item, already completed, or when the request carries `grantRoot` (a session-wide write grant, which the one-time flow does not offer). If the diff changes, the turn ends, or the connection drops while the prompt is open, the prompt is cancelled and the request is declined. Legacy `applyPatchApproval` is always declined because it carries no turn identity. Snapshots are held in memory only and never written to session files.

Session metadata is stored under `~/.vesper/sessions/` (or `$VESPER_HOME/sessions/` when `VESPER_HOME` is set). Files contain only the Vesper session id, canonical project path, Codex thread id, schema version, and timestamps. The session directory and files are created with mode `0700` and `0600`; prompts, responses, and authentication material are not stored there. App-server stderr is not copied to terminal output.

## VS Code extension

This repository is directly loadable as a VS Code extension: `package.json` points to the existing `extension.js` entry point. No build step or VSIX is required. There is no checked-in `.vscode/launch.json`, so use the command below instead of relying on `F5` to select an extension-host configuration.

For an isolated run, start it from a desktop terminal outside any restricted Linux command sandbox, from this repository directory. The fixture and dedicated homes are prepared by the integration procedure above; the VS Code profile and extension directories are also kept under the ignored `.audit-artifacts` directory:

```sh
E2E_PROJECT="$PWD/.audit-artifacts/disposable-e2e-project"
VS_CODE_DATA="$PWD/.audit-artifacts/phase1d-vscode-data"
VS_CODE_EXTENSIONS="$PWD/.audit-artifacts/phase1d-vscode-extensions"
mkdir -p "$VS_CODE_DATA" "$VS_CODE_EXTENSIONS"

CODEX_HOME="$PWD/.audit-artifacts/e2e-codex-home" \
VESPER_HOME="$PWD/.audit-artifacts/e2e-vesper-home" \
code --new-window \
  --user-data-dir "$VS_CODE_DATA" \
  --extensions-dir "$VS_CODE_EXTENSIONS" \
  --extensionDevelopmentPath="$PWD" \
  "$E2E_PROJECT"
```

The `code` command's exit status alone does not prove that Electron created a usable window. In this environment, launching it inside the restricted command sandbox produced `sandbox_host_linux.cc:41: Operation not permitted` while the CLI still returned status 0. Do not work around that restriction with `--no-sandbox`; run the command from the desktop session instead. Verify a separate VS Code window opened on the disposable project, run **Fast Lane: Open Panel** from the Command Palette, and confirm the Vesper webview appears. The Vesper Output channel and the Extension Host log can confirm activation after the command is invoked. Startup logs are under the selected VS Code user-data directory's `logs` folder; keep them local and do not share raw logs.

The extension panel keeps its VS Code message bridge and local-first routing, and uses the same tested app-server client and session store as the terminal frontend.

The panel shows the selected workspace folder and lets you choose among folders already open in the VS Code workspace. It resolves the folder to the CLI's canonical real path and looks up the most recently updated Vesper session for that exact path. The session store continues to hold only the Vesper session ID, project path, Codex thread ID, schema version, and timestamps; it does not store prompts or model output. On a Codex task, the panel resumes the stored thread and verifies the returned thread ID and project path. A failed resume keeps the saved session, blocks further tasks, and offers a retry or an explicit **Start new conversation** action. Starting a new conversation leaves the previous session record available.

The panel uses the app-server client's read-only sandbox override for both `thread/start` and `thread/resume`, and declines approval requests. A **Stop** button interrupts only the active turn. The extension host keeps one panel instance; closing the webview does not dispose the session mapping, and restarting VS Code reloads it from the existing Vesper session store.

After a saved thread is verified, the panel requests its latest 50 persisted turns through `thread/turns/list` with `itemsView: "full"`. It projects supported user and assistant messages, turn outcomes, and bounded tool activity into the conversation view in chronological order. Non-text user content is represented by an omission marker and makes the history partial. This projection is in memory; Vesper still stores only session/thread identifiers and project metadata. Empty history, partial history, and unavailable history have different status messages. If Codex confirms the thread but history retrieval fails, the panel leaves the session usable and reports that history was unavailable rather than empty. Local answers are not part of Codex thread history and are not restored. Retrieved server history describes recorded activity; it does not prove that a file was written to disk.

## Tests and manual checks

Run the full prototype test suite from this folder:

```sh
npm test
```

Tests use mocks for app-server initialization, turns, stream events, failures, interruption, timeouts, approvals, and saved-thread resume. `node test/extension-routing.test.js` exercises the real `SessionStore` files under a temporary `VESPER_HOME` with a mocked app-server. The existing Git integration test uses read-only Git commands against the current worktree. The runner records the test summary, exit code, timestamps, and source fingerprint in the ignored `.fast-lane-test-result.json`; no prompt or answer content is included. A local test-result answer is confirmed only while the fingerprint matches the prototype and test sources.

Try these local requests:

- `What Git branch am I on?`
- `Is my working tree clean?`
- `Does this branch have an upstream?`
- `How many local commits are ahead of upstream?`
- `Did the last test run pass?`

Each local result includes its state and evidence. Ahead-of-upstream uses local tracking refs only, checks the tracking-ref reflog for age, and warns that the remote was not contacted. A branch name alone never establishes that it is pushed. If trustworthy test evidence is absent or stale, the answer reports unknown or stale rather than claiming a pass.

For terminal fallback, submit `Explain what a Git rebase does in one sentence.` and then `Give one example.`; both Codex answers should stream in the same Vesper session. Exit, copy the printed session id, and run `npm run cli -- --resume SESSION_ID` to verify resumption. Local questions should remain local in both runs. The documented synthetic TTY smoke check exercises real PTY streams without starting Codex or contacting a model.

## Limitations

- Vesper is its own frontend. It does not attach to, import, or continue the original interactive Codex CLI conversation.
- When multiple Vesper sessions exist for one canonical workspace path, the extension restores the record with the latest `updatedAt`; it does not yet offer a session-history picker. The panel restores at most the latest 50 Codex turns; older turns are marked as omitted when the server provides a continuation cursor. Locally answered Git/test questions are not in Codex history and are not restored.
- Codex app-server is experimental in the inspected CLI version; protocol behavior can change. Recheck the installed generated schema before updating protocol methods.
- The live aggregate diff view uses cursor movement and erase sequences only when both streams are TTYs and `TERM` is usable. Its terminal cell-width calculation is an approximation for combining marks and emoji sequences, so unusual glyph widths may cause imperfect wrapping. The installed event schema has no sequence/version field; Vesper scopes events by process, thread and turn and applies same-turn snapshots in transport arrival order. A local PTY smoke check exercised synthetic events and redirected output; it did not validate authenticated model behavior, live app-server delivery, or real file operations.
- The app-server turn timeout is five minutes. Vesper asks the server to interrupt after timeout; if the server does not confirm a terminal event, the connection is closed and the request is reported as an error. Another fallback tries to resume the same saved thread; it never silently starts a replacement conversation.
- Local Git checks do not fetch or contact a remote. Their results are bounded by local repository evidence and its freshness.
- Upstream freshness uses the tracking ref's latest recorded reflog update (`%gD` with `--date=raw`), not the referenced commit's date. Missing or invalid reflog evidence leaves freshness unknown, even when the local ahead count is confirmed. An unchanged fetch need not add a reflog entry; a recent entry never confirms live remote state.
- Remove `experiments/fast-lane-app-server-poc/` to discard the prototype. Runtime use creates no project configuration, dependencies, or Git changes.
