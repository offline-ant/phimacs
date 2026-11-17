# Pi orchestration

One worker implementation with tmux, Herdr and Emacs/Pilish hosts.
Run from the Phimacs checkout. Hydrate the root graph with
`npm ci --ignore-scripts`, then compile/check affected packages and run focused
tests as described in [development](../../docs/development.md). Load compiled
package paths; use disposable sessions for checks. Package installation and loading
its Pi extension manifest are separate choices; there is no extension-local install.
The [npm package](../../docs/development.md#npm-packages) carries the same compiled
manifest; `emacs/` is also the `pi-orchestration` Emacs package.
Managed Pi launches resolve the selected global Pi to an absolute executable and
use common session claims. On the Emacs host, RPC agents and workers belong to the
separate foreground pimux service; every Pilish frontend is a protocol-2 socket
client. Only the `phimacs` launcher or a supervisor starts the service; frontends
never do: launches wait up to ten seconds for readiness and otherwise report how to
bring it up. Service restart restores roots idle, never workers or interrupted
work; see the [lifecycle](../../docs/lifecycle.md). The tmux and Herdr hosts need no
service or Emacs: their workers run Pi's TUI under `pimux tui`, which holds the
writer claim itself. No PATH-resolved `pi` or raw recovery writer is supported.
Native CLI/control replies have an explicit 1 MiB execution cap. Truncated replies
fail before parsing or accepting success, including zero-status replies. Panel
streaming/capture keeps its separate runtime and output limits.
The package also exports the [`peer-agents` skill](skills/peer-agents/SKILL.md)
for inspecting, waiting for and prompting sibling agents through `pimux agent`.

## Hosts

- **tmux:** direct machine-oriented CLI; Pi TUI in owned panes.
- **Herdr:** owned panes run the absolute managed TUI wrapper. Herdr's
  `agent.start` cannot select an executable, so it is not used to launch Pi.
  Pi's ordinary integration still reports native agent state.
- **Emacs:** local [Pilish](../../emacs/pilish/README.org) with the named-session
  API from this repository. Check its public integration
  API, not a source revision or archive; stock Pilish lacks the required APIs.
  [ghostel](https://github.com/dakra/ghostel) (libghostty-vt, 0.59.0 with its
  native module) is the sole shell terminal. Pi uses RPC chat/input pairs; shell
  panels support terminal keys and fullscreen applications. A persistent panel
  wrapper owns the PTY relay, input and capture independently of Ghostel display
  rendering; hidden-panel reads use that owned capture. Load Pilish and ghostel
  on the server's load path.
  Load `emacs/pi-orchestration.el` in Pilish's `use-package :config`, before
  the first root Pi spawn (not just when a worker starts):

  ```elisp
  (use-package pilish
    :commands (pilish pilish-toggle pilish-session-browser)
    :config
    (add-to-list 'load-path "/path/to/phimacs/packages/orchestration/emacs")
    (require 'pi-orchestration))
  ```

  The adapter also loads the companion when handling native operations.
  User interfaces (such as `pi-deck`) read live targets with
  `pi-orchestration-targets` (ID, kind, name, buffer and the parent's buffer,
  taken from the start spec's `parent`) and observe starts and closes through
  `pi-orchestration-target-functions`. Managed shell targets expose
  `:command-state` independently of the live wrapper. The public accessor
  `pi-orchestration-panel-command-state(buffer)` returns `held`, `running`,
  `exited` or `unknown` (nil for unmanaged buffers); UIs must not infer command
  completion from wrapper process liveness.
  `pi-orchestration-stop-target(id &optional callback)` closes without confirmation.
  Its return value is not success: `callback(error)` settles exactly once after
  root exit/native cleanup, or worker exit and its parent's final task cleanup/name
  release. Concurrent callers join one operation. Worker command acceptance is
  not completion. Failure/timeout retains the target and reports an error; no
  automatic destructive retry or worker-to-root promotion occurs. Worker Close
  uses public Pilish Close, which first requires a fresh `get_commands` response
  advertising the `worker-cancel` extension command for the captured context; a
  missing command never becomes an inference prompt. Internal attachment cleanup
  uses Pilish's disconnect API, never the user-facing global Close. A live-server
  cleanup failure propagates; only verified frontend disappearance is suppressed.
  Late task completion still reconciles its exact target after waiter timeout.
  The parent's final notification reconciles retained worker views through
  `pilish-reconcile-worker-task(buffer, runtime)` using exact read-only final
  evidence, even when transport disconnected before natural completion. It never
  sends stop/cancellation or reconnects; uncertain evidence retains the target.
  Pi workers are launched into service ownership before the companion attaches
  a view. A start prompt goes to the runtime before the view attaches, so work
  does not wait for the view. A worker can therefore finish and exit before its
  view is ready; its result file, not view readiness, then decides the outcome,
  and a missing result is still an exit failure. A new worker view sets Pilish's
  `pilish-history-hidden-before` to the worker's start time: its inherited
  conversation and earlier runs show as one line with a `[show]` button instead
  of being drawn. Their process-start identity, prompts, transcript reads and explicit
  stop do not depend on that view or daemon. A failed new worker attachment stops
  only the task it created; an independent root/fork remains available.
  Emacs can stall for a long time, so `emacsclient` calls have deadlines: 10 s
  for queries (`state`, `response`, `read`, `switch-state`), 60 s for mutations
  (`start`, `send`, `close`, `switch`), because killing a client mid-mutation can
  orphan its work. A killed client is a typed "did not answer" error, never read
  as output. Startup and `/switch` readiness keep polling through it until their
  own deadline, and prompt acceptance keeps polling; running workers do not depend
  on Emacs answering at all (see [Completion and waiting](#completion-and-waiting)).

Select one host per Pi process with `PI_ORCHESTRATION_HOST=tmux|herdr|emacs`
and `PI_ORCHESTRATION_ENDPOINT` (tmux/Herdr socket or Emacs server endpoint).
Without explicit selection, an unambiguous tmux or Herdr environment is used.
Conflicting native environments fail rather than guessing.
`PI_ORCHESTRATION_ENDPOINT` belongs to the explicitly selected host only; other
reachable hosts use their native endpoint (`HERDR_SOCKET_PATH`, `TMUX`).

New managed launches use the global `pi` on `PATH`, resolved to its absolute
entry point; an absolute `PHIMACS_PI` selects another host (tests use the
checkout's SDK copy).
Native tmux/Herdr run the compiled `pimux tui` wrapper, which claims
before opening the session and loads the cooperative transition guard. Input
readiness and stop receipts identify the actual Pi by PID/start-time/boot ID.

`/orchestration-host [tmux|herdr|emacs|reset|status]` overrides that environment
default for the current session branch, with a picker when the argument is
omitted. Only hosts reachable from this process are offered, for example Herdr
when Pilish itself runs inside a Herdr pane. The override applies to new workers,
panels, and forks; existing targets keep their host. It survives reload/resume
and normal forks, and `reset` returns to the environment default. The footer
shows `host:<kind>` (`*` for an override) when there is a choice. The companion uses
Pilish's generic `pilish-session-environment-functions` hook to set the Emacs
host, live server endpoint, and root session target before spawn. Owned children
retain their explicit target identity and endpoint across reload.
Targets retain their host and endpoint; later environment changes cannot redirect
operations. Execution and session/artifact files must be local; TRAMP is unsupported.

Child startup preserves the parent agent directory override, provider, model,
thinking level, and nesting depth unless a `do`, `delegate`, or `fresh_look` call
explicitly selects the configured alternate model (see below). Root depth is
zero; children at depths one through three are allowed. A depth-three session remains usable but cannot start
another Pi child. Shell panels do not consume worker nesting depth.

## Tools

- `do({task})`: the preferred worker tool. The ephemeral worker continues from
  the conversation as it stood before the calling assistant message, in the
  current directory, so `task` is a brief goal. `do({resume: "<name>", task})`
  instead continues a stopped worker from this conversation; see
  [Files and recovery](#files-and-recovery).
- `microdo({task})`: offload a small, self-contained side task immediately with
  a short action and target, for example `microdo({task: "update example.md"})`.
  The only argument is `task`, from 1 to 40 Unicode code points; longer tasks
  are rejected, not truncated. It inherits the same pre-call conversation as
  `do`, the current directory, model, thinking level, and remote target. The
  worker is instructed to complete the bounded task autonomously and report the
  outcome, verification, and any blocker in at most three sentences. This is
  report guidance, not truncation: recovery metadata, human guidance, and errors
  remain intact. It makes no retrospective request. There is no `alt`, `remote`,
  `folder`, or `resume` argument; use `do({resume: "<microdo-name>", task})` for
  recovery. Like `do`, it waits for completion, not background continuation.
  Use `do` when a short action and the inherited context are insufficient.
- `delegate({task, folder?})`: the occasional exception for a large standalone
  assignment. The worker starts blank with normal project/global resources;
  `task` must contain every necessary requirement.
- `fresh_look({task, folder?})`: like `delegate`, but also without discovered
  context files, skills, templates, or system prompts. It is disabled at
  startup; enable it manually in `/tools`.

  Saved tool selections remain exact; enable `do` or `microdo` in `/tools` if
  an existing selection does not include it. Without a saved selection, both
  are active by default.

  All four share one implementation. `do`, `delegate`, and `fresh_look` return
  the worker's result plus an automatic retrospective. Optional `alt` appears
  on those three only when enabled
  with `/delegate-alt`; omitted/false retains the caller's model, true uses the
  other configured model, or the first if the caller is outside the pair.
  Optional `remote: "user@host[:/path]"` runs the worker's tools on that SSH
  host; see [Remote execution over SSH](#remote-execution-over-ssh).

  New workers receive a conversation title derived once from the task's first
  sentence, not from the worker prompt's fixed instructions. Sentences starting with `Your`
  (notes about a worker's earlier run) are skipped when another follows. Simple
  formatting is stripped, filesystem paths become filenames, a leading
  `You are [a|an|the|next|one of N]` is removed, `You own` becomes `Own`, and an
  opening `subtask[ of X]:` label is cut because the worker tree shows the parent.
  Fixed whole-word fillers that repeat the tree or only add emphasis (`only`,
  `separate`, `distinct`, `new`, `subtask`, `genuinely`, `actual`, `actually`,
  `independently`, `agreed`, `a`, `the`) are removed. Leading whole-word actions,
  ignoring case and an optional trailing colon, become Review → `R]`,
  Implement and Build → `B]`, Investigate → `I]`, Fix → `F]`, Verify → `V]`. An
  opening pair joined by `and` or `&` combines prefixes in order: `Review and
  implement` → `RB]`. Up to three leading qualifiers (`read-only`, `independent`,
  `final`, `fresh-eyes`, `fresh`, `focused`, `narrow`, `critical(ly)`,
  `adversarial`, `second`, `small`, `quick`) may precede the action and stay
  lowercased after the prefix, and one `of`/`for` directly after the action is
  dropped: `Final fresh-eyes review of diff` → `R] final fresh-eyes diff`.
  Other openings, later actions, negations and filename components stay intact.
  Replacement precedes the 60-Unicode-code-point limit; titles fall back to the
  unfiltered excerpt when filler removal removes everything. There is no title argument or extra model
  call. Frontends use their normal width truncation; pi-deck also retains the
  title for finished workers. Generated `<tool>-<id>` handles remain recovery
  identities and transcript-link captions. Root-agent names/numbers are unchanged;
  resuming preserves the saved title, including subsequent human renames.
- `panel-start({name, command, folder?})`: start a server, watcher, or
  interactive program. The command runs in the shell Pi's `bash` tool resolves
  (`shellPath` setting, else bash), as a login shell (`-l`) when that is bash;
  hosts execute that argv under `script`, a PTY relay that also appends raw
  terminal output to a private capture log for `wait`. Panel-start itself has no
  readiness wait; use `wait`.
  To run several commands in sequence, start an interactive shell that emits OSC
  133 marks (`fish` 4+, or bash with the integration) and send each command with
  `panel-send`.
- `panel-read({name, lines?})`: bounded screen snapshot, default 500 lines, maximum
  2,000 lines/50KB. Reads may overlap; no incremental/lossless-log promise.
- `panel-send({name, text?, keys?})`: exactly one of a literal line of text or
  terminal keys such as `ctrl+c` and `Escape`; text always presses Enter. Input
  to a shell panel whose command has exited is refused with its captured exit
  status: command completion is separate from the still-live owning wrapper, so
  input must never reach a replacement native shell or later command. Text
  typed at a shell idle at its prompt with OSC 133 marks (see `wait` below; also
  through ssh) is followed in the capture log for up to 5 seconds. If its command
  ends (`D;<status>`, or a prompt start `A`, such as a nested shell's first
  prompt), the result is `finished` with the command's output and exit code. A
  longer command returns its output so far as `running`; a panel whose command
  exits meanwhile returns `exited`. Keys, and text sent to a running program or a
  panel without marks, return the output after a 250 ms settle as `sent`; use
  `panel-read` for the screen of a full-screen program. This is terminal input,
  not draft-safe Pi prompt delivery. When typed text goes where no shell reports
  its prompt (see `wait` below), the result ends with a warning naming the
  receiving program (for example `ssh -tt remote-host`, or the panel's own unmarked
  command) and how to fix it; the user
  also gets a one-time TUI notification per panel and program. Keys never warn.
  Pilish Pi targets are RPC conversations,
  not terminals; type into them in their input buffers.
- `panel-close({name})`: stop the owned target and release its name and capture
  log. Cancel an active worker request rather than closing it through this tool.
- `wait({panel?|file?|pid?, match?, timeoutSeconds})`: the replacement for
  `sleep`. Exactly one source. It returns at the first of: a new output line
  matching the JavaScript regex `match`; the panel's shell or gdb back at its prompt; the
  panel or pid process exiting (with its status when known); or the timeout,
  which is a result, not an error. A panel already idle at its prompt answers at
  once as `idle`. Progress updates show the latest line.

  Panel output comes from the capture log, not screen snapshots, so nothing
  scrolls away between polls. A `wait` returns only output no earlier
  `panel-send` or `wait` result returned, so their outputs join without gaps or
  repetition. The cursor is per panel, shared by every session.

  Shell completion uses OSC 133 marks (prompt start `A`, input end `B`, command
  start `C`, command end `D;<status>`) in the captured bytes, so it works for
  every host and through ssh. fish 4+ emits them by itself. Bash needs
  `source <phimacs>/packages/orchestration/shell/osc133.bash` at the end of `~/.bashrc`;
  fish 3 needs `source <phimacs>/packages/orchestration/shell/osc133.fish` in
  `config.fish` (both locally and, copied, on remote hosts; verified on macOS
  fish 3.7.1 and Windows Git Bash 5.3). Detection of unmarked input needs no
  ssh wrapper: when the last mark is a command start `C` (fish includes its
  command line) and nothing follows, input after it reaches that command, for
  example an ssh session, REPL, or nested shell without integration. gdb reports
  its prompt with `gdb -q -x <phimacs>/packages/orchestration/shell/osc133.gdb -ex 'set
  pagination off' -ex 'set confirm off'`: its prompt carries a status-less `D`
  and `A`, so `panel-send` returns each command's output (the text between the
  echoed line and that `D`) and `wait` ends when `run`/`continue` stops. Pager and
  confirmation questions have no marks, hence the two settings. Without marks, a command typed into an interactive shell cannot
  be detected as finished: such waits end only on match, exit, or timeout, and
  a timeout says so explicitly. Herdr 0.9.x and tmux expose no prompt state
  themselves; the capture relay is the host-independent source.

  `file` waits need `match` and examine only text appended after the call; a
  truncated file restarts from its beginning. A missing file fails immediately,
  pointing to a wait on the panel or pid that creates it. `pid` waits poll process existence
  and do not accept `match`. Escape cancels any wait. Panels started before
  output capture existed must be restarted to be waited on.

Codemode receives these results (`panel-close` returns the name as text):

| Tool | `structuredContent` |
|---|---|
| `panel-start` | `{name, host, cwd}` |
| `panel-read` | `{output, truncated, state: running\|idle\|exited, name, host}` |
| `panel-send` | `{output, truncated, state: finished\|running\|exited\|sent, exit_code?, wall_time_seconds, warning?, name, host}` |
| `wait` | `{output, truncated, state: matched\|prompt\|idle\|exited\|timeout, exit_code?, matched_line?, wall_time_seconds, warning?, name?, host?}` |

All four panel tools show every supplied argument in their normal collapsed TUI
call row, including partial arguments while the model is still streaming them.
Foreground `bash` retains Pi's execution and output contracts. The optional
[local bash extension](../extensions/README.md#agent-tools) and SSH replacement
share a 900-second (15-minute) default for omitted `timeout`; explicit values
override it. Human `!` commands, panels and `pi.exec` are unchanged.

Hosts clean their own provisional targets. After RPC commitment, failure stops a
new task-owned worker, never an attached agent or independent root/fork. An
independent runtime remains discoverable by its reported mux ID; attachment
failure never causes an automatic prompt retry or another writer.
All logical names share one registry and must match `^[a-z][a-z0-9_-]{0,31}$`.
Registered names, including exited panels and forks, remain reserved until
explicit close; a panel whose native surface was destroyed elsewhere reports
that on read and releases its name to the next `panel-start`. A host-native shell target whose server no longer listens counts as destroyed.
For a managed Pi, only its recorded process-start identity proves liveness or
exit; a disconnected frontend, stale discovery or refused socket proves neither.
Uncertain shutdown keeps the target and session claim for reconciliation. Native IDs are diagnostic details, not public lookup names.

Every native shell panel has a private identity-bound control endpoint and a
persistent wrapper allocated before any user command starts. The wrapper checks
its creator's exact PID/start-time/boot identity while held and running. Tmux,
Herdr and Emacs all hold commands until target registration and detached observer
readiness; cancellation before activation publishes a cancellation marker and
awaits owned rollback. Uncertain native allocation retains its binding, target,
capture and original/cleanup errors instead of deleting recovery evidence.

The wrapper owns the `script` PTY relay and admits text/keys through its exact
identity/token, never a reusable pane alias. The inner PTY starts with the native
terminal's dimensions; native resizes update its held slave descriptor and deliver
SIGWINCH to its foreground process group. The wrapper remains alive after command
exit, so completed output is readable and ordinary Close still has exact ownership.
Close settles observed child identities and the wrapper before releasing the
registered name/output. Descendants it may not signal (another user's, such as
`su`'s shell) are awaited until they end on the PTY hangup; any still running
fail Close with their PIDs, and a later Close retries. Tmux pins its server and conditionally closes the live
wrapper in the native command queue. Herdr allocates explicit wrapper argv and
uses its owning close-on-process-exit lifecycle, not alias-based `pane.close`.
Emacs disposes Ghostel only after wrapper cleanup; its sidebar uses the same
control API. A replaced surface cannot redirect input or authorize stopping its
new occupant. Unknown exit evidence retains the old binding for reconciliation.

A detached per-panel observer removes registered ownership after creator exit,
independently of frontend views. Cleanup remains asynchronous: a root's stop
receipt does not acknowledge all panel cleanup. Worker panels follow their own
creators; independent forks are not stopped. Native frontend/terminal destruction
can end its hosted wrapper, whereas an RPC view disconnect does not. Cleanup
tracks observed descendant process identities, not kernel-level containment:
deliberately daemonized/double-forked work can escape observation.

Observer readiness validates the registered target. Bootstrap/late errors remain
in its private diagnostic file; registry diagnostics are updated only while
holding the name claim, never by an unlocked read/check/save against a replacement.
Failed cleanup retains target/output and `closeError` for explicit reconciliation;
uncertain destructive operations are not retried automatically.
Tools of one assistant batch run concurrently, so panel starts and closes take a
short `operation` claim and wait for one another, and `panel-read`, `panel-send`
and `wait` look a name up only after such an operation finished: a batch acts on
one name in call order. A worker's `request` claim lasts its run; operations on
that name fail at once.

Independent sibling `do`/`microdo`/`delegate`/`fresh_look` calls run concurrently and
join before the parent continues. Pi startup alone is serialized to avoid
authentication races.

## Remote execution over SSH

A Pi process whose environment sets `PI_REMOTE=user@host[:/abs/path]` (any
OpenSSH destination, including `~/.ssh/config` aliases; without a path, the
remote home) keeps Pi itself local: providers and authentication, sessions,
browser tools, codemode, workers and panels' native hosts. Only execution
moves. `extensions/remote.ts` replaces `read`, `write`, `edit`, `bash`, `ls`
and `find` with Pi's own tool definitions over remote `*Operations`
(`remote-tools.ts`), and routes the user's `!`/`!!` commands through the
`user_bash` hook. Relative paths resolve against the remote directory and `~`
is the remote home. The [`py` tool](../extensions/README.md#py-scripts)
calls this same `bash` backend, so its interpreter, code and saved run folder are remote.
The remote host needs bash, coreutils, `base64 -d` and, for `find`, `rg`; nothing
of Pi is installed there. Python's additional runtime requirements belong to its
linked tool contract.

- **Connection:** `ssh.ts` runs every call through one multiplexed OpenSSH
  connection per destination (`ControlMaster=auto`, `ControlPersist=600`,
  `BatchMode=yes`, sockets in the private `$TMPDIR/pi-ssh-<uid>/`, shared by
  this user's Pi processes). Remote login shells differ (fish, zsh, bash), so
  the remote command is a fixed bootstrap carrying a base64-encoded bash script
  (limit about 90 KB per command). File contents travel on stdin, byte-exact.
- **bash:** output streams as it arrives. The command runs in its own remote
  process group under a watchdog that kills the group when ssh's stdin closes,
  so Escape, timeouts and a dying Pi stop it remotely (without a tty, killing
  the local ssh client alone would not). The exit status is reported separately,
  so background descendants that keep stdout open do not hold the result, and a
  missing status is reported as a connection failure. Truncated output's
  full-output file is copied to the same path on the remote host.
- **grep:** Pi's grep spawns ripgrep locally even with custom operations, so
  remote sessions deactivate it and replace it with a tool that fails with "use
  rg through bash".
- **System prompt:** the `cwd` section shows the remote directory and a `remote`
  section explains the split. Each run loads remote `AGENTS.override.md`/
  `AGENTS.md`/`CLAUDE.md` from the remote cwd and its ancestors (Pi's rules,
  without worktree shadowing) into project context, and remote `AGENTS.d/` into
  the `agents_d` section, in one round trip. Local project context files (local
  cwd and ancestors) and local skills are removed; global `~/.pi/agent/AGENTS.md`
  stays. The extensions package's `agents-d.ts` and `lints.ts` stand down. Workers started
  with `--no-context-files` (`fresh_look`) receive no remote instructions.
- **Failures:** an invalid or unreachable target never falls back to local
  execution: tools fail with the SSH error, the prompt says the host is
  unavailable, and the footer status shows `SSH <target> unavailable` instead of
  `SSH <user@host:/cwd>`. A later call reconnects.
- **Workers:** `do`, `delegate` and `fresh_look` accept `remote`. The parent
  resolves the target and directory over SSH before starting a worker (a
  `delegate`/`fresh_look` `folder` is a path on that host, relative to its
  directory), then starts the ordinary local child with
  `PI_REMOTE=<host>:<absolute dir>`. Without `remote`, a remote session's
  workers, forks and nested workers inherit its target through the host
  environment on every host (tmux, Herdr, Emacs). `microdo` always inherits
  the current target and offers no override. The recovery command
  restores the worker's target, or unsets `PI_REMOTE` for local workers.
- **Panels:** in a remote session `panel-start` runs
  `ssh -t <host> 'cd <dir> && exec bash -l -c <command>'` under the same capture,
  so `panel-send`/`wait` work with the remote shell's OSC 133 marks; `folder` is
  remote.
- **Resume:** sessions record `pi-orchestration:remote` entries; resuming one
  without `PI_REMOTE` warns that tools now run locally.

Limits: `wait({file|pid})`, the TUI's `@` file completion, `/cwd`, worktree
commands, the edit preview diff before execution, and any other extension
that touches the filesystem directly still act locally. Remote non-interactive
shell startup files must not print to stdout. Changing the target of a running
process requires a restart. `/switch` is not remote-aware; a
destination started without `PI_REMOTE` shows the resume warning above.

## Codemode delegation

Worker tools are model-only by default. `/codemode-delegate` toggles whether
`do`, `microdo`, `delegate`, and `fresh_look` can also be called from codemode scripts or
other tools. Explicit `/codemode-delegate on`, `off`, and `status` work in TUI,
RPC, and print mode. `on` removes `exposure: "model-only"`, using Pi's default
`direct` exposure; `off` restores it. Registration updates immediately without
changing the active-tool selection or `/delegate-alt` schemas. This does not
enable codemode or inactive workers; use `/tools` for that. In codemode `only`
mode, enabled workers follow Pi's ordinary callable-tool presentation.

The preference is global to the agent directory, saved atomically in private
`codemode-delegate.json` as `{"enabled":true}`. `off` removes the file. New
sessions, reload/resume, and workers read the same preference; other sessions
refresh on submitted input and worker calls. Invalid configuration fails closed.
Already-running workers are not cancelled by changing this preference.

```js
const results = await Promise.all([
  tools.do({ task: "Check the implementation" }),
  tools.microdo({ task: "update example.md" }),
  tools.delegate({ task: "Standalone assignment with its complete brief" }),
]);
for (const result of results) text(result.result);
```

A nested `do` or `microdo` follows Pi's parent-call links and forks before the **outer
model-issued tool call's assistant message**. It retains the prior conversation,
not script-local reads, earlier worker results in that same script, or unfinished
sibling calls. Include any such findings explicitly in `task`; use `do` rather
than `microdo` when they need a longer handoff. `delegate` and
`fresh_look` retain their blank-context policies. The one-time context warning
uses a branch entry so nested calls also retain acknowledgment across reload.

Codemode receives `{state: finished|failed|not_started, result, worker?, model?,
thinking?, remote?, retrospective?, guidance?}`. Startup
failures and cancellation reject. Await workers and print/return results you
want retained.
Pi cancels nested workers when the script is cancelled, but can settle the script
before asynchronous worker cleanup finishes and omit the worker's eventual
recovery error. Session files remain; verify the old worker stopped before
resuming. Use direct calls when durable per-worker recovery receipts are needed.

## Alternate-model delegation

Disabled by default: no configuration file is required or created, and `do`,
`delegate`, and `fresh_look` contain neither an `alt` parameter nor
alternate-model guidance.

Use `/delegate-alt` in TUI or RPC for **Disabled** or **Choose model pair**, then
select two distinct authenticated models. You can also use exact identifiers:

```text
/delegate-alt openai-codex/gpt-6-astra anthropic/claude-fable-5-1
/delegate-alt status
/delegate-alt off
```

Choosing immediately re-registers `do`, `delegate`, and `fresh_look` with or
without optional boolean `alt` (default false), updating the actual schemas and
descriptions without a reload. The active-tool selection is preserved, including
disabled tools. This does not affect forks. `microdo` never offers `alt` and
always uses the caller's model.

When enabled, `alt: true` selects the other member relative to the current
caller's provider/model, or the first configured model if the caller is outside
the pair; nested workers follow the same rule. Missing auth, an unavailable selected
model, or a stale alternate request after disabling produces an error, never a
substitute-model fallback. Model IDs starting
with their own provider prefix are refused because Pi's child CLI interprets them
ambiguously. Parent model/thinking remain unchanged. The worker inherits thinking
clamped to the selected model's capabilities; startup flags and the structured
request use that same selection. Progress and results identify the selected model.
Once started, a request is not redirected by later configuration changes.

Selection is global to Pi's agent directory, saved atomically as private
`delegate-alt.json` (honoring `PI_CODING_AGENT_DIR`):

```json
{
  "models": ["openai-codex/gpt-6-astra", "anthropic/claude-fable-5-1"]
}
```

`off` removes that optional file. Reload/resume, new sessions, and workers read
the same global setting; this is not branch-local state. Other running sessions
refresh before their next submitted prompt or worker-tool invocation, without file
watchers. Invalid configuration reports an error and hides the option while
ordinary same-model calls remain usable. Picker cancellation preserves the
previous selection. `/scoped-models` does not enable or disable this feature.

Model selection is independent of the tool. `do` with `alt: true` is the ordinary
second opinion and still carries the conversation; a provider extension may
represent unmatched inherited history as a lossy text handoff rather than native
tool/thinking history. For a review without the conversation, use `delegate`
with a complete brief, or `fresh_look` when project guidance is also unwanted.

## Interactive commands

`/switch [emacs|herdr]` opens a picker when omitted. For a committed
protocol-2 RPC agent, `emacs` attaches another frontend to the **same runtime**, including while work, queues or dialogs are active. It never reloads
the source, persists transfer metadata, submits a prompt, releases a writer claim
or opens the session in another Pi. Both views remain synchronized. Disconnecting
a view is distinct from stopping the agent everywhere.

Source discovery is only a locator. Before attachment, the current session claim
must identify this exact Pi (PID/start-time/boot identity), its initial capability
and committed protocol-2 discovery. A spoofed/stale discovery entry or retained
old-file claim cannot authorize sharing another conversation.

- **Emacs:** an explicitly selected endpoint must already run. Otherwise configure
  `PHIMACS_EMACS_LAUNCHER` as the absolute selected deployment launcher (the
  checkout's `scripts/emacs-launch.mjs`); there is no global fallback. It receives `--no-frame --json` and returns its socket.
  The companion ships in the same checkout and only attaches. The `switch`
  request names the runtime's `muxId`; a request without it is refused. Its
  acknowledgement and `switch-state` readiness must report that same mux ID. Failure cleanup sends
  `{close:true,detachOnly:true,muxId}` and may disconnect only its own new view. A failed/uncertain client
  attachment leaves the source agent and claim intact. Cleanup disconnects only
  the new view, never stops a shared runtime.
- **Herdr/native sources:** writer handoff is refused with an actionable message.
  Pi 1.5 cannot permanently freeze a loaded source before another writer opens
  its file, and cancelled/failed replacement has no authoritative settlement.
  Reloading the same file only releases provider state, not writing authority.
  No destination preflight or startup occurs and no source claim is released.

To reopen a native conversation, explicitly
stop its managed source, verify actual owned process exit, then use the selected
checkout's managed launcher; never start a raw second Pi against a live file.
Universal storage safety and transactional native handoff require an upstream
owning API, not a claim bypass or a hidden feature substitution.

`/worktree` reserves its newly allocated session path through the public
`@phimacs/orchestration/session-transfer` `reserveManagedSession` export before the
first file write. It copies an in-memory snapshot, preserves the selected branch,
and exclusively creates the new file rather than opening/migrating another
mutable session. Cancellation/failure conservatively retains the reservation
until this writer exits; a second managed process cannot take it meanwhile.

`/fork-here [name] [folder] [-- <prompt>]` opens an independent conversation on
the same host, defaulting to the parent's cwd and the name `<session>-fork` (the
session name, else the cwd's basename; `-fork-2`, … when taken).
No prompt means idle. The parent branch, session, and editor draft are unchanged.
A running parent keeps working: its fork ends at the latest finished reply or
complete tool batch, without a running tool call, an unanswered prompt, a failed
reply awaiting retry, or queued input.
Forks inherit the active branch, provider/model/thinking, and exact applicable
active tools. They have no result wait, retrospective, or automatic close.
Tmux/Herdr use an explicitly identified sibling pane; Emacs creates a separate
non-displaying Pilish chat/input pair. Native placement never follows current
focus. Pi's built-in `/fork` is unchanged.

`Ctrl+Alt+F` opens an unprompted fork in Pi TUI and Pilish. The companion binds
`C-M-f` in both Pilish buffers to `pi-orchestration-fork-here`; Pilish itself
contains no orchestration environment, server dependency, or fork shortcut.
`ask` offers **Fork (discuss separately)** on all hosts: edit the discussion
prompt, fork immediately before
the active ask call, then return to the unchanged question and selections. This
works while the parent waits for the answer. `/tools` works in TUI and RPC using
shared selection policy with native presentation. Pilish's multiline
editor dialogs use separate buffers, never the parent prompt draft.

- `/panels`: list registered shell panels, workers, and interactive forks.
- `/worker-return [text]`: hand back to the parent now, in a worker. The result
  is the saved main result if there is one, else `text`, else the latest assistant
  text of this worker run (never the inherited conversation). With nothing to
  return it warns and changes nothing. Otherwise it stops any current work and
  completes without a model retrospective; during the retrospective the main
  result stays immutable and `text`, if given, becomes the retrospective.
- `/worker-cancel`: explicitly ends this worker's exact private parent-task lease,
  then stops its owned work without publishing a final result or retrospective.
  The Emacs worker Close action uses this command, not root-runtime stop. A dispatch
  receipt is not an exit acknowledgement: the parent verifies actual exit, closes
  its native target, removes the registered name and releases its claim before
  acknowledging the companion's pending Close. Failed cleanup preserves both the
  original task error and cleanup errors. Failed or uncertain dispatch retains the
  view; it is never retried
  automatically. Ordinary roots cannot use this command to terminate another task.

## Equal-client worker task evidence

`@phimacs/orchestration/worker-task` exports `readWorkerTask(muxId, env?)` and the
owning parent's `publishWorkerTask(target, binding, env?)` / `finishWorkerTask`.
The read-only `phimacs-task-status --id MUX --json` executable exposes the same
record to non-TypeScript frontends. Query in the captured runtime's namespace:
`PIMUX_DIR=dirname(runtime.socket)`, not an unrelated frontend default.

Private atomic `task-receipts/<muxId>.json` files bind schema 1, mux ID, exact
worker process identity, parent process/task ID and existing lease path. State is
`pending`, `complete` or `failed` (with `error`). The parent publishes pending
before registering the target; initial frontend attachment may precede publication,
so absent evidence must refuse cancellation rather than send speculative input.
After worker exit, host cleanup, target removal and name release, the parent
publishes terminal evidence before its frontend notification. Final publication
independently verifies the exact parent, matching ended lease and dead worker.
Terminal records survive target/lease removal; the most recent 128 are retained.

Equal clients capture the pending identity before cancellation and wait for the
same binding's `complete` record. Command acceptance, `pimux_exit`, an ended lease,
missing/unsafe evidence and socket loss are not task completion. `failed` reports
the original/cleanup error; it is never success. If death or lease termination
cannot be proven, finalization fails and evidence remains pending. Reconnect or
status queries never cancel, stop, restart or replay input. Native terminal workers
without an RPC mux retain their existing owning-task cleanup path.

## Completion and waiting

The shared `worker-frame.ts` owns one current request/result schema. The parent
writes `request.json` beside the worker's parent task lease and the exact first
prompt to `prompt.md`. At session start the worker loads that request; when the
parent's prompt arrives with exactly that text, its `input` handler applies the
request's model, thinking and tool policy before Pi starts the run. The prompt
never starts with `/`: pimux re-snapshots every client after a slash prompt,
which would make frontends rebuild the whole inherited transcript again. Earlier
input is ordinary. The child saves `result.md`. Missing, unreadable, invalid or
foreign requests (including a missing required `resultPolicy`) fail startup and
stop the owned worker so its parent can finish cleanup, rather than leaving an
idle process and pending tool.
No result or retrospective is fabricated for startup failure. Ordinary requests then run a retrospective (its prompt
forbids tool calls; the tool set is unchanged, so no transcript system message is
added) and save `retrospective.md`. Brief requests from `microdo` skip that model
request and artifact. Both atomically publish a matching `result.json`. Only that matching final
artifact means completion—not an input acknowledgement, idle screen, spinner,
or process exit. Failure resolution waits for Pi's `agent_settled`, including
retries and overflow compaction. Any unresolved main-task assistant error or
abort, including a human interrupt and provider quota, authentication, and
context errors, leaves the worker **waiting for you**. Provider failover and Pi
recovery run first; successful recovery continues automatically.

An agent that only waits on orchestration work is distinct from one that works.
`extensions/waiting.ts` sets extension status `orchestration-waiting` to
`waiting` while tools run and every running call without running calls of its
own is `do`, `microdo`, `delegate`, `fresh_look` or `wait`, including calls a
codemode script makes. Streaming, any other tool and a script's own code clear
it. Frontends may show it as its own state (pi-deck's `◌ waiting`).

A waiting worker stays open with its history and actual reason, and the parent
tool remains pending until completion or cancellation. `status.json` has
`state: "waiting"` and `waitingReason`; `ctx.ui.setStatus("worker-frame", ...)`
starts with `worker:waiting`, which frontends may match on that key; a warning
notification and a widget say what to do; parent progress reports
`details.status: "waiting"`. Entering it does not itself resume an already-failed
request. To go on, do either:

- **Type a message.** Any new agent run leaves waiting, at `agent_start`, so a
  rejected prompt keeps it. The next final reply follows the normal path:
  result reaches the parent, with a retrospective for ordinary requests and none
  for `microdo`. That path is the same
  whether or not a human took part, so a side question's answer can become the
  result; the parent can tell from the user guidance below.
- **`/worker-return [text]`** hands back now, without a model request.

Messages typed while a worker runs are ordinary Pi steering and change nothing
about completion. Every message a human sends a worker, whenever they send it,
reaches the parent ahead of the result as positioned user guidance, so it can
judge whether the result finishes the task or the worker needs `do({resume})`:

```text
> User guidance: what a human did in this worker. [n] counts the model messages it had sent by then, of 301. If the result below does not finish the task, continue the worker with do resume.
[32] Use the staging database instead.
[300] What are you doing?
```

Positions count this request's model messages; an early `/worker-return` is
listed too. `result.json` holds the same data as `guidance` and `modelMessages`.
A run without human input has no such section. A worker stopped by parent
cancellation returns no result, so its guidance stays in its transcript.
Parent cancellation still stops the worker. Startup, process,
and protocol failures remain terminal. A failed retrospective returns the
successful main result with an unavailable-retrospective note.

Liveness does not depend on the host. Targets and matching status records carry
`process:{pid,startTime,bootId}` for the actual worker Pi. The parent checks that
identity, never a reused PID, Emacs network process or tab. A status record without
it is invalid; bounded host-state grace applies only before the first status.
The parent and worker must share a PID namespace, like their artifact files.

Before startup the parent creates private `parent-task.json` containing
`{schema:1,process,taskId,state:"active"}`. `PHIMACS_PARENT_TASK` carries the process
identity/task ID and `PHIMACS_PARENT_TASK_FILE` names that lease. Frontend detach
leaves it active. Parent cancellation/completion records `ended` before cleanup;
worker startup and ongoing monitoring stop the worker on that terminal state,
process death or malformed/uncertain lease, even before the first prompt arrives.
This does not create a result or replay work. Detached workers also give pimux the
same owning parent process/task identity. Native panels retain host lifetime.

A provider extension may wait out a quota limit inside its original request and
then retry inference from the exact input/tool-result checkpoint. Phimacs ships
no such provider; any provider may implement the events below, and providers
that ignore them keep normal failure handling. During such a wait, completed
tools are not replayed and no extra user message is injected. The parent remains pending;
local UI and parent progress show the scheduled retry time in the process's local
timezone with its UTC offset. Parent cancellation or Escape cancels the current
provider request, not recovery for later prompts; the worker then waits for you,
and a typed message starts a request with the same recovery. `/worker-return`
during a quota wait aborts that pending request. A quota wait happens inside a
run and waiting for you between runs, so the two never coincide.

The public extension event contract is:

- Worker → provider: `pi-provider:recovery-policy` with `{allowed:boolean}`.
  Main start publishes `true` before its prompt; only the optional retrospective
  phase publishes `false`. Human input, waiting and self-compaction do not disable
  recovery. Completion and shutdown restore the default `true`; actual request cancellation belongs to abort/shutdown, not this
  policy. Retrospective failure therefore returns the saved main result without
  waiting for quota.
- Provider → worker: `pi-provider:recovery-status` with
  `{sessionId:string,retryAt?:number}`. `retryAt` is absolute epoch milliseconds;
  omission clears it. Only the current session's main work accepts it.
  `status.json` and parent progress details carry `retryAt` during the wait;
  progress details use `status: "quota-wait"`. The worker owns no retry timer.

Unsent draft edits and submitted human input do not change policy; normal Pi
steering semantics apply. Other errors, unsafe checkpoints, and partial
responses retain normal failure handling. Loading this integration does not
revive failed requests.

When `self_compact` is enabled, its private `pi-ant:self-compact-handoff` events
identify the terminating tool call and its resumed or failed handoff. Only a
matching successful tool result preserves automatic capture while native compaction
runs and the note restarts work. The eventual final answer follows the request's normal completion policy,
including no retrospective for `microdo`. Failed, cancelled, or skipped handoffs use the existing
failure handling even when they happen after `agent_settled`. No timers, polling,
or Pi-core changes are needed. Worker
prompts discourage compaction near completion only when the tool is enabled.

Pilish submits ordinary input through RPC `prompt` with `streamingBehavior`.
Backend queue snapshots, `clear_queue`, and `agent_settled` replace local
follow-up queues/timers. Rejected ordinary prompts, including compaction
rejection, keep the input draft.

Both tmux paste and Herdr 0.8.2 `agent prompt` append to human drafts. Therefore
both terminal adapters explicitly load the same internal `terminal-input`
extension and submit machine prompts over a private local Unix socket. It calls
Pi's supported extension input API without reading or modifying the editor.
This is only input delivery, not another worker protocol or scheduler.
`fresh_look` terminal workers load this input extension and the common worker
frame explicitly; on Emacs they need only the common frame. `fresh_look` blanks
the worker's conversation and instructions, not its runtime: extension discovery stays enabled, because
providers are registered by extensions and a worker cannot reach an
extension-registered model without them.

The parent polls structured status through the same `onUpdate` contract on every
host, with a preview of what the worker appended to its session file since the
wait began: recent user and assistant text and tool calls, at most 12 lines and
8 KiB, read from a bounded tail so entries of any size cost nothing. It shows
completed messages, not streaming text. The complete transcript remains in the
child pane/buffer and session file. Every worker closes itself after writing its
final result. Cancellation stops owned work instead of abandoning the wait. Session files and diagnostics remain
available for recovery. Workers receive available parent tools plus `do`.
First-action re-delegation gets a one-time warning, except an ordinary worker may
immediately offload a small side task through `microdo`. A `microdo` worker still
gets the warning when its first action is delegation. Above 90% parent context
(using Pi's reported model limit), the first `do` or `microdo` on a branch is not
started and suggests `delegate`; explicitly retrying proceeds. `delegate` and
`fresh_look` never warn.

## Files and recovery

Worker session files mark themselves; frontends (pi-deck's Reopen agent) rely on
this to tell workers from top-level sessions. A fresh-context worker's first entry
after the header is a `pi-orchestration:delegate` custom entry. An inheriting
worker's file has `parentSession` and a `pi-orchestration:delegate-runtime` entry
whose `childSession` is that file.

A stopped worker continues with `do({resume: "<name>", task: "..."})`, on every
host. Each worker start persists a `pi-orchestration:worker` branch entry (name
`<tool>-<id>`, tool, session file and ID, cwd, launch arguments and environment,
remote target, model, thinking level) before the host starts anything. `resume`
takes the latest entry with that name on the current branch, so it survives
reloading the parent and belongs to its conversation branch; an unknown name is
an error. It reuses that stored launch and session file, never forks, skips the
context warning, and goes through the normal worker path with new artifacts and
a new request ID, so the parent gets a result again. The name's claim and registry
entry refuse a worker that still runs. It works for any stored worker, including
`microdo`, `delegate`, `fresh_look` and finished ones, and cannot be combined with
`alt` or `remote`. Resuming a `microdo` worker preserves its brief report policy
and skips the retrospective, even though the recovery call uses `do`. Results
and progress name the worker in their first line.

Thrown errors, including parent Escape and startup/process/protocol failures,
state the worker's name, that its conversation is saved, and the exact
`do({resume: ...})` call, in model-visible content because Pi discards error
details. After a parent interrupt you can therefore just tell the parent to
continue. On Emacs that is all, since pi-deck has a Resume action.

On tmux and Herdr hosts each direct call also publishes a copyable shell
resume command as soon as its session is prepared, before host startup. Progress
and successful results retain it in `details.sessionCommand`, not model-facing
`content`. The shared TUI result renderer displays the hint as **User-only recovery
command (not sent to model)** in both collapsed and expanded views. Rendering does
not add it to the prompt. Non-TUI clients may display that metadata themselves.
Errors repeat it in model-visible content, not labeled user-only. Progress and
successful results on every host also carry `details.savedConversations` (version 1:
absolute session directory `root`, relative `file`, header `sessionId`, label
`<tool>-<id>`), which Pilish renders as a read-only link to the worker transcript.
Finished tool results persist in the parent transcript, including successful
recovery metadata and cancellation content. Live progress alone is not durable if
the parent process is forcibly killed.

Run the offered shell command **after the original worker has stopped**. If cleanup
failed, resolve that failure first to avoid two processes writing one session.
It uses absolute Node, the selected compiled `pimux tui` wrapper and the exact
Pi executable with its version/hash, never `pi` from PATH. It clears
inherited claim, parent task, discovery, nesting, host and private input/target
identities, and retains an explicit absolute agent-directory override. Pi restores the saved working directory and model/thinking state;
no `cd`, original worker flags, temporary request files or worker prompt are needed.
The worker request is process-local, so reopening does not resurrect automatic
completion, retrospective, or auto-close. Normal resources load, including for a
former `fresh_look`. Enter a new prompt to continue; `/login`, `/model`, or
`/compact` may be needed to resolve the original failure. This is an independent
ordinary session, not a resumed parent tool call. No session files are deleted
or rewritten by orchestration cleanup; only already-persisted progress is recoverable.

- `/tmp/pi-orchestration-worker-*`: request, status, main result, retrospective,
  final matching result, and prompt diagnostics.
- `/tmp/pi-orchestration-targets`: target records and exclusive request claims.
- `/tmp/pi-terminal-*`: private terminal-input sockets, removed with owned targets.
- `/tmp/pi-panel-*`: Herdr shell command liveness files, removed on close.
- `$TMPDIR/pi-ssh-<uid>/`: private OpenSSH control sockets for remote
  execution; masters exit 10 minutes after their last use.
- `/tmp/pi-panel-output-*`: raw panel capture logs (`output.log`, unbounded
  while the panel lives) and `wait.json` cursors, removed on `panel-close`.
- `/tmp/pi-mux-<uid>/` (or `$PIMUX_DIR`): `pimux` discovery files and sockets, see
  [pimux](../pimux/README.md).

Every Pi child a host starts gets `PI_ORCHESTRATION_PLACEMENT` (`worker` or
`interactive-fork`) and `PI_ORCHESTRATION_PARENT` (JSON `{host, endpoint, id, name}`
of the starting session, empty without one). They identify it to frontends that share
it through `pimux`; independent launches (`/switch` and resume commands) clear them.

Logical-name claim files contain the holder's process-start identity, purpose
and unique token. Only a confirmed dead matching holder's unchanged claim can be
reclaimed; any other claim record is invalid and fails closed. These names are separate from the
common canonical session writer claims, which persist until actual writer exit. Registry entries of targets whose host reports them
missing remain until the name is read, started or closed again; there is no
global stale-cleanup command. Updating the source does not restart running sessions.

## Checks

Run from the Phimacs workspace root after explicit dependency hydration and
compilation. The root runner resolves SDK imports from declared dependencies,
not global npm or a sibling reference tree.

```sh
npm run check
node scripts/test.mjs packages/orchestration/session-tools.test.ts packages/orchestration/context.test.ts
node scripts/test.mjs packages/orchestration/extensions/fork-here.test.ts packages/orchestration/switch-session.test.ts
node scripts/test.mjs packages/orchestration/extensions/delegate.test.ts packages/orchestration/delegate-policy.test.ts
node scripts/test.mjs packages/orchestration/extensions/waiting.test.ts
node scripts/test.mjs packages/orchestration/worker-frame.test.ts packages/orchestration/worker-preview.test.ts
node scripts/test.mjs packages/orchestration/panel-owner.test.ts packages/orchestration/extensions/panels.test.ts
node scripts/test.mjs packages/orchestration/remote.test.ts packages/orchestration/extensions/remote.test.ts
node scripts/test.mjs test/integration/ask.test.ts test/integration/self-compact.test.ts test/integration/error-prompt.test.ts
```

The Emacs companion's ERT suites (`emacs/pi-orchestration-test.el` and
`emacs/pi-orchestration-runtime-test.el`) use synthetic peers and prepared Lisp
inputs, never a user daemon:

```sh
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node scripts/emacs-deck-tests.mjs --orchestration [--selector REGEXP]
```

The opt-in actual-child worker check is an explicit long-test lane. It uses an
explicit isolated foreground pimux service and faux Pi, with synthetic frontend
attachment, to verify one main request for `microdo` versus main plus retrospective
for `do`; it needs no user host, credentials, or paid calls:

```sh
PI_MICRODO_CHILD=1 timeout 60 node scripts/test.mjs packages/orchestration/microdo-integration.test.ts
```

Native integration tests are opt-in and use only test-owned runtimes with faux
inference. Read [the integration prerequisites](../../test/integration/README.md)
before enabling them; use this checkout's source and explicit prepared Lisp/Ghostel
inputs rather than borrowing a live installation or home caches. Isolate every
runtime registry, agent directory, session directory, socket and provider state.
RPC harnesses explicitly start and stop their own foreground pimux service.
Never run against the user's Emacs daemon or restart a user service. Shell panels
require the selected terminal host and its documented native tools.

The bounded terminal parity checks verify initial dimensions, native resize and
SIGWINCH, alternate-screen redraw, canonical echo and raw keyboard bytes:

```sh
node scripts/test.mjs packages/orchestration/hosts/tmux-panel-parity.test.ts
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node scripts/test.mjs packages/orchestration/hosts/emacs-panel-native.test.ts
```

These use disposable tmux and Emacs/Xvfb hosts and a local Python fixture through
`uv`; the Emacs checks use this checkout's `emacs/pilish/` and skip unless
`PHIMACS_TEST_EMACS_DIR` names an explicit prepared Emacs directory with the dependencies,
Ghostel module and essential grammars (see [development](../../docs/development.md)).

The practical Emacs socket lane uses the in-repository Pilish source and an
absolute prepared `PHIMACS_TEST_EMACS_DIR`. Run it with:

```sh
PI_CONTEXTUAL_NATIVE=1 PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node scripts/test.mjs packages/orchestration/hosts/contextual-native.test.ts
```

It exercises acknowledged worker startup, completion after view detach,
parent-task cancellation, idle fork prompting, same-runtime reattachment,
explicit stopped-session recovery and confirmed stop. It creates its own HOME,
session/claim/discovery and durable-state namespaces, and an Emacs daemon;
without the explicit opt-in it skips and supplies no native acceptance evidence.
