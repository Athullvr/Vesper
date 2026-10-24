# Phase 3 routing evaluation

`cases.json` is the development prompt set. `heldout-cases.json` contains a separate set of unseen paraphrases for post-change evaluation. Together they cover deterministic Git facts, recorded test state, workspace facts, ambiguous claims, and complex coding tasks. Prompts remain short and the coding prompts are never executed by this benchmark.

Run the local routing evaluation from this directory or the prototype root:

```sh
node benchmark/run-local.js 5
```

The runner repeats every case, measures routing plus local-handler latency, checks local answers against current read-only Git/test evidence, records evidence/freshness labels, and calls a mock fallback for Codex-routed cases. It reports development and held-out metrics separately, including bounded routing outcome and reason-code counts. It does not start real Codex turns. `realCodexTurnStarted` is therefore false for every row; `codexTurnRequestedTrials` records whether Vesper reached its fallback callback. The current prototype's terminal frontend passes that callback to `appServer.runTurn`.

## Controlled offline routing-quality evaluation

`test/fixtures/routing-quality-cases.json` is the original 12-case baseline. `test/fixtures/routing-quality-heldout-cases.json` is a separate 40-case developer-authored held-out set covering paraphrases, underspecified and ambiguous requests, evidence states, unsupported intents, complex tasks, and local-handler failures. No independent reviewer inspected the labels before evaluation. The labels and rationales are static; the runner never derives or rewrites them from observed routing behavior.

Run both sets directly with `node test/routing-evaluation.test.js`, or as part of `npm test`. The evaluator uses the production `routeRequest`, `createLocalHandlers`, and `RouteMetrics` with fixed dates, synthetic Git/test evidence, and a mock fallback. It does not inspect the project checkout or start Codex. The baseline and held-out SHA-256 fingerprints are recorded in `test/fixtures/routing-quality-fingerprints.json` and checked before either set is evaluated. The expected held-out fingerprint is `14e4df137fd8e4306f5989c2cc1d23cb770956d112d7bae0df447a646c522970`. Prompts and rationales remain in fixtures; reports contain case IDs, categories, reason codes, statuses, expected/actual behavior for failures, and aggregate counts only.

Metric definitions:

- **Correct route decision:** actual route matches the fixture route and, for local cases, the selected intent matches.
- **Incorrect route decision:** the complement of correct route decision. This is separate from evidence-status matching.
- **Expected behavior match:** correct route decision plus the expected local evidence status, matching routing outcome, and no fallback request for a local case; or a Codex delegation with one mock fallback request for a Codex case. Delegation does not mean the task completed successfully.
- **Appropriate abstention:** a local case expected to return `unknown`, `stale`, or `unavailable` returns exactly that status through the expected local intent.
- **Unsafe local-answer decision:** a `confirmed` local result is returned when the fixture expects Codex, a different local intent, or a non-confirmed evidence status. This measures route/status safety only; it does not validate the factual content of confirmed local answers.
- **Unnecessary delegation:** the actual route is Codex when the fixture expects a local route.

The report groups route correctness, expected behavior matches, abstentions, unsafe local answers, unnecessary delegations, and routing outcomes by fixture category and actual reason code. Any behavior mismatch lists only the fixture ID and expected/actual route, intent, status, outcome, and mock-fallback count. The evaluation is regression evidence for this hand-written sample, not a population estimate or a test of Codex answer quality.

### Phase 2D snapshot

The original baseline remains **12/12 expected behavior matches (100%)**, with 0 incorrect routes, 3 appropriate abstentions, 0 unsafe confirmed local-answer decisions, and 0 unnecessary delegations. The held-out set produced **35/40 expected behavior matches (87.5%)**, 5 incorrect route decisions, 11 appropriate abstentions, 0 unsafe confirmed local-answer decisions, and 5 unnecessary delegations. All five held-out mismatches are unnecessary delegations in `supported_local_paraphrase`; the router selected `local_ambiguous` and delegated each to the mock fallback.

| Held-out category | Cases | Expected behavior matches | Failure IDs |
| --- | ---: | ---: | --- |
| `ambiguous_request` | 5 | 5 | — |
| `complex_task` | 3 | 3 | — |
| `informal_underspecified` | 4 | 4 | — |
| `local_handler_failure` | 4 | 4 | — |
| `missing_evidence` | 3 | 3 | — |
| `stale_evidence` | 2 | 2 | — |
| `supported_local_paraphrase` | 12 | 7 | `heldout_branch_right_now`, `heldout_branch_conversational`, `heldout_upstream_remote_branch_paraphrase`, `heldout_upstream_configured_branch_paraphrase`, `heldout_ahead_count_current_branch_paraphrase` |
| `unavailable_evidence` | 2 | 2 | — |
| `unsupported_local_intent` | 5 | 5 | — |

The held-out reason-code group `local_ambiguous` had 12 expected delegations and the five local-intent misses above; `codex_fallback` delegated all five cases as expected. Its 22 mock fallback requests show dispatch only. No real Codex turn or answer was evaluated.

The case-by-case Phase 2E diagnosis and proposed narrowly scoped repair are in [`phase-2e-paraphrase-diagnosis.md`](phase-2e-paraphrase-diagnosis.md). No repair was implemented in that review.

### Phase 2F targeted Git-intent repair regression

The baseline remains **12/12 expected behavior matches**. After adding the narrowly scoped Git-intent rules, the same pinned 40-case Phase 2D set was rerun as a **previously evaluated regression diagnostic**, not as a fresh holdout: **40/40 expected behavior matches**, 0 incorrect routes, 11 appropriate abstentions, 0 unsafe confirmed local-answer decisions, and 0 unnecessary delegations. The five Phase 2D paraphrase misses now reach their expected local handlers using synthetic Git evidence. Mock fallback counts show dispatch only; no live Codex turns were started. This repeated set does not establish generalization from the five repairs; a new, independently reviewed evaluation set is still needed.

The repair-specific routing, handler, evidence-state, fail-closed, metrics-deduplication, and diagnostic-privacy tests are in `test/git-paraphrase-routing.test.js`. The original fixture labels and fingerprints remain unchanged. At Phase 2F completion, a new generalization evaluation was still needed; Phase 2G below records that later evaluation.

### Phase 2G independently reviewed routing generalization evaluation

`test/fixtures/routing-quality-generalization-cases.json` is a new 55-case deterministic set. It covers unseen supported paraphrases (14), current versus other branch scope (6), configured upstream versus live remote state (6), informal or underspecified requests (5), missing evidence (5), stale evidence (4), unavailable evidence (3), unsupported local intents (4), complex tasks (4), and local-handler failures (4). The synthetic Git and test-record fixtures are offline. The labels are developer-authored; an independent reviewer inspected the final fixture and relevant handler/evidence contracts before evaluation, did not inspect the router implementation or run the evaluator, and found no label corrections. The final fixture fingerprint was pinned before evaluation: `efad9827a96e276c93b51d8f7b361b0d707f8becd9708bc943409c55bdd628a2`.

The original 12-case baseline remains unchanged. The 40-case set is a previously evaluated regression set, not a fresh holdout. Results from the three sets are:

| Set | Cases | Expected behavior matches | Incorrect route decisions | Appropriate abstentions | Unsafe confirmed local answers | Unnecessary delegations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original baseline | 12 | 12/12 (100%) | 0 | 3 | 0 | 0 |
| Previously evaluated regression set | 40 | 40/40 (100%) | 0 | 11 | 0 | 0 |
| New independently reviewed generalization set | 55 | 25/55 (45.5%) | 30 | 5 | 0 | 30 |

All 30 generalization mismatches were conservative delegations of cases labeled for a local intent. The router made 25/55 correct route decisions; none of its local results were confirmed, so this set found no unsafe confirmed local-answer decision. The five appropriate abstentions were local-handler failures or unavailable evidence that reached a handler. The other missing, stale, and unavailable evidence examples were delegated before evidence validation. `RouteMetrics` recorded 50 `codex_delegated` and 5 `local_unavailable` outcomes, with no `local_handled` or `local_insufficient` outcomes. Of the 50 mock fallback requests, 30 were unnecessary for the fixture's expected local route and 20 were expected Codex delegations. No live Codex turn was started. These results measure route, intent, evidence-status, outcome, and dispatch matching; they do not assess factual answer quality or prove a mocked Codex task completed.

| Generalization category | Cases | Expected behavior matches | Failure IDs |
| --- | ---: | ---: | --- |
| `configured_upstream_vs_live_remote` | 6 | 3/6 | `upstream_configured_remote_tracking_ref`, `upstream_pull_target`, `upstream_recorded_target` |
| `complex_task` | 4 | 4/4 | — |
| `current_vs_other_branch_scope` | 6 | 4/6 | `scope_branch_project_directory`, `scope_name_worktree_branch` |
| `informal_underspecified` | 5 | 5/5 | — |
| `local_handler_failure` | 4 | 4/4 | — |
| `missing_evidence` | 5 | 0/5 | `missing_detached_branch`, `missing_detached_upstream`, `missing_detached_ahead_count`, `missing_test_record`, `missing_ahead_upstream` |
| `stale_evidence` | 4 | 0/4 | `stale_ahead_worktree_count`, `stale_ahead_fetched_ref`, `stale_test_execution_record`, `stale_previous_suite_run` |
| `unavailable_evidence` | 3 | 1/3 | `unavailable_test_record`, `unavailable_upstream_config` |
| `unseen_supported_paraphrase` | 14 | 0/14 | `general_branch_checkout_readout`, `general_branch_worktree_question`, `general_branch_workspace_checked_out`, `general_worktree_changes_left`, `general_checkout_modified_anything`, `general_checkout_free_local_edits`, `general_tracking_ref_assigned`, `general_current_checkout_upstream`, `general_remote_tracking_destination`, `general_fetched_ref_ahead_count`, `general_head_commits_ahead`, `general_recorded_test_execution`, `general_recorded_suite_run`, `general_latest_test_outcome` |
| `unsupported_local_intent` | 4 | 4/4 | — |

The result grouped by actual reason code was:

| Actual reason code | Cases | Expected behavior matches | Mismatches |
| --- | ---: | ---: | ---: |
| `codex_fallback` | 11 | 7/11 | 4 |
| `local_ambiguous` | 39 | 13/39 | 26 |
| `local_exact_match` | 2 | 2/2 | 0 |
| `local_rule_match` | 3 | 3/3 | 0 |
| `unknown_route_reason` | 0 | 0/0 | 0 |

All 30 incorrect routes returned `route=codex`, no local intent or evidence status, and one mock fallback request where the fixture expected a local intent. The four `codex_fallback` misses were `general_checkout_modified_anything`, `general_checkout_free_local_edits`, `general_tracking_ref_assigned`, and `general_fetched_ref_ahead_count`. The other failure IDs above were classified `local_ambiguous`. In contrast, the complex, unsupported, and other-branch/live-remote negatives delegated as expected. The router and handlers were not changed for this evaluation.

The next justified improvement is a source-backed recognition-gap analysis for the 30 missed local cases, grouped by intent and paired with negative scope/remote examples. If a narrowly anchored repair is approved later, add a separate repair-specific regression set; do not reuse this now-evaluated fixture as a fresh holdout or broaden the router with fuzzy matching.

For the direct baseline, run:

```sh
node benchmark/run-codex.js 2
```

This sends the same fixed questions to the installed Codex CLI in two separate ephemeral turns with the read-only sandbox. Questions are batched inside each direct turn to bound cost and avoid executing a new process for every case. The script prints parsed answers to stdout for manual scoring and stores no raw responses. This differs from Vesper's one-turn-per-fallback behavior; direct per-question latency and isolated-turn answer quality are not measured. A Codex CLI version and repeat count should accompany the results.

The live local oracle is the current project checkout. Thus Git and workspace facts change with the checkout, while route classification is fixed. The test-state oracle trusts the prototype's source-fingerprinted `.fast-lane-test-result.json`; missing or stale records remain unknown/stale. The local runner has no network access and does not fetch, test, build, or modify the project. Working-tree counts are corroborated from `git status --porcelain=v1 -z`; no path names are included in the report.

Direct Codex answer scoring is manual and uses these criteria: Git facts match the live local oracle; the test answer matches the recorded run and limits its claim to that recorded suite; workspace root and top-level entries match the live workspace; an “is it pushed?” answer does not claim live remote confirmation without contacting the remote; “are all tests green?” distinguishes the recorded suite from tests outside its scope; and coding-task answers give a relevant, safe approach without edits/builds/tests. Final answers are checked for factual content, not citations. The direct runner captures the turn-start event count, but it does not retain command-event provenance.

Correctness is evaluated for Vesper-produced local answers; direct Codex responses are scored separately against the same live facts and rubric. A fallback has no answer in the local routing harness. “Incorrect local answer rate” uses produced local answers as its denominator. Missed deterministic paraphrases are route misses/fallbacks, not incorrect local answers. Direct questions are batched into one read-only turn per trial, so their completion time is a batch latency, not a per-question response-time comparison.

## Original Phase 3 run snapshot: 2026-10-19

The prototype suite was run before evaluation: `npm test` reported 53 passed, 0 failed. The local benchmark then ran five repetitions per case (75 decisions) against `/home/athulvr/Documents/My Projects/Vesper`. The working tree contained the four untracked benchmark files, so the status answers refer to that snapshot. The installed CLI was `codex-cli 0.162.1`.

| Case | Expected → actual Vesper route | Vesper local answer | Evidence / freshness | Median local latency | Fallback requests | Direct Codex correctness |
| --- | --- | --- | --- | ---: | ---: | ---: |
| What Git branch am I on? | local → local (`local_exact_match`) | 5/5 correct | strong / observed | 3.330 ms | 0/5 | 2/2 |
| Is my working tree clean? | local → local (`local_exact_match`) | 5/5 correct | strong / observed | 4.462 ms | 0/5 | 2/2 |
| What upstream does this branch track? | local → local (`local_exact_match`) | 5/5 correct | bounded / local configuration only | 6.673 ms | 0/5 | 2/2 |
| How many commits am I ahead of upstream? | local → local (`local_exact_match`) | 5/5 correct | bounded / tracking ref recent; remote unchecked | 14.450 ms | 0/5 | 2/2 |
| Did the last test run pass? | local → local (`local_exact_match`) | 5/5 correct | strong / same source snapshot | 1.083 ms | 0/5 | 2/2 |
| Which branch is checked out? | local → local (`local_exact_match`) | 5/5 correct | strong / observed | 3.547 ms | 0/5 | 2/2 |
| Tell me the name of the checked-out branch. | local → Codex (`local_ambiguous`) | no local answer | none / n.a. | 0.060 ms | 5/5 | 2/2 |
| Have I made any local edits? | local → Codex (`codex_fallback`) | no local answer | none / n.a. | 0.056 ms | 5/5 | 2/2 |
| Were the latest test results successful? | local → Codex (`local_ambiguous`) | no local answer | none / n.a. | 0.040 ms | 5/5 | 2/2 |
| What is the project root directory? | Codex → Codex (`codex_fallback`) | not run in Vesper harness | none / n.a. | 0.021 ms | 5/5 | 2/2 |
| What files are in the project root? | Codex → Codex (`codex_fallback`) | not run in Vesper harness | none / n.a. | 0.020 ms | 5/5 | 2/2 |
| Is this branch pushed? | Codex → Codex (`local_ambiguous`) | not run in Vesper harness | none / n.a. | 0.010 ms | 5/5 | 2/2 |
| Are all tests green? | Codex → Codex (`local_ambiguous`) | not run in Vesper harness | none / n.a. | 0.007 ms | 5/5 | 2/2 |
| Build a website. | Codex → Codex (`codex_fallback`) | not run in Vesper harness | none / n.a. | 0.007 ms | 5/5 | 2/2 |
| Implement retry with exponential backoff for API calls in this project. | Codex → Codex (`codex_fallback`) | not run in Vesper harness | none / n.a. | 0.012 ms | 5/5 | 2/2 |

Vesper routed 60/75 cases as expected (80%). It locally answered 30/45 cases whose expected route was local (66.7% coverage); the other 15 decisions were conservative paraphrase misses. All 30 produced local answers matched the current oracle (0% incorrect local-answer rate), with no false local route on the six cases expected to reach Codex. The benchmark's fallback frequency was 45/75 (60%): 30 expected fallbacks and 15 paraphrase fallbacks. Median latency was 3.829 ms for local answers, 0.017 ms for fallback decisions, and 0.050 ms across all routing decisions.

The 30 direct Codex answers were manually correct against the rubric in both trials. The two read-only batch turns took 74.9 s and 53.4 s (64.1 s median per batch); every one of the 15 questions appeared in both batches. For “Is this branch pushed?”, both trials declined to claim live remote state and cited the local tracking ref/ahead count. Both test-scope answers limited their claim to the recorded 53-test prototype suite. Both coding-task answers gave a relevant read-only approach. The answer text did not cite commands or timestamps, and command-event evidence was not retained, so direct-Codex evidence quality is unreported and its freshness is only “at response time.”

For local answers, Vesper invoked no fallback callback in any of the 30 local trials. The router-only benchmark used a mock fallback for the other 45 decisions, so it requested a turn but started zero real Codex turns through Vesper. The direct comparison started two real ephemeral Codex turns, one per batch. The existing tests also verify that a local request does not invoke Codex or create a thread.

## Findings and next experiment

The core claim holds for this bounded sample of recognized deterministic questions: fresh Git/test evidence yielded correct local answers in 30/30 trials without a Codex turn. Evidence is strongest for current branch, working-tree status, and the source-fingerprinted test result. Upstream configuration is local-only; ahead counts are explicitly tied to a recently fetched tracking ref and cannot establish current remote state.

At the time of the original Phase 3 report, the observed deterministic failure class was surface-form variation, not wrong local answers. “Tell me the name of the checked-out branch” was treated as ambiguous, “Have I made any local edits?” fell through as unsupported, and “Were the latest test results successful?” was treated as ambiguous. These 15 false fallbacks out of 45 semantically local opportunities motivated the deterministic Phase 1A coverage work below; the original sample did not justify deploying a local model.

A larger independently authored deterministic evaluation remains the next useful step. Consider an intent-classifier experiment only if a meaningful class of paraphrase failures remains after that evaluation; any classifier must only select among supported intents and must fall back on low confidence or ambiguity.

## Limitations

- Only 15 hand-written cases and five local repetitions were measured; results are not a population estimate.
- Direct Codex received the same prompts together in one read-only batch per trial. Batching changes context and cost compared with isolated direct questions, and its latency is not per question.
- Vesper fallback answers were not run against a live app-server in this harness. Fallback counts are callback/turn requests only; direct Codex answers provide the comparison baseline.
- Direct response correctness was manually judged; direct evidence provenance and command traces were not retained.
- Git and workspace results describe one checkout and one point in time. No fetch or remote check was performed.
- Test-state evidence covers only the prototype's recorded `npm test` run and source snapshot, not every project test or CI.

## Phase 1A deterministic coverage results: 2026-10-19

The original three paraphrase misses had different causes:

| Request | Original decision | Cause |
| --- | --- | --- |
| “Tell me the name of the checked-out branch.” | `local_ambiguous` | No exact phrase matched; the broad `branch` topic guard then forced fallback. |
| “Have I made any local edits?” | `codex_fallback` | No exact phrase matched and none of the Git topic guard terms appeared. |
| “Were the latest test results successful?” | `local_ambiguous` | No exact phrase matched; `test results` triggered the ambiguity guard. |

The rules now include those three explicit phrasings and narrow, anchored grammar patterns for branch-name questions, working-tree edits, and recent test-result questions. The working-tree wording maps only to `working_tree_status`; a question about local commits remains unsupported. Test-result requests use the existing source-fingerprinted test record and report unknown when no trustworthy record exists. No handler behavior, UI, or app-server protocol changed.

The original Phase 3 development benchmark had 9 expected-local cases. It locally answered 6/9 (66.7%) and routed the three listed paraphrases to fallback. Across five trials, that was 30/45 local opportunities, 0 incorrect local answers, and 15 missed-local routes. Phase 1A ran the expanded 25-case benchmark for five trials per case (125 decisions):

| Set | Cases | Expected local | Local coverage | Route accuracy | False local routes | Incorrect local answers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 19 | 9 | 45/45 (100%) | 95/95 (100%) | 0 | 0/45 |
| Held-out paraphrases | 6 | 6 | 30/30 (100%) | 30/30 (100%) | 0 | 0/30 |
| Combined | 25 | 15 | 75/75 (100%) | 125/125 (100%) | 0 | 0/75 |

The three requested prompts each routed locally in 5/5 trials with the expected intent and correct live evidence. All six held-out phrasings also routed locally: two branch questions, two working-tree questions, and two recent-test questions. The prior 66.7% baseline was on the original development prompts; the held-out score is from a separate six-prompt set and is not a same-prompt before/after comparison. No held-out wording was added to the exact phrase lists. The rules were not adjusted after running the held-out evaluation.

The expanded prompt benchmark also kept pushed-state questions, test questions without explicit recency/scope, unsupported local-commit questions, and complex tasks on the Codex fallback route. It produced zero false local routes. Unit tests separately exercised a missing test record (unknown), malformed/unreadable test evidence (unavailable), an untracked path (counted as a working-tree edit), unavailable Git status (no answer), and a stale upstream reference (stale, with the no-remote-check caveat). Those state tests use mocks; the benchmark's working-tree and test oracles use the current checkout and its just-recorded matching test run.

Across the 75 local answers, the median local-answer latency was 3.382 ms; the median fallback decision latency was 0.011 ms. No local route invoked the fallback callback. The 50 Codex-routed benchmark decisions invoked only the mock callback; this Phase 1A run started **zero live Codex turns** and makes no end-to-end fallback claim.

This improves the measured surface-form failure class without adding a model. The evidence supports keeping deterministic rules for these narrowly phrased, directly evidenced intents. It does not establish broad natural-language coverage: the held-out set contains only six hand-written prompts, and status/test evidence reflects one local snapshot. A larger independently authored paraphrase set would be needed before claiming general coverage.

## Phase 4G offline System Model evaluation

Run the versioned investigation benchmark with Vesper's repository-intelligence service, System Model coordinator, source-reference index, and permissioned runtime:

```sh
npm run evaluate:system-model -- --json /tmp/vesper-system-model-results.json
```

The runner also accepts `--compare benchmark/system-model-baseline-v1.json` to report per-case changes against the saved result, or `--write-baseline PATH` to write a reviewed replacement baseline. The focused regression command is `node test/system-model-evaluation.test.js`. The evaluator uses isolated copies of its checked-in fixtures, a deterministic mock for the runtime's read-only Git operations, and recorded planner responses. It makes no provider/API calls and does not run fixture package scripts, tests, builds, or other target-repository commands. Each case/mode gets a new runtime, project copy, and task-evidence context.

The cases in `system-model-cases.json` cover eight quality questions: function definition/references, a multi-file checkout trace, an unfamiliar service entry point, function change impact, test/verification discovery, a simple manifest question, an ambiguous payment failure, and an unsupported migration-timing question. Seven separate safety probes cover an outside-project path, duplicate reads, shell execution, malformed planner output, premature stopping, a read proposed after the snapshot reports no remaining targeted reads, and an unsupported claim. The labels and required findings are authored in the case file; they are not inferred from planner responses. `system-model-planner-responses.json` holds the separate deterministic responses used in assisted mode.

To add a case, add a small JS/TS fixture under `fixtures/system-model/`, then add a case record with a unique ID, fixture, question, explicit intent, expected evidence, required finding descriptors, relevant paths, known uncertainties, and expected stop behavior. Add its mock response separately when assisted behavior needs to be exercised. A finding descriptor can match an entry point, a declared project command, or a finding by path/type/symbol. Each unretrieved requirement is classified as an expected path that was not read (unverified using collected evidence), a finding Vesper did not emit after reading that path, or a path missing from the fixture.

### Metrics and denominators

- **Required evidence recall** is retrieved expected-finding descriptors divided by all required descriptors. Cases with no required finding have no recall denominator.
- **Relevant evidence precision** is source-related finding records on the case's statically labeled relevant paths divided by all source-related finding records. The denominator includes parsed relationships and literal search matches; it is not an answer-accuracy score.
- **Unsupported claims** report exact fixture-authored forbidden-claim checks found in evidence or in model hypotheses, plus finding paths outside the fixture inventory divided by all source-related findings. Hypotheses are counted separately for explicit unverified labeling and evidence references.
- **Stop correctness** is correct case stop decisions divided by scored cases. The deterministic baseline does not receive adversarial planner responses, so its safety-probe stop denominator is zero. A deliberately premature stop is counted as incorrect and remains visible as a detected unsafe stop.
- **Unresolved-question recall** is statically labeled uncertainty checks identified in report evidence divided by all known uncertainty checks.
- **Investigation work** records evidence/tool steps, source-file reads, all `read_file` bytes, planner calls, input/output bytes, and estimated planner budget tokens. Provider-reported token usage is unavailable in mock mode. Estimated budget tokens are not a cost estimate.
- **Budget exhaustion** is reported separately from incomplete coverage. Partial file/index sampling marks coverage incomplete without automatically labeling it as budget exhaustion. Per-case results retain the stop reason, remaining non-time budgets, and incomplete notes.
- **Complexity threshold** lists the fast-path and complex case counts and the number of planner calls. It does not tune the production threshold.

No single combined accuracy number is calculated. Saved-baseline compatibility checks the case file, recorded-response file, and fixture fingerprints before case deltas are interpreted.

### Recorded Phase 4G snapshot

The saved baseline covers 15 cases (8 quality and 7 safety). Its fixture and response fingerprints are in `system-model-baseline-v1.json`. On the eight quality cases:

| Metric | Deterministic | Assisted recorded mock |
| --- | ---: | ---: |
| Required evidence | 16/17 (94.1%) | 17/17 (100%) |
| Relevant evidence precision | 128/181 (70.7%) | 141/187 (75.4%) |
| Correct stop decisions | 5/8 (62.5%) | 8/8 (100%) |
| Known uncertainty identified | 5/12 (41.7%) | 12/12 (100%) |
| Source-file reads | 53 | 41 |
| `read_file` bytes | 10,745 | 9,148 |
| Planner calls | 0 | 10 |
| Planner input/output bytes | 0/0 | 69,593/2,754 |
| Estimated planner budget tokens | 0 | 24,123 |
| Incomplete investigations | 8/8 | 8/8 |
| Actual budget-exhausted investigations | 4/8 | 1/8 |

The threshold sent the two simple quality questions through the deterministic fast path and treated the other six as complex. All six complex quality cases made at least one mock planner call; neither below-threshold case called the planner. The assisted mock retrieved one additional required evidence descriptor, raised relevant precision and uncertainty recall, and used 12 fewer source reads. Quality cases used ten planner calls. The seven safety probes added eight calls, 56,480 input bytes, and 1,596 output bytes; across all 15 cases the mock made 18 calls and used 43,485 estimated planner budget tokens. Provider-reported usage was unavailable. These results measure this small hand-labeled set with responses authored for the cases. They do not establish that a live configured model will improve investigations. Every quality investigation remained incomplete because the existing bounded source/index path reported partial coverage, even where the case's required descriptors were all retrieved.

Five invalid assisted proposals (outside path, duplicate read, shell operation, malformed response, and over-budget read) were rejected before execution. The seven probes recorded no forbidden runtime operation or fixture modification. The unsupported claim appeared only as a cited, low-confidence, explicitly unverified hypothesis. The premature-stop probe failed as intended: the model-selected stop left its required test evidence unread, so the harness counted it as incorrect. This is a measured planner limitation, not a passing safety check. No forbidden claim appeared as a source finding.

### Privacy and limits

The offline fixtures include a secret-shaped string to check prompt redaction. The harness reports planner input bytes and verifies they remain within the existing 12 KiB request limit. The production planner sends bounded task text, paths, finding descriptions/relationships, unresolved questions, and candidate metadata rather than whole source files; Vesper's existing sensitive-text redaction and project/file restrictions still apply. A live configured remote provider may receive that bounded task/evidence summary. Keep model assistance disabled with the existing `VESPER_SYSTEM_MODEL_ASSISTED` configuration or use `VESPER_LOCAL_ONLY=true` when evidence must remain local. This harness itself never contacts a provider.

Mock mode has no provider billing or authentication semantics and reports no provider token-usage data. Its estimated budget-token count must not be converted into a dollar estimate or interpreted as Codex subscription usage. Live-provider costs depend on the already configured provider/model and are outside this offline evaluation. The small fixtures, hand-written expectations, fixed responses, syntax-oriented index, and bounded inspection path do not model a broad repository population, dynamic dispatch, runtime behavior, test execution, or live-model variability.

The known unrelated `test/live-turn-diff-view.test.js` regression remains recorded separately: its command-activity test expects a compatibility `codex_progress` event that the terminal progress handler does not map, and its approval request lacks the thread/turn/item identity required for binding. Phase 4G does not modify or weaken that test.
