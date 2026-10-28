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

Open the Command Palette and run **Vesper: Open Panel**. Record whether the panel opens, whether its project/session status is understandable, and any extension-host error. The manifest contributes no VS Code settings; the default provider is Codex. Confirm the panel shows status changes from running to completed or failed and that a failed provider request does not switch providers or submit twice.

For a provider-backed repository question, Vesper sends the task and bounded synthesized repository findings to the explicitly selected provider. Do not use private source. Simple exact local requests such as **What Git branch am I on?** use Vesper's local handler and do not start a provider.

## 4. Approval and task-state boundaries

The VS Code Codex client is read-only and declines native approval requests. It should not write project files. Verify the decline/error is visible and the project diff remains empty. Do not treat this as an approval prompt in the panel.

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

In a separate isolated run, explicitly select OpenAI or NVIDIA, provide a non-secret model label, and leave that provider's key unset. Submit only a harmless prompt in the disposable project. Expected behavior: a clear missing-configuration error, a failed task state, no provider switch, and no network request. Then use the exact local Git-status request to confirm the panel remains responsive.

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
| VSIX install and panel activation |  |  |
| Panel task-state updates |  |  |
| Read-only approval boundary |  |  |
| Terminal one-time approval |  |  |
| Missing-provider failure and recovery |  |  |
| Clean deactivation and restart |  |  |

Keep factual observations separate from tester opinions. Return a report only with explicit consent using `PREVIEW-FEEDBACK.md`. No feedback is collected automatically.
