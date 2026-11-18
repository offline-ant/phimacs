# @phimacs/extensions

General Pi extensions in the Phimacs workspace. This package provides safety
lints, `ask`, `/tools`, session tools, workflows and skills. Its declared
[orchestration dependency](../orchestration/README.md) provides the shared contracts;
loading orchestration's tools remains an explicit setup choice.

## Install

Run from the Phimacs checkout using Node 24+ and its root lockfile:

```sh
npm ci --ignore-scripts
npm run compile
npm run check
```

The root workspace owns the Pi SDK version. The parser dependency is declared
here rather than in a nested install.
Pi host peers remain `*` and must resolve to the host's physical module copies.
Load compiled package paths explicitly; installation does not enable extensions.
The [npm package](../../docs/development.md#npm-packages) is the same compiled
manifest.
Source edits do not reload existing sessions. Compile and check affected code
before a reload; do not mix old and new package graphs.

The package works in any Pi frontend, including Pi's own TUI in tmux or Herdr
without Emacs. With Pilish, orchestration's Emacs companion
(`packages/orchestration/emacs/pi-orchestration.el`) owns host/server identity and
`C-M-f`; the [orchestration README](../orchestration/README.md#hosts) says how to
load it.

## Agent tools

These are the pi tools registered by this package:

- `ask` — ask the user interactive multiple-choice or free-form questions. In TUI and RPC sessions, each question also offers `Fork (discuss separately)`: edit a discussion prompt, launch an inherited session on the selected host, then return to the unchanged question and answer it.
- `py` — run one-off Python scripts for computation and analysis, each saved with its output for later calls; enabled by default, subject to exact `/tools` selections. See [py scripts](#py-scripts).
- `document_flow_review` — read one document strictly in sequence without lookahead and assess its internal coherence, including logical flow, definitions, transitions, expectations, internal contradictions, and misplaced or late information. It does not verify factual truth or external validity. Codemode receives `{report, reportPath, metadataPath, sessionPath}`. The tool is inactive by default and can be exposed through `/tools`. Focused test: `node scripts/test.mjs packages/extensions/extensions/document-flow-review-runner.test.ts`.
- Core `bash` is wrapped by the `bash` extension: omitted `timeout` defaults to 900 seconds (15 minutes); explicit values retain Pi's validation. The shared [orchestration](../orchestration/README.md) policy also applies to SSH-backed bash; the local extension yields to remote tools. Human `!` commands, panels, `pi.exec` and linter subprocess deadlines are unchanged. Shell settings, cwd, streaming, cancellation, rendering and structured results remain native. Focused checks: `node scripts/test.mjs packages/orchestration/bash-tool.test.ts packages/extensions/extensions/bash.test.ts packages/extensions/extensions/bash-session.test.ts packages/orchestration/remote.test.ts`.
- Core `edit` and `write` are wrapped by `lints` to display post-write safety warnings. Its `edit` guideline steers file changes away from bash. `ty` checks a PEP 723 script in the environment `uv` selects for it, and `import-not-found` warnings explain how to expose dependencies. Focused test: `node scripts/test.mjs packages/extensions/extensions/lints.test.ts`.
- `self_compact` — the agent calls `self_compact({note})` alone in its tool batch at a clean checkpoint. Its normal TUI tool display shows the full handoff note as arguments stream in, without requiring expansion. The run ends, Pi's native compaction runs (normal summary prompt, model, and `keepRecentTokens` retention; extra focus caps each rewritten summary at 3,000 words so chained summaries do not grow until summarization stalls), and the note is then delivered verbatim as the next message, which continues the work without a human prompt. Structured workers retain automatic completion across this handoff; their eventual result returns under the [worker completion policy](../orchestration/README.md#completion-and-waiting). It does not retry: failure, cancellation, or a skipped handoff is reported and work stops; an unfinished worker waits for a human (a saved main result is preserved if its retrospective fails). From 69% context usage, a generic reminder without usage numbers is added to each model request but not displayed or saved in the session. Tool guidance and reminders tell the agent to finish without `self_compact` when the original user request is nearly complete. The reminder also says to continue when all current context is needed, and to compact when much of it is irrelevant. Native `/compact` and automatic-compaction settings are unchanged. The tool is on by default; `/tools` can turn it off. Adapted from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (MIT). Focused test: `node scripts/test.mjs test/integration/self-compact.test.ts`.
- `prompt_history({idx?})` — returns the exact text of one user prompt on the current branch, including compacted ones. `idx` follows Python: 0 is the first prompt, -1 (default) the current one. Codemode receives `{text, index, from_end, time}`. Focused test: `node scripts/test.mjs packages/extensions/extensions/prompt-history.test.ts`.
- `present_guidance` — validates structured guidance output for guidance-mode final answers. It is only registered for `PI_GUIDANCE=true` runs or dynamically inside `/ugo` guide-phase sessions.

## py scripts

`py({code, dependencies?, timeout?})` runs source in a fresh interpreter; use `print()` for
results. Imports, variables and cwd changes do not survive a call. The name and
description avoid the `python` name of stateful code-interpreter tools, whose
persistent variables models otherwise assume. For example:

```js
const result = await tools.py({ code: "print(sum(x * x for x in range(10)))", timeout: 10 });
text(result.output);
```

Each call gets a private folder `${XDG_RUNTIME_DIR:-/tmp}/pi-py-<uid>/<id>`
(mode 0700; `<id>` is a digest of the tool-call id) on the host that runs the
shell. It holds the source as `input.py` and the complete combined output as
`output`, and is exported to the script as `PY_DIR`. A finished call ends its
result with `Saved: <dir>/input.py, <dir>/output` and adds `py_dir` to the
structured output; a timed-out or cancelled call reports no folder. Later calls
reuse results by loading files an earlier script saved to its `PY_DIR`, or by
reading its `output`. Nothing deletes the folders; `/tmp` and the runtime
directory are cleared by the host. A pre-existing base folder that is a symlink
or owned by another user is refused.

The tool is enabled by default and can be toggled in `/tools`. Existing saved
and branch selections remain exact: include `py` to enable it there. `bash`
must also be enabled, since Python calls the current shell tool through Pi's
nested-tool API. That retains permission/execution hooks, streaming, cancellation,
timeouts, remote routing and output recovery without a separate process backend.

`uv run` uses an isolated environment and an already-installed interpreter.
Declare optional distribution requirements explicitly, for example
`dependencies: ["numpy", "pandas>=2,<3"]`; omitted dependencies default to `[]`.
Named registry requirements support extras and version comparisons; URLs, paths,
editable installs and environment markers are rejected. Source runs through
`python -`, so inline script metadata does not install additional packages.
The project environment, dependencies and lockfile are not used or changed.
Execution disables bytecode writes and ignores uv configuration and `.env` files,
including an inherited `UV_CONFIG_FILE`. Missing `uv` or a matching interpreter
is an error; Python is never downloaded automatically.

Dependency policy is user-owned `<agentDir>/py.json` (normally
`~/.pi/agent/py.json`), for example:

```json
{"dependencies": ["numpy", "pandas"]}
```

Entries are distribution names, normalized case-insensitively with `.`, `_` and
`-` treated alike. This controlling-session file governs local and remote calls
and is read again on every dependency-bearing call. A missing file allows no
explicit dependencies; invalid or unreadable configuration fails closed. The
whitelist and its contents are not advertised in tool descriptions, schemas or
prompt guidelines. A denied request asks the user to add the package at the
reported path; the agent must not change policy itself. No file is created or
populated by the tool.

All resolved packages, including transitive dependencies, have a **30-day upload
cooldown** (`--exclude-newer 30d`, requiring uv with duration support). The cutoff
applies to each artifact's upload time, not its version number. `--no-build`
permits installation of wheels, including cached wheels previously built from
source, but never runs a source build. uv caches packages outside the project;
there are no approved-version pins or hashes maintained by this tool. Dependency
resolution, installation and execution share the shell timeout and cancellation.

Approval covers direct package names, their requested extras and normal
transitive dependencies; it is not approval of every transitive name or version.
Other environment settings, such as registry selection, remain inherited.
A cooldown can delay security fixes and is not a guarantee against compromise.
These controls are not a sandbox and do not prevent Python code from accessing
the network or invoking subprocesses.

Direct calls show combined stdout/stderr. Codemode receives the shell's structured
`output`, `truncated`, optional `full_output_path`, `exit_code`, and
`wall_time_seconds`; nonzero exits retain that data and mark direct calls failed.
Model-facing output is limited to the last 2,000 lines/50KB; programmatic output
to 1 MiB, with the complete output saved when truncated. An omitted timeout uses
the selected bash backend's default (900 seconds with Phimacs' bash extension). Remote command-size limits are inherited from the shell backend.

This is **not a sandbox**: snippets have the shell's filesystem, network and
process permissions. Use `read`, `edit` and `write` for normal file work; only the
latter two attach post-write lints. The existing once-per-chat file-rewrite
reminder also checks `py` scripts; it is guidance, not containment. Use
`codemode` for tool orchestration, `bash` for saved scripts, and `wait` for readiness.

Focused check: `node scripts/test.mjs packages/extensions/extensions/py.test.ts`.
It uses real Python and shell execution, a faux model, and an isolated SSH stub;
no user services, credentials or paid inference are used.

## Error prompt

When a run ends in an error nothing else recovers from, `error-prompt` opens a standard dialog with
the error: **Continue** sends `continue`; **Type my own reply** or cancelling leaves you at the input.
It reaches every frontend as a normal extension dialog, so a pi-deck session turns blocked and pings, and it
emits `herdr:blocked` while open.

It runs at `agent_settled`, after Pi's retries and compaction, and skips your own aborts, sessions without
UI and work already queued. Anything that starts a new run closes the dialog. It never retries by itself.
Workers ask too, on top of their waiting state: Continue resumes the worker and reaches the parent as user
guidance. An extension whose failed run must not ask sets `claimed` on `pi-orchestration:error-claim` at
`agent_end`; the worker frame does this for retrospectives and early hand-backs.

Browser automation and web retrieval belong to the separately loaded
[`@phimacs/browser`](../browser/README.md) package, which registers `browser`,
`web_search`, `web_fetch` and `web_read`.

## Copy quoted text

After `/reload`, run `/copy-quote` in a terminal Pi session. It reads the latest
completed assistant response on the current branch. One nonempty blockquote copies
immediately; several open a numbered picker. Escape cancels without copying; no
quotes produces a notification rather than falling back to an older answer.

Nested quotes are included in their enclosing quote, with all quote markers removed.
Internal Markdown (including code fences), literal `>`/`|`, code indentation, and
source line breaks are preserved. The display and history do not change, and normal
mouse copying is unaffected. Pi's clipboard helper retains its platform and OSC 52
behavior. RPC/print modes are refused to avoid writing the server's clipboard.

The package declares micromark 4.0.2 for concrete source positions; Pi's bundled
Marked tokens do not reliably retain source spans. No nested installation is needed.
Checks from the Phimacs root, without model calls or touching the real clipboard:

```sh
node scripts/test.mjs packages/extensions/extensions/copy-quote.test.ts
npm run check
```

## Herdr finish prompts

Inside a Herdr Pi TUI, while this Pi is idle:

```text
/start-tab-finish Review the changes and run the tests
/start-space-finish Check the combined work across this workspace
/start-finish-cancel
```

The first two commands wait, without model calls, until **all other recognized
agents** in the caller's tab or workspace are `idle` or `done`, then submit the
prompt once to this Pi. They do not create a tab, workspace, or session. Herdr
change events trigger fresh checks of the live scope: late arrivals and agents
that become busy again count; agents that leave no longer count. Ordinary shells
are ignored. `working`, `blocked`, and `unknown` prevent starting. No other agents
means the prompt can start immediately.

Waiting Pi sessions report `blocked` through the installed Herdr Pi integration
(`herdr:blocked`). Two waiters in each other's scope deliberately block each other;
cancel one to release the other. The integration must be active and its blocked
report must be observed before a prompt can start. The widget shows the pending
prompt and remaining agents. Only one prompt may be scheduled at a time.

Cancellation, another submitted prompt, this Pi starting work, branch/session
changes, reload, exit, connection failure, or the caller leaving its scope clear
the wait. Waits are not persisted or automatically retried. Submission uses Pi's
local message API and preserves human drafts. This is a live readiness check,
not an atomic scheduler or proof that the other agents succeeded. Commands are
absent outside Herdr and in RPC/print/JSON mode.

Focused checks from the Phimacs root:

```sh
node scripts/test.mjs packages/extensions/extensions/herdr-finish.test.ts packages/extensions/extensions/herdr-finish-client.test.ts
PI_HERDR_FINISH_NATIVE=1 node scripts/test.mjs test/integration/herdr-finish-native.test.ts
```

The opt-in native test creates only disposable Herdr topology and real Pi TUIs
with faux inference; it never makes paid model calls or changes existing panes.

## Skills

The package exports `skills/`. After `/reload` or in a new session, invoke
`/skill:herdr` or ask the agent to use the skill. Other agents can read
[`skills/herdr/SKILL.md`](skills/herdr/SKILL.md) directly.

- `herdr` — local guidance for Herdr 0.9.x CLI operations, with ownership safeguards and a separate managed Pi orchestration workflow.

Verify package skill discovery without model calls:

```sh
node scripts/test.mjs test/install/skills.test.ts
```

## Commands, snippets, and safety extensions

- Document flow review command: `/document-flow-review <document-path> [--profile <reader profile>]` runs a persistent isolated agent with no discovered context, skills, prompts, extensions, or built-in tools. The agent-callable `document_flow_review({ file, prompt? })` tool is inactive by default and can be enabled through `/tools`, so it consumes no model context until selected. Both entry points reveal Markdown in visually coherent 3–6-sentence reading units and assess whether each unit follows coherently from what preceded it. They show each consumed source unit with its recorded friction and current reader thinking/output, then save the full session, metadata, and final review under `scratch/document-flow-review/` in the active working directory. This review concerns the document's internal consistency and sequence, not the factual truth or external validity of its claims. Slash-command results are inserted into the current agent context; tool results enter it normally as tool output.
- Vim conversation edit command: `/vim` — opens the current conversation transcript in `$VISUAL`/`$EDITOR`/`vim`; changed lines are sent as the next user message.
- Working-directory switch command: `/cwd <path>`.
- Git commit command: `/git-commit [message]` runs `git add -A && git commit -m <message>`, defaulting to `auto`.
- Git worktree creation command: `/worktree <name>`.
- AGENTS.md command: `/init-agents-md [instructions]` asks the agent to create or update `./AGENTS.md` from the [coding-agent rules template](extensions/agents-md-template.md), keeping the project's own rules. Arguments guide this update only.
- Execution safety toggle: `/exec-lints`. Besides git and pipe-tail guards, it blocks the first standalone local `grep` in `bash` (pointing to `rg`; the built-in `grep` tool is disabled, and an identical retry passes) and a local `sleep` of 6 seconds or more, or any `sleep` inside a shell loop, in `bash` and `panel-send` commands, pointing to the orchestration `wait` tool. The first `py` script or local `bash` command per chat that rewrites a file with inline Python, `sed -i`, `perl -i`, or a `cat`/`tee` heredoc is blocked with a reminder to use `edit` or `write`; every later one passes. Local `pi` launches with either `--no-session`, `-p`, or `--print` are always blocked in `bash`, `panel-start`, and `panel-send`, including absolute executable paths, command wrappers and nested shell `-c` scripts. The rejection directs the agent to `do`/`delegate`, or to `ask` for user guidance if orchestration failed or spawning was denied; retrying does not bypass it. This is command inspection, not a security boundary: dynamically constructed commands, external scripts and other launch forms are not comprehensively inspected. Commands of 120 characters or more skip every lint except the git guards, Pi launch guards and file rewrite reminder. Focused test: `node scripts/test.mjs packages/extensions/extensions/exec-lints.test.ts`.
- Worker commands `/codemode-delegate` and `/delegate-alt` belong to orchestration; see [codemode delegation](../orchestration/README.md#codemode-delegation) and [alternate-model delegation](../orchestration/README.md#alternate-model-delegation).
- Tool configuration: `/tools` opens a branch-persistent toggle list in TUI or standard RPC dialogs that enables or disables individual tools immediately. Ctrl+S (RPC: **Save as default**) saves the exact current selection as `{"enabledTools": [...]}` in `~/.pi/agent/tool-selection.json`, the global default for branches without their own selection. Without a saved default, Pi's own active tool set is left unchanged. The selection is applied at session start, on branch changes, and on edits; before each prompt it is reapplied only if it changed (for example a default saved by another session, or Ugo control ending). Tools Pi activates itself in between stay active until the selection changes again: `codemode` or `tool_search` enabled when an MCP server connects, tools `tool_search` loads, and direct MCP tools. Selected tools that register later, such as those of a server that connected after startup, are activated. The list opens on the actual active tools, so toggling keeps Pi's activations. `do({task})` is the preferred worker tool for substantial tasks; [`microdo({task})`](../orchestration/README.md#tools) offloads small side tasks with a short action and target. Both inherit the conversation in the current directory. Existing saved selections must explicitly include `microdo` to enable it. `delegate({task, folder?})` is the occasional exception for a large standalone assignment; its worker sees project instructions but no conversation, so the task must be a complete brief. `fresh_look({task, folder?})` starts without conversation or discovered instructions; it is disabled at startup and is enabled manually in `/tools`. Independent sibling `do`, `microdo`, `delegate`, and `fresh_look` calls execute concurrently and join before the parent continues. Structured workers receive the caller's active tools that are available in the child, plus `do`. First-action delegation receives a one-time warning before retries are allowed, except an ordinary worker may immediately offload a side task with `microdo`. Ugo keeps its own tool control; `present_guidance` remains required when registered.
- Workboard command/context: `/new-workboard` creates `workboard.md`; when `workboard.md` exists in the current working directory, it is autoloaded into agent context as active operational state. `/new-workflow` creates editable `workflow.md` guidance policy; `/ugo` and guidance mode also create it when missing. Cold ideas/backlog items belong in project files outside `workboard.md` until promoted to `needs-enrichment` or `ready`.
- AGENTS.d auto-loading: before every agent start, discovers `AGENTS.d/` in the current directory and every ancestor through the filesystem root, without stopping at repository boundaries. Like Pi's `AGENTS.md` ancestor traversal, content is concatenated outermost-first, with the current directory last; a local directory is not required and same-named files from different ancestors are all retained. Each directory's top-level files and file-target symlinks load alphabetically. File paths, tree roots, and notifications are relative to the current directory, distinguishing inherited sources. Subdirectories are listed in trees at the end of the injected block but their contents are not loaded. Symlinks show their resolved real path; dangling symlinks appear only in the tree listing. Discovery and contents refresh each run, including after cwd changes. This is ancestor inheritance only: no separate global config-directory lookup or Markdown-specific override/worktree-shadowing rules. Focused test: `node scripts/test.mjs packages/extensions/extensions/agents-d.test.ts`.
- Guidance mode: `PI_GUIDANCE=true pi -p "inspect workboard.md and present_guidance"` loads editable `workflow.md` guidance policy and requires a structured `present_guidance` result. `bin/pi-guidance-loop` repeatedly runs guidance, executes `CONTINUE_WORK` prompts, applies `UPDATE_WORK` workboard updates, and stops on `REQUIRE_HUMAN_DECISION` or `EMPTY_WORKBOARD`.
- Ugo workboard loop: `/ugo` alternates ugo-guide and ugo-do phases in fresh sessions until `REQUIRE_HUMAN_DECISION`, `EMPTY_WORKBOARD`, commit failure, Escape, or `/ugo-pause`. Ugo creates `workflow.md` when missing and loads it as editable guidance policy for guide phases. Ugo requires a clean git worktree except for `workboard.md`, `workflow.md`, and `scratch/`, and commits changed files after each ugo-guide/ugo-do phase with the prompt, result, and automatic no-tools ugo-do reflection in the commit message. The reflection has `Retrospective` and `Simplify` notes; the complete reflection is injected into the next ugo-guide prompt so guidance can promote relevant improvements into workboard updates/items. Human-decision phases watch `workboard.md` and `scratch/decisions/*` for `DONE:` or `CLARIFY:` signals, apply the resulting workboard transition, and continue. Empty-workboard phases remain active and watch `workboard.md` for new work without creating decision artifacts. `/ugo` also resumes paused, human-decision, or empty-workboard state; `/ugo-pause` stops watchers immediately or pauses after the active phase safely checkpoints. See `HOWTO-UGO.md`.
- `#` prompt snippets: `#principles`, `#cut`, `#simplify`, `#delegate-review`, `#ts`, `#delegate-progress`, `#supervise`, `#api-review`, `#enrich`, `#distill`.
