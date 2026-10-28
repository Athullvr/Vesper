# Vesper external developer preview

Vesper is an experimental local-first coding interface. This guide gets a new developer from installation to one local inspection and one small reversible coding task. Vesper itself adds no telemetry and does not upload project data in the background. VS Code may make its own telemetry, update, and product-metadata requests according to its settings; review those separately if you need to control them.

## Prerequisites and install

- Node.js 18 or newer, npm, and Git.
- Codex CLI on `PATH` for the default provider. Codex uses its own CLI sign-in; it does not need an API key.
- VS Code 1.85 or newer for the extension. The extension host and other operating systems are not yet verified for this preview.

From a Vesper checkout:

```sh
cd experiments/fast-lane-app-server-poc
npm install --global .
vesper --help
vesper setup
```

Setup is read-only. It reports prerequisites and effective settings without changing the provider, storing credentials, or transmitting project data. Run `vesper doctor --project /path/to/project` for local diagnostics. See [INSTALL.md](INSTALL.md) for OpenAI/NVIDIA configuration, reset, and uninstall.

## Inspect a disposable project

Use a small throwaway Git project so you can compare Vesper's report with files you know:

```sh
mkdir -p /tmp/vesper-preview-project/src
cd /tmp/vesper-preview-project
git init
printf 'export function greet(name) { return `Hello, ${name}!`; }\n' > src/greeting.js
git add src/greeting.js
git -c user.name=Preview -c user.email=preview@example.invalid commit -m 'Add greeting fixture'
vesper doctor --project "$PWD"
vesper inspect "Trace greet in src/greeting.js" --project "$PWD"
```

Inspection is local and read-only by default. It reports bounded evidence and may be partial; it does not run tests or establish a complete call graph.

## Try one reversible coding task

The default Codex provider needs a local Codex CLI sign-in. For OpenAI or NVIDIA, configure the model and key through a secret manager or secure environment injection, then run `vesper setup --provider PROVIDER_ID` and `vesper providers status --provider PROVIDER_ID`. Do not put keys in command arguments, source files, or shared logs. The [provider validation procedure](PROVIDER-LIVE-VALIDATION.md) keeps a live smoke request separate from this coding task.

From the disposable project, start a new CLI session:

```sh
vesper --new "$PWD"
```

Enter this task:

> Add an exported `farewell(name)` function to `src/greeting.js` that returns `Goodbye, ${name}!`. Edit only that file. Do not run commands or tests.

Review the proposed paths and approval request before accepting anything. Codex keeps its native approval flow. Vesper-managed file proposals require a fresh one-time terminal approval. Providers cannot run shell commands. After the task, compare the result with:

```sh
git status --short
git diff --check
git diff -- src/greeting.js
```

The VS Code panel can inspect and discuss a project, but its current Codex policy is read-only and it declines native approval requests. Use the terminal for this write-task preview. Reset only the known fixture edit after review with `git restore -- src/greeting.js`.

## Known preview limits

- The npm package name and Marketplace publisher must be finalized before a public registry release. A VSIX preview can be installed from a local file without publishing.
- Only the stated Linux x64 / Node.js 20 host has been exercised. Other OS and Node versions are unverified.
- Authenticated provider turns, VS Code graphical activation, and real file-write approval flows remain separate checks; see the release report.
- Optional rootless Podman command isolation is not validated and remains disabled by default. Vesper does not fall back to host command execution.
- Repository inspection is bounded and language coverage is partial. Dynamic dispatch, aliases, reflection, and framework conventions can hide relationships.
- This checkout has no root `LICENSE` file or package license declaration. The VSIX packager warns about this; do not publish or redistribute the artifact until the project license is decided.

For a reproducible bug report, copy [PREVIEW-FEEDBACK.md](PREVIEW-FEEDBACK.md), remove private paths and source, and never include keys, tokens, or request headers.

For the isolated VS Code interaction, approval-boundary, provider-failure, and shutdown checks, use [PREVIEW-VALIDATION-CHECKLIST.md](PREVIEW-VALIDATION-CHECKLIST.md). Return results only with the tester's explicit consent.
