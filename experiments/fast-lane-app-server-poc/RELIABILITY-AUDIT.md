# Vesper reliability audit — 2026-10-19

Vesper remains the existing Node.js terminal and VS Code prototype. This audit fixes local tracking-ref freshness and terminal app-server lifecycle failures, extends deterministic coverage, and records the interface gaps in [INTERFACE-ROADMAP.md](INTERFACE-ROADMAP.md). No dependencies, model, database, framework, local command executor, or session schema were added.

**Starting state and scope**

- Repository: `Vesper`; implementation: `experiments/fast-lane-app-server-poc/`.
- Initial branch: `main`, tracking `origin/main`, clean working tree at `e8901e8`.
- Node: `v20.18.0`; Git: `2.43.0`; Codex: `codex-cli 0.162.1`.
- No repository `AGENTS.md`, `CLAUDE.md`, or CI workflow was found. `package.json` has `test` and `cli` scripts; the local routing benchmark is a separate Node script.
- Baseline: **60 tests passed, 0 failed, 0 cancelled, 0 skipped**.
- During the audit, HEAD advanced to `96c7711` and then `5ee7299`, containing earlier portions of these edits. The audit did not run Git commit, reset, checkout, rebase, or push against the user repository. Those commits and subsequent edits were preserved. Review the work relative to `e8901e8`, not only the final working-tree diff.
- Temporary repositories, test logs, generated schemas and the isolated smoke-test home are under ignored `.audit-artifacts/`. Existing Vesper sessions, Codex credentials and user configuration were not read, copied, reset, or deleted.

**Execution flow**

`bin/vesper.js` invokes `runVesper()` in `cli.js`. The CLI parses new/resume arguments, canonicalizes the project directory, creates or loads private metadata through `SessionStore`, constructs the app-server client lazily, and starts `TerminalFrontend`. The session UUID and Codex thread ID remain separate. Metadata contains only schema version, session ID, project directory, thread ID, and creation/update timestamps.

`routing-core.js` classifies constrained exact phrases and anchored grammatical variants into five intents: branch, working-tree status, upstream configuration, local ahead count, and recorded prototype test result. `local-handlers.js` uses fixed Git argument arrays or source-fingerprinted test evidence. No user shell text is executed. A local handler's missing, malformed or failed result becomes an explicit unknown/unavailable answer without automatically escalating.

Unsupported or ambiguous requests call `AppServerClient.runTurn()`. The terminal client initializes JSON-RPC over stdio, starts or resumes a thread in the correct project, persists its ID, sends text input to `turn/start`, streams agent deltas, mediates approvals and waits for a terminal state. It inherits installed Codex configuration and authentication; production calls introduce no sandbox or approval-policy override.

The VS Code extension shares the router, local handlers, persistent `SessionStore`, and tested `AppServerClient`. It uses the client's optional read-only sandbox override for thread creation and resume and declines every approval request. Its panel bridge remains VS Code-specific; the runtime/session architecture is shared with the terminal.

**Verified bugs and corrections**

1. **Commit dates were reported as tracking-ref update dates.** `git reflog show -1 --format=%ct @{upstream}` prints the referenced commit's committer epoch. The replacement is `git reflog show -1 --format=%gD --date=raw @{upstream}`. `%gD` selects the reflog designator and explicit `--date=raw` makes its suffix `@{<entry epoch> <timezone>}`. Only a well-formed ref selector and safe, plausible epoch are accepted.
2. **Disconnected processes could affect a recovered turn.** Old stdout listeners remained active after reconnect. Data is now accepted only from the current child and connection generation. Late old-process output, completion and close events cannot settle or stream into the new turn.
3. **Stale turn-start events could overwrite the active turn ID.** All supported notifications now check turn identity before updating state or forwarding activity, not only deltas and completion.
4. **An outstanding approval response could reach the replacement process.** Approval responses, denials and errors are now tied to the originating child. They cannot cross a reconnect. The existing check against approvals for a finished or different turn remains.
5. **Early failure notifications could cause an unhandled rejection.** A turn can fail before the `turn/start` RPC responds. Its completion rejection is now observed immediately, while the original promise still carries the failure to the caller. A delayed-acknowledgement test reproduced the prior unhandled rejection.
6. **Uncertain starts and unsupported server requests left the transport running after reporting failure.** A failed/timed-out start RPC or unsupported active server request now closes that connection and rejects pending work before another fallback. This avoids treating a potentially running operation as safely finished. Thread metadata remains available for explicit retry/resume.

Two small additive changes support the interface foundation: supported tool/diff/plan/error progress events now retain their `params` instead of discarding the payload, and approval prompts print the user's choice explicitly. A choice is not a claim that the requested operation succeeded; terminal turn status continues to come from the app-server. Timeout wording now accurately explains that the next request attempts to resume the saved thread.

**Why the Git evidence is appropriate**

The installed `git-reflog(1)` states that reflogs record when reference tips were updated and that `reflog show` uses `log -g`. `git-log(1)` documents `%ct` as the committer timestamp, `%gD` as the reflog selector, and the explicit `--date` rule for timestamp selectors. The local manuals were inspected; no documentation fetch was needed.

Disposable real Git repositories independently set commit dates and `update-ref` reflog dates. A commit from 2001 with a ref update on 2026-10-18 is recent at a fixed 2026-10-19 observation time. A commit dated 2026-10-19 with a ref update on 2026-10-01 is stale. The tests also assert that the old `%ct` command actually returns the commit date, establishing that the fixture detects the original bug.

Git is asked for the relevant upstream reflog instead of reading `.git/logs` directly, which avoids assuming a worktree layout or ref-storage backend. `FETCH_HEAD` and file modification times are unsuitable substitutes: they can describe another ref, maintenance, or an unchanged fetch.

The seven-day threshold and existing one-hour future-clock tolerance are retained. Empty/missing/unavailable reflogs, invalid or unsafe epochs, and implausibly future values yield `freshness.state: "unknown"` with no `lastUpdatedAt`. Missing upstreams and detached HEAD retain their prior unavailable/unknown behavior. A valid local ahead count can still have `status: "confirmed"` while **its freshness remains unknown**; the summary explicitly states that distinction.

A reflog entry dates a recorded local ref update, not necessarily a fetch. The summary therefore says “local upstream reference” instead of “last fetched upstream reference.” An unchanged fetch may produce no new reflog entry, and reflogs can expire. Neither recent nor stale tracking data proves the live remote's state. Every successful local ahead answer retains the remote-not-contacted caveat. No fetch, push, or remote lookup is used.

**Routing decisions**

| Request | Decision | Reason |
| --- | --- | --- |
| What is the current Git branch? | Local, `current_git_branch` | Direct current checkout evidence |
| Show working-tree status. | Local, `working_tree_status` | Fixed porcelain Git query |
| What upstream does this branch track? | Local, `branch_upstream` | Local configuration, no remote claim |
| How many commits am I ahead of upstream? | Local, `ahead_of_upstream` | Local ref count with explicit age and remote qualification |
| Has this branch been pushed? | Codex, `local_ambiguous` | Cached refs cannot establish the requested live state |
| `grep -nE 'freshness\|stale\|reflog\|upstream\|aheadCount' test tests 2>/dev/null` | Codex, `local_ambiguous` | Unsupported shell request; Git terms trigger the conservative topic guard |
| Inspect the repository and explain its architecture. | Codex, `codex_fallback` | Requires analysis outside the five deterministic intents |
| Review the code and analyze potential bugs. | Codex, `codex_fallback` | Requires code analysis |

The reported classifications match the current policy. `local_ambiguous` is a fallback reason, not an instruction to execute locally. No classifier rules or local command allowlist were expanded. Failed local handlers remain explicit local failures; Codex responses never receive a confirmed-local label.

**Integration matrix**

All rows have deterministic coverage. “Mock protocol” means no model or real approved operation was executed.

| # | Behavior | Coverage and result |
| --- | --- | --- |
| 1 | Current branch, no turn | Real Git + `runVesper`: confirmed branch, zero process spawns, saved thread remains null |
| 2 | Working-tree status, no turn | Real Git with an untracked file + CLI: local counts, zero spawns |
| 3 | Upstream configuration | Real local upstream and absent upstream; detached HEAD yields unknown |
| 4 | Ahead count and freshness | Real zero/one counts; independent commit/ref timestamps, recent/stale/unknown cases |
| 5 | Pushed state | Router fallback test, no local result; remote approval refusal is covered by mock decisions, not a live remote check |
| 6 | Repository inspection | Router fallback only, no local handler invocation |
| 7 | Code review/bug analysis | Router fallback only, no local handler invocation |
| 8 | Insufficient evidence | Missing test record, malformed Git evidence and detached checkout return unknown/unavailable without a fabricated value |
| 9 | Approval accepted | Terminal + real client + mock server: command/file/permission decisions; simulated operation runs only on accept; returned server outcome governs completion |
| 10 | Approval declined/cancelled | Same integration: no simulated operation on refusal; explicit choice and refusal output; command/file cancellation ends interrupted; permission refusal returns an empty turn-scoped grant |
| 11 | Failed/interrupted turn | Failed terminal events, partial text, early failure before start reply, acknowledged timeout and unconfirmed timeout never produce a completed answer |
| 12 | Disconnect/recovery | Client reconnects/resumes same thread; stale old-process events and approvals ignored; terminal loop accepts another prompt after recoverable errors |
| 13 | Session resume | CLI preserves UUID, saved thread and canonical cwd; wrong selected directory, wrong returned thread/cwd or failed resume cannot silently create a replacement |
| 14 | Local handler failure | Router and terminal show unavailable, do not leak raw failure details, and do not create a Codex turn |

Tests live in the existing `test/*.test.js` files. The new Git fixtures create local refs and configuration without creating or contacting a remote. No new test file or fixture dependency was required.

**Commands and results**

Commands below ran from `experiments/fast-lane-app-server-poc/` unless specified. Test temporary directories were confined using `TMPDIR="$PWD/.audit-artifacts"`; npm cache was confined there as well.

| Executed command/check | Actual result |
| --- | --- |
| `git status --short --branch`, `git branch --show-current`, `git log`, `git ls-files`, targeted `find`, `sed`, `grep`, `cat` | Repository, documentation, tests, current changes and execution flow inspected. `rg` was unavailable; `find`/`grep` used instead. |
| `node --version`, `git --version`, `codex --version` | Versions above |
| Baseline `npm test` | 60 passed, 0 failed, 0 skipped/cancelled |
| Freshness regressions before fix: `node --test test/local-handlers.test.js test/git-integration.test.js` | 23 tests: 18 passed, 5 failed |
| Same focused freshness tests after fix | 23 passed, 0 failed |
| Transport regressions before fix: `node --test test/app-server-client.test.js` | 13 tests: 10 passed, 3 failed |
| Expanded suite after transport/approval matrix changes: `unshare --user --map-root-user --net npm test` | 82 passed, 0 failed |
| Early failure/uncertain-start regressions before fix: `node --test test/app-server-client.test.js` | 27 tests including approval subtests: 24 passed, 3 failed; early failure reproduced `unhandledRejection` |
| Final `unshare --user --map-root-user --net npm test` | **85 passed, 0 failed, 0 cancelled, 0 skipped** |
| `unshare --user --map-root-user --net node benchmark/run-local.js 1` | 25/25 route decisions correct; 15/15 local answers correct; 10 mock fallbacks; 0 false local routes; 0 live Codex turns |
| `codex app-server --help`, `codex app-server generate-json-schema --help` | Local command syntax inspected |
| `unshare --user --map-root-user --net codex app-server generate-json-schema --out ...` (with and without `--experimental`) | Both schema bundles generated locally with isolated `CODEX_HOME`; 105/170 client methods, 10/11 server requests, 84 notifications |
| `git reflog show -1 --format='%ct %gD' --date=raw '@{upstream}'` | Different commit and reflog entry epochs observed in this repository |
| Installed `git-log(1)` / `git-reflog(1)` via `zcat` and targeted `grep` | Documented timestamp semantics verified |
| `node .audit-artifacts/offline-smoke.cjs` | Real offline initialize/start/turn-start/event stream/interrupt/resume, details below |
| `git diff --check` | No whitespace errors |

Initial schema generation emitted a warning because the isolated Codex home was beneath `TMPDIR`; schemas were still generated. The smoke test uses sibling home/tmp directories and succeeded without relying on those aliases. The baseline npm command printed its update notice; subsequent npm runs explicitly disable that notifier and run without network access. No package installation or update was run.

**Actual runtime verification and limits**

The real smoke script launches the installed binary through `bwrap` with an isolated network namespace, a read-only host filesystem, and only `.audit-artifacts/` writable. It uses an empty isolated `CODEX_HOME`, a repository-local temp directory and an explicit read-only sandbox. It neither reads/copies the user's Codex credentials nor mutates their configuration or sessions.

Observed: `initialize` succeeded; `thread/start` succeeded; `turn/start` produced a real `turn/started` notification and item activity; a three-second test deadline requested `turn/interrupt`; the server confirmed termination and the client returned `status: "timeout"`; a new process successfully resumed the same thread ID and verified the same project directory.

No agent text deltas or successful model answer were observed. This proves local protocol startup, notification delivery, interruption and persistent resumption in this environment, not authenticated model execution. A successful network-backed turn and live command/file approval flow remain unverified because external access was not approved and the isolated home has no credentials. No live remote was contacted, and the direct network-backed `benchmark/run-codex.js` was not run. The VS Code graphical Extension Development Host was not launched; its existing automated routing tests passed.

**Files changed**

- `local-handlers.js`: reflog evidence, qualified local-ref wording and evidence description.
- `app-server-client.js`: connection/turn isolation, approval reply ownership, early rejection handling, uncertain-operation shutdown, retained progress payloads and recovery wording.
- `terminal-frontend.js`: explicit approval-choice feedback.
- Existing tests in `test/local-handlers.test.js`, `test/git-integration.test.js`, `test/app-server-client.test.js`, `test/routing-core.test.js`, `test/terminal-frontend.test.js`, `test/cli.test.js`: regressions and the integration matrix.
- `.gitignore`: repository-local audit scratch directory.
- `README.md`, this report and `INTERFACE-ROADMAP.md`: behavior, verified protocol coverage, remaining risks and incremental roadmap.

`session-store.js`, public result schemas, production configuration/authentication behavior, routing policy, package scripts and security defaults remain compatible. The test runner refreshed its existing ignored source-fingerprinted test record, as it normally does.

## Milestone update: safe command activity visibility — 2026-10-19

**Starting baseline and result.** Before edits, `npm test` passed **102 tests, 0 failed, 0 cancelled, 0 skipped**. The first sandboxed invocation could not spawn the test runner (`EPERM`); the authorized run outside the sandbox established the baseline. After this milestone, `npm test` passed **114 tests, 0 failed, 0 cancelled, 0 skipped**. The final `git diff --check` passed after the documentation update.

**Installed protocol evidence.** The installed `codex-cli 0.162.1` JSON schema bundle generated locally on 2026-10-19 was inspected before implementation:

- `item/started` requires `threadId`, `turnId`, `item`, and `startedAtMs`. `item/completed` has the same identity/item fields and `completedAtMs`.
- A `commandExecution` item requires `id`, `type`, `command`, `cwd`, and `status`. Its status enum is `inProgress`, `completed`, `failed`, or `declined`. `exitCode` and `aggregatedOutput` are nullable and may be absent.
- `item/commandExecution/outputDelta` requires `threadId`, `turnId`, `itemId`, and `delta`.
- `turn/started` and `turn/completed` carry `threadId` and a `turn` with `id` and `status`. Turn statuses include `completed`, `interrupted`, `failed`, and `inProgress`.
- The command approval server request requires `threadId`, `turnId`, `itemId`, and `startedAtMs`; its command and cwd may be null. The response carries a decision. There is no later approval-accepted acknowledgement in these schemas: Vesper can report the user's decision sent to the server, while execution status still comes from the command item.
- `error` carries turn identity, an error and `willRetry`; it may describe a retry and is not evidence that a particular command failed.

The command status enum has no `interrupted` value. Vesper shows an interrupted turn separately and leaves an in-progress command's execution result unresolved. A missing exit code is shown as unavailable; it does not become success. A disconnected process does not complete or fail a command item.

**Implementation.** `command-activity.js` is a bounded in-memory reducer keyed by thread, turn, and item. It accepts only command execution item and output events, limits command text to 4,096 characters, cwd to 2,048, output payload to 16,384, approval callbacks to 8 per item, and retained command items to 50 per turn. Terminal control sequences and Unicode format controls are escaped; common credential forms are redacted in command arguments and output. Output deltas are buffered until item/turn completion so redaction can span delta boundaries. If an item is still in progress when its turn ends, the terminal labels any output partial and leaves the execution result unresolved.

`AppServerClient` now binds activity to the `turn/start` response ID. Pre-ack notifications are retained only in bounded buffers and filtered against that authoritative identity; late notifications from a replaced process remain rejected by the existing process-generation guard. Command approval requests wait for the confirmed turn and require an item ID before prompting. The one-time approval choices and backend execution settings are unchanged. The terminal does not execute commands. No route, local command allowlist, session metadata, file-approval store, Codex configuration, or permission setting changed.

**Tests.** Added eight reducer tests in `test/command-activity.test.js` for normal start/output/completion, failure, interruption, missing exit code, out-of-order/duplicate lifecycle events, identity isolation, malformed payloads, truncation, control escaping/redaction, approval/execution separation, and the retained-item cap. Added client tests for stale pre-ack turn events, command approval identity, and late events after process replacement. Added terminal/client mock integration tests for rendered command output and the distinction between an accepted approval decision and an observed execution result.

**Limitations and validation scope.** The full test suite uses mock app-server notifications for command lifecycle and approval behavior. The installed schema is live local protocol evidence; this milestone did not run a real Codex command, a network-backed model turn, or authenticated model behavior. Credential masking is heuristic and cannot identify every secret. The protocol gives output deltas no sequence/event ID, so exact duplicate delta chunks cannot always be distinguished from legitimate repeated output when a final `aggregatedOutput` is absent; lifecycle notifications are idempotent, and a final aggregate replaces buffered deltas when supplied. Command output is shown at item/turn end rather than streamed live.

**Changed files.** `command-activity.js` adds the reducer and safe renderer. `app-server-client.js` adds authoritative turn binding and command approval progress. `terminal-frontend.js` renders command states and redacts common secrets in command approval details. `test/command-activity.test.js`, `test/app-server-client.test.js`, and `test/terminal-frontend.test.js` add coverage. `README.md` and `INTERFACE-ROADMAP.md` describe the behavior, limits and next work.

**Next smallest milestone.** Render bounded file-change summaries outside approval prompts using the existing per-turn evidence cache, while preserving its fail-closed behavior for missing or stale diffs.

## Milestone update: safe file-change summaries — 2026-10-19

**Starting baseline and result.** Before edits, `npm test` passed **114 tests, 0 failed, 0 cancelled, 0 skipped**. The sandboxed test runner could not spawn Node (`EPERM`); the authorized run outside the sandbox established the baseline. After this milestone, `npm test` passed **127 tests, 0 failed, 0 cancelled, 0 skipped**. `git diff --check` passed.

**Installed protocol evidence.** The locally generated schema bundle for installed `codex-cli 0.162.1` was inspected before implementation:

- `item/started` requires `threadId`, `turnId`, `item`, and `startedAtMs`. `item/completed` requires `threadId`, `turnId`, `item`, and `completedAtMs`.
- A `fileChange` item requires `id`, `type`, `status`, and `changes`. Its status enum is `inProgress`, `completed`, `failed`, or `declined`. Each `FileUpdateChange` requires `path`, `kind`, and `diff`. Change kinds are `add`, `delete`, and `update`; `update` may include `move_path`.
- `item/fileChange/patchUpdated` requires `threadId`, `turnId`, `itemId`, and `changes`, making it suitable for exact item association.
- `turn/diff/updated` requires `threadId`, `turnId`, and `diff`, but has no item ID. This milestone does not use that turn-scoped event to infer per-item summaries.
- `item/fileChange/outputDelta` has exact identity fields and `delta`, but its schema describes it as deprecated and says the server no longer emits it. It is not used as summary evidence.

**Evidence lifecycle and implementation.** `FileChangeApprovalStore` remains the sole source of file-change evidence. Its immutable snapshots continue to gate approval exactly as before; an additive projection reports only paths, change kinds, and line counts parsed from unified diff hunks. No diff body is sent to the summary renderer. Each update is keyed by the store's thread/turn/item IDs. Replaced evidence reports a new summary, malformed evidence reports invalidated without old paths, item completion reports completed without paths, and turn/process closure invalidates active snapshots before clearing them. Pre-ack evidence is included only if its turn ID matches the authoritative `turn/start` response. Existing process-generation and thread checks continue to reject late or unrelated notifications.

The terminal escapes controls, heuristically redacts path secrets, caps visible paths at 1,024 characters, shows at most eight paths per item and 50 items per turn, and caps all file-summary text at 12,000 characters per turn. Added/removed counts appear only when a unified diff hunk is present; binary or otherwise non-hunk diffs have unavailable counts. Output is labeled as proposed evidence and explicitly says it does not verify a disk write. Approval choices and execution outcomes remain separate.

**Tests.** Added cache and renderer coverage for matching immutable summaries, counts, malformed/missing/oversized snapshots, duplicate paths, multiple items, update/invalidation, identity isolation, duplicate notifications, item completion, turn closure, approval refusal/cancellation separation, control escaping, heuristic redaction and output bounds. App-server tests cover pre-ack turn filtering, lifecycle events, interruption invalidation and late events from a replaced process. Terminal integration tests verify normal rendering outside the approval prompt and no false disk-write claim. The full suite is mock-protocol validation; it did not execute a real file operation.

**Limitations and validation scope.** Terminal output is an append-only activity log: later state markers clarify when prior evidence is no longer current, but do not erase terminal scrollback. Secret matching is heuristic. A `turn/diff/updated` payload cannot be attributed to a file item under this schema, and the deprecated file output delta is not used. No authenticated model turn or real file write was tested. No network request, app-server command, policy change, allowlist change, or file-approval policy change was made.

**Changed files.** `file-change-approval.js` exposes immutable summary projections and invalidation events from the authoritative cache. `app-server-client.js` forwards only exact active-turn summaries and closure invalidations. `terminal-frontend.js` renders bounded proposed-change summaries. `command-activity.js` fixes a token-flag redaction boundary used by the shared summary sanitizer. `test/file-change-summary.test.js`, `test/app-server-client.test.js`, and `test/terminal-frontend.test.js` cover the new behavior. `README.md`, `INTERFACE-ROADMAP.md`, and this report document the feature and limits.

**Next smallest milestone.** Add a separate bounded turn-level diff view for `turn/diff/updated`, labeled only with thread/turn identity and never attributed to an individual file item unless a future protocol provides that association.

## Milestone update: bounded turn-level diff visibility — 2026-10-19

**Starting baseline and result.** At the start of this milestone, the worktree was clean at `cce1e8a` on `main`, and `npm test` passed **127 tests, 0 failed, 0 cancelled, 0 skipped**. After the implementation and documentation updates, `npm test` passed **136 tests, 0 failed, 0 cancelled, 0 skipped**; `git diff --check` passed.

**Installed protocol evidence.** The installed binary reports `codex-cli 0.162.1`. I inspected the locally generated `codex_app_server_protocol.v2.schemas.json` bundle:

- `TurnDiffUpdatedNotification` requires `threadId`, `turnId`, and `diff` (string). Its description says the event contains the latest aggregated diff across all file changes in the turn. It has no `itemId`, sequence number, or version field.
- `TurnCompletedNotification` requires `threadId` and `turn`; `Turn` requires `id`, `items`, and `status`. The installed `TurnStatus` enum is `completed`, `interrupted`, `failed`, and `inProgress`.
- The notification is a complete latest aggregate snapshot, not a partial patch. The schema gives no same-turn ordering token, so Vesper uses the order in which notifications arrive over the app-server stdio transport and cannot identify a producer that reorders complete snapshots.

**Implementation.** New `turn-diff-activity.js` owns a bounded aggregate projection per active turn, separate from `FileChangeApprovalStore`. It filters against the active thread and authoritative `turn/start` turn ID; a bounded pre-ack buffer retains at most four turn identities and binds only the acknowledged one. Each valid full snapshot replaces the prior snapshot. Duplicate content is idempotent. Empty, malformed, oversized, or redaction-expanded payloads clear previous content and become explicit empty/unavailable states. Snapshots are limited to 32,768 characters; pre-ack state is capped at four turns.

`AppServerClient` closes the projection with the matching completion, interruption, failure, timeout, disconnect, or client-close state. Its existing process-generation check rejects old-process notifications. The terminal renders one final view for the matching thread and turn when the projection closes, rather than appending every full snapshot. The output is capped at 16,000 characters, terminal controls are escaped, common secrets are heuristically redacted, and truncation/unavailable states are explicit. The heading identifies this as a turn-level server snapshot, says it is not mapped to file-change items, and does not claim a disk write. No turn-level diff enters per-item approval evidence; file approval code and decisions are unchanged.

**Tests.** Added reducer/renderer tests for complete snapshot replacement and duplicates, pre-ack identity binding, cross-thread/turn filtering, missing/malformed/empty/oversized events, bounded pending state, escaping/redaction, output truncation, no item ID, and unavailable evidence. Client tests cover latest-snapshot closure, separation from file approval evidence, terminal completion/interruption/failure, and late events from a replaced process. A frontend test verifies one distinct bounded view and rejects a mismatched identity. Existing file-approval regression tests remain in the full suite.

**Limitations and validation scope.** The complete suite uses mock app-server events. The schema was inspected locally against the installed CLI, but no authenticated model turn, live `turn/diff/updated` delivery, or real file operation was performed. The view appears at turn close, not as a live redraw. Same-turn source reordering cannot be detected without a protocol sequence/version field. Credential redaction is heuristic and may miss secrets. The aggregate event cannot establish which item changed a file or whether a proposed change reached disk.

**Changed files.** Added `turn-diff-activity.js`; integrated its lifecycle with `app-server-client.js` and bounded rendering with `terminal-frontend.js`; added `test/turn-diff-activity.test.js` and client/frontend regressions; updated `README.md`, `INTERFACE-ROADMAP.md`, and this report. The local schema artifact and Codex configuration were not changed.

**Next smallest milestone.** Add a stable in-place terminal view that replaces the current aggregate diff while a turn is running, then validate its redraw and interleaving behavior with terminal mocks before attempting a live-server check.

## Milestone update: live in-place turn diff view — 2026-10-19

**Starting baseline and result.** Before edits, the worktree was clean at `0ccc0ab` on `main`; `npm test` passed **136 tests, 0 failed, 0 cancelled, 0 skipped**. After the implementation, the complete suite passed **146 tests, 0 failed, 0 cancelled, 0 skipped**. The sandboxed runner could not spawn Node (`EPERM`), so the full run was repeated outside the sandbox. `git diff --check` was run after the implementation.

**Protocol and event flow.** This milestone uses the existing locally inspected `codex-cli 0.162.1` protocol contract: `turn/diff/updated` supplies `threadId`, `turnId`, and a complete `diff` string, with no item ID or sequence/version field. `AppServerClient` now emits accepted snapshots after the authoritative turn identity is established; pre-ack snapshots are emitted once after exact binding. Existing process-generation, thread, turn, and reducer checks remain authoritative. Same-turn order remains app-server stdio arrival order. Turn completion, interruption, failure, timeout, disconnect, and client closure continue to emit the bounded final projection.

**Rendering.** A new `live-turn-diff-view.js` owns only cursor movement, bounded line wrapping, resize handling, coalesced redraws, and cleanup; it does not execute commands or alter routing or approvals. The terminal frontend uses the view only when both streams are TTYs and `TERM` is not `dumb`. Updates replace the one active frame. Before other frontend output, the frame is erased and then redrawn after that output; approval prompts suspend the view so readline input and approval text remain unobscured. Resize rewraps and reclips the current snapshot. On close, the last frame remains as static output. If rendering throws, redraw and resize handling are disabled and the final bounded renderer is used when output remains available. Redirected and non-TTY output receives no intermediate snapshots and one bounded final summary. Snapshot, render, terminal width, and frame height bounds are preserved; the live frame has an explicit truncation marker. Escaping, common-secret redaction, thread/turn identity checks, item separation, and the “disk write not verified” wording are retained.

**Tests.** Added mock TTY coverage for rapid replacement/coalescing, thread/turn mismatch, lifecycle cleanup across completion/interruption/failure/disconnect/timeout/client close, terminal resize and long multiline snapshots, approval suspension with concurrent command activity, redirected output, control escaping/redaction/output bounds, and recovery after a rendering error. Client regressions verify live updates only after exact active-turn binding, pre-ack snapshot forwarding, complete snapshot replacement, foreign identity filtering, and old-process event rejection. Existing per-item approval tests remain in the full suite and were not changed.

**Changed files.** `app-server-client.js` forwards accepted live snapshots; `live-turn-diff-view.js` implements bounded TTY redraw; `terminal-frontend.js` integrates lifecycle, output interleaving, and approval suspension; `test/app-server-client.test.js` and new `test/live-turn-diff-view.test.js` cover event association and terminal behavior; `README.md`, `INTERFACE-ROADMAP.md`, and this audit describe the behavior and its limits.

**Limitations and validation scope.** Tests use mock app-server events and a fake TTY stream. There was no authenticated model run, live app-server delivery, real file operation, or actual interactive TTY smoke-check. Terminal width calculation is approximate for complex Unicode glyph clusters. Because the protocol has no snapshot sequence/version, Vesper cannot detect a producer that sends old complete snapshots later on the same transport. Secret redaction remains heuristic. The view never proves a disk write and never supplies file-approval evidence.

**Next smallest milestone.** Run an opt-in local TTY smoke-check with synthetic app-server events to validate cursor cleanup, resize, approval input, and command-output interleaving on a real terminal without invoking an authenticated model or modifying files.

## Milestone update: real TTY smoke and integration readiness — 2026-10-19

**Baseline and final suite.** Work began on a clean worktree at `568c8f0` (`feat: implement live in-place turn diff view in terminal frontend and client`). The baseline and final `npm test` result was **146 passed, 0 failed, 0 cancelled, 0 skipped**. The sandboxed Node test invocation was blocked by `EPERM`; rerunning with the approved command completed both runs. `git diff --check` exited 0. No existing implementation or approval policy was changed in this milestone.

**Real PTY check.** `test/tty-live-diff-smoke.cjs` was run as `TERM=xterm-256color node test/tty-live-diff-smoke.cjs` in a PTY with both `stdin.isTTY` and `stdout.isTTY` true. It used a synthetic `EventEmitter` progress source, not `AppServerClient`; it did not start Codex, run a command, authenticate, or contact a model. The test replaced the same live panel across repeated snapshots, resized the PTY from 80 by 24 to 42 by 11 with `stty` and `SIGWINCH`, observed seven rendered rows after resize, clipped a long multiline diff, interleaved synthetic command and streamed output, and verified the live frame stayed suspended during an approval prompt then returned after declining. Synthetic completion, interruption, disconnect, and a one-shot rendering write error each closed the view and detached its resize listener. The error path wrote the SGR reset/newline cleanup. No cursor-hide or alternate-screen sequence was used; readline input was not left in raw mode and `:quit` exited cleanly. The final TTY smoke command exited 0.

The first PTY attempt showed that the harness's rendering-error injection flag was not wired to `stdout.write`, so its recovery assertion failed. The harness hook was corrected and the full PTY scenario was rerun successfully. This was a harness-only correction, not a product-code fix.

**Redirected output.** `node test/tty-live-diff-smoke.cjs --non-tty > .audit-artifacts/non-tty-live-diff-smoke.log` was run twice. Each run produced one bounded final frame (295 characters), no raw terminal escape sequence, and the same SHA-256 `77dadb90e6ea3d55cfa71f0e025b349fd5f133f13ba552863ae69a9718cecd03`; intermediate snapshots were not printed. Both runs exited 0.

**Integration preparation.** A separate no-remote repository is prepared under ignored `.audit-artifacts/disposable-e2e-project`, branch `main`, with fixture commit `9d5a4fb` and one `target.txt`. `TTY-INTEGRATION-READINESS.md` records the exact future isolated-home/login/start sequence and steps for streaming plus command lifecycle, matching file evidence, one-time approval and disk verification, refusal, cancellation, thread/session resume, and final Git checks. None of those authenticated steps was run.

**Changed files.** Added `test/tty-live-diff-smoke.cjs` as a manual synthetic-event PTY/redirect harness; added `TTY-INTEGRATION-READINESS.md` for repro and future integration procedure; updated `README.md` to link the procedure and state the validation boundary; updated `INTERFACE-ROADMAP.md` and this audit to record the real PTY check and remaining live integration step. The ignored fixture and smoke reports are local test artifacts, not tracked product changes.

**Tests and validation.** The harness was syntax-checked with `node --check test/tty-live-diff-smoke.cjs`. The PTY and redirected-output checks are manual controlled checks and are not included in `npm test`; the regular suite's app-server process and TTY behavior remains mocked. The added untracked smoke source and procedure were also checked for trailing whitespace.

**Limitations and next smallest milestone.** This validates a PTY-backed Node process in the current command environment, not every terminal emulator. App-server notifications were synthetic. Authenticated model streaming, live command/file approval events, actual file writes, and session recovery against a live Codex thread remain unverified. The next smallest milestone is an explicitly authorized live end-to-end run against the prepared disposable repository, starting with a read-only command lifecycle and session resume before testing a proposed write and approval outcome.

## Milestone update: VS Code persistent sessions and recovery — 2026-10-20

**Lifecycle and integration boundary identified before editing.** The terminal calls `resolveProjectDirectory()` to require an existing directory and canonicalize it with `realpath`. `SessionStore` persists versioned, private, atomic JSON records containing only the Vesper session ID, project `cwd`, Codex thread ID, and timestamps. The terminal passes a saved thread ID to `AppServerClient`; `thread/resume` must return that same thread and the matching project path. Resume failure is surfaced and does not fall back to `thread/start`. When no thread ID exists, the client starts a thread and persists its ID through the store callback. The smallest extension boundary was therefore exact canonical-path lookup in that same store plus use of the shared client’s resume path; no extension-specific session database or copied transport was needed.

**Implementation.** `SessionStore.findLatestByCwd()` validates existing records and selects the most recently updated record whose stored path exactly matches the canonical workspace path. The VS Code panel now uses the CLI path resolver, the existing store, and the shared `AppServerClient`. The client accepts only a `read-only` sandbox override, which the extension supplies on both thread start and resume; the extension continues to decline approval requests. Successful resume is displayed only after the server returns the saved thread ID and matching `cwd`. Failed or disconnected sessions remain saved and block new prompts until retry succeeds or the user explicitly starts a new conversation. Starting a new conversation creates a separate Vesper session record and retains the previous record. The panel is a singleton per extension host; its transcript is intentionally not persisted.

The installed `codex-cli 0.162.1` schema bundle was inspected locally. `ThreadStartParams` supports `cwd` and `sandbox`; `ThreadResumeParams` requires `threadId` and supports `cwd` and `sandbox`; both responses include `thread` and `cwd`. The client verifies the response thread ID and canonical project path before marking a session connected. Project and request generations, client identity, session ID, and active request ID guard event delivery; interruption is sent through the shared client for its active thread/turn only. A removed or moved folder is not matched to another path and cannot start a Codex task until selected as an available folder.

**Tests and validation.** Baseline `npm test` passed **147 tests, 0 failed, 0 cancelled, 0 skipped**. The first sandboxed invocation could not spawn Node (`EPERM`); the test run was repeated with authorization and passed. After changes, `npm test` passed **158 tests, 0 failed, 0 cancelled, 0 skipped**. `node test/extension-routing.test.js` passed **10 tests**. Syntax checks passed for all six modified JavaScript files, and `git diff --check` passed. Extension integration tests use real temporary `SessionStore` files under a temporary `VESPER_HOME` and a mocked app-server process; separate store and client tests cover exact-path lookup and saved-thread resume. These tests are deterministic local validation, not a live app-server session.

**Limitations.** If multiple saved sessions share a project path, the extension chooses the most recently updated record; no session picker exists yet. The Vesper metadata store persists identifiers, not transcript turns, so previous panel messages are not redrawn after restart. No authenticated model execution, live app-server reconnect, or real file operation was performed. The sandboxed test spawn restriction required an approved run outside the sandbox. Existing Phase 1A work in the extension, README, and routing tests was present in the worktree before this milestone and was preserved.

**Changed files.** `extension.js` now integrates the existing router, store, and client into the VS Code message bridge and recovery UI. `session-store.js` adds bounded exact-project lookup without changing the session schema. `app-server-client.js` adds explicit resume and the extension-only read-only sandbox option. Tests were added or extended in `test/extension-routing.test.js`, `test/session-store.test.js`, and `test/app-server-client.test.js`. `README.md`, `INTERFACE-ROADMAP.md`, and this audit describe the integration and its limits.

**Next smallest implementation task.** Add a project-scoped saved-session picker, then a bounded history read that lets a resumed panel render prior conversation turns without adding prompt or output text to Vesper’s session metadata.
