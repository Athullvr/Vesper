# Private preview validation checklist

This checklist is for a small, invite-only preview. The current package and Marketplace identities are placeholders and the repository has no approved license. The generated kit is a local candidate only; do not distribute it until the owner approves the package slug, display name, publisher ID, and license.

Vesper adds no telemetry or automatic repository collection. VS Code can make its own update and product-metadata requests. OpenAI/NVIDIA requests are remote; Codex tasks use the tester's existing Codex authentication. Use only a disposable project with content the tester is comfortable sharing with the selected provider.

## Record before testing

- Tester pseudonym (optional):
- Explicit consent to return a redacted report: yes / no
- OS and version:
- Node.js / npm / Git / Codex CLI / VS Code versions:
- Install mode: npm tarball / VSIX:
- Provider selected, if any:
- Start time and first successful task time, if the tester agrees to record it:

Mark each check `pass`, `fail`, or `not run`. Record observed behavior separately from impressions. Do not include credentials, request headers, private paths, or project contents.

## 1. CLI install and first run

Use the npm tarball in the preview kit and a dedicated global prefix if possible. From a shell with an isolated `VESPER_HOME`:

```sh
export VESPER_HOME="$(mktemp -d)"
npm install --global ./artifacts/fast-lane-app-server-poc-0.1.0.tgz
vesper --help
vesper setup
vesper doctor --project /path/to/disposable-project
```

Check that:

- Help describes the available commands.
- Setup explains required Codex CLI and its CLI-managed sign-in without asking for an API key.
- Setup and diagnostics redact secrets and do not make provider network requests.
- Missing optional OpenAI/NVIDIA configuration is called optional and has actionable remediation.
- Existing project contents, provider selection, and permissions are unchanged by setup.

## 2. Repository inspection

Follow the disposable project recipe in `PREVIEW-GUIDE.md`. Run:

```sh
vesper inspect "Trace greet in src/greeting.js" --project /path/to/disposable-project
```

Check whether the report cites the expected file and distinguishes observed evidence from inference. Confirm that it does not claim to have run tests or found a complete call graph. This CLI command is local by default.

## 3. Isolated VS Code install and activation

Use new user-data and extension directories, not the tester's normal profile:

```sh
mkdir -p /tmp/vesper-preview-code-data /tmp/vesper-preview-code-extensions
code --install-extension ./vesper-preview-0.1.0.vsix \
  --user-data-dir /tmp/vesper-preview-code-data \
  --extensions-dir /tmp/vesper-preview-code-extensions
code --list-extensions --show-versions \
  --user-data-dir /tmp/vesper-preview-code-data \
  --extensions-dir /tmp/vesper-preview-code-extensions
code --disable-telemetry --disable-updates --disable-experiments --new-window \
  --user-data-dir /tmp/vesper-preview-code-data \
  --extensions-dir /tmp/vesper-preview-code-extensions /path/to/disposable-project
```

Open the Command Palette and run **Vesper: Open Panel**. Record whether the panel opens, whether its project/session status is understandable, and any extension-host error. The manifest contributes no VS Code settings; the default provider is Codex. Try the panel's **Inspect repository** and **Change impact** actions with a known symbol. Check that evidence paths and coverage limitations are visible, no coding task is submitted, and no project files change. Try **Switch session** and confirm the picker lists only sessions for this workspace folder and displays provider, model, status, and update time. Confirm the panel lists recent sessions and reports provider support, configuration, authentication state, availability, live results, and model freshness as distinct observations. **New provider session** should require an explicitly selected, configured provider and pin the entered model ID to that new session; its selection must not change the workspace default. Also confirm that a failed provider request does not switch providers or submit twice.

For a provider-backed coding question, Vesper sends the task and bounded synthesized repository findings to the explicitly selected provider. Do not use private source. Direct repository inspection uses the read-only System Model path by default; simple exact local requests such as **What Git branch am I on?** use Vesper's local handler and do not start a provider.

## 4. Approval and task-state boundaries

The VS Code Codex client is read-only and declines native approval requests. Confirm that a bounded request preview is shown, no approval button appears, the decline is explained, and the project diff remains empty. Do not treat this as an approval prompt in the panel.

With a tool-calling OpenAI/NVIDIA model explicitly configured, confirm that a proposed file change appears as an exact one-time approval card. Reject one proposal and verify no write occurs; in a disposable fixture, approve a separate safe proposal and verify the runtime rechecks and reports the actual result. Confirm the approval cannot be reused after a project, session, proposal, or file-state change.

For verification visibility, confirm investigation requirements and manifest command candidates are labeled as suggestions and nothing runs during refresh. Without `VESPER_ENABLE_ISOLATED_COMMANDS=1`, no run-approval control should be offered. If the opt-in and sandbox prerequisites are deliberately enabled for the isolated disposable fixture, request one candidate, inspect the exact argv and read-only policy, then approve or reject it once. Confirm only an actually executed command displays output/exit status, and exercise cancellation and isolation failure without claiming a pass.

To test the existing one-time file-change approval, use the terminal CLI on the disposable project:

```sh
vesper --new /path/to/disposable-project
```

Ask for the reversible `farewell(name)` edit described in `PREVIEW-GUIDE.md`. Review the proposed file path. Reject once and confirm no file changed; retry in a new task, approve once, and review:

```sh
git status --short
git diff --check
git diff -- src/greeting.js
```

The expected completion report must distinguish provider completion from tests or verification that were not run. Do not approve unrelated paths or commands.

## 5. Missing-provider error and recovery

In a separate isolated run, set `VESPER_PROVIDER` to OpenAI or NVIDIA in the VS Code process environment, provide a non-secret model label, and leave that provider's key unset. Reload the isolated VS Code window and submit only a harmless prompt. Expected behavior: a clear missing-configuration error, a failed task state, no provider switch, and no network request. Then use the exact local Git-status request to confirm the panel remains responsive. The explicit provider picker is expected to refuse creating an API-provider session while its required key or model configuration is missing.

Do not test rejected credentials by entering an invalid key. Mock tests cover rejected HTTP responses. An authenticated provider request is optional, may cost money, and must follow `PROVIDER-LIVE-VALIDATION.md`.

## 6. Shared state, shutdown, and recovery

- When comparing terminal and VS Code state, set both processes to the same new `VESPER_HOME`; do not run simultaneous turns in one session.
- Close the panel and exit VS Code normally. Restart with the isolated profile and project; check that saved session metadata remains readable and that no stale running state or duplicate request appears.
- After the missing-provider failure, verify the local status request still works. If a configured provider is then used, verify recovery is explicit and does not silently select another provider.
- Record any unexpected remaining process or error before cleanup. Remove only the disposable project/profile and the named preview directories.

## 7. Result summary

| Check | Result | Observed evidence / reproduction |
| --- | --- | --- |
| Install and first run |  |  |
| Local repository inspection |  |  |
| VS Code impact report and evidence limits |  |  |
| VSIX install and panel activation |  |  |
| Panel task-state updates |  |  |
| Project-scoped session switching |  |  |
| Explicit provider/model session selection |  |  |
| Codex decline-only approval boundary |  |  |
| Vesper-managed VS Code file approval |  |  |
| VS Code verification approval and output |  |  |
| Terminal one-time approval |  |  |
| Missing-provider failure and recovery |  |  |
| Clean deactivation and restart |  |  |

Keep factual observations separate from tester opinions. Return a report only with explicit consent using `PREVIEW-FEEDBACK.md`. No feedback is collected automatically.
