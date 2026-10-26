# Vesper

Vesper is a local-first coding-agent interface with a terminal CLI and a VS Code panel. The runnable implementation is in [`experiments/fast-lane-app-server-poc`](experiments/fast-lane-app-server-poc/).

> **Project status:** Vesper is an active prototype. Deterministic repository inspection and the offline System Model evaluation are covered by automated tests. Authenticated model turns, real file-change approval flows, the VS Code Extension Development Host, and the optional Podman sandbox have not been validated end to end. Focused test success is not a production-readiness claim.

## What Vesper does

- Inspects a selected repository with bounded, read-only filesystem and Git evidence.
- Routes a limited set of explicit Git and test-result questions to deterministic local handlers.
- Uses the installed Codex CLI app-server by default for coding tasks. OpenAI Chat Completions and NVIDIA NIM are optional API providers.
- Offers the same project and session lifecycle from the terminal and VS Code.
- Preserves provider-specific approvals. Codex keeps its native app-server approval flow. Vesper-managed file proposals require a fresh one-time approval. Provider tools cannot run shell commands.

Vesper does not automatically run project tests, claim a complete call graph, execute generated code, or treat a proposed diff as proof of a disk write. It is not a hosted service or a replacement for Git, test, or security review.

## Quick start

Requirements: Node.js 18 or newer and Git. Codex CLI is required for Codex-backed tasks. See [installation and configuration](experiments/fast-lane-app-server-poc/INSTALL.md) for provider setup and environment limits.

From a Vesper checkout:

```sh
cd experiments/fast-lane-app-server-poc
npm install --global .
vesper setup
vesper doctor --project /path/to/project
vesper inspect "Trace handleCheckout through the service layer" --project /path/to/project
```

Start a coding session and enter a task in the workspace:

```sh
vesper --new /path/to/project
```

For example, enter `Add tax validation to handleCheckout`. Vesper runs a bounded local preflight, then sends the task through the configured provider. Codex is the default and uses Codex CLI authentication; it does not require an API key. Run `vesper --help` for commands and [`INSTALL.md`](experiments/fast-lane-app-server-poc/INSTALL.md) for optional OpenAI and NVIDIA setup.

## Safety and privacy

`vesper inspect` is local and read-only by default. `VESPER_LOCAL_ONLY=1` disables optional model-assisted investigation planning; it does not prevent a coding task from being sent to its selected provider. OpenAI and NVIDIA tasks send task text and bounded synthesized repository findings; structured tool calls can send bounded tool definitions and results. Review provider data handling before using remote APIs with private repositories. No network check is performed by `setup` or `doctor`.

The terminal asks before accepting supported approval requests. The VS Code extension keeps a read-only Codex policy and declines native approval requests. Command execution is disabled by default. The optional Podman backend is Linux-only, requires local validation, and is not validated in the current release-check environment.

## Developer checks

Run from `experiments/fast-lane-app-server-poc`:

```sh
npm test
npm run evaluate:system-model
npm run release:check
```

The release check tests the npm artifact from a clean temporary prefix and runs repository inspection from that installation. It reports VSIX packaging or graphical extension activation as skipped when the required tools or host are unavailable. See [developer task workflow](experiments/fast-lane-app-server-poc/DEVELOPER-WORKFLOW.md) and [reliability audit](experiments/fast-lane-app-server-poc/RELIABILITY-AUDIT.md) for behavior and validation limits.

When reporting a bug, include the command and arguments, Node/Git/Codex/VS Code versions from `vesper doctor`, expected and observed results, and a minimal reproducible project. Remove credentials, tokens, private source, and private repository paths from logs before sharing them.
