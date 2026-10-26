# Vesper CLI and VS Code extension

Vesper is a local-first coding-agent interface with two frontends over the same routing core:

- A VS Code extension panel that answers explicit Git and test-evidence questions locally and sends other prompts to the selected execution provider.
- A terminal CLI named `vesper` with local-first repository inspection and provider-backed coding sessions.

The package uses Node.js built-ins, Git, the VS Code Extension API, and (for the default provider) the installed Codex CLI. It has no npm runtime dependencies. The [installation guide](INSTALL.md) covers first run, provider configuration, diagnostics, privacy, reset, and uninstall.

The [developer task workflow](DEVELOPER-WORKFLOW.md) documents the shared terminal/VS Code lifecycle, status rules, one-time approval gates, `:verify`, the deterministic multi-package scenario, and the current host/sandbox limitations.

From the source checkout, `npm run test:pty` exercises the CLI lifecycle in a pseudo-terminal. Test files and benchmark fixtures are deliberately omitted from the packed runtime installation.

## Terminal frontend

Requirements: Node.js 18 or newer and Git. Codex CLI on `PATH` is required for Codex-backed tasks. Install from this folder and review local prerequisites:

```sh
npm install --global .
vesper --help
vesper setup
vesper doctor --project /path/to/project
```

Inspect a project locally or run the CLI from source without a global install:

```sh
npm run cli -- inspect "Trace handleCheckout" --project /path/to/project
vesper inspect "Trace handleCheckout" --project /path/to/project
```

Setup and doctor are read-only and do not validate remote credentials. The default Codex integration uses Codex CLI authentication and does not require an API key. Optional OpenAI and NVIDIA API setup is documented in [INSTALL.md](INSTALL.md).

The default launch resumes the most recently updated Vesper session for that exact canonical project, or creates one if none exists. Use `vesper --new` to create a separate session. `vesper run` is an explicit alias for the normal terminal workflow.

Project-scoped session commands are also available:

```sh
vesper sessions list
vesper sessions resume SESSION_ID
vesper sessions new
```

`list` shows at most the 50 newest sessions for the selected canonical project and prints the Vesper id, update time, provider, and whether a provider conversation is saved. Session metadata does not retain a title or prompt preview. `resume` defaults to the current project and rejects a session saved for another project; it resumes with the same provider recorded on that session. `new` creates a separate session and leaves existing sessions intact. Each command accepts an optional project directory.

The interactive workspace keeps task text separate from workspace commands. Use `:providers` and `:tools` to inspect local support, `:new [PROVIDER_ID [MODEL_ID]]` to create a separately scoped provider/model session, `:plan TASK` to preview an advisory plan, `:inspect [TASK]` to inspect this repository locally, and `:capabilities` to inspect discovered extensions. Ordinary terminal input is routed as a Vesper task or local query; Vesper does not intercept arbitrary shell commands. Code-oriented provider tasks get a bounded, read-only repository preflight before dispatch. Explicit commands remain behind the isolated, approval-gated `run_command` tool.

Read-only integration discovery is available from the terminal. `vesper plugins` checks project and personal local marketplace manifests plus the local plugin cache; `vesper mcp` uses Codex's JSON listing command; and `vesper skills` checks project and user skill directories. These commands show only names, status, and source, never MCP command arguments, environment values, skill instructions, or conversation text. `vesper modules` is not implemented.

The unified catalog supports list, search, detail, and status workflows:

```sh
vesper capabilities
vesper capabilities search git
vesper capabilities show skill:project/review/SKILL.md
vesper capabilities status
vesper plan "Query the configured PostgreSQL database for the latest migration state"
```

IDs are stable for a source identity: plugins use `plugin:MARKETPLACE/NAME`, MCP servers use `mcp:NAME`, and skills use `skill:project/RELATIVE_PATH` or `skill:user/RELATIVE_PATH`. Capability details show installation, configuration, enabled state, runtime-loaded state, operational state, source, and observation time separately. Unknown values remain explicit.

The Codex runtime adapter uses only `mcpServer/startupStatus/updated` notifications already received by an existing Vesper app-server thread. A `ready` event confirms that Codex completed MCP startup in that thread and marks it available for use; it does not prove tool health, so operational status stays unknown. `failed` or `cancelled` startup is shown as unavailable, with raw runtime error text withheld. Malformed notifications are ignored and counted; valid observations are retained separately. The adapter does not start or resume a thread, call `mcpServerStatus/list`, execute an MCP tool, or contact a remote server. Consequently, the standalone `vesper capabilities status` command has no active app-server thread and reports runtime inspection as unsupported; it does not attach to or resume saved sessions. Terminal and VS Code expose passive observations through the existing routing-context provider; the current routing heuristics do not consume them. Plugin and skill runtime-loaded state remains unknown because the inspected local protocol has no passive runtime-loaded signal for those types.

For example, a standalone status command may report:

```text
Runtime inspection: unsupported
Runtime loaded: yes 0 · no 0 · unknown 3
Operational: yes 0 · no 0 · unknown 3
Runtime note: No already-connected Codex app-server thread is available. Vesper does not start a runtime for status inspection.
```

The installed `codex-cli 0.162.1` schema also contains a richer MCP status RPC, but it can inspect server state and is not called here. Codex `plugin/list` may include remote marketplace data and is not used. The catalog provider exposes only bounded status enums and stable capability IDs to routing context; Vesper does not pass source details, runtime errors, environment values, or credentials into Codex, and it does not change routing heuristics.

## Advisory capability plans

`vesper plan TASK [--project PROJECT_DIRECTORY]` prints a deterministic, read-only preview based on the normalized local catalog and the existing router decision. In the terminal workspace, use `:plan TASK`. The VS Code panel's **Plan** button previews the text currently in the prompt box without sending it. Plan output is labeled advisory and not executed; it never starts or resumes Codex, activates a skill/plugin, launches an MCP server, or calls an MCP tool.

The planner uses bounded topic and metadata matching over capability IDs, names, descriptions, declared capabilities, and supported command names when present. It does not use a model. Local Git and test handlers remain authoritative for their existing local routes; a matching capability can be shown in a preview, but it is declined because the local handler already covers the request. On Codex routes it adds only a bounded category, relevant IDs, eligibility states, and reason codes to the existing in-process routing context. This metadata is not included in routing diagnostics or telemetry and does not change the route.

Eligibility is deliberately stricter than discovery. A fresh, timestamped Codex `ready` startup observation for a configured and enabled MCP server can make it **usable to try**; its separate `operational` field remains `unknown` because Vesper does not call tools or run health checks. A fresh failed or cancelled startup, explicit disablement, uninstalled plugin, or missing requirements is unavailable. A runtime observation older than 15 minutes is stale; even an old failure remains uncertain and is never recommended as available. Missing timestamps, unsupported inspection, and unknown states stay uncertain. A discovered skill file is not treated as an explicit configuration setting. Plugin and skill runtime loading remain unknown with the currently inspected Codex signal. “Usable to try” is not a claim that a server tool, plugin, or skill worked.

Example plan outcomes:

```text
$ vesper plan "Query the configured PostgreSQL database"
Vesper plan · advisory only · not executed
Task category: database and SQL work
Existing route: codex · codex_fallback
Relevant capabilities:
- mcp:postgres · mcp · PostgreSQL · usable to try
  State: discovered yes; installed not_applicable; configured yes; enabled yes; available yes; loaded yes; operational unknown; ...
  Codex-reported MCP startup: ready; this is not a tool health check.
Eligible to try: mcp:postgres
Vesper does not automatically select or execute capabilities from this advisory plan.

$ vesper plan "Review the database migration plan"
Vesper plan · advisory only · not executed
Relevant capabilities:
- mcp:postgres · mcp · PostgreSQL · unavailable
  Recommendation declined: Codex reported that MCP startup failed; it is not recommended as available.
Eligible to try: none

$ vesper plan "Draft a short release announcement"
Vesper plan · advisory only · not executed
Relevant capabilities: none
Execution path: codex_fallback
```

The second example depends on matching local metadata and a failed observation; the third shows the valid no-match case. Plans list at most eight relevant capabilities and truncate display output at a fixed limit. Full task text is not copied into the plan object or routing metadata.

## Repository intelligence and System Model

The repository-intelligence service builds bounded evidence from the selected project through Vesper's existing permissioned read-only runtime. Use it directly without starting a provider:

```sh
vesper inspect
vesper inspect "Trace handleCheckout through the service layer" --project /path/to/project
```

Inside the terminal workspace, `:inspect [TASK]` prints the same kind of report. For code-oriented terminal and VS Code tasks, Vesper performs a local preflight, shows its status and grounded next steps, then sends a bounded synthesized evidence summary alongside the original task. The findings are scoped to the active project, provider, and Vesper session and are attached only to that submission; a separate inspection is not reused later. Model-assisted planning is an optional extra completion only for complex questions when explicitly enabled. In VS Code, Stop cancels preflight, including an active planning request, before task submission. If inspection fails, the panel reports unknown coverage and submits the original task once without repository evidence. Partial investigation remains labeled.

Model-assisted investigation is disabled by default. Set `VESPER_SYSTEM_MODEL_ASSISTED=1` to let complex or ambiguous repository questions ask the already selected OpenAI Chat Completions or NVIDIA NIM provider for a bounded next-read/stop decision. The request uses that provider's configured model, endpoint, API key, and normal billing/authentication. It does not switch models. The Codex app-server adapter has no stateless planning operation, so Codex uses deterministic planning even when this setting is enabled. `VESPER_LOCAL_ONLY=1` forces local-only behavior and disables model calls. Simple questions stay on the deterministic fast path.

The planner receives the user question plus bounded, redacted evidence metadata: finding types and descriptions, paths and line ranges, confidence/observation labels, unread candidate paths, and remaining budgets. It receives no source excerpts or repository archive; the current planner sends zero source bytes. Obvious credentials are redacted from the task and evidence text before submission. Even so, task text, project-relative paths, and evidence summaries may leave the machine when remote planning is enabled. Review the selected provider's privacy and retention settings before enabling it for private repositories. Planning is not added to Vesper's conversation history or task evidence as a transcript. The request includes `store: false`, but provider retention and account data controls remain subject to that provider's terms and settings.

Each investigation allows at most two planning calls and two model-selected follow-up reads, 12 KiB input per call, 4 KiB output per call, 400 output tokens per call, and 8,000 total estimated or reported tokens, within the existing 10-second investigation, five targeted-read, 64 KiB per-file, 512 KiB source, and 32-operation bounds. Provider usage tokens are recorded when returned; Vesper does not estimate a currency charge because pricing depends on the configured provider/model and account terms. Remote calls may incur separate API charges; a Codex subscription or credit is not assumed to cover OpenAI/NVIDIA API usage. On timeout, cancellation, malformed output, rejected actions, or budget exhaustion, Vesper uses its deterministic planner or returns a partial report with unresolved questions.

The service examines at most 600 inventory entries, sixteen directories, four manifests, four initial source/config reads plus five justified follow-up reads, 64 KiB per analyzed source file, 2,000 lines per analyzed file, 512 KiB of source content read for evidence, 32 permissioned operations, and about 10 seconds. Change-impact investigations add one bounded `search_files` operation over at most 128 eligible inventory files, at most 64 KiB each (8 MiB total), for up to four literal task terms. Search results contain only bounded, redacted match lines and repository-relative paths; they remain candidates until a targeted read or language scan classifies the relationship. If inventory or search limits are reached, the report says so. Each operation is validated by the existing project-scoped runtime before dispatch. For trace, bug, investigation, impact, and change-planning questions, the deterministic System Model can follow up to two project-local import hops when inspected evidence points to an unread inventoried file. It stops when no read is justified or a bound is reached, and reports ordered operations, exact observed line ranges, unresolved questions, and remaining budget. Git status/history/diff and Git ignore checks run locally when safe in-project `.git` metadata is available. Without Git, a bounded subset of `.gitignore` rules is applied. Common generated/dependency directories, generated-looking source files, sensitive credential-like paths, and symbolic links are excluded from source analysis and from the explicit search file list. Git ignore checks use project `.gitignore` and `.git/info/exclude`; global excludes are not read. Git status omits untracked files, and the current diff is unstaged tracked changes only.

For `vesper inspect "Trace handleCheckout"`, the same bounded reads also feed a rebuildable JS/TS symbol/reference index. It uses a small lexical scanner (no parser dependency) for function, method, class, and type declarations; imports and exports; identifier references; likely call syntax; recognizable route-handler registrations; and test-path references. These findings include path, line, discovery method, confidence, and whether the source file was read. A call-shaped identifier is only a candidate relationship: aliasing, dynamic dispatch, reflection, and framework conventions prevent a complete or authoritative call graph.

The index covers JavaScript and TypeScript files admitted by repository inventory and read through `read_file`; other languages continue to receive the existing import and text inspection, but do not get symbol-index claims. It is limited to 12 files, 64 KiB and 2,000 lines per file, 512 KiB total, 24,000 lexical tokens per file, 750 ms total parser time, and 2,400 retained relationships (400 per file). The existing four initial reads and five targeted reads remain the per-inspection ceiling for full source evidence. The separate candidate search scans a bounded set of inventoried paths locally and does not add entire files to model context. The System Model uses indexed definitions and search-hit paths to prioritize same-directory and test-file reads after observed local imports.

For impact analysis, use `vesper inspect "Impact of changing handleCheckout to validate tax" --project /path/to/project` or `:impact Impact of changing handleCheckout to validate tax`. The report groups definitions, syntactic call candidates, local import dependencies, route matches, test references, working-tree changes, and unresolved coverage gaps. These are separately labeled: a text match is not a caller, an import is not proof of runtime execution, and a nearby test is not proof of coverage. The inventory may be partial, and dynamic dispatch, reflection, aliases, and framework conventions remain outside the scanner's guarantees.

For a coding task, submit the implementation request as ordinary task text, for example `Add tax validation to handleCheckout`. The existing local preflight runs on that task, attaches only the bounded synthesized findings and suggested verification commands to the selected provider request, and preserves the selected provider/session. Codex continues through its app-server and native approval flow; other providers retain their current contract and approval gates. The preflight does not execute tests, scripts, or project commands. For remote OpenAI/NVIDIA providers, code-oriented tasks include this bounded summary in the existing task request; full repository files are not sent by preflight. A separate `vesper inspect`/`:impact` run is an explanation and does not persist or silently attach evidence to a later task.

Each inspection builds relationships only from files freshly read in that inspection. Vesper retains only the prior read-file content digests to report changed or removed paths and same-content renames; cached line references are never returned as current evidence. Newly discovered, unread, oversized, ignored, binary, malformed, unsupported-language, or budget-limited files are reported as incomplete or omitted. A changed file's current line numbers come from its fresh read; if an earlier indexed file is not reread, its old relationships are discarded and the report says so.

Example `vesper inspect "Trace handleCheckout"` additions:

```text
JS/TS reference index: partial · 6/19 eligible files · 42 relationships · 2 excluded or unsupported.
Symbol references and candidate relationships (not a complete call graph):
- likely-call-site · src/routes/checkout.ts:38 → handleCheckout [medium; source read].
- test-reference · src/routes/checkout.test.ts:21 → handleCheckout [medium; source read].
```

Counts and paths vary with the repository and remaining investigation budget. `partial` means Vesper did not index every eligible source file; it never implies the missing files have no references.

Manifest declarations, dependency summaries, language counts, framework indicators, source symbols, textual references, import edges, and likely entry points are reported with relative paths, actual inspected line references where available, source, confidence, observation kind, status, and observation time. Duplicate inspected symbol declarations are marked ambiguous. Package-declared entry points are distinguished from conventional inferences. Import tracing currently recognizes simple relative JavaScript/TypeScript imports, Python relative imports, Rust `mod` declarations, and quoted C/C++ includes. Import edges show declared local module dependencies only; they do not prove that a function calls another function, establish runtime order, or form a complete call graph. Missing symbols, unresolved relative imports, unsupported or malformed manifests, generated files, inaccessible paths, absent Git metadata, contradictory declarations, and coverage limits remain visible. Suggested test/build commands are never run automatically.

Examples:

```sh
vesper inspect "Trace handleCheckout request flow" --project /path/to/project
vesper inspect "What changed recently that might explain the login regression?" --project /path/to/project
```

The matching terminal command is `:inspect <question>`. Both workflows use the same System Model and investigation service. With model assistance disabled, they stay deterministic and local. When enabled for a complex question, the model can only choose an unread candidate path for the existing bounded `read_file` operation or stop; Vesper validates the strict response and the existing permissioned runtime performs every read. No arbitrary commands, automatic tests/builds, writes, approval bypass, parallel evidence database, or provider switching are available to the planner.

Test/build/start commands are identified from manifests as observed or inferred suggestions; Vesper never runs them automatically. Repository contents are untrusted input. For remote OpenAI/NVIDIA sessions, the selected provider receives the task and the bounded synthesized repository summary, not full source files from this preflight. Existing structured tool calls may separately request bounded file results through the permissioned runtime. Review the provider's data-sharing settings before using remote providers with private repositories.

The System Model classifies investigation intent, selects bounded local inspections, collects findings into the existing task-evidence ledger, and returns a grounded plan, unresolved assumptions, and verification requirements. Its deterministic selector remains the fallback. Model-generated hypotheses are kept separate from source findings and cite existing evidence; they are labeled unverified. A model cannot execute tools, select or switch providers, install capabilities, or change files. Codex continues through its native app-server execution and approval path; OpenAI/NVIDIA use their existing adapters and runtime approval boundary.

Vesper can manage only operations with a documented Codex CLI interface. Each operation prints the exact target, intended change, backup/recovery guidance, then requires typing the capability ID:

```sh
vesper capabilities install plugin:marketplace/plugin-name
vesper capabilities remove plugin:marketplace/plugin-name
vesper capabilities remove mcp:server-name
vesper capabilities configure mcp local-server --stdio /path/to/server --arg start
vesper capabilities configure mcp hosted-server --url https://mcp.example.org --bearer-token-env-var MCP_TOKEN
```

Plugin install/remove and MCP add/remove use the installed `codex plugin` and `codex mcp` commands. Before invoking them, Vesper copies an existing `$CODEX_HOME/config.toml` to a unique mode-`0600` backup. The Codex CLI performs the configuration change, preserving unrelated settings according to its own implementation. Vesper reports completion only after local discovery verifies the result. Plugin installation can download remote marketplace content: treat it as untrusted. Vesper does not execute the downloaded code, though Codex may load the installed capability in later use. Codex documents that installing a plugin does not automatically trust its lifecycle hooks; Codex skips plugin-bundled hooks until the user reviews and trusts the current hook definition ([plugin package documentation](https://developers.openai.com/plugins/build/plugins)). MCP setup stores the configuration but Vesper does not launch the server. Vesper does not accept environment-variable values; for an HTTP bearer token, provide only the environment-variable name.

For an installed plugin listed in the selected project's `.agents/plugins/marketplace.json`, Vesper can also manage that project's documented plugin override:

```sh
vesper capabilities enable plugin:local-market/plugin-name
vesper capabilities disable plugin:local-market/plugin-name
```

These commands edit only `.codex/config.toml` in that project, using `[plugins."plugin-name@local-market"]` and its `enabled` boolean. Vesper shows the exact file and setting, requires the exact capability ID, and backs up an existing config beside the file with mode `0600`. It preserves the existing config mode and unrelated text. If it creates the file, it uses mode `0600`; a missing `.codex` directory is created with requested mode `0700` (subject to the process umask). Vesper verifies the resulting project setting. A project setting does not prove the project is trusted, the effective plugin state, or runtime loading; those states remain unknown. If the file or a table cannot be parsed safely, Vesper refuses the change. The official [plugin package documentation](https://developers.openai.com/plugins/build/plugins) describes this project setting and the trust boundary.

Standalone MCP and skill enable/disable remain unsupported, and the inspected Codex CLI has no MCP update command. To replace an MCP definition, remove it and configure it again. Skills are read-only in this version. Configuration details and environment values are not printed; stdio arguments are omitted from the confirmation summary. Avoid passing secret values as command arguments because the operating system may expose process arguments to local users.

To run straight from the checkout without linking or opening VS Code, invoke the checked-in launcher from the project directory:

```sh
node /path/to/Vesper/experiments/fast-lane-app-server-poc/bin/vesper.js
```

Vesper prints the session id at startup. Resume that Vesper session and its saved Codex thread with:

```sh
vesper --resume SESSION_ID
```

An optional project path on resume must resolve to the same directory recorded for that session.

The interactive workspace shows the canonical project path and active Vesper session. Enter a task at `vesper> ` to use local-first routing or a streamed Codex turn. The workspace commands are:

```text
:sessions              list this project's recent sessions
:switch SESSION_ID     switch to a saved session in this project
:new                   create and select a separate session
:capabilities status   show current catalog and passive runtime observations
:capabilities show ID  inspect one capability in this session
:plan TASK             preview an advisory plan without executing it
:inspect [TASK]        inspect this project locally without calling a model
:routing               show routing outcome counts for the active session
:help                  show workspace commands
:quit                  exit and keep saved sessions
```

The interactive `:capabilities status` and `:capabilities show ID` commands inspect the current process's catalog and any MCP startup events already observed on its active Codex thread. They do not start a thread or perform a status RPC. The standalone `vesper capabilities status` command remains read-only and reports runtime inspection as unsupported because it has no attached thread.

Session lists show at most 50 ids, update times, and whether a saved Codex thread exists; they do not show prompts or conversation text. Switching verifies the saved thread through Codex `thread/resume` before restoring bounded history. A reconnect failure leaves that session selected and saved, reports the error, and retries on a later task. `Ctrl+C` during a Codex turn requests interruption and returns to the prompt when the turn ends; `Ctrl+C` at an idle prompt exits cleanly. EOF also exits. TTY output uses the existing bounded live diff view and cleans up its resize listener; redirected input/output stays line based with no cursor-mode changes.

Exact supported local questions are answered before the app-server starts. Other and ambiguous prompts use the installed Codex app-server. Vesper starts a Codex thread lazily on the first fallback, then sends later fallback prompts to that same thread. Resuming a saved session calls `thread/resume`; it will report an error if that thread or directory cannot be resumed rather than silently replacing it with a new conversation.

Each task prints one short `[Route · …]` indicator based on the router decision and, for local requests, the handler's returned status. `VESPER_ROUTING_DEBUG=1` adds a bounded JSON routing record with stable reason/outcome codes and a concise explanation; it omits the submitted prompt, handler summary, and evidence payload. A `confirmed` handler status describes the local result's status and does not independently verify its correctness. Unknown, stale, or unavailable local results remain local; local-handler failures do not fall back to Codex.

`:routing` shows counts for routing decisions recorded in the active in-memory Vesper session, grouped by stable router reason code. A Codex delegation is a routing outcome and does not mean its task succeeded. Counts are neither persisted nor restored when a saved session is resumed; they reset when switching sessions. The command reads only the bounded aggregate counters and does not display prompts, responses, evidence, or handler errors. Missing optional counters appear as `—`.

Before the first Codex task in a resumed Vesper session, the terminal verifies the saved thread and restores the latest 50 Codex turns through the existing bounded history projection. If history retrieval fails after the thread is verified, Vesper reports it as unavailable and keeps the thread usable. Local answers were never sent to Codex, so they are not part of that history. This does not attach to or import a conversation started directly with `codex`.

The terminal app-server client was implemented against the schema generated by the installed `codex-cli 0.162.1` (`codex app-server generate-json-schema --experimental`). It initializes JSON-RPC over stdio, uses `thread/start` or `thread/resume`, streams agent text deltas, and waits for a terminal turn state. It passes the selected project directory to the app-server process, thread creation, and each turn. It does not set a sandbox or approval-policy override, so the installed Codex configuration remains in effect.

## Boundary with the Codex CLI

The installed CLI reports `codex-cli 0.162.1`. Its help exposes fixed built-in commands, including `app-server`, `plugin`, and `mcp`; it does not expose a third-party command registration mechanism. Codex does support plugins in its own workflow: its plugin documentation covers skills and MCP-backed capabilities, and the CLI includes `codex plugin` management commands. The documented [CLI /plugins flow](https://developers.openai.com/learn/developers-codex-plugin) opens Codex's plugin browser. These integrations do not register new top-level `codex` commands or an arbitrary Vesper screen in the interactive terminal. The plugin package model and CLI marketplace commands are documented in [Package your plugin](https://developers.openai.com/plugins/build/plugins).

No supported in-process extension point for adding Vesper UI to the Codex CLI terminal was documented in the inspected CLI 0.162.1 help or plugin documentation. Codex's [app-server protocol](https://developers.openai.com/blog/codex-as-a-platform) is the documented integration surface for an application-owned frontend; the installed CLI labels it experimental. Vesper therefore runs as its own transparent terminal frontend and uses the installed Codex app-server/runtime for fallback turns. Running `codex` still launches Codex normally. Vesper does not replace or modify the `codex` executable, copy credentials, or reset Codex configuration.

The original discovery commands use bounded, read-only sources:

- `vesper plugins` reads `$PROJECT/.agents/plugins/marketplace.json`, `~/.agents/plugins/marketplace.json`, and plugin cache directory names under `$CODEX_HOME/plugins/cache` (default `~/.codex/plugins/cache`). A cached copy is reported as `installed`; a local marketplace entry with `policy.installation: "AVAILABLE"` is `available`. Other policy states, remote/universal marketplaces, and whether an item is enabled or loaded remain `unknown`. It does not run `codex plugin list --available`, because that can consult configured and remote marketplaces.
- `vesper mcp` runs the installed CLI's documented read-only `codex mcp list --json` command and projects only each server name and its `enabled` boolean. Vesper labels enabled servers `installed` (configured and enabled), disabled servers `available` (configured but disabled), and missing/failed state `unknown`. Codex has no list of unconfigured MCP servers, so Vesper cannot discover hypothetical servers.
- `vesper skills` recursively checks `$PROJECT/.agents/skills/` and `$CODEX_HOME/skills/` for `SKILL.md` files, with a five-level depth and 2,000-directory scan cap. A valid named manifest is `available`; missing, malformed, or other skill sources are `unknown`. Codex exposes no separate installed/enabled skill state through these sources, so runtime loading or activation remains unknown.

The catalog reuses the same local discovery sources. It does not inspect Codex settings for secrets or query remote marketplace listings; the plugin search scope remains local marketplace manifests and the local cache. Codex's built-in commands remain available independently (`codex plugin list --help`, `codex mcp list --help`, `codex plugin add --help`, `codex mcp add --help`). Vesper uses `codex plugin add/remove` and `codex mcp add/remove` only after an explicit typed confirmation. The documented project plugin toggle edits only the selected project's `.codex/config.toml`, also after typed confirmation. Vesper does not download marketplace data itself or claim runtime-loaded state.

When Codex requests command, file, patch, or permission approval, Vesper shows the request in the terminal. Only typing `yes` grants a one-time approval; all other answers decline, except the explicit `cancel` answer. Permission-profile approval grants only the displayed requested profile for that turn. Vesper does not automatically approve commands or make session-wide grants. Unsupported request methods return a protocol error.

The terminal shows command activity only after the app-server confirms the active turn. It associates command items with the exact thread, turn, and item IDs; displays the supplied command, a valid working directory, lifecycle state, exit code when present, and bounded output; and keeps approval decisions separate from command execution results. Command text, working directories, and output payloads are limited to 4,096, 2,048, and 16,384 characters, with at most 50 retained command items per turn. Terminal controls are escaped and common credential patterns are redacted heuristically; this is not comprehensive secret detection. Output deltas are buffered until the command item or turn ends so redaction can span chunk boundaries; command start state remains visible while it runs.

Outside approval prompts, the terminal also shows bounded file-change summaries derived from the same in-memory snapshots used for file approval. Summaries are associated with the exact thread, turn, and item IDs; show proposed paths and change types, and include added/removed line counts only when a unified diff hunk is available. Later events report updated evidence; invalidation and completion markers state that earlier paths are no longer current. Summary paths are escaped and heuristically redacted, at most 50 file-change items and 8 paths per item are rendered, and total file-summary output is capped at 12,000 characters per turn. Summaries describe server evidence and do not establish that files were written to disk.

The app-server's separate `turn/diff/updated` event is shown as a turn-level aggregate diff. It is keyed only by the exact thread and turn IDs because this event has no item ID; it never becomes file-approval evidence or a per-file claim. Each accepted notification replaces the previous complete aggregate snapshot. When both input and output are interactive TTYs and `TERM` is not `dumb`, Vesper redraws one bounded live view in place, using a 60 ms debounce for snapshot updates. It erases the view before writing streamed text, command activity or other terminal output, then redraws the latest snapshot. The view suspends while an approval prompt is active and resumes afterward; terminal resize recalculates wrapping and the row cap. On turn closure, the final frame is left in place. Redirected or non-TTY output receives no live redraw and gets one bounded final summary instead.

The cached diff is capped at 32,768 characters and the escaped terminal view at 16,000 characters; the live frame is additionally limited to the terminal width and height, with an explicit truncation marker. Empty, unavailable, malformed, oversized, interrupted, failed, and disconnected states are labeled; incomplete last snapshots are marked as such. The header states that the server-reported diff does not verify a disk write. Terminal controls are escaped and common secrets are heuristically redacted. The protocol has no diff sequence number, so same-turn notifications are applied in stdio arrival order; this view cannot detect a producer that sends snapshots out of order.

File-change approval (`item/fileChange/requestApproval`) is shown only with a diff snapshot taken from `item/started`/`item/fileChange/patchUpdated` for the exact thread, turn and item IDs, printed before the prompt. Vesper declines, without asking, when the snapshot is missing, malformed, oversized, duplicated, for another thread/turn/item, already completed, or when the request carries `grantRoot` (a session-wide write grant, which the one-time flow does not offer). If the diff changes, the turn ends, or the connection drops while the prompt is open, the prompt is cancelled and the request is declined. Legacy `applyPatchApproval` is always declined because it carries no turn identity. Snapshots are held in memory only and never written to session files.

Session metadata is stored under `~/.vesper/sessions/` (or `$VESPER_HOME/sessions/` when `VESPER_HOME` is set). Schema version 3 records the stable Vesper session id, canonical project path, provider id, provider conversation id, selected model id where applicable, session status, bounded recovery code/timestamp, and creation/update timestamps. Schema v1 Codex-thread records and schema v2 provider-neutral records are read compatibly; a record is rewritten in v3 on its next update while preserving its provider and conversation mapping. The in-memory `threadId` accessor remains as a compatibility alias for Codex callers, but it is not written to v3 files. The session directory and files are created with mode `0700` and `0600`; prompts, responses, and authentication material are not stored there. App-server stderr is not copied to terminal output.

## Provider selection and compatible chat APIs

`execution-interface.js` defines the provider contract, explicit capability declarations, bounded normalized events, and stable structured error codes. `execution-provider.js` is the small selection boundary. Codex app-server remains the default. OpenAI Chat Completions and NVIDIA NIM are selected explicitly for new sessions:

```sh
vesper providers
vesper providers status --provider openai-chat-completions
vesper providers status --provider openai-chat-completions --check
vesper providers status --provider nvidia-nim
vesper providers status --provider nvidia-nim --check

# Set OPENAI_API_KEY in your shell or secret manager before selecting this provider.
export VESPER_OPENAI_MODEL='your-model-id'
vesper --provider openai-chat-completions --new /path/to/project

# A model can also be pinned to a new session:
vesper --provider nvidia-nim --model 'your-nim-model-id' --new /path/to/project
```

Tool calling stays off unless the host opts into one exact model identifier. For an OpenAI model you have verified supports Chat Completions tools, set `VESPER_OPENAI_TOOL_CALLING_MODEL` to the same value as `VESPER_OPENAI_MODEL`. For NVIDIA, use `VESPER_NVIDIA_TOOL_CALLING_MODEL` equal to `VESPER_NVIDIA_MODEL` only after verifying that exact deployment/model. This setting only enables Vesper to send structured tool definitions; it does not verify compatibility. Provider-specific limits can be set with `VESPER_OPENAI_MAX_TOOL_CALLS`, `VESPER_OPENAI_MAX_TOOL_ITERATIONS`, `VESPER_OPENAI_MAX_AGENT_ELAPSED_MS`, `VESPER_OPENAI_MAX_TOOL_RESULT_BYTES` and the corresponding `VESPER_NVIDIA_...` variables. Vesper validates these settings against bounded ranges and rejects invalid values. Tool results leave the machine for the selected provider.

`VESPER_OPENAI_API_KEY` can be used instead of `OPENAI_API_KEY`. `VESPER_OPENAI_BASE_URL` optionally changes the API base URL and `VESPER_OPENAI_TIMEOUT_MS` sets a 1,000 to 600,000 ms request timeout. The default base is `https://api.openai.com/v1`.

NVIDIA NIM reads `VESPER_NVIDIA_API_KEY` (or `NVIDIA_API_KEY`), `VESPER_NVIDIA_MODEL`, and optionally `VESPER_NVIDIA_BASE_URL` and `VESPER_NVIDIA_TIMEOUT_MS`. The default base URL is NVIDIA's hosted compatible endpoint, `https://integrate.api.nvidia.com/v1`; it may be changed for a compatible NIM deployment. Vesper stores a session's provider and selected model in private session metadata, but never stores the API key. `VESPER_PROVIDER=nvidia-nim` selects NIM for new sessions; `--provider` and `--model` select a new session explicitly. Inside the terminal workspace, `:new nvidia-nim MODEL_ID` starts a separate session. Existing sessions retain their provider and model; Vesper rejects a provider/model change on resume. Codex model selection remains under Codex configuration because the inspected app-server interface does not expose a supported model-selection operation.

`vesper providers` and `vesper providers status` read local configuration only. A configured model is not described as live-available until the user explicitly runs `--check`. For compatible APIs, that check makes a bounded authenticated `GET /models`, prints a capped list of model IDs, and checks whether the configured model appears; it does not generate text or make a paid completion request. Codex's explicit check connects the local app-server and does not expose a model catalog. Structured tool calling is disabled by default. A host can opt in only for one exact model ID with `VESPER_OPENAI_TOOL_CALLING_MODEL` or `VESPER_NVIDIA_TOOL_CALLING_MODEL`; this is an operator setting, not proof that the model supports tools. API keys are read from the environment and never printed or written to session files.

The OpenAI and NVIDIA NIM adapters share the bounded compatible Chat Completions implementation, but have independent provider IDs, environment configuration, and local conversation IDs. With tool calling opted in for the exact configured model, Vesper sends registered JSON-schema tool definitions and `tool_choice: "auto"` to `POST /chat/completions`. It assembles streamed `tool_calls` fragments (or parses a completed JSON response), validates each call through the existing permissioned runtime, and returns bounded results as Chat Completions `tool` messages. Ordinary assistant prose is never interpreted as a tool request. A turn begins with project file/list/search and Git inspection tools; proposal tools are advertised only after a successful inspection, and Vesper rejects a proposal unless the assistant first shows a concise `Plan:` line referencing inspected evidence. Vesper appends a bounded evidence report listing actual inspections and file proposal/write outcomes, and explicitly marks tests/builds as unrun. `run_command` is never sent to a model. Applying a proposal is exposed only in an interactive terminal and requires a fresh approval of the exact complete file snapshot; VS Code and redirected sessions omit the apply tool. A host that opts into NIM tool calls must independently verify its chosen model and deployment compatibility; Vesper does not claim support for a particular NIM model.

NVIDIA documents OpenAI-compatible chat completions, streaming, and model listing for NIM deployments ([NIM LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis), [NIM quickstart](https://docs.nvidia.com/nim/large-language-models/latest/get-started/quickstart.html)). Actual model support varies. The explicit check expects `GET /models` to return a `data` array; a deployment without this listing shape can still handle tasks, but Vesper cannot verify its configured model. Redirects, non-SSE/non-JSON responses, malformed records, oversized output, and incomplete streams fail closed. `store: false` is sent as an API request option; it is not a guarantee about provider retention or account data controls, which remain governed by the selected provider's current terms and settings.

The provider owns a private local message record under `~/.vesper/sessions/provider-conversations/` (or `$VESPER_HOME/sessions/provider-conversations/`), separate from the Vesper session metadata. Conversation files and their directory use `0600` and `0700` permissions, are bounded, and are scoped to the canonical project path, provider, model, and API-base fingerprint. Vesper stores the stable local conversation id on the session record. Resume reuses that exact local transcript; it does not depend on a remote thread ID. If request submission may have reached the server but no complete response was confirmed, the transcript is marked uncertain and Vesper never resubmits that task. The API does not provide a supported way for this adapter to reconcile an uncertain response or cancel generation remotely, so recovery is declared unsupported; interrupt aborts Vesper's local HTTP stream and reports the remote completion as unknown.

Using either remote provider sends the submitted task and provider-owned conversation text to that provider. When structured tools are enabled, Vesper also sends the registered tool schemas and bounded results from each requested project operation; those results can contain project text, matching lines, Git diffs, or file metadata. Review that data-sharing choice before enabling remote tool calling. OpenAI and NIM receive no environment variables or API credentials in tool results. Tool outputs and generated responses are not proof that code was tested. Vesper never executes model-generated commands or scripts. Proposed writes stay in memory until a terminal user approves the complete operation once; Vesper revalidates and verifies the write. VS Code and redirected sessions do not offer file-write approval, so the apply tool is omitted. Tool loops have bounded call, iteration, time, request, and result sizes. Cancellation or a lost/truncated provider response never triggers task resubmission; the conversation may require a new Vesper session if completion is uncertain.

The Codex adapter continues to wrap the existing `AppServerClient`, translates app-server activity into normalized events, and maps one-time approval choices back to Codex responses. The existing client remains responsible for app-server framing, session identity checks, uncertain start acknowledgements, and exact file-change evidence capture. A lost `turn/start` acknowledgement is reported as `SUBMISSION_OUTCOME_UNCERTAIN`, never automatically submitted again. Terminal and VS Code consume normalized `text-delta`, `task-started`, `command-activity`, `approval-required`, `file-change`, `task-state`, and `connection-lost` events; provider-specific protocol payloads do not reach the panel by default.

Task evidence reports use the same bounded format across Codex and the structured OpenAI/NIM tool loop and are correlated to the Vesper session, provider conversation, and task/turn when those identities are available. Codex evidence is explicitly provider-reported: command item status and an available exit code are recorded, approval responses are recorded after Vesper successfully writes them to the app-server transport, and file-change events report proposed paths and lifecycle only. That write does not confirm Codex acceptance. An exit code does not independently verify project effects; a completed file-change item does not prove that files were written. The inspected app-server events do not provide Vesper with reliable read-only file inspection evidence, so Codex reports do not claim reads. Interruption, connection loss, incomplete command status, and missing exit codes remain unverified or uncertain.

An additional provider must implement `initialize`, `startConversation`, `resumeConversation`, `readConversationHistory`, `submitTask`, `interrupt`, `recover`, `getState`, and `dispose`; emit contract-versioned normalized `event` objects; and declare streaming, interruptions, resume, history, approvals, file changes, command execution, recovery, and persistence support explicitly. A declared-false operation must return a structured `UNSUPPORTED_OPERATION`. Local handlers still run before provider dispatch; capability-plan previews remain advisory and do not dispatch capabilities.

## Permissioned tool runtime

`permissioned-tool-runtime.js` is a provider-neutral API for explicit, typed tool requests. The OpenAI and NVIDIA NIM Chat Completions loop routes structured calls through `preview()` and `invoke()` with registered tool IDs, schema-checked input, canonical project/session context, and fresh request UUIDs. It cannot supply its own tool implementation or approval result. Codex continues to use its existing app-server execution and native approval flow.

The Vesper host constructs the runtime for the active project/session and owns the interactive approval callback. A future adapter receives only the facade and submits a normalized request:

```js
const request = {
  toolId: "read_file",
  input: { path: "src/main.js" },
  context: { projectRoot, sessionId },
  requestId: crypto.randomUUID(),
};
const preview = await tools.preview(request);
if (preview.state === "validated") {
  const result = await tools.invoke(request);
}
```

The same runtime validates the request again at invocation. Protected tools pause for the host approval callback, which receives an immutable operation snapshot. Providers cannot set `commandExecutionEnabled`, provide the approval handler, reuse a request UUID, or invoke internal executor methods through the facade.

Inspect the registered tools and preview a request without running it:

```sh
vesper tools
vesper tools preview read_file '{"path":"src/cli.js"}'
vesper tools preview search_files '{"query":"approval","path":"src"}'
```

Manual requests can invoke bounded read-only operations directly. A file proposal is held only in the runtime process; `--apply` lets the same CLI invocation show the proposal and then request a separate one-time approval:

```sh
vesper tools run read_file '{"path":"README.md"}'
vesper tools run list_files '{"path":"src"}'
vesper tools run search_files '{"query":"createExecutionProvider","path":"src"}'
vesper tools run git_status '{}'
vesper tools run git_diff '{"path":"src/cli.js"}'
vesper tools run git_log '{"limit":10,"path":"src"}'
vesper tools run propose_file_change '{"path":"notes.txt","content":"Reviewed text\n"}'
vesper tools run propose_file_change '{"path":"notes.txt","content":"Reviewed text\n"}' --apply
```

The initial tools are `read_file`, `list_files`, `search_files`, `git_status`, `git_diff`, `git_log`, `git_check_ignore`, `run_command`, `propose_file_change`, and `apply_file_change`. `git_log` returns at most 20 local commit summaries and never contacts a remote. `git_check_ignore` accepts at most 100 literal project-relative paths and disables external/global Git configuration. File operations use canonical project-root descriptors with no-follow path traversal, reject hard links and cross-device mounts, and currently fail closed outside Linux with `/proc/self/fd` and `O_NOFOLLOW`. Same-device bind mounts are not distinguished from ordinary directories. Reads are limited to 1 MiB; directory lists to 100 entries; literal search to depth 5, 2,000 entries, 100 matches, 16 MiB scanned, and 16 KiB displayed; Git output to 16 KiB and five seconds. Git inspection rejects worktrees/external metadata, repositories rooted above the selected project, Git object alternates, and local config includes. Search skips symbolic links and non-text/oversized files.

`propose_file_change` is a whole-file UTF-8 replacement proposal, not a patch engine. The existing file and proposed content must each fit in an 8 KiB review field, and the complete review must fit 20 KiB. `.git` and `.vesper` metadata paths are excluded. Existing files must be owned by the Vesper user and have the group the replacement would inherit. Applying a proposal requires a fresh `approve-once`, binds the approval to the proposal, session, project, original snapshot, and proposed content, then rechecks the target immediately before the atomic operation and verifies the resulting bytes. A concurrent change observed during revalidation invalidates the proposal. New files use atomic create-if-absent; existing files use an atomic same-directory replacement. Node does not expose a compare-and-swap rename, so a narrow race remains between the final existing-file check and replacement; a later native filesystem adapter should close that window. Replacement preserves basic mode and owner/group eligibility, but extended ACLs and xattrs are not preserved. Proposals and approvals do not survive runtime disposal. Secret-like text that the existing redactor would hide is refused for protected-operation approval so a reviewer is not asked to approve a partially hidden command or file.

`run_command` is disabled by default. When the host enables it, Vesper requires a one-time approval and uses a Linux rootless Podman backend; there is no host-process fallback. Before prompting, Vesper verifies the local Podman runtime, rootless status, seccomp support, cgroup v2 CPU/memory/process controllers, and a locally available Linux image matching the host architecture. Vesper never installs Podman, builds or pulls an image, or changes host configuration.

Check the backend without creating a container:

```sh
vesper tools status
```

To enable commands for one invocation, configure a trusted image that is already present in the local rootless Podman store, then set the opt-in variables:

```sh
VESPER_ENABLE_ISOLATED_COMMANDS=1 \
VESPER_SANDBOX_IMAGE=localhost/vesper-toolbox:latest \
vesper tools status

VESPER_ENABLE_ISOLATED_COMMANDS=1 \
VESPER_SANDBOX_IMAGE=localhost/vesper-toolbox:latest \
vesper tools preview run_command '{"argv":["git","status","--short"]}'

VESPER_ENABLE_ISOLATED_COMMANDS=1 \
VESPER_SANDBOX_IMAGE=localhost/vesper-toolbox:latest \
vesper tools run run_command '{"argv":["git","status","--short"]}'
```

The preview only checks and displays the planned isolation policy. `tools run` asks for a fresh interactive approval of the exact argv, project mount, image id, network policy, and limits. The sandbox receives only the selected project at `/workspace`, mounted read-only by default. Vesper rejects workspace roots that are the user's home (or contain it), inside protected host system/runtime trees, or contain nested mount points. For an operation that needs to modify the project, both the request and a separate host opt-in are required:

```sh
VESPER_ENABLE_ISOLATED_COMMANDS=1 \
VESPER_ENABLE_SANDBOX_WRITES=1 \
VESPER_SANDBOX_IMAGE=localhost/vesper-toolbox:latest \
vesper tools run run_command '{"argv":["npm","test"],"workspaceAccess":"read-write"}'
```

An approved writable mount can alter or delete project files and is separate from `propose_file_change`/`apply_file_change`. Network access remains disabled; there is no network opt-in in this phase. Vesper passes an explicit argv to Podman without wrapping it in a host shell; if the reviewed argv explicitly names a shell executable, that program can interpret its arguments inside the sandbox. The container has a read-only root, a 64 MiB `/tmp`, an 8 MiB shared-memory limit, 1 CPU, 512 MiB memory, 64 processes, a five-second maximum, and 16 KiB captured output per stream. Vesper passes a fixed `PATH`, `HOME`, and `TMPDIR` into the container, clears image/default environment values, disables proxy forwarding, drops all Linux capabilities, requests no-new-privileges and private namespaces, ignores image-declared volumes, and uses an empty hooks directory. Vesper adds no mount for the host home, SSH files, cloud credentials, runtime sockets, or host `/proc`. The selected project tree is visible to the command, so keep host credentials and service sockets outside that tree. A nested mount inside the selected project causes refusal.

Before starting the command, Vesper inspects the created-but-unstarted container and checks the effective image, argv, user, workspace mount, network mode, read-only root, capability drop, security options, namespace modes, environment, and resource limits. It removes the container after completion and attempts to kill and remove it on timeout, interruption, output overflow, or disposal. A failed setup or unverifiable setting is reported unavailable; Vesper does not weaken the policy or launch the argv on the host. `vesper tools status` reports local prerequisites; `vesper tools` only lists registered tools and does not probe Podman or start a container.

These controls rely on the host's rootless Podman and Linux kernel. They are container isolation, not a virtual machine: a container escape can still attack the shared host kernel, and the selected image is trusted executable code. The backend fails closed if the installed runtime does not report cgroup v2 controllers or expose the expected container inspect fields. CPU/memory/process and temporary-storage settings are verified against the created container configuration; this does not independently measure kernel enforcement or eliminate host-wide resource exhaustion. The current development environment has no Podman executable, so live container execution and runtime enforcement are unavailable for validation here until an operator installs/configures rootless Podman and supplies a suitable local image.

Audit records retain at most 50 structured state events with tool ID, Vesper session ID, a hashed project identity, request/approval references, state, timestamp, result status, and stable error code. They omit request arguments, file content, task prompts, command output, environment values, and credentials. Read/search/Git results apply the existing sensitive-text redactor. Tool results distinguish `validated`, `proposed`, `awaiting-approval`, `approved`, `executed`, `verified`, `rejected`, `failed`, `timed-out`, `interrupted`, `uncertain`, and `isolation-unavailable`; approval is never reported as successful execution. The runtime does not execute downloaded code, invoke MCP tools, generate or apply patches automatically, or change provider behavior.

## VS Code extension

This source folder is directly loadable as a VS Code extension: `package.json` points to the existing `extension.js` entry point. No build step is required. VSIX packaging is optional and has not been validated; use the release-check workflow to see whether `vsce` is available in the current environment. There is no checked-in `.vscode/launch.json`, so use the command below instead of relying on `F5` to select an extension-host configuration.

For an isolated run, start it from a desktop terminal outside any restricted Linux command sandbox, from this repository directory. The fixture and dedicated homes are prepared by the integration procedure above; the VS Code profile and extension directories are also kept under the ignored `.audit-artifacts` directory:

```sh
E2E_PROJECT="$PWD/.audit-artifacts/disposable-e2e-project"
VS_CODE_DATA="$PWD/.audit-artifacts/phase1d-vscode-data"
VS_CODE_EXTENSIONS="$PWD/.audit-artifacts/phase1d-vscode-extensions"
mkdir -p "$VS_CODE_DATA" "$VS_CODE_EXTENSIONS"

CODEX_HOME="$PWD/.audit-artifacts/e2e-codex-home" \
VESPER_HOME="$PWD/.audit-artifacts/e2e-vesper-home" \
code --new-window \
  --user-data-dir "$VS_CODE_DATA" \
  --extensions-dir "$VS_CODE_EXTENSIONS" \
  --extensionDevelopmentPath="$PWD" \
  "$E2E_PROJECT"
```

The `code` command's exit status alone does not prove that Electron created a usable window. In the previously tested restricted command sandbox, launching it produced `Operation not permitted` while the CLI returned status 0. Do not work around that restriction with `--no-sandbox`; run the command from the desktop session instead. Verify that a separate VS Code window opens on the disposable project, run **Vesper: Open Panel** from the Command Palette, and confirm the Vesper webview appears. The Vesper Output channel and Extension Host log can confirm activation after the command is invoked. Startup logs are under the selected VS Code user-data directory's `logs` folder; keep them local and do not share raw logs.

The extension panel keeps its VS Code message bridge and local-first routing, and uses the same provider-neutral execution interface and session store as the terminal frontend. The Codex adapter continues to wrap the tested app-server client.

The panel shows the selected workspace folder and lets you choose among folders already open in the VS Code workspace. It resolves the folder to the CLI's canonical real path and looks up the most recently updated Vesper session for that exact path. Session metadata stores the provider id and provider conversation id alongside the Vesper session ID, project path, status, recovery marker, schema version, and timestamps; it does not store prompts or model output. On a Codex task, the panel resumes the stored conversation and verifies the returned thread ID and project path. A failed resume keeps the saved mapping, blocks further tasks, and offers a retry or an explicit **Start new conversation** action. Starting a new conversation leaves the previous session record available.

The panel uses the app-server client's read-only sandbox override for both `thread/start` and `thread/resume`, and declines approval requests. A **Stop** button interrupts only the active turn. The extension host keeps one panel instance; closing the webview does not dispose the session mapping, and restarting VS Code reloads it from the existing Vesper session store.

After a saved thread is verified, the panel requests its latest 50 persisted turns through `thread/turns/list` with `itemsView: "full"`. It projects supported user and assistant messages, turn outcomes, and bounded tool activity into the conversation view in chronological order. Non-text user content is represented by an omission marker and makes the history partial. This projection is in memory; Vesper still stores only session/thread identifiers and project metadata. Empty history, partial history, and unavailable history have different status messages. If Codex confirms the thread but history retrieval fails, the panel leaves the session usable and reports that history was unavailable rather than empty. Local answers are not part of Codex thread history and are not restored. Retrieved server history describes recorded activity; it does not prove that a file was written to disk.

## Tests and manual checks

Run these checks from the source checkout; test files are not included in the packed runtime installation:

```sh
npm test
```

Tests use mocks for app-server initialization, turns, stream events, failures, interruption, timeouts, approvals, and saved-thread resume. `node test/extension-routing.test.js` exercises the real `SessionStore` files under a temporary `VESPER_HOME` with a mocked app-server. The existing Git integration test uses read-only Git commands against the current worktree. The runner records the test summary, exit code, timestamps, and source fingerprint in the ignored `.fast-lane-test-result.json`; no prompt or answer content is included. A local test-result answer is confirmed only while the fingerprint matches the prototype and test sources.

Try these local requests:

- `What Git branch am I on?`
- `Is my working tree clean?`
- `Does this branch have an upstream?`
- `How many local commits are ahead of upstream?`
- `Did the last test run pass?`

Each local result includes its state and evidence. Ahead-of-upstream uses local tracking refs only, checks the tracking-ref reflog for age, and warns that the remote was not contacted. A branch name alone never establishes that it is pushed. If trustworthy test evidence is absent or stale, the answer reports unknown or stale rather than claiming a pass.

For terminal fallback, submit `Explain what a Git rebase does in one sentence.` and then `Give one example.`; both Codex answers should stream in the same Vesper session. Exit, copy the printed session id, and run `npm run cli -- --resume SESSION_ID` to verify resumption. Local questions should remain local in both runs. The documented synthetic TTY smoke check exercises real PTY streams without starting Codex or contacting a model.

## Limitations

- Vesper is its own frontend. It does not attach to, import, or continue the original interactive Codex CLI conversation.
- When multiple Vesper sessions exist for one canonical workspace path, the extension restores the record with the latest `updatedAt`; it does not yet offer a session-history picker. The panel restores at most the latest 50 Codex turns; older turns are marked as omitted when the server provides a continuation cursor. Locally answered Git/test questions are not in Codex history and are not restored.
- Codex app-server is experimental in the inspected CLI version; protocol behavior can change. Recheck the installed generated schema before updating protocol methods.
- The live aggregate diff view uses cursor movement and erase sequences only when both streams are TTYs and `TERM` is usable. Its terminal cell-width calculation is an approximation for combining marks and emoji sequences, so unusual glyph widths may cause imperfect wrapping. The installed event schema has no sequence/version field; Vesper scopes events by process, thread and turn and applies same-turn snapshots in transport arrival order. A local PTY smoke check exercised synthetic events and redirected output; it did not validate authenticated model behavior, live app-server delivery, or real file operations.
- The app-server turn timeout is five minutes. Vesper asks the server to interrupt after timeout; if the server does not confirm a terminal event, the connection is closed and the request is reported as an error. Another fallback tries to resume the same saved thread; it never silently starts a replacement conversation.
- Local Git checks do not fetch or contact a remote. Their results are bounded by local repository evidence and its freshness.
- Upstream freshness uses the tracking ref's latest recorded reflog update (`%gD` with `--date=raw`), not the referenced commit's date. Missing or invalid reflog evidence leaves freshness unknown, even when the local ahead count is confirmed. An unchanged fetch need not add a reflog entry; a recent entry never confirms live remote state.
- Uninstalling the npm package removes the CLI and extension files only; it leaves Vesper session/history data and project data in place. See [INSTALL.md](INSTALL.md) for uninstall and reset guidance. Vesper runtime use does not add project dependencies or project configuration automatically.
