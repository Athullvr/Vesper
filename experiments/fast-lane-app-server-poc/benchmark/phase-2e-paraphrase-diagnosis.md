# Phase 2E — Held-Out Paraphrase Diagnosis

This is a post-evaluation diagnosis only. No routing code, fixture label, or expected outcome was changed. The original baseline and the Phase 2D held-out set remain the same previously evaluated sets; after any future router tuning, the 40-case set must be treated as regression/validation data rather than an untouched holdout.

## Integrity and provenance

- Baseline fixture: `test/fixtures/routing-quality-cases.json`, SHA-256 `00d9ec3db031dfc54fb1325fd649163a86d54d10cab02f936ac3c6988720b22a`.
- Held-out fixture: `test/fixtures/routing-quality-heldout-cases.json`, SHA-256 `14e4df137fd8e4306f5989c2cc1d23cb770956d112d7bae0df447a646c522970`.
- Both hashes match `test/fixtures/routing-quality-fingerprints.json`; the test suite checks them before evaluation.
- The labels were developer-authored and had no independent review before the Phase 2D run. After that run, a separate read-only agent reviewer assessed the five meanings and labels before this diagnosis. The reviewer agreed that all five expected local labels are defensible in the current-project context. No human reviewer participated, and no labels were revised.

The Phase 2D results remain reproducible: baseline **12/12 expected behavior matches**; held-out **35/40**. All five held-out mismatches are the local-intent paraphrases listed below, each delegated with reason `local_ambiguous`.

## Five-case diagnosis

`classifyRequest()` first checks normalized exact phrases and constrained patterns, then sends unmatched requests containing a local-topic word to Codex with `local_ambiguous` ([routing-core.js](../routing-core.js#L121-L157)). In all five cases, the classifier returned `{ route: "codex", intent: null, reason: "local_ambiguous" }`. With the evaluation's mock callback, the resulting routing outcome was `codex_delegated` with one fallback request.

| Case | Intended meaning, expected label, and evidence | Actual result and recognition gap | Is the local handler safe for this fixture? Could it still need delegation? |
| --- | --- | --- | --- |
| `heldout_branch_right_now` | “Which branch is checked out in this project now?” Expected `current_git_branch`, `confirmed`, `local_handled`; `branch_main` supplies a non-empty branch result for `git branch --show-current`. | The normalized wording is `which branch am i on right now`. It is not an exact phrase, and the branch pattern only covers “which/what branch is [currently] active/checked out.” The topic guard sees `branch` and selects `local_ambiguous`. | Yes. The current-workspace branch command directly establishes the requested name. A detached checkout would return `unknown`, and a Git failure would return `unavailable`. No material alternate meaning is apparent in the prompt. |
| `heldout_branch_conversational` | “Which branch am I on?” Expected `current_git_branch`, `confirmed`, `local_handled`; `branch_main` provides the same local branch evidence. | Normalization removes the apostrophe in “I'm,” producing `im on which branch`. The phrase set expects “which branch am i on”; no pattern covers this reversed conversational form. The `branch` topic guard selects `local_ambiguous`. | Yes. `git branch --show-current` answers this in the active workspace. The question is informal but still identifies a single fact. |
| `heldout_upstream_remote_branch_paraphrase` | “Which remote branch is configured as this checkout's tracking branch?” Expected `branch_upstream`, `confirmed`, `local_handled`; `upstream_configured` supplies local `main` → `origin/main` configuration. | The exact phrase set includes “what remote branch does this branch track,” but not “what remote branch is this checkout tracking.” There is no constrained `branch_upstream` pattern. The `remote`/`branch` topic guard selects `local_ambiguous`. | Yes for local tracking configuration. The handler uses `symbolic-ref` and `for-each-ref` and explicitly says the remote was not checked. If “remote branch” means live remote existence or current remote state, that interpretation should be delegated. |
| `heldout_upstream_configured_branch_paraphrase` | “Which upstream is configured for the current branch?” Expected `branch_upstream`, `confirmed`, `local_handled`; `upstream_configured` again supplies a configured local tracking ref. | The phrase set contains “which upstream does this branch track” and “is there an upstream configured for the current branch,” but not this sentence. Normalization removes the possessive apostrophe, leaving `this branchs upstream`; no pattern covers it. The `branch` guard selects `local_ambiguous`. | Yes when “this branch” means the active workspace branch. The handler reports local configuration and states that no remote was contacted. If the user means another named branch, the current handler contract is insufficient and delegation remains appropriate. |
| `heldout_ahead_count_current_branch_paraphrase` | “How many commits ahead of its upstream is the current branch?” Expected `ahead_of_upstream`, `confirmed`, `local_handled`; `ahead_recent` supplies a count of 2 and a synthetic reflog timestamp at the fixed current time. | Existing phrases include “how many commits am i ahead of upstream” and “how many local commits are ahead of upstream,” but not the subject-form wording here. No ahead-count pattern exists. `branch` and `upstream` trigger `local_ambiguous`. | Yes for the local tracking ref represented by the fixture: the handler uses `git rev-list --count @{upstream}..HEAD`, and the fixture marks that ref fresh. It does not query the remote. If the user requires a live comparison with the current remote, delegation is appropriate. |

## Diagnosis

These are **intent-recognition gaps**, not unsupported handler capabilities or incorrect fixture labels. The held-out fixture supplies evidence that the existing handlers can answer the labeled local questions, and the independent reviewer found the intended meanings defensible. The classifier misses them because its exact phrase lists are finite, its patterns are deliberately narrow, and the broad topic guard delegates unmatched Git-topic wording.

The upstream and ahead-count answers remain bounded by the handler contract: they describe local configuration and fetched tracking refs, not live remote state. The existing freshness logic can return `stale` for an old upstream reflog; absent upstreams and Git command errors return `unavailable` or `unknown` as defined by the handler. Local-handler errors do not fall back to Codex: `routeRequest()` only invokes the fallback for an already Codex-routed decision ([routing-core.js](../routing-core.js#L271-L319)).

## Smallest proposed repair (not implemented)

Add a few **anchored, intent-specific patterns** without changing the topic guard or evidence handlers:

1. For `current_git_branch`, recognize the `which branch am i on right now` suffix and the normalized conversational form `im on which branch` (optionally also `i am on which branch`).
2. For `branch_upstream`, recognize only explicit local-tracking formulations equivalent to “what remote branch is this checkout tracking” and “which branch is configured as this branch's upstream.” Keep wording about whether a branch is pushed or whether a remote is currently up to date on the Codex path.
3. For `ahead_of_upstream`, recognize the anchored “how many commits ahead of upstream is the current branch” form. Preserve the local-ref freshness caveat and the current status mapping.

**Expected benefit:** the five currently missed, clearly scoped local questions would reach their existing handlers without adding a new handler or runtime path.

**Risks:** broad patterns could mistake a live-remote question for local tracking configuration, or “this branch” could refer to a branch other than the active checkout. Anchored wording should limit that risk; ambiguous, mixed, push-state, and live-remote questions should continue to delegate. If a local handler returns `unknown`, `stale`, or `unavailable`, its current status and no-fallback behavior must remain intact. Routing-record fields, privacy, and `RouteMetrics` semantics need no change.

## Tests to add if the repair is approved

- Assert each of these five prompts selects the expected local intent and reaches its handler with zero fallback calls.
- Cover the corresponding positive local result with synthetic branch, upstream, and fresh-ref evidence.
- Add negative neighbors: a bare “Branch?”, pushed-state questions, current remote-state questions, a question about a different named branch, and mixed local-plus-remote requests must still delegate exactly once.
- Recheck missing/detached evidence (`unknown`), stale upstream evidence (`stale`), unavailable configuration or command failures (`unavailable`), and zero fallback after every local-handler failure.
- Preserve baseline fixtures, routing-decision privacy, and exactly-once `RouteMetrics` counting. Create a new held-out set for generalization measurement; do not treat the already evaluated 40 cases as untouched after tuning.
