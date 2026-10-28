# Install and configure Vesper

Vesper currently ships from this source checkout; no registry release is published by this repository. The CLI and VS Code extension share this package. The package has no npm runtime dependencies.

## Prerequisites

- Node.js 18 or newer and npm.
- Git for repository status, history, and diff evidence. Inspection still runs without Git, with reduced Git evidence.
- Codex CLI on `PATH` for the default Codex provider and Codex-backed tasks.
- VS Code 1.85 or newer for the extension. The package declares these minimum versions; the current release check has only been run on Linux x64 with Node.js 20, npm 10, Git 2.43, Codex CLI 0.162.1, and VS Code CLI 1.135. macOS, Windows, other Linux distributions, older versions, authenticated turns, and extension-host activation are unverified.

## Install from a checkout

From the Vesper repository root:

```sh
cd experiments/fast-lane-app-server-poc
npm install --global .
vesper --help
```

The package contains its CLI executable and VS Code extension entry point. Use `npm test` and `npm run release:check` from this source directory; tests and benchmark fixtures are deliberately excluded from the installed artifact.

For a source-only invocation without a global install:

```sh
npm run cli -- --help
npm run cli -- inspect "Trace main" --project /path/to/project
```

## First run

Run setup and diagnostics before opening a project:

```sh
vesper setup
vesper doctor --project /path/to/project
vesper inspect "Trace handleCheckout through the service layer" --project /path/to/project
```

In an interactive terminal, `vesper setup` lets you choose a provider to review. When stdin is not a terminal, it uses the current default and prints the same provider instructions. Select an alternate provider explicitly with `vesper setup --provider PROVIDER_ID`.

Setup is read-only. It validates local prerequisites and configuration shape, reports effective settings with secret values hidden, and explains how to set environment variables. It does not create a provider config file, change `VESPER_PROVIDER`, modify Codex configuration, change permissions, store credentials, or transmit repository contents. Exit codes are `0` when required checks pass, `1` when setup is unavailable, misconfigured, or a required check cannot be completed, and `2` for invalid command usage. If the installed CLI supports it, Vesper reads `codex login status` locally and reports only whether sign-in is detected; it does not print account details or validate provider connectivity.

`vesper doctor` reports `available`, `unavailable`, `misconfigured`, `not tested`, and `not applicable` states. It runs local version/help checks for Git, Codex, and VS Code where permitted, checks the selected project and Git metadata, and does not call provider APIs. A nonzero exit means a required runtime, project, provider configuration, or local Codex sign-in check failed or could not be completed. The sandbox and VS Code extension host are never launched by diagnostics.

## Providers

Codex app-server is the default provider. It uses the installed Codex CLI and its existing authentication; it does **not** require `OPENAI_API_KEY`. Check sign-in yourself with `codex login status`; if signed out, run `codex login`. Vesper does not display or copy Codex credentials.

OpenAI Chat Completions and NVIDIA NIM are optional. Both need a model identifier and a provider API key in the environment of the Vesper process:

| Provider | Key variables | Required model | Optional setting |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `OPENAI_API_KEY` or `VESPER_OPENAI_API_KEY` | `VESPER_OPENAI_MODEL` | `VESPER_OPENAI_BASE_URL` |
| NVIDIA NIM | `NVIDIA_API_KEY` or `VESPER_NVIDIA_API_KEY` | `VESPER_NVIDIA_MODEL` | `VESPER_NVIDIA_BASE_URL` |

`VESPER_PROVIDER` selects the default for new sessions. Use `vesper --provider openai-chat-completions --new PROJECT` or `vesper --provider nvidia-nim --new PROJECT` to choose for one new session. For example, to configure the OpenAI provider in the current shell (set the secret through your organization’s secret manager or secure environment injection):

```sh
export VESPER_PROVIDER=openai-chat-completions
export VESPER_OPENAI_MODEL=your-model-id
vesper setup --provider openai-chat-completions
vesper providers status --provider openai-chat-completions
```

Use `VESPER_NVIDIA_MODEL`, `VESPER_PROVIDER=nvidia-nim`, and the NVIDIA key variable for NVIDIA NIM. Vesper never prints key values. A locally present key is not proof that a provider accepted it. `vesper providers status` validates configuration without network access; append `--check` only when you explicitly want Vesper to send a bounded `GET /models` request to the selected API endpoint. That check tests reachability and API authorization, not model quality or task completion.

OpenAI and NVIDIA API requests are remote. Coding tasks send task text and bounded synthesized repository findings. With structured tool calling explicitly enabled for an exact model, the provider can also receive tool definitions and bounded results for individual permissioned project reads or file proposals. Vesper does not send a complete repository archive. Review provider retention and privacy settings before using remote APIs with private code.

## Local inspection, approvals, and permissions

`vesper inspect TASK --project PROJECT` uses a bounded read-only local runtime and does not start a provider by default. Optional model-assisted investigation planning is disabled unless `VESPER_SYSTEM_MODEL_ASSISTED=1` is set for an OpenAI/NVIDIA provider. `VESPER_LOCAL_ONLY=1` disables that optional planner call; it does not block coding tasks or change their provider. For deterministic local inspection, leave model-assisted planning disabled and use `vesper inspect`.

Investigation can be partial when a repository exceeds its read/search budgets or relevant files are ignored, generated, oversized, or unsupported. The symbol/reference index covers JavaScript and TypeScript only; other languages receive bounded import and text evidence. Dynamic dispatch, aliases, reflection, and framework conventions prevent authoritative call-graph or runtime-execution claims. Vesper does not run tests as part of inspection, and suggested verification commands remain unrun unless separately approved through the existing validated sandbox path.

Codex keeps native app-server approval semantics. The terminal requires an explicit one-time decision for supported approvals. The VS Code panel uses a read-only Codex policy and declines native approval requests. OpenAI/NVIDIA provider tools use Vesper’s permissioned project runtime; file changes are proposals and applying one requires fresh one-time approval in an interactive terminal. Providers cannot execute shell commands. Arbitrary shell execution is not enabled by setup or diagnostics.

Command execution is disabled by default. The optional sandbox backend only supports Linux rootless Podman with a locally available trusted image and verified controls. Vesper never pulls or builds the image and never falls back to host execution. `vesper doctor` reports sandbox validation as not tested or not applicable; `vesper tools status` inspects local prerequisites but does not run a project command. No sandbox execution has been validated by the current release check.

## VS Code extension

Package the extension from a source checkout. The packager is installed into a separate tooling prefix, not as a runtime dependency or into users' projects:

```sh
npm ci --prefix tooling/vsce --ignore-scripts --no-audit --no-fund
npm run package:vsix
```

The generated artifact is `.audit-artifacts/vesper-preview-VERSION.vsix`. `package:vsix` stages only runtime files and preview documentation, then inspects the VSIX archive and manifest. The pinned `@vscode/vsce` 3.6.0 toolchain is isolated under `tooling/vsce` and is excluded from user packages. Its packager requires Node.js 20 or newer.

For a clean installation, use dedicated extension and user-data directories so the normal VS Code profile is untouched:

```sh
code --install-extension .audit-artifacts/vesper-preview-VERSION.vsix \
  --user-data-dir /tmp/vesper-preview-code-data \
  --extensions-dir /tmp/vesper-preview-code-extensions
code --list-extensions --show-versions \
  --user-data-dir /tmp/vesper-preview-code-data \
  --extensions-dir /tmp/vesper-preview-code-extensions
```

Then open that profile with the disposable project and run **Vesper: Open Panel** from the Command Palette. The extension contributes no VS Code settings; Codex remains the default unless `VESPER_PROVIDER` selects another configured provider. Extension-host activation and authenticated tasks are reported separately from packaging and VSIX installation. The release check installs into temporary directories and skips graphical activation if it cannot launch a desktop host.

## Troubleshooting

- `vesper: command not found`: confirm the npm global bin directory is on `PATH`, or use `npm run cli -- ...` from this package directory.
- `Codex CLI was not found`: install Codex CLI, ensure `codex --version` works in the same shell, then run `vesper doctor`.
- Codex reports an authentication failure: check with `codex login status`; if needed, sign in with `codex login`. Vesper does not replace Codex authentication with an API key.
- OpenAI/NVIDIA reports a configuration error: run `vesper setup --provider PROVIDER_ID`, check that the model and key variable names in the table are available to the Vesper process, then rerun `vesper providers status --provider PROVIDER_ID`.
- API credentials are rejected: `vesper providers status --check` makes an explicit network request. Confirm account/API access and endpoint settings with the provider. Vesper withholds raw API error bodies.
- `vesper inspect` lacks Git evidence: confirm the project is a Git repository and that `git -C PROJECT status --short` works. Filesystem inspection can still run without `.git` metadata.
- VS Code command is missing: install VS Code and make `code --version` work, or use the terminal CLI.
- Diagnostics say `not tested`: that component could not be safely validated by the local check. Follow the printed remediation; do not treat it as available.

## Upgrade, reset, and uninstall

Upgrades replace the CLI/extension package only. Vesper does not keep provider settings in a Vesper config file: provider selection and OpenAI/NVIDIA values come from the process environment, and the Codex CLI manages its own config and authentication. Setup never overwrites either source.

The current npm slug `fast-lane-app-server-poc` and publisher `local-experiment` are development placeholders awaiting final identity approval; this repository has not published the npm package or Marketplace extension. If the approved identity changes, remove a local global CLI install with `npm uninstall --global fast-lane-app-server-poc`, then install the renamed package or checkout. The `vesper` command and `VESPER_HOME` data location remain unchanged. If the old local VSIX is installed, remove `local-experiment.fast-lane-app-server-poc` with `code --uninstall-extension local-experiment.fast-lane-app-server-poc` before installing the new VSIX. These steps do not remove sessions, Codex authentication, or project files.

By default, Vesper’s session metadata and provider conversation history live under `~/.vesper/sessions/`; set `VESPER_HOME` to use a different root. These files are outside project directories. Uninstalling the package leaves this state and all project data in place.

To uninstall a global install:

```sh
npm uninstall --global fast-lane-app-server-poc
```

To reset provider selection, remove `VESPER_PROVIDER` and the relevant OpenAI/NVIDIA variables from the shell or secret manager that supplies them. This does not remove Codex login or settings. There is no Vesper config file to delete. If you also intend to reset Vesper session/history data, first confirm the exact `VESPER_HOME` value and archive or move only its `sessions` directory. Do not remove a project directory to reset Vesper.

## Verification and bug reports

From this directory:

```sh
npm test
npm run evaluate:system-model
npm run release:check
```

`release:check` runs syntax checks, provider and approval regressions, the full suite, the offline System Model evaluation, npm package-content checks, clean npm installs, and packaged CLI inspection. When `VESPER_VSCE_BIN` is set, it also packages and inspects a VSIX and installs it into isolated VS Code directories. Graphical extension activation is a separate desktop check and is never inferred from installation.

For a reproducible bug report, include the exact command and arguments, relevant version output from `vesper doctor`, expected and observed results, and the smallest project that reproduces it. Redact keys, tokens, private paths, and private source before sharing logs.
