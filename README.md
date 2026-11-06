# Vesper

Vesper is a local-first, terminal-first AI coding workspace for understanding unfamiliar repositories and carrying evidence-backed changes through review. It combines Codex as the default coding agent with optional OpenAI and NVIDIA NIM providers, bounded repository intelligence, approval-controlled tools, and a VS Code panel over the same task and session services.

> **Project status:** The main implementation is ready for a dedicated testing, hardening, and release-validation phase. Authenticated provider turns, VS Code Extension Development Host activation, real file-write approvals, and the optional Podman sandbox have not been verified end to end. Vesper is not published. The package slug, Marketplace publisher, and software license remain owner decisions.

## What Vesper adds

Vesper keeps deterministic repository inspection and task evidence alongside the selected coding provider. Reports cite bounded source and Git observations, distinguish parsed relationships from literal matches and hypotheses, and surface what could not be established. The provider still does the coding work through its supported execution path; Vesper controls which project tools are available, preserves approval boundaries, and reports what the runtime actually confirmed.

The workflow is:

**Understand → Investigate → Plan → Implement → Review → Verify → Report**

Vesper does not claim a complete call graph or test coverage from heuristic indexing, execute generated code, run suggested commands automatically, or treat a provider response as proof that files changed. It is not a hosted service and does not require a cloud account.

## Install and start

Requirements: Node.js 18 or newer and Git. Codex CLI is required for Codex-backed tasks. From a Vesper checkout:

```sh
cd experiments/fast-lane-app-server-poc
npm install --global .
vesper setup
vesper doctor --project /path/to/project
```

Inspect the repository locally, then start a coding session:

```sh
vesper inspect "Trace handleCheckout through the service layer" --project /path/to/project
vesper impact "Rename handleCheckout and assess related code and tests" --project /path/to/project
vesper --new /path/to/project
```

Codex is the default provider and uses its own CLI authentication; it does not need an API key. See [installation and configuration](experiments/fast-lane-app-server-poc/INSTALL.md) for OpenAI/NVIDIA setup, diagnostics, local-only behavior, permissions, and privacy details.

## VS Code

Install a locally packaged VSIX from the application directory with `npm run package:vsix`. In the Command Palette, Vesper provides:

- **Open Panel** for project questions and coding tasks.
- **Inspect Repository** and **Assess Change Impact** for direct, bounded, read-only System Model reports. The CLI offers the same workflows with `vesper inspect` and `vesper impact`.
- **Switch Session** to select a saved session scoped to the current workspace folder.
- **New Session with Provider** to choose Codex, configured OpenAI, or configured NVIDIA NIM and pin a remote model ID to that new session.

The panel also has **Inspect repository**, **Change impact**, and **Capabilities** actions. The Capabilities action previews the local capability catalog; it does not create an implementation plan or activate an integration. The extension keeps Codex in read-only mode and declines native approval requests. Use the terminal for approval-controlled file changes and supported verification.

## Providers and capabilities

Codex remains the default. OpenAI Chat Completions uses `OPENAI_API_KEY` (or `VESPER_OPENAI_API_KEY`) and `VESPER_OPENAI_MODEL`. NVIDIA NIM uses `NVIDIA_API_KEY` (or `VESPER_NVIDIA_API_KEY`) and `VESPER_NVIDIA_MODEL`. `VESPER_PROVIDER` selects the default for new sessions; CLI flags and the VS Code new-session picker can choose a provider for one session. Provider status and model labels are configuration observations, not proof of successful authentication or model support.

Vesper discovers MCP servers, skills, and plugins using existing local/Codex sources. Run `vesper capabilities`, `vesper capabilities status`, `vesper skills`, `vesper mcp`, or `vesper plugins` to inspect them. Management actions are explicit and limited to supported documented operations; discovery does not prove that an integration is loaded or operational.

## Privacy and approvals

Repository inspection is local and read-only by default. Optional model-assisted investigation is disabled unless `VESPER_SYSTEM_MODEL_ASSISTED=1` is set for a supported OpenAI/NVIDIA provider. `VESPER_LOCAL_ONLY=1` disables those planner requests; it does not prevent a coding task from going to its selected provider. Remote coding tasks send task text and bounded synthesized repository findings. Review provider data handling before sending private source.

Codex keeps its native app-server approval semantics. Vesper-managed file proposals require fresh one-time approval in the interactive terminal. Provider tool calls cannot run shell commands. Command execution is disabled by default and, when explicitly enabled, is restricted to the existing Linux rootless Podman path. No hosted backend or telemetry is required by Vesper.

## Current limits and troubleshooting

Inspection is bounded and language coverage is partial. JavaScript and TypeScript get a symbol/reference index; other languages receive more limited import and text evidence. Dynamic dispatch, aliases, reflection, and framework conventions can hide relationships. Git observations use local metadata only; they do not contact a remote. Verification suggestions remain unrun until separately approved through the supported execution workflow.

For setup issues, run `vesper doctor --project PATH` and `vesper providers status`. Codex sign-in is managed by Codex (`codex login status`, `codex login`). API keys belong in a secret manager or process environment, never command arguments, source files, or shared logs. See [troubleshooting](experiments/fast-lane-app-server-poc/INSTALL.md#troubleshooting).

## Developer setup

The runnable package and VS Code extension remain under [`experiments/fast-lane-app-server-poc`](experiments/fast-lane-app-server-poc/); the existing package name is unchanged. From that directory, `npm test`, `npm run evaluate:system-model`, and `npm run release:check` are the project checks for the later validation phase. They have not been run as part of this build sprint. The release check does not verify authenticated providers, VS Code activation, real approval flows, cross-platform behavior, or the optional sandbox.

Read the [developer workflow](experiments/fast-lane-app-server-poc/DEVELOPER-WORKFLOW.md), [preview guide](experiments/fast-lane-app-server-poc/PREVIEW-GUIDE.md), [manual validation checklist](experiments/fast-lane-app-server-poc/PREVIEW-VALIDATION-CHECKLIST.md), and [owner release decisions](experiments/fast-lane-app-server-poc/PREVIEW-RELEASE-DECISIONS.md) before distribution. Vesper has no license decision yet; do not publish or redistribute until the owner resolves it.
