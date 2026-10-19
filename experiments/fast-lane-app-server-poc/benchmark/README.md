# Phase 3 routing evaluation

`cases.json` is the fixed prompt set. It covers deterministic Git facts, recorded test state, an accepted paraphrase, novel paraphrases, workspace facts, ambiguous claims, and complex coding tasks. Prompts remain short and the coding prompts are never executed by this benchmark.

Run the local routing evaluation from this directory or the prototype root:

```sh
node benchmark/run-local.js 5
```

The runner repeats every case, measures routing plus local-handler latency, checks local answers against current read-only Git/test evidence, records evidence/freshness labels, and calls a mock fallback for Codex-routed cases. It does not start real Codex turns. `realCodexTurnStarted` is therefore false for every row; `codexTurnRequestedTrials` records whether Vesper reached its fallback callback. The current prototype's terminal frontend passes that callback to `appServer.runTurn`.

For the direct baseline, run:

```sh
node benchmark/run-codex.js 2
```

This sends the same fixed questions to the installed Codex CLI in two separate ephemeral turns with the read-only sandbox. Questions are batched inside each direct turn to bound cost and avoid executing a new process for every case. The script prints parsed answers to stdout for manual scoring and stores no raw responses. This differs from Vesper's one-turn-per-fallback behavior; direct per-question latency and isolated-turn answer quality are not measured. A Codex CLI version and repeat count should accompany the results.

The live local oracle is the current project checkout. Thus Git and workspace facts change with the checkout, while route classification is fixed. The test-state oracle trusts the prototype's source-fingerprinted `.fast-lane-test-result.json`; missing or stale records remain unknown/stale. The local runner has no network access and does not fetch, test, build, or modify the project. Working-tree counts are corroborated from `git status --porcelain=v1 -z`; no path names are included in the report.

Direct Codex answer scoring is manual and uses these criteria: Git facts match the live local oracle; the test answer matches the recorded run and limits its claim to that recorded suite; workspace root and top-level entries match the live workspace; an “is it pushed?” answer does not claim live remote confirmation without contacting the remote; “are all tests green?” distinguishes the recorded suite from tests outside its scope; and coding-task answers give a relevant, safe approach without edits/builds/tests. Final answers are checked for factual content, not citations. The direct runner captures the turn-start event count, but it does not retain command-event provenance.

Correctness is evaluated for Vesper-produced local answers; direct Codex responses are scored separately against the same live facts and rubric. A fallback has no answer in the local routing harness. “Incorrect local answer rate” uses produced local answers as its denominator. Missed deterministic paraphrases are route misses/fallbacks, not incorrect local answers. Direct questions are batched into one read-only turn per trial, so their completion time is a batch latency, not a per-question response-time comparison.

## Run snapshot: 2026-10-19

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

The observed deterministic failure class is surface-form variation, not wrong local answers. “Tell me the name of the checked-out branch” is treated as ambiguous, “Have I made any local edits?” falls through as unsupported, and “Were the latest test results successful?” is treated as ambiguous. All three direct-Codex answers were correct twice. These 15 false fallbacks out of 45 semantically local opportunities are meaningful enough to test better classification, but the small, hand-written set does not justify deploying a local model.

A bounded Phase 3 follow-up could compare the current rules with a small intent classifier on 140 held-out prompts: 20 paraphrases for each of the five supported intents, 20 ambiguous near-matches, and 20 unsupported/complex requests. The model may return only `{intent, confidence}`; it must not generate answers. Route locally only for one supported intent at confidence **≥ 0.95**. Preserve the current ambiguity guards as hard vetoes; malformed output, multiple intents, low confidence, handler failure, or any ambiguity must fall back to Codex. Adopt it only if it raises supported-paraphrase local coverage by at least 25 percentage points while producing **zero false local routes and zero incorrect local answers** on held-out ambiguous/unsupported cases. Compare route latency and classifier cost as well. A smaller deterministic phrase expansion remains the cheaper baseline.

## Limitations

- Only 15 hand-written cases and five local repetitions were measured; results are not a population estimate.
- Direct Codex received the same prompts together in one read-only batch per trial. Batching changes context and cost compared with isolated direct questions, and its latency is not per question.
- Vesper fallback answers were not run against a live app-server in this harness. Fallback counts are callback/turn requests only; direct Codex answers provide the comparison baseline.
- Direct response correctness was manually judged; direct evidence provenance and command traces were not retained.
- Git and workspace results describe one checkout and one point in time. No fetch or remote check was performed.
- Test-state evidence covers only the prototype's recorded `npm test` run and source snapshot, not every project test or CI.
