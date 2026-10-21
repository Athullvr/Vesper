# TTY smoke test and integration readiness

## Actual CLI lifecycle smoke without Codex

Run `npm run test:pty` on a POSIX system with Python 3, Node.js and Git. The script launches the real `bin/vesper.js` in fresh PTYs, creates a disposable Git project and sets `HOME`, `CODEX_HOME` and `VESPER_HOME` to temporary directories. Its child `PATH` contains only Node.js and Git, so a Codex executable is unavailable. It sends only a locally routed Git-branch question and Vesper workspace/exit commands; it does not start the app-server or make network requests.

The check observes the prompt's raw terminal modes, project path, ordinary input, PTY resize responsiveness, idle Ctrl+C, Ctrl+D EOF, normal `:quit`, terminal-mode restoration, process-group cleanup, saved-session persistence, and redirected output bounds/control sequences. A PTY does not expose the cursor's rendered visibility, so the script verifies that Vesper emits no cursor-hide sequence; actual terminal-emulator rendering is outside this check.

## Local terminal smoke test

`test/tty-live-diff-smoke.cjs` is a controlled frontend driver. It feeds synthetic progress notifications through `TerminalFrontend` and does not construct `AppServerClient`, start Codex, execute a command, authenticate, or contact a model. The interactive mode requires an actual PTY (`stdin.isTTY` and `stdout.isTTY`) and a usable `TERM`.

From `experiments/fast-lane-app-server-poc`, run:

```sh
TERM=xterm-256color node test/tty-live-diff-smoke.cjs
```

Enter the following at the `vesper>` prompts, in order. During the first turn, answer `no` to the synthetic command approval request.

1. `Explain the synthetic terminal smoke test.`
2. `Explain interrupted terminal state.`
3. `Explain transport disconnect state.`
4. `Explain rendering recovery state.`
5. Enter `:quit` after the fourth turn.

The first turn emits two replacement snapshots, changes the PTY to 42 by 11 columns and sends `SIGWINCH`, emits a long multiline snapshot, interleaves synthetic streamed text and command activity, and updates the diff while an approval prompt is open. The second turn closes as interrupted, the third closes as disconnected, and the fourth injects a one-shot `stdout.write` failure during live rendering. The harness restores the original PTY dimensions and records its checks at `.audit-artifacts/tty-live-diff-smoke.json` (ignored by Git).

The `--non-tty` mode requires redirected stdout. Run it twice to check that redirected rendering is bounded and deterministic:

```sh
node test/tty-live-diff-smoke.cjs --non-tty > .audit-artifacts/non-tty-live-diff-smoke.log
node test/tty-live-diff-smoke.cjs --non-tty > .audit-artifacts/non-tty-live-diff-smoke.log
```

Compare `renderedDiffHash` in `.audit-artifacts/non-tty-live-diff-smoke.json` after each run. The mode sends two snapshots but expects only one bounded final unavailable summary; it never emits intermediate live frames.

These checks exercise Vesper's real Node terminal streams attached to a PTY, including actual `stty` resize and readline input. App-server events and command activity remain synthetic; the command marker explicitly states that no command ran. This is not a GUI terminal emulator check or a live Codex integration test.

## Disposable project prepared for a future live test

An isolated Git repository is ready at:

```text
experiments/fast-lane-app-server-poc/.audit-artifacts/disposable-e2e-project
```

It has no remote, branch `main`, one commit (`9d5a4fb Add disposable integration fixture`), and a single `target.txt` containing `change-me: original`. It is ignored by the Vesper repository. No Codex credentials, user Git configuration, project files outside this fixture, or network resources were used to prepare it.

The following sequence is for a future run only. It has not been executed. Authenticate or start a model-backed turn only after separately authorizing network access and authenticated execution. Keep the disposable Codex home and Vesper session home inside `.audit-artifacts`, and do not pass flags that bypass the configured approval or sandbox policy.

From the prototype folder:

```sh
E2E_PROJECT="$PWD/.audit-artifacts/disposable-e2e-project"
E2E_CODEX_HOME="$PWD/.audit-artifacts/e2e-codex-home"
E2E_VESPER_HOME="$PWD/.audit-artifacts/e2e-vesper-home"
mkdir -p "$E2E_CODEX_HOME" "$E2E_VESPER_HOME"
git -C "$E2E_PROJECT" status --short --branch
cat "$E2E_PROJECT/target.txt"
```

After explicit authorization, log in with the isolated Codex home using the installed Codex CLI's normal login flow, retaining its ordinary sandbox and approval settings:

```sh
CODEX_HOME="$E2E_CODEX_HOME" codex login
```

Then start Vesper with both homes scoped to the disposable run:

```sh
export CODEX_HOME="$E2E_CODEX_HOME"
export VESPER_HOME="$E2E_VESPER_HOME"
node ./bin/vesper.js --new "$E2E_PROJECT"
```

Record the printed Vesper session ID. Use this sequence in the live session:

1. **Real model-backed turn and streaming:** ask, `Run the read-only command cat target.txt once, then explain its two lines. Do not run any other command.` Confirm a streamed response and command item start/output/completion events. If Vesper does not receive the matching lifecycle events or the requested command differs, stop and record the discrepancy. Decline any request whose scope is not the expected read-only inspection.
2. **Proposed change and evidence association:** ask, `Propose changing only target.txt from "change-me: original" to "change-me: approved". Show me the exact change and wait for approval before applying it.` Confirm Vesper shows the file-change summary and the approval prompt uses evidence with the exact active thread, turn and item identity. Before deciding, from a second shell run `git -C "$E2E_PROJECT" diff --exit-code -- target.txt` and confirm the fixture is unchanged.
3. **Approval and resulting disk state:** only if the path and exact patch match the fixture, type `yes` once. After the turn, run:

   ```sh
   cat "$E2E_PROJECT/target.txt"
   git -C "$E2E_PROJECT" diff -- target.txt
   git -C "$E2E_PROJECT" status --short
   ```

   Check the actual disk content and Git diff. A displayed proposed or aggregate diff alone is not evidence of a write.
4. **Refusal:** restore the sole fixture in this disposable repository with `git -C "$E2E_PROJECT" restore -- target.txt`, confirm it is back to the initial content, request the same proposed change, and type `no`. Confirm the file remains unchanged and Git reports no target-file diff.
5. **Cancellation (optional separate case):** repeat after verifying the fixture is pristine, then answer `cancel` at the approval prompt. Confirm no disk change and that the turn/request reports cancellation or interruption according to the actual server events.
6. **Session recovery:** enter `:quit`, then resume the recorded Vesper session using the same homes:

   ```sh
   node ./bin/vesper.js --resume SESSION_ID "$E2E_PROJECT"
   ```

   Confirm the saved Codex thread resumes. Do not count a new thread as successful recovery.
7. **Final repository check:** after restoring only the disposable fixture to its original line, run:

   ```sh
   git -C "$E2E_PROJECT" status --short --branch
   git -C "$E2E_PROJECT" diff --exit-code
   git -C "$E2E_PROJECT" diff --cached --exit-code
   ```

Record whether every operation completed, was refused or was cancelled, and retain only the test outcome needed for review. Do not copy prompts, outputs, tokens, or credentials into the repository.

## Current validation boundary

The PTY smoke and redirected-output check use actual Node streams, while the app-server notifications are synthetic. The regular automated suite also uses mock app-server processes and fake TTY streams. No authenticated model, real app-server event stream, proposed live file approval, or real file modification has been tested in this milestone. Unicode cell-width approximation and behavior in other terminal emulators remain unverified.
