# Developer task workflow

The repository inspector, System Model, execution providers, permissioned runtime, and both frontends use the shared task lifecycle. `task-workflow.js` owns evidence preflight and event-based status projection; terminal and VS Code retain their interface-specific state and presentation without creating a second orchestration engine. Standalone inspection and impact actions in both interfaces use the same bounded repository intelligence and System Model services.

## Lifecycle

1. **Understand.** Code-oriented tasks receive bounded, read-only repository investigation. Evidence is attached only when it is fresh (at most 15 minutes old) and matches the active project, provider, session, and provider conversation. The context added to a task is capped at 7,000 characters. On inspection failure or a scope mismatch, Vesper submits the original task without evidence. Cancellation during preflight prevents submission.
2. **Plan.** The frontend presents observed findings, the System Model's plan, unresolved assumptions, and manifest-derived verification suggestions. Suggestions are explicitly marked “not run.” Advisory capability planning can fail without changing the selected route.
3. **Implement.** Codex continues through its native app-server protocol and approval handling. OpenAI and NVIDIA continue through their existing structured-tool adapters. File proposals remain in memory until a one-time Vesper approval; the runtime revalidates the project, session, proposal, and file state before writing. Suggested shell commands are not exposed to model tool calls.
4. **Review.** The terminal retains Codex's native file activities and turn diff. For Vesper-managed writes, both interfaces re-read a bounded Git diff for the verified paths after the provider returns. For Codex changes, they do this only for paths whose file-change item completed and whose exact one-time approval was accepted. That workspace diff may include edits made before the task. The VS Code panel shows the same paths, workflow status, approvals, and verification state; provider-reported Codex diffs are labeled separately from Vesper-managed writes and working-tree read-back.
5. **Verify.** Terminal `:verify` and the VS Code panel refresh bounded package-manifest and System Model evidence separately from command execution. Suggestions are labeled not run. In VS Code, a developer can request one exact candidate; Vesper shows its argv and isolation policy, then requires one-time approval. Execution uses a temporary instance of the existing permissioned runtime, only when `VESPER_ENABLE_ISOLATED_COMMANDS=1`, the rootless Podman runtime and local image are validated, and the workspace is mounted read-only with network disabled. Provider tool calls never receive `run_command`. Shell syntax and unsupported tokens remain suggestions. Cancellation, error, exit status, and output are shown only from the actual runtime result.
6. **Report.** Vesper separates provider completion from task completion. An implementation request is `completed` only after a Vesper-managed file write is approved and read-back verified, or after an approved provider file-change item completes and a fresh working-tree diff confirms the path. A provider response without such evidence is `partial`. Failed or rejected verification, pending/rejected approval, unverified changed paths, and incomplete workflow events remain partial. Provider failure is `failed`; a confirmed interruption is `interrupted`; unknown remote outcome or timeout is `uncertain`; pre-submission cancellation is `cancelled`. Reports list changed paths, Vesper-verified writes, approved provider paths confirmed by working-tree read-back, the available diff, verification outcome, and suggestions that remain unrun.

Statuses describe evidence Vesper received. A Codex server diff is not proof of disk state. A successful working-tree diff read-back confirms that the approved path is present in the current Git diff; it can include earlier edits and does not prove tests pass. Verification is reported as passed only when the existing isolated runtime returns exit code 0 with no signal; failed, cancelled, rejected, unavailable, and not-run outcomes stay distinct. Vesper does not retry non-idempotent operations or silently resubmit a cancelled task.

## Terminal use

```text
:inspect [TASK]
:impact TASK
:verify
:verify N
```

`:verify` lists fresh test/build/check/lint scripts without running them. After reviewing the list, `:verify N` requests approval for one listed argv and does not retry it. Command execution is disabled by default. `VESPER_ENABLE_ISOLATED_COMMANDS=1` is only an opt-in; the supported host and local sandbox image must still pass the runtime's checks. Vesper does not pull or build an image.

## VS Code use

The panel's **Inspect repository** and **Change impact** actions run bounded read-only reports without submitting a coding task. **Capabilities** previews the discovered local catalog and reports discovery, installation, configuration, availability, runtime, and operation statuses separately; discovery alone does not establish that a capability is installed or usable. The Command Palette also provides **Vesper: Inspect Repository**, **Vesper: Assess Change Impact**, **Vesper: Switch Session**, and **Vesper: New Session with Provider**. The panel lists the selected project's recent sessions; the picker is scoped to that canonical project and shows provider, pinned model, status, and update time. Conversation history is read from the selected provider's existing storage and can page older entries when the provider supplies a continuation cursor. The panel keeps only bounded in-memory page state. Provider selection creates a new session, leaves the default provider unchanged, and pins the supplied API model ID to that session. Codex inherits its installed CLI configuration.

Provider status distinguishes Vesper support, configuration, authentication, session availability, and live task results. API-key presence is configuration only; this panel does not claim API authentication from a key. Codex sign-in is managed by Codex CLI and is not conflated with API-key authentication. A successful live task is reported as a live result, not as a permanent authentication guarantee.

For OpenAI/NVIDIA structured tool sessions, file proposals stay in memory and the panel can show the exact runtime preview and request one-time approval. The runtime checks request identity, project/session scope, freshness, and file state before applying it. Codex requests are displayed with a bounded review preview, but the panel intentionally has no Codex approval control and the existing adapter declines native requests; use the Vesper terminal for Codex's native approval flow. Verification commands are never automatic: refresh evidence, select one candidate, review the exact request, and approve it once. Stop cancels the active investigation or execution path when the runtime accepts cancellation.

## Reproducible scenario and tests

`test/task-workflow-scenario.test.js` creates an isolated two-package pricing/checkout repository with a related pricing and checkout test. It uses an in-memory OpenAI protocol mock, mocked read-only Git responses, and a deterministic `run_command` backend. The scenario traces `calculateTotal`, checks cross-package impact and test references, approves three file proposals, inspects the resulting bounded diff, and verifies the result through the permissioned runtime's one-time approval path. It does not contact a provider or start a real sandbox. `test/task-workflow.test.js` covers stale/mismatched evidence, completion without a verified write, failed verification, rejected approval, provider failure, interruption, timeout, cancellation, and state bounds.

Run the focused deterministic checks or the full suite from this folder:

```sh
node test/task-workflow.test.js
node test/task-workflow-scenario.test.js
npm test
```

## Current limitations

- Native Codex file changes stay under Codex's own approval path. Vesper reports server-reported diff and file activity, but cannot independently claim those writes were read-back verified.
- The VS Code panel intentionally declines native Codex approvals. It can approve Vesper-managed file changes once and can request one-time approval for a manually selected verification command. The latter remains unavailable unless host opt-in and supported sandbox prerequisites pass. No provider tool can execute commands.
- Host sandbox support is not assumed. No live Podman run, provider-backed run, or VS Code extension-host validation is implied by deterministic tests.
- Workspace `git diff` covers tracked changes and can include earlier edits; new untracked files may not appear in Git diff output.
- Verification commands containing shell composition, globbing, quoting, or other unsupported tokens remain suggestions for manual handling.
