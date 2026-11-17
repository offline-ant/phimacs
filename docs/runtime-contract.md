# Managed runtime integration contract

Pilish and other managed runtime clients use this protocol-2 contract. No client
is a creator/primary owner.

## Launcher

`pimux start --json -- <absolute-pi-executable> [Pi arguments]` starts or locates an
RPC runtime through the running pimux service, which the `phimacs` launcher or a
supervisor starts. Frontends never start it: readiness waits at most ten seconds
before an actionable unavailable error. Callers include `--mode rpc` and may provide an exact absolute
`--session` path; absent one, the launcher allocates a unique path before spawn.
ID/continue/resume selection must resolve read-only to an exact path or refuse.
An existing compatible RPC owned by this service returns attachment, never a
second writer. Native, unmanaged and other-service owners refuse.

Successful stdout is exactly one JSON object:

```json
{"protocol":2,"operationId":"opaque","muxId":"opaque","socket":"/private/runtime.sock","pid":1234,"piPid":1235,"sessionFile":"/private/session.jsonl","state":"committed","outcome":"started"}
```

`outcome` is `started` or `attached`. Success means owned Pi/companion snapshot
readiness, not merely a listening socket. Diagnostics go to stderr without secrets.
Failure is nonzero; any unresolved operation identity is retained/reported so the
caller can reconcile it instead of retrying a spawn. Post-commit attach failure
leaves the runtime available. No initial prompt is inferred or resent.

`pimux list --json` returns a JSON array of discovery entries. `pimux lookup --json
--session <absolute-path>` locates an owner. `pimux stop --json --id <muxId>` performs
an identity-bound explicit stop, waits for actual exit and returns its receipt.
Stop receipt retention makes repeated requests reconcilable against that identity.
`pimux receipt --json --id <muxId>` reads retained terminal evidence or returns
JSON null without connecting, stopping or starting a runtime. Missing evidence
is uncertainty, not proof of exit. The runtime library exposes corresponding
typed APIs through declared exports. `pimux resolve --json --id <oldMuxId>` and
`resolveRuntime` perform read-only service successor resolution, never a launch.
Service restart terminates old agents and restores roots idle with fresh runtime
IDs after proving both previous writers dead; it never restores workers or
interrupted execution. The owning [lifecycle](lifecycle.md) defines persistence
and restart policy.

## Clients

Connect directly with a Unix socket client; do not spawn an stdio bridge. Validate
private same-user socket ownership, hello `protocol:2`, mux/session identity and
capabilities. `pimux_hello` has no lifetime role. The existing snapshot/replay/live
records retain their ordering contract. Enable user input only after authoritative
`pimux_live`. Reconnection never implicitly starts a missing runtime or replays work.

Snapshots carry `inputContext:{sessionFile,leafId,contextId}` or null. The opaque
anchor changes on file/tree replacement, not ordinary message appends. After the
matching snapshot/live boundary, clients capture this exact anchor while composing
an action and supply it as `pimuxContext` on every non-getter command, including
abort and dialog replies. Admission checks the anchor atomically; an unavailable
or stale action refuses without automatic retarget/retry. Null context disables
input. The hello capability `contextual-input` identifies this required contract.
Frontends preserve rejected intent for explicit review, not replay.

All clients can send the same RPC/control requests. `pimux_stop` identifies the
expected mux and an operation ID; only its owning runtime may perform the stop.
User-facing Close uses that exact identity-bound stop without confirmation.
For service roots, process exit alone does not close the conversation: resolve
its service successor first. Durable explicit root Close (`rootClosed:true` in the
terminal receipt), or no successor plus terminal evidence, retires active views
without sending another stop. An unavailable service retains an unavailable view.
Transport disconnect and frontend shutdown never mean Close; uncertain loss retains
recoverable state. Unsupported protocols fail explicitly.

Worker Close instead uses orchestration's owning task cancellation. Before any
slash input, require an advertised `worker-cancel` extension command and capture
its exact worker/task binding. Completion requires the same task's final cleanup
evidence, not command acceptance or `pimux_exit`. The public
`@phimacs/orchestration/worker-task` reader and checkout-owned `phimacs-task-status` CLI
provide that read-only evidence in the captured runtime socket's namespace. See
orchestration's README for the schema and cleanup contract.

The optional Emacs profile configures Pilish with the selected absolute Pi host
and this checkout's pimux executable. It resolves `phimacs-task-status` only when
orchestration is enabled, after private Lisp overrides have selected the feature.
Existing-config users supply those public executable options themselves. Ordinary
roots do not need a task reader; worker operations without task evidence refuse.
The frontend requires `:authoritative-close` and never substitutes a raw PID signal.
No frontend change selects, migrates or restarts an already running agent.

## Safety scope

The claim library protects cooperating Phimacs managed launches/transitions and
short stopped-file mutation leases. It is shared across checkouts and frontends.
It cannot enforce ownership against raw Pi 1.5 storage operations, external tools
or its unguarded internal mutations. The universal storage gate requires an
upstream owning API; Phimacs does not fork Pi. Tests use synthetic session
roots and constrained test namespaces, never production runtime/session paths.
