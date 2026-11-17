# pimux: service-owned Pi runtimes and equal frontends

One foreground `pimux serve`, started by the `phimacs` launcher or an explicit
supervisor, owns all managed RPC
agents and workers through retained per-agent owner processes. Pilish and
command-line clients connect directly to each agent's private Unix socket;
frontends do not own its lifetime. Frontend restart preserves agents. Service
restart ends old agents and reopens root conversations idle with fresh
extensions; workers and interrupted execution are never restored. There is no primary promotion or idle auto-stop.

Linux, Node 24 and a Pi host are required. Compile with the workspace's
`npm run compile`; the executable and every Node-loaded module are JavaScript and
work below `node_modules`. The [npm package](../../docs/development.md#npm-packages)
installs beside the global Pi. The companion, tree-navigate and guard extensions are
explicitly loaded, never auto-discovered package extensions.

## Launch and control

```sh
pimux serve  # foreground service: started by `phimacs`, or `phimacs service pimux` under a supervisor
pimux start --json -- /absolute/global/pi-coding-agent/dist/bundle/cli.js --mode rpc --session /absolute/session.jsonl
pimux list --json
pimux watch --json
pimux lookup --json --session /absolute/session.jsonl
pimux receipt --json --id <muxId>
pimux resolve --json --id <oldMuxId>
pimux stop --json --id <muxId>
pimux tui -- /absolute/global/pi-coding-agent/dist/bundle/cli.js --session /absolute/session.jsonl
```

`start` returns exactly one JSON object on stdout:

```json
{"protocol":2,"operationId":"opaque","muxId":"opaque","socket":"/private/runtime.sock","pid":1234,"piPid":1235,"sessionFile":"/private/session.jsonl","state":"committed","outcome":"started"}
```

`start --operation-id <uuid>` (before `--`) selects the launch operation ID instead
of a random one; it must be a new lowercase UUID, and a reused one is refused.
Discovery publishes it from the provisional phase on, so a frontend can recognize
its own launch there before the receipt names the mux ID. An `attached` receipt
names the existing runtime's operation instead.

`list` prints the discovery records whose owner may still run (unknown liveness
counts as running), in creation order (`startedAt`, then `muxId`). Dead owners'
files are filtered, never deleted. `watch` needs no service: it prints one line
`{"type":"agents","agents":[…]}` with the same complete list at once and again
whenever it changes, ignoring `updatedAt`, until stdin closes. Directory events
are batched for 100 ms and the directory is reread every 5 s, which notices dead
owners and missed events. Each line replaces the previous one; there are no
deltas, so a restarted consumer resynchronises from its first line. A missing
directory lists nothing until it appears. Both commands fail (exit 1) for a
directory that is not private; `watch` also when it becomes unsafe.

`start` requests the already-running service; it never starts a daemon. It waits
up to ten seconds for readiness, then reports
``pimux unavailable; start it with `phimacs` or its supervisor, then retry``. The outcome is `started` or
`attached`. Only a compatible RPC owned by this service is attached. A native TUI,
unmanaged detached owner or other service refuses; stop its exact owner before
explicitly reopening its conversation. No duplicate writer fallback.
Absent `--session`, the launcher allocates an exact unique pathname before spawn.
Resolve session IDs/continue/resume/fork selectors read-only in the frontend first;
managed startup rejects unresolved selectors, `--no-session` and initial prompts.
Submit intentional input only after the socket's complete snapshot/live boundary.

The host must be the absolute Node entry point of an `@earendil-works/pi-coding-agent`
package. `resolveHost(env)` (`@phimacs/pimux/host-identity`) selects the global `pi` on
`PATH`, or an absolute `PHIMACS_PI` override, and records its path and version.
Bytes and versions are not pinned: attaching checks the owner's exact process
identity, so a runtime keeps the Pi it started with across a global Pi update.
Managed argument selection uses the workspace SDK's public `parseArgs` API,
not a second guessed flag parser. Discovery/control CLI commands, the detached
owner, `host-identity` and `host-modules` do not load that SDK. The CLI execs a separate static launch entry for
`serve`/`start`/`tui`, preserving its PID, environment, stdio and cancellation signals.
The public `main`, `runtime` and `host` aggregate exports retain their launch APIs.

`tui` is a separate managed native launch, not an RPC bridge. It inherits the
terminal, holds the same writer claims and loads the transition guard. Its lifetime
remains terminal/host-owned; it is not an attachable shared root. Raw Pi remains
outside the cooperative guarantee.

## Agent client

`pimux agent` is a command-line frontend beside Pilish, for agents and scripts.
The [`peer-agents` skill](../orchestration/skills/peer-agents/SKILL.md) teaches
agents to use it. It is SDK-free (`agent-cli.ts`, `agent-client.ts`).

```sh
pimux agent list [--all]
pimux agent get <muxId>
pimux agent read <muxId> [--messages N] [--format json|text]
pimux agent wait <muxId> [--until idle|working|blocked]... [--next-turn] [--timeout MS]
pimux agent prompt <muxId> [--follow-up|--steer] [--wait [--until STATE]...] [--timeout MS] -- <text>
```

- Each command prints one JSON value (`read --format text` prints text). Failures
  print `{"error":{"code","message",…}}`: exit 2 for `timeout`, 3 for
  `agent_exited` (with the retained terminal receipt), otherwise 1 (`usage`,
  `agent_not_found`, `agent_ambiguous`, `agent_unavailable`, `agent_blocked`,
  `agent_working`, `self_target`, `prompt_rejected`, `prompt_uncertain`,
  `agent_prompt_stalled`).
- `list` and `get` read discovery only. Default `list` peers are roots and
  interactive forks whose cwd is the caller's, excluding the caller (named by
  `PIMUX_DISCOVERY`) and every worker, newest `updatedAt` first. `--all` lists
  every agent and marks the caller `self`. `title` is the session name, else the
  first user prompt in the session file's first MiB. A target is an exact muxId
  or a unique prefix.
- `read`, `wait` and `prompt` connect as an ordinary peer. They rebuild the
  runtime's own `MuxState` status (the discovery status source) from a complete
  snapshot/live boundary: the snapshot's run state, its replay, then live records.
  A gap or session/tree change waits for the next boundary.
- `read` reports the last user prompt and the last assistant text after it from
  the snapshot messages plus live `message_end` records, and `inFlight` streaming
  text. `--messages N` gives the last N user/assistant text messages; tool
  output and thinking are omitted.
- `wait` matches idle or blocked by default, including the state at attachment.
  `--next-turn` matches only after a live `agent_start` following the boundary,
  so a run already active at attachment does not count. Unlike Herdr, this
  tracks runs rather than lifecycle state.
- `prompt` sends Pi's RPC `prompt` once through `runtimeRequest`, after its own
  observing connection is live, so no record of that run is missed. It refuses
  a blocked agent and a working one unless `--follow-up` or `--steer` selects
  Pi's `streamingBehavior`. `--wait` follows the response's disposition:
  `handled` returns at once, `queued` waits for the current run, `started`
  waits for the run's `agent_start` (otherwise `agent_prompt_stalled` after five
  seconds) and then for a matching state. Uncertain delivery is reported, never
  retried.
- It never stops, closes or aborts agents and never answers dialogs. Waiting on
  or prompting the caller itself is `self_target`.
- Discovery `updatedAt` is the owner's last discovery write: at startup, commit
  and snapshot adoption, and when status, blocked state, session, model or
  thinking level changes. An agent waiting inside a long tool call (for example
  `do` with a running worker) stays `working` with an old `updatedAt`; that is
  not a stuck status.

## Typed APIs

Declared exports:

- `@phimacs/pimux/runtime`: `startRuntime({command,args,cwd?,env?,signal?,timeoutMs?,
  parent?})`, `listRuntimes(env?)`, `lookupRuntime(file,env?)`,
  `resolveRuntime(muxId,env?,signal?)`, `lookupTerminalReceipt(muxId,env?)`, `stopRuntime(muxId,{env?,operationId?,timeoutMs?})`,
  `verifyRuntimeConnection(receipt,timeoutMs?,signal?,expectedSessionFile?)` and
  `validateSocket(path)`.
- `@phimacs/pimux/discovery`: `muxDirectory(env?)`, `listDiscovery(dir)` (every
  readable record), `liveDiscovery(dir)` (the `list` set) and
  `watchDiscovery(dir,onSnapshot,{debounceMs?,backstopMs?,onError})` (the `watch`
  stream in-process; the first read throws, later failures stop it through
  `onError`), plus `discoveryOwnerAlive` and the record types.
- `@phimacs/pimux/ownership`: `acquireClaim`, `lookupClaim`, `updateClaim`,
  `reconcileClaim`, `releaseClaim`, `claimsForOwner`, `canonicalSessionPath`,
  `createClaimTestEnvironment` and the claim types/errors.
- `@phimacs/pimux/process-identity`: exact Linux PID/start-time/boot identity,
  `readProcessIdentity`, `processIdentityStatus`, `processExists` and equality.
- `@phimacs/pimux/private-files`: `ensurePrivateDirectory`/`verifyPrivateDirectory`
  (canonical, same-user, no group/other access), `writePrivateJson` (atomic replace),
  `createPrivateJson` (atomic create, EEXIST if present) and `readPrivateJson`.
- `@phimacs/pimux/request`: `runtimeRequest(receipt,request,signal?,timeoutMs?)`
  sends one non-replayed request after the snapshot/live boundary, bound to the
  socket's input context; `runtimeIdentity(receipt,env?)` reads the claim-recorded
  Pi start identity.
- `@phimacs/pimux/guard`: explicit Pi transition extension and
  `installManagedSessionGuard` and `reserveManagedSession(file)`;
  `MANAGED_CLAIM_ENV` names its private capability. Reservation is available only
  to the exact managed Pi, before an extension initializes a new file; the guard
  retains it until writer exit, including failed/cancelled switches. It does not
  transfer/release a source claim or authorize another Pi.
- `@phimacs/pimux/tree-navigate`: the extension behind
  [in-place tree navigation](#in-place-tree-navigation).
- `@phimacs/pimux/host-modules`: `shareHostModules(modules)` serves the given
  specifier → module-namespace objects to every later import of those specifiers in
  this process, through one Node resolve/load hook; the first object shared for a
  specifier wins. Pi hands its own SDK only to extension files jiti transpiles and
  imports compiled `.js` natively, so without it each package resolves
  `@earendil-works/*` and `typebox` from its own `node_modules`: a second SDK copy
  (about 0.75 s per start) or, without peer copies, a failed import. See
  [npm packages](../../docs/development.md#npm-packages) for the entries that call it.
- Discovery, protocol, JSONL, transaction, host, host-identity, endpoint, main and companion exports
  own their corresponding contracts; no orchestration-host dependency exists. The
  mux, client, state and managed-TUI modules are internal to the executable.

`RuntimeReceipt` has the fields shown above. `RuntimeOperationError` carries
`operationId` and `muxId` for uncertainty recovery. `TerminalReceipt` has
`{protocol:2,muxId,operationId,state:"stopped",code,signal,stoppedAt}`. Service-owned
receipts also identify the service and placement; terminal receipts include
`rootClosed`, true only after durable explicit Close. An ended process does not
close a root awaiting service restoration. The receipt identifies that runtime,
not a successor using the same conversation. `resolve`/`resolveRuntime` return
only a service-recorded committed successor or `null`; they never start an agent.

`receipt --json --id` and `lookupTerminalReceipt` read only retained terminal
evidence: a validated `TerminalReceipt`, or JSON/typed `null` when none is retained.
They never connect, start/stop Pi, create runtime directories or mutate claims.
Malformed identities, records and unsafe/symlink evidence fail explicitly. Missing
or expired evidence is unknown, not proof of closure; frontends must not retire a
saved view merely because this lookup returns `null`.

An RPC worker must supply `parent:{process:{pid,startTime,bootId},taskId}`. The CLI
reads the same structure from `PHIMACS_PARENT_TASK`. Worker placement without a
live exact parent and task ID refuses. Parent death stops its subordinate runtime;
view disconnect does not. The orchestration result protocol still owns task
cancellation, result publication and intentional resume; pimux never promotes an
orphan worker or fabricates its result.

## Startup, cancellation and lifetime

The service claims the exact file before Pi can open it. It spawns an owner with
retained private IPC and no frontend stdio. That same capability transfers to the
owner atomically, then records Pi's exact process identity. Before commitment,
request cancellation/loss stops only this provisional owner/Pi and waits for exit. A timeout or uncertain exit retains operation evidence and claims; callers
reconcile instead of blindly retrying.

Readiness requires the mandatory guard and a successful companion snapshot without
inference. A listening socket or `get_state` is insufficient. Before commitment
the service durably journals root restoration intent. It retains the child and IPC
after acknowledging readiness to the caller. A lost acknowledgement is resolved
from private operation evidence; it is not permission to retry a launch. A
post-commit frontend failure leaves the agent available for reconnect/explicit stop.

With zero clients Pi output is drained and snapshots/replay state still update.
Already accepted work and provider waits continue and may incur usage. Closing
a frontend or its last view never sends EOF to Pi. Reconnection sends no paid
prompt, `continue`, tool command or inferred retry. After service restart a root
view resolves its recorded successor, then applies a fresh snapshot/live boundary.
Service absence preserves an unavailable view rather than starting another writer.

Explicit stop is identity-bound and acknowledged after actual Pi exit. Its private
receipt is written before final socket output, so a lost reply can be reconciled.
Repeated stop of that identity returns the same receipt. Graceful termination is
followed by identity-checked forced termination only for the owned Pi; uncertainty
keeps the claim and refuses replacement. No client signals a raw Pi PID.

Pi death ends its mux. Mux death is detected by the companion using exact parent
identity plus pipe closure; Pi terminates and cleans its child groups. The owner
also remembers identity-proven tool groups for cleanup after a Pi crash, walking
Pi's own process tree (`/proc/<pid>/task/*/children`) every second and on each Pi
output chunk. A tool
spawned immediately before an unobservable Pi `SIGKILL` can escape that observation;
this is a process-lifecycle limitation, not a claimed kernel-level containment
guarantee. Individual agent failure does not automatically restart it. Service
loss stops every owned agent, including committed ones. Its replacement waits for
both exact old writer identities to be definitely dead before restoring roots
idle with new runtime IDs. Old identity-bound Close cannot stop a successor.
Workers, prompts, queues and tool execution are never replayed.

## Service status and stop

The service socket greets each connection with
`{"type":"pimux_service","protocol":1,"ready","stopping","root","stateId","process"}`.
`root` is the `PHIMACS_ROOT` of the service environment or `null`. `stateId` is the
durable identity of the state directory holding its journal (`identity.json`,
created by the first service there). `process` is its exact process identity.
Besides `start` and `resolve`, it answers one request per connection:

- `{"type":"status"}`: `process`, `root`, `stateId`, `stopping`, the `stop` operation
  in progress (`{operationId, committed, caller}` or `null`), pending launches, owned agents
  (`muxId`, `placement`, `status`, `cwd`) and journaled roots, each with the `error`
  of a failed restoration or `null`. Readiness alone does not mean every root was
  restored.
- `{"type":"stop","service","operationId","caller","force","phase","exit"}`: `service`
  binds the request to that exact process; `operationId` and `caller` (the calling
  process's identity) belong to the caller. Only one stop operation exists at a
  time. Another operation's request is refused while its caller lives; once that
  caller is proven dead, the abandoned operation is undone (input reopened) and
  the new request proceeds. An uncertain caller is treated as alive.
  - `phase:"drain"` refuses while a launch is pending or an agent is working,
    blocked or not a root (it would not be restored), unless `force`; then refuses
    new agents. Unforced, every agent's owner then closes its frontend input
    (prompts, steering, follow-ups, shell commands and other changes are refused
    with `pimux service stopping; input was not forwarded`; aborts and dialog
    answers still pass), waits for forwarded input to be answered and reports
    idleness at a companion boundary. Any agent not proven idle refuses the drain
    and reopens input. Repeating the drain of the same operation returns its state.
  - `phase:"commit"` checks again, then marks it committed. With `exit` the
    service shuts down after replying; otherwise it waits for its supervisor's
    termination. Idle roots stay journaled and are restored idle.
  Turns that an extension starts on its own are not frontend input and are not
  gated; a later check refuses them, and a forced stop interrupts them.
- `{"type":"resume","service","operationId","caller"}`: undoes that operation if it
  has not shut the service down, reopening input. It also undoes another operation
  whose caller is proven dead; otherwise it returns `resumed:false` and leaves
  another or finished operation untouched.

A disconnected frontend's accepted input (for example a prompt still held by an
async input hook) still counts as forwarded input until Pi answers it, so it
keeps an unforced drain from committing.

`@phimacs/pimux/service-client` exports these requests with `probeService` (one
bounded greeting look), `serviceLeases` (the singleton leases) and
`expectedStateId` (the identity a given environment's state directory carries).
None starts a service.

## Cooperative writer claims

Production claims live under fixed `/tmp/phimacs-session-claims-<uid>`, independent
of `TMPDIR`, agent directories, release versions and `PIMUX_DIR`. Private 0700
nonsymlink directories, 0600 files, a cross-process bakery transaction mutex and
atomic publication serialize intended canonical path and existing inode indexes.
Hardlinks, symlinks, absent destinations and subsequent inode materialization share
ownership. Retargeted paths refuse; obsolete capabilities cannot release a new
owner. Atomic owner updates have no release/reacquire gap.

A live **or uncertain** wrapper or Pi retains ownership. Linux start time and boot
identity distinguish reused PIDs; zombies are exited writers. Stale recovery checks
unchanged records while serialized and requires both recorded processes definitely
dead. A refused socket, timeout, missing discovery or sent signal is not exit proof.

Existing-file transitions acquire in awaited `session_before_switch` and return
`{cancel:true}` on refusal. Throwing a hook is not cancellation. New/fork paths
claim at `session_start`; startup failures terminate this owned Pi and fail wrapper
readiness. Old and provisional claims stay until exit because Pi does not
settle every cancelled/failed/flush transition authoritatively. This deliberately
prefers refusal over reopening a possibly still-writable file. An old retained
reservation is not an attachable conversation: attachment validates the snapshot's
current session file and refuses to redirect an old-file request to a new session.

**Boundary:** Pi can repair/migrate during open; native selectors, direct SDK
mutators and runtime fork allocation have unguarded pre-I/O writes. Post-open
claims cannot prevent those operations, nor raw external Pi/editors. The stronger
universal storage gate remains blocked on an owning upstream storage API; no Pi
fork or hidden monkeypatch is included. All Phimacs launch/transfer callers must
use the exported launch/claim facilities. Wiring every orchestration path is a
separate integration gate, not implied by this package's tests.

Tests use `createClaimTestEnvironment()` and `PHIMACS_TEST_ROOT` only inside a
marked, user-private `/tmp/phimacs-test-*` tree. They cannot authorize files outside
its `sessions/` subtree, including escaping symlinks or external hardlinks. The
helper returns `{root,sessions,claims,options,env}` without changing process env.
Never point synthetic claims at production conversations.

## Socket protocol 2

All transports are same-user private Unix sockets. Clients verify socket/directory
ownership and permissions, `pimux_hello.protocol === 2`, mux identity and the complete
snapshot/live boundary. There is no role field, privileged creator or stdio transport. Maximum 32 connected peers;
client lines are limited to 64 MiB, Pi records to 128 MiB.

The first record is:

```json
{"type":"pimux_hello","protocol":2,"muxId":"opaque","clientId":1,"piPid":1235,"socket":"/private/runtime.sock","capabilities":["snapshot","stop","detached"]}
```

Pi JSONL records otherwise retain their RPC meaning. Framing splits LF only,
strips an optional CR and never treats U+2028/U+2029 as record boundaries.

### Snapshots, generations and replay

Each peer automatically receives `pimux_snapshot`, N replay records, then
`pimux_live` of the same generation. `pimux_bootstrap` requests a new authoritative
boundary and optionally narrows `include` to a nonempty subset of `entries` and
`messages`. Its correlated response reports the requested generation.

A snapshot contains `generation`, `reason`, `session:{file,id,name,cwd}`, `model`,
`thinkingLevel`, `idle`, `leafId`, selected `entries`/`messages`,
`run:{active,compacting,tailTruncated}`, optional `historyError`, and replay count.
Entries are flat append-order entries across all branches, not a nested tree.
Follow parent IDs iteratively. Messages reflect exactly Pi's active projection at
the boundary. Completed messages never overlap replayed in-flight streams.

Replay order: latest title, per-key status/widget, authoritative queue, live run/
message/tool/compaction/retry/bash tail, then open dialogs. The tail is bounded at
32 MiB; overflow drops an entire stream's replay and marks `tailTruncated`, never
an arbitrary middle. Final live records remain authoritative. UI caches each have
bounded counts/bytes. Notifications, editor overwrite, responses and ended turns
are not replayed as new work.

Generations increase globally. A newer snapshot/gap/session/tree boundary abandons
an unfinished older sequence; discard the old partial reconstruction. Waiting
clients receive their own responses and exit, not incremental records that would
mix with the pending snapshot. Every snapshot's identity is authoritative even if
a separate change record was lost. Failed ordinary snapshots send
`pimux_snapshot_failed`; change snapshots can fall back to identity plus
`historyError` so stale history is never presented as the new session.

Other records retain their names: `pimux_session_changed`, `pimux_tree_changed`,
`pimux_model_changed`, `pimux_bash_start/end`, `pimux_gap`,
`pimux_dialog_closed`, and final `pimux_exit {code,signal,stderrTail}`.

### Routing, input and control

Commands get per-client correlated IDs; only their sender gets the response with
its original ID restored. Bash start/output/end are shared with `bashId`; private
response IDs do not leak. Pending requests and snapshots are bounded and purged
on disconnect. Internal snapshot commands never appear in `get_commands`.
External commands/dialog replies are refused until runtime commitment/readiness.

All peers see dialogs; first answer wins, and every peer sees closure. Timeout and
Pi's aggregate prompt-ended indication remain distinct. Pi does not identify one
abandoned dialog among multiple open dialogs, so exact per-dialog abandonment
remains an upstream limitation. Never close a dialog merely because a run starts.

Pi supplies no causal request identity for `set_editor_text`; even one pending
request cannot prove that a delayed callback belongs to it. Every such request
becomes a recoverable labelled `pimux_editor_text` notice, never a draft overwrite. At
most 256 notices/4 MiB survive for later snapshots; truncation is explicit and must
not be presented as complete. Malformed/unroutable Pi output goes to bounded
private diagnostics, never to an elected frontend.

`pimux_stop` requires `expectedMuxId` and nonempty `operationId` (and, if supplied,
protocol 2). Its receipt is authoritative even when shutdown closes the socket
before the correlated reply. Wrong identities/protocols cannot stop another owner.
Abort remains Pi's explicit RPC abort, not frontend disconnect or runtime stop.

Slow peers never pause Pi or other peers. Each queue recovers dropped live output
with a gap and snapshot. Repeated overflow or more than 64 MiB queued disconnects
that peer; responses are not silently discarded. Recovery/reconnect never resends
input whose delivery is uncertain.

### In-place tree navigation

Pi's RPC reads the session tree (`get_tree`, `get_entries`) but cannot move its
leaf; `fork`/`clone` create another file. The owner therefore loads
`tree-navigate.ts` beside the companion into every managed RPC Pi (not `pimux
tui`, whose native `/tree` does this). Any peer may send the ordinary prompt

```json
{"type":"prompt","message":"/pimux-tree-navigate [--summarize] <entryId>"}
```

It requires an idle agent and an existing entry, then calls Pi's
`ctx.navigateTree` with the given id, as Pi's `/tree` does: a user or custom
message moves the leaf to its parent, any other entry moves it to that entry, and
`--summarize` adds Pi's branch summary of the abandoned path. Pi derives a reopened
session's leaf from its last entry, so an unsummarized move appends a
`pimux:navigate-tree` custom entry `{navigatedTo}` at the new leaf; a summary is
already the last entry. Neither the command nor the marker enters model context.
The command sets no editor text: clients prefill a selected message themselves.
The prompt response does not report the handler outcome. Refusals arrive as
`extension_error` with `extensionPath` `command:pimux-tree-navigate`; clients
confirm the move from the following tree boundary or `get_entries`. Runtimes
started before this extension lack the command in `get_commands`.

## Discovery, private diagnostics and tests

`PIMUX_DIR`, else `/tmp/pi-mux-<uid>`, contains `service.sock`, private per-runtime
discovery/socket files and `operations/`, `receipts/`, `logs/`. Discovery includes protocol, mux/Pi
identities, host entry path and version, provisional/committed phase, session, model,
status, placement and redacted host/parent references. Unsupported owners remain
visible and fail closed. Claims, not discovery scans, enforce writer exclusion.

Diagnostics retain at most 64 KiB per runtime; completed receipts and their linked
operation/log files are retained for the most recent 128 stopped runtimes, and
beyond that while orchestration's `task-receipts/<muxId>.json` for the runtime is
not `complete`: frontends need the receipt to retire a failed or orphaned worker's view.
Provisional operation evidence is retained for explicit reconciliation, not erased
on timeout. No private capability token is exposed by the public lookup command.
Source/dependency changes never hot-swap a live owner's modules; restarting the
service reloads them while restoring roots idle.

Durable service lease, root journal and Close intents live in
`PHIMACS_STATE_DIR/pimux`, else `$XDG_STATE_HOME/phimacs/pimux` or
`~/.local/state/phimacs/pimux`, separate from ephemeral sockets. Tests use only
`PHIMACS_TEST_ROOT/pimux-state`. Root records retain the conversation, command,
working directory, model/thinking selection, exact writer identities and at most
128 recent runtime aliases. Environment persistence is limited to Pi agent/session
directories and orchestration placement references; provider credentials come
from the service environment or Pi's authentication directory. State and Close
intents are privately written and fsynced. Saved launch arguments and endpoint
references can be sensitive; keep the whole journal private. Do not delete it to bypass an
uncertain writer. The `phimacs` launcher and any supervisor must use the same
persistent state selection.

```sh
# From the Phimacs root; all provider calls below are faux and sessions synthetic.
npm run compile --workspace=@phimacs/pimux
node --test packages/pimux/ownership.test.ts packages/pimux/mux.test.ts packages/pimux/state.test.ts packages/pimux/discovery.test.ts packages/pimux/watch.test.ts packages/pimux/companion.test.ts
node --test packages/pimux/pimux.test.ts packages/pimux/runtime.test.ts packages/pimux/lifecycle.test.ts packages/pimux/managed-tui.test.ts packages/pimux/host.test.ts packages/pimux/runtime-files.test.ts packages/pimux/receipt.test.ts
node --test packages/pimux/service.test.ts packages/pimux/import-boundary.test.ts
node scripts/test.mjs packages/pimux/tree-navigate.test.ts
```
