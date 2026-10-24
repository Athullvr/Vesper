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

At the time of this Phase 4G snapshot, `test/live-turn-diff-view.test.js` had a known approval/activity regression. Phase 4H documents the event-flow diagnosis and fix below; the Phase 4G measurement and baseline remain unchanged.

## Phase 4H held-out System Model evaluation

Run the independently authored held-out cases separately from the Phase 4G development cases:

```sh
npm run evaluate:system-model -- --set heldout --json /tmp/vesper-system-model-heldout-results.json
```

The command is fully offline and deterministic. It uses recorded planner responses, fresh fixture copies, a mock read-only Git interface, and the same permissioned runtime/evidence format as Vesper. It does not need credentials or network access and never runs scripts, tests, builds, or commands from a benchmark fixture. Development and held-out cases have separate case/response files. Expected evidence, findings, uncertainties, and stopping criteria are fixture-authored independently of the planner responses. The held-out case metadata records `authorship: independent-of-planner-responses` and `thresholdTunedOnThisSet: false`; do not tune the production complexity threshold against this set.

This held-out version contains nine quality cases and five adversarial safety cases in `system-model-heldout-cases.json`, backed by the small `ledger-api` fixture. Cases cover cross-file invoice behavior, a misleading legacy literal match, a computed worker path whose expected target is absent, a generated worker excluded by ignore rules, an ambiguous idempotency request, an easy manifest fast path, a task where additional reads do not help, a premature stop before a related test, and an unsupported runtime-order conclusion. Safety proposals include outside-project paths, duplicate reads, shell execution, malformed output, and a read after the budget is exhausted. Recorded assisted responses are in `system-model-heldout-planner-responses.json`.

Each mode runs against a fresh copy of the same case fixture. The original Phase 4G baseline, `system-model-baseline-v1.json`, is unchanged. The updated development snapshot is saved as `system-model-baseline-v2.json`; the independent held-out run is saved as `system-model-heldout-baseline-v1.json`. The runner refuses to overwrite an existing versioned baseline. The Phase 4H development snapshot comparison reports 13 case rows with changed evidence/uncertainty or related measured values against Phase 4G; its relevant-evidence totals are 141/189 deterministic and 148/194 assisted, versus the historical 128/181 and 141/187. Use `--compare PATH` to compare compatible case/fixture inputs and per-case evidence, uncertainty, stop, and work/coverage outcomes. The result includes benchmark version, fixture hashes, planner mode and config, per-case evidence status, and separate aggregate denominators. `--json PATH` writes sanitized machine-readable case details; raw prompts and raw provider responses are not stored.

### Held-out results, version 1

Exact command used to produce the saved offline result:

```sh
node benchmark/run-system-model.js --set heldout --write-baseline benchmark/system-model-heldout-baseline-v1.json --json /tmp/vesper-system-model-heldout-results-final.json
```

The two quality modes evaluated all 9 cases on equivalent fixture copies. The 5 safety probes are reported separately; the baseline never receives adversarial model proposals. Counts below use the explicit denominators shown.

| Quality metric | Deterministic | Assisted recorded mock |
| --- | ---: | ---: |
| Required evidence retrieved | 14/17 (82.4%) | 11/17 (64.7%) |
| Required evidence retrieved where path is available | 14/15 (93.3%) | 11/15 (73.3%) |
| Relevant evidence precision | 159/356 (44.7%) | 117/294 (39.8%) |
| Correct stop decisions | 6/9 (66.7%) | 6/9 (66.7%) |
| Known uncertainties identified | 4/8 (50.0%) | 6/8 (75.0%) |
| Source-file reads | 66 | 52 |
| `read_file` bytes inspected | 19,463 | 15,333 |
| Planner calls | 0 | 6 |
| Planner input/output bytes | 0/0 | 43,176/1,484 |
| Estimated planner budget tokens | 0 | 14,891 |
| Provider-reported token usage | unavailable (offline mock) | unavailable (offline mock) |
| Planner latency | not measured in reproducible offline mode | not measured in reproducible offline mode |
| Incomplete investigations | 9/9 | 9/9 |
| Budget-exhausted investigations | 0/9 | 0/9 |

Assistance reduced reads by 14 and raised uncertainty recall by 25 percentage points. It lowered total required-evidence recall by 17.7 points, available-path recall by 20 points, and relevant-evidence precision by 4.9 points; stop accuracy was unchanged. The result does not support claiming the assisted planner improves overall evidence quality on this held-out sample. The threshold kept five quality questions on the deterministic fast path and marked four complex; all four complex cases made at least one recorded planner call.

Unsupported findings and hypotheses are distinct. Both modes had 0/2 forbidden claims in source evidence and 0 findings outside the fixture inventory (0/356 deterministic, 0/294 assisted). Assisted planning surfaced the fixture-authored unsupported runtime-order claim in 1/2 checks, but the one hypothesis was marked unverified and cited one evidence record. Uncertainty recall is 4/8 deterministic versus 6/8 assisted. Five of five assisted adversarial stop checks were safely handled; no proposal executed a command, wrote a fixture, or bypassed permission checks. The deliberate premature-stop quality case is counted as an incorrect stop in both the quality report's six correct decisions out of nine; its unread required test remains visibly unverified.

Required-path status explains the recall denominator: one target file is absent from the fixture and one is excluded by fixture ignore rules, leaving 15 available expected evidence descriptors. Among the available-but-not-retrieved descriptors, the deterministic run read one file without emitting the expected finding; assisted planning inventoried but did not read three files and also read one file without emitting the expected finding. Missing and ignored paths are not counted as verified evidence. No claim of full coverage is made.

### Incomplete coverage analysis and bounded change

All 9 quality cases in both modes remain incomplete. The most common cause is candidate selection: the existing bounded source investigation sampled 4 of 8 candidate code files in all nine cases. Seven deterministic cases and three assisted cases also hit the existing 48-finding evidence cap. Four assisted cases hit the existing finding-bound on cross-file candidate discovery. Required-path diagnostics additionally identify unread inventoried files, one missing fixture path, one ignore-excluded path, and a read file with a missing expected finding. This separates candidate sampling, finding/index limits, unread relevant files, and unavailable evidence rather than marking a partial investigation complete.

The measured candidate traversal previously stopped at six directories before reaching relevant route/service/storage paths in this fixture, so the existing traversal cap was raised to sixteen while remaining bounded. The 48-finding ledger now replaces lower-priority path/literal/source-section hints with higher-priority parsed definitions/imports/call/test relationships when full; it still retains the same hard cap and reports truncation. The report now exposes a bounded list of paths excluded by ignore rules and labels computed `require`/`import` paths unresolved instead of guessing their targets. These changes improved inspectable provenance but did not make the held-out investigations complete. Candidate inventory, source-read, and index budgets remain, and the evidence shows no basis for a broader source-reading bypass.

### Optional live-provider evaluation

Live mode is opt-in and was **not run** for this report. The runner requires explicit selection of the already configured `openai-chat-completions` or `nvidia-nim` provider, `--confirm-live-charges`, model assistance enabled, a held-out quality case limit, planner-call limit, elapsed-time limit, and a JSON result path. It never switches provider or model, and it refuses to compare against or overwrite an offline baseline. For example, this optional command evaluates one quality case with at most two planner calls and 30 seconds elapsed:

```sh
VESPER_SYSTEM_MODEL_ASSISTED=1 npm run evaluate:system-model -- --set heldout --live-provider openai-chat-completions --confirm-live-charges --max-cases 1 --max-planner-calls 2 --max-elapsed-ms 30000 --json /tmp/vesper-system-model-live.json
```

Use `--live-provider nvidia-nim` to explicitly select NVIDIA instead. The command uses Vesper's existing configured adapter, credentials, endpoint, and model. It may incur separate API charges according to that provider's billing; a Codex subscription or credit is not assumed to cover them. It rejects live mode under `VESPER_LOCAL_ONLY=true` and requires `VESPER_SYSTEM_MODEL_ASSISTED=1`. The request is bounded to the existing redacted task/evidence metadata and provider output limits; source excerpts, whole repositories, command execution, fixture writes, tests, and builds are not sent or run. Provider-reported input/output/total token usage is recorded only when the adapter returns it; missing values remain unknown, and currency cost is always unknown. The JSON report is the documented inspection path for sanitized per-case outcomes. It excludes raw prompt/response text by default. A live request can still disclose the bounded task text, repository-relative paths, and evidence metadata to the selected remote provider; follow its privacy/retention settings.

### Metric definitions and limitations

- Required-evidence recall is retrieved independent descriptors divided by expected descriptors. Available-path recall excludes only descriptors whose paths are missing from the fixture or explicitly ignored; both totals remain visible.
- Relevant-evidence precision is source-related finding records on case-labeled relevant paths divided by all source-related records. It is not answer accuracy and includes literal search hits as well as parsed relationships.
- Unsupported claims count fixture-authored forbidden-claim checks in evidence and hypotheses separately. Out-of-fixture finding rate uses all source-finding records as its denominator. Model hypotheses are also checked for explicit unverified labels and evidence-reference counts.
- Stop correctness is scored per case with a defined stop expectation. Uncertainty recall is identified labeled uncertainties divided by the independent known-uncertainty checks.
- Source reads and bytes are measured from `read_file` tool operations. Offline planner calls are recorded mock calls; estimated planner-budget tokens are not provider usage or a cost estimate. Live provider latency and token usage are reported only when actually measured or returned. Missing provider usage and all currency costs are unknown.
- An incomplete investigation is not necessarily budget exhaustion. Inventory sampling, candidate bounds, index/finding caps, missing paths, ignored paths, and unread files remain visible even when required evidence happens to be found.

The fixtures are small, hand-authored JavaScript, TypeScript, and configuration examples. This sample does not establish broad repository performance or the likely quality of live models. The lexical index does not prove runtime control flow, dynamic module paths remain unresolved, and the harness never runs fixture tests to validate suggested verification opportunities. The saved results are deterministic and offline; no API keys or network are needed for the normal benchmark or tests.

The focused regression commands are:

```sh
node test/system-model-evaluation.test.js
node test/live-turn-diff-view.test.js
```

## Phase 4H live-turn approval/activity regression

The original failure was reproduced in the approval/activity assertion in `test/live-turn-diff-view.test.js`. App-server notifications arrived through the compatibility `codex_progress` event, while the terminal progress handler only handled native event names; consequently the live diff did not suspend for the command activity. Approval requests also traveled from the app-server JSON-RPC response through the Codex execution provider without the JSON-RPC request ID, so the activity could not be tied to the request that Vesper had actually approved.

The fix preserves Codex's app-server flow and one-time approval response: `app-server-client.js` carries the actual protocol request ID with approval callbacks and approval events, `codex-execution-provider.js` preserves it in the normalized approval activity, and `command-activity.js` keys approvals by their real request identity. `terminal-frontend.js` now maps only allowlisted compatibility `codex_progress` command activity and binds it to the active thread/turn. Missing, stale, or mismatched progress identities are ignored; missing approval request IDs are not fabricated or approved. Tests cover the request ID arriving at the live activity, turn scoping, and stale/mismatched progress. The complete live-turn-diff test file passed after this fix.

## Phase 4I multi-package repository evaluation

This extension evaluates the same System Model and permissioned runtime on curated source snapshots from three upstream workspaces. The evaluator copies each fixture to a new temporary project for each case and mode. It does not run commands, tests, or builds from a fixture. The checked-in fixture directories contain no `.git` metadata, dependencies, generated output, or secrets; Git status/history are therefore unavailable during these inspections. Git facts are reported as unavailable rather than fabricated. Each snapshot includes its upstream MIT license and root workspace metadata.

| Set | Repository and pinned revision | Included packages | Snapshot files |
| --- | --- | --- | ---: |
| Development | [changesets/changesets](https://github.com/changesets/changesets), `e2ee472cc6c901a0bb29781dac12603f6e4d5215` | `@changesets/cli`, `@changesets/read`, `@changesets/assemble-release-plan` | 16 |
| Development | [vitejs/vite](https://github.com/vitejs/vite), `82e7aa0374a15e1c67594557ab5893c91578f897` | `vite`, `@vitejs/plugin-legacy` | 17 |
| Held-out | [vuejs/core](https://github.com/vuejs/core), `0ff253bfba3ee8d3d65448bd44ad890fd01b0ecd` | `vue`, `@vue/runtime-dom`, `@vue/runtime-core`, `@vue/shared` | 20 |

The fixture manifest at `system-model-multipackage-repositories.json` records full revisions, source URLs, license, included packages, and omissions. Development questions and their independently written evidence locations, required findings, relevant paths, uncertainty checks, and stopping criteria are in `system-model-multipackage-development-cases.json` (five Changesets and five Vite tasks). `system-model-multipackage-heldout-cases.json` contains five Vue Core tasks written separately from the development set; compiler source and generated `dist` files are intentionally unavailable. The held-out threshold was not tuned. Recorded planner replies are stored separately from the cases.

The tasks cover cross-package entry/consumer traces, shared-interface impact, tests, misleading literals, lazy loading, incomplete package/compiler evidence, and simple manifest fast paths. Each `expectedEvidenceLocations` record names the path and explains why it matters. The Vite `normalizePath` descriptors accept the evaluator's `symbol` record because it carries an exact source path, line, and source-declaration description; the separately reported source index still marks the 2,005-line file as over its 2,000-line indexing limit. This corrects an evidence-type mismatch in the rubric, not the planner output.

Run both modes offline and save a new, immutable result version with:

```sh
node benchmark/run-system-model.js --set multipackage-development --write-baseline benchmark/system-model-multipackage-development-baseline-v3.json --json /tmp/vesper-system-model-multipackage-development-v3.json
node benchmark/run-system-model.js --set multipackage-heldout --write-baseline benchmark/system-model-multipackage-heldout-baseline-v3.json --json /tmp/vesper-system-model-multipackage-heldout-v3.json
```

The command prints per-repository and aggregate terminal summaries and writes the full per-case JSON, including the pinned revision and fixture fingerprint. To compare a later run without replacing a saved result, pass `--compare benchmark/system-model-multipackage-heldout-baseline-v3.json` (and use the development baseline for development cases). Normal operation is offline, requires no keys, and makes zero provider calls. The v1 and v2 multi-package files are preserved as earlier measurements; v3 is the final result after failure-stage instrumentation and the evidence-type correction. The original Phase 4G baselines are unchanged.

### Results

All counts below are measured from baseline v3. “Assisted” means the recorded deterministic planner-response fixture, not a live provider. Both modes receive the same case, fixture bytes, and independent expected answers. No amount is estimated from token counts.

| Repository / set | Mode | Required evidence | Relevant precision | Correct stops | Uncertainty identified | Candidate discovered / read | Source reads / bytes | Planner calls / estimated tokens | Incomplete / budget exhausted |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Changesets / development (5 cases) | Deterministic | 10/12 | 102/197 (51.8%) | 4/5 | 3/8 | 11/11 / 11/11 | 30 / 411,724 | 0 / 0 | 5/5 / 0/5 |
| Changesets / development (5 cases) | Assisted | 9/12 | 109/190 (57.4%) | 3/5 | 6/8 | 11/11 / 9/11 | 23 / 286,909 | 7 / 21,025 | 5/5 / 0/5 |
| Vite / development (5 cases) | Deterministic | 11/13 | 95/221 (43.0%) | 3/5 | 1/7 | 12/12 / 10/12 | 31 / 1,070,738 | 0 / 0 | 5/5 / 1/5 |
| Vite / development (5 cases) | Assisted | 11/13 | 114/176 (64.8%) | 2/5 | 3/7 | 12/12 / 10/12 | 23 / 854,362 | 7 / 21,244 | 5/5 / 0/5 |
| Vue Core / held-out (5 cases) | Deterministic | 5/13 | 105/189 (55.6%) | 0/5 | 0/8 | 10/12 / 7/12 | 24 / 387,076 | 0 / 0 | 5/5 / 0/5 |
| Vue Core / held-out (5 cases) | Assisted | 7/13 | 129/195 (66.2%) | 1/5 | 5/8 | 10/12 / 9/12 | 23 / 407,499 | 7 / 21,246 | 5/5 / 0/5 |
| Both development repositories (10 cases) | Deterministic | 21/25 | 197/418 (47.1%) | 7/10 | 4/15 | 23/23 / 21/23 | 61 / 1,482,462 | 0 / 0 | 10/10 / 1/10 |
| Both development repositories (10 cases) | Assisted | 20/25 | 223/366 (60.9%) | 5/10 | 9/15 | 23/23 / 19/23 | 46 / 1,141,271 | 14 / 42,269 | 10/10 / 0/10 |

The held-out Vue sample shows higher assisted retrieval (7/13 vs 5/13), relevant-evidence precision (66.2% vs 55.6%), uncertainty recall (5/8 vs 0/8), and candidate-path read recall (9/12 vs 7/12). Candidate discovery itself was unchanged at 10/12. Stop accuracy remained poor (1/5 assisted), all five investigations remained incomplete, and the assisted run read one fewer file while inspecting 20,423 more bytes. This supports a measured gain for this fixed recorded-response sample, not a conclusion about live model quality or a broad repository population.

On development, deterministic planning retrieved more required findings overall (21/25 vs 20/25), read more required candidate paths (21/23 vs 19/23), and made more correct stop decisions (7/10 vs 5/10). Recorded assistance raised relevant precision by 13.8 percentage points and uncertainty recall by 33.3 points, while reducing source reads by 15 and read-file bytes by 341,191. It used 14 planner calls and 42,269 estimated budget tokens. The result does not support replacing deterministic behavior with assistance for these cases.

The development assisted prompts/responses measured 122,326/4,449 input/output bytes. The held-out assisted mode measured 61,574/2,151 bytes across seven planner calls and 21,246 estimated budget tokens. These are local harness measurements; actual provider token usage is unknown because no provider was called. Offline planner latency was not measured.

In offline recorded mode the provider-reported token usage and latency are unavailable; estimated budget tokens are only the planner's internal accounting, not provider usage, API charges, or a Codex subscription estimate. The harness made zero provider API calls, so currency cost is unknown. Question-specific forbidden-claim checks were not authored for these quality cases, so that rate has no denominator. The measurable inventory check found 0 findings outside the fixture in 418 deterministic and 366 assisted development findings, and in 189 deterministic and 195 assisted held-out findings.

### Candidate, index, and stopping diagnosis

Each required descriptor retains its snapshot presence, permissioned inventory presence, ignore-rule observation, candidate rank, read status, source-index status, and earliest failure class. The JSON also retains the ranked candidate list (path, rank, score, search-match, entry-point/change flags, and whether it was read), exact source-read paths, candidate-discovery bounds, index skipped paths/reasons, and unresolved expected paths. A fixture omission is kept separate from an ignore rule that the runtime actually observed; the author-specified reason for unavailable paths is stored independently.

| Earliest failure class | Development deterministic | Development assisted | Held-out deterministic | Held-out assisted |
| --- | ---: | ---: | ---: | ---: |
| 1. Not present in permitted inventory | 0 | 0 | 0 | 0 |
| 2. Present but not discovered | 0 | 0 | 2 | 2 |
| 3. Discovered but ranked below read window | 2 | 3 | 3 | 1 |
| 4. Appropriate rank but not read before stop/budget | 0 | 1 | 0 | 0 |
| 5. Read but expected finding not emitted | 2 | 1 | 3 | 3 |
| 6. Properly excluded or unverifiable required evidence | 0 | 0 | 0 | 0 |

Counts classify missed required findings across each mode's cases; retrieved findings are not shown. The development rubric correction above means the two Vite utility definitions are now retrieved as source-backed `symbol` findings. The index still reports `file-limit` for `packages/vite/src/node/utils.ts` in two expected-path checks per mode; direct source scanning found `normalizePath` at line 234, but the bounded JS/TS relationship index did not process that 2,005-line file. This is an index-limit observation, not a missed definition after the corrected rubric.

The held-out discovery misses are `packages/runtime-core/src/renderer.ts` in the createApp and createVNode traces (two per mode). They were present and listed by the permitted inventory, but did not enter the ranked candidate list. Ranked-but-unread misses were mostly related test or shared-helper files below the initial read window. Other read-but-unemitted misses include the held-out `compileToFunction` question and root `test-unit` command: the source was read, but task-term symbol extraction did not emit the expected definition, and the root package script appears after the parser's 12-script manifest cap, respectively. Vue Core also reported only four of five manifests analyzed in every case. Each condition remains visible; no global file, byte, index, manifest, or model-call limit was raised.

All sets report partial discovery in 8/10 development cases and 3/5 held-out cases. The reference index was partial in all ten development cases and all five held-out cases. This broad partial flag includes the intentional fact that the index only contains source files actually read; per-path `file-limit` and `index-budget` reasons are available in the case JSON. Development required-path index statuses were `indexed=19`, `file-limit=2`, and `not-indexed-or-not-applicable=2` deterministic; assisted was `indexed=17`, `file-limit=2`, and `not-indexed-or-not-applicable=4`. Held-out status counts were `indexed=7`, `not-indexed-or-not-applicable=5` deterministic and `indexed=9`, `not-indexed-or-not-applicable=3` assisted.

No System Model budget or execution behavior was changed based on these results. The repeated bottlenecks point to separate follow-ups: improve task-term extraction for named declarations and high-value manifest scripts; make cross-package import targets easier to discover; and tune ranking/read selection using development data, then validate once on a fresh held-out repository set. Raising global budgets would not resolve the read-but-not-extracted cases, so no budget increase is justified here.

### Metric denominators and limitations

- Required evidence is independently retrieved descriptors divided by required descriptors (25 development and 13 held-out per mode); every required path in these sets is present in the curated snapshot, so available-path recall has the same denominator. Source-candidate selection/read recall excludes two root-manifest `projectCommand` descriptors: development is 23 path descriptors and held-out is 12. Aggregate candidate-selection recall is development 23/23 in both modes and held-out 10/12 in both modes. Required candidate paths read are development 21/23 deterministic and 19/23 assisted; held-out 7/12 and 9/12.
- Relevant-evidence precision is relevant-path source findings divided by every source finding: literal matches and parsed/source relationships are included. It is not answer correctness.
- Stop accuracy and uncertainty recall use the exact denominators in the result table. The expected stop rules and uncertainty labels live in the case files. A source test reference is not evidence that tests ran or that coverage is complete.
- Budget exhaustion is a subset of incomplete investigations. The development deterministic Vite cases hit the existing operation bound once; no held-out investigation exhausted a budget. Every case in both modes is still incomplete, including cases that retrieved all required descriptors.
- The sample uses only three hand-curated repositories and 15 authored tasks. The held-out set has one repository and is not enough to estimate general performance. Snapshot boundaries omit unrelated packages/files, and no evaluator result proves complete call graphs, test coverage, Git history/status, or runtime behavior. No live provider evaluation was run.
- To add a repository, pin a commit, include the upstream license and a small curated snapshot, record provenance and omissions in the repository manifest, then author expected paths/reasons and required evidence in the case file before writing a separate deterministic response fixture. Keep held-out cases and thresholds independent of tuning.

The multi-package focused evaluation checks run with `node test/system-model-evaluation.test.js`. Existing System Model, repository intelligence, source index, and live-diff tests should still be run as regressions; the overall suite should be run with child-process spawning enabled because this repository's suite launches child processes.
