# Runtime lifecycle

One pimux service owns all managed RPC agents and workers through retained
per-agent owner connections. Pilish views are equal
socket clients, independent of that service's lifetime. Agent Close, from a sidebar,
a title bar or a menu, is identity-bound and unconfirmed, even while busy. It stops
the agent and removes active views across frontends after authoritative exit.
The closing Emacs frontend hides the agent at once instead of waiting for that exit.
Close space closes its agents and owned descendants before forgetting its layout.
Failed or uncertain Close lists the agent again as a recoverable view and reports
the error.

Frontend shutdown, restart, window loss and generic transport disposal
only disconnect; accepted work can continue and incur provider usage. No local
Disconnect versus Stop-everywhere choice is exposed in the ordinary Close UI.
Hide is an explicitly named layout action. Stop turn remains Pi's abort, not agent
Close. Neither Close nor frontend loss deletes the persisted conversation.

Service restart ends its old agents and restores saved root conversations idle
with new runtime identities and freshly loaded extensions. Both previous owner and
Pi must be definitely dead before replacement. Workers, interrupted prompts,
queues and tool execution are never restored. Explicit Close durably removes root
restoration intent. Individual agent failure does not automatically restart it.

## Starting and stopping the service

Only the top-level `phimacs` launcher starts the service, or a supervisor through
`phimacs service pimux`. Emacs, Pilish, deck and other frontends never start or
restart it. The launcher attaches only to an answering service whose greeting
names its checkout (`root`), the durable identity of its `PHIMACS_STATE_DIR`
(`stateId`) and its exact process, and whose process is running and holds both of
that state's singleton service leases. It refuses a service without them, from
another checkout or with another state directory, one whose process identity is
invalid, dead or not the lease holder, an unanswering endpoint and an owner of
uncertain liveness, instead of replacing any of them. A stopping service is
attached only after undoing a stop whose caller is proven dead; while that caller
runs, attach refuses and names its process. Otherwise it starts exactly
one (a concurrent launcher waits for it). When an Emacs daemon must also start,
its prerequisites are checked before the service starts; if the daemon still
fails, the error names the service that keeps running. A configured supervisor
start never falls back to an unsupervised service.

Starting the service is not "starting no agents". It restores journaled root
conversations idle, as Pi processes with freshly loaded extensions, and replays
no prompt, worker, queue or tool. Extension startup hooks still run, so starting
the service does not guarantee zero provider usage. Accepted work continues and
can incur usage while no frontend is visible. The launcher says this on first
start and lists roots whose restoration failed. `phimacs status` reports agents
by state, journaled roots and each restoration failure with its error; service
readiness alone does not mean every root was restored.

`phimacs stop` is one operation with its own ID, bound to the service it would
attach to, that service's exact process and the calling process's identity.
Another operation is refused while its caller lives
(`pimux stop ID by live process PID is already in progress`); an uncertain caller
counts as alive. Once its caller is proven dead, the next stop, resume or attach
undoes the abandoned operation and reopens input. A request naming an operation
that another caller owns changes nothing (`... belongs to another caller`).
It first refuses while an Emacs file buffer has unsaved changes, with or without
`--force`. The service then stops accepting agents and, in one serialized section,
refuses while a launch is pending, an agent is working or blocked, or a non-root
agent (worker or fork) exists, because those are not restored; `--force` stops
them too. Unforced, every agent's frontend input closes before idleness counts:
prompts, steering, follow-ups and shell commands are refused with
`pimux service stopping; input was not forwarded`, while aborts and dialog answers
still pass. Forwarded input must be answered and each agent shown idle within a
time limit. That includes input a since-disconnected frontend sent, such as a
prompt still held by an asynchronous input hook: it blocks an unforced stop until
Pi answers it; a timeout refuses the stop instead of counting as idle, and every
refusal reopens input. Turns that an extension starts by itself are not frontend
input and are not gated: a later check refuses them, and one that begins after
the final check, or under `--force`, is interrupted, not replayed.

Emacs then saves its deck and quits, and the service checks again and exits, or
its supervisor stops it so that it is not restarted. A failure after the drain
resumes only this operation and reports both errors; a final request whose reply
was lost counts as done only once the service process has exited. Idle roots stay
journaled and return idle with the next start.

## Reconnect, input and ownership

Reconnect uses a read-only service successor lookup followed by an authoritative
snapshot/live boundary; it never starts an agent or resends input. A root's old
process receipt alone is not closure: the service may be restoring its successor.
Durable explicit root Close (`rootClosed`), or no service successor plus terminal
evidence, retires its views. Service absence retains an unavailable view and local
input. Unsupported/unmanaged identities remain unavailable without authoritative
closure. Frontends never launch a daemon: requests wait up to ten seconds for
service readiness, then report
``pimux unavailable; start it with `phimacs` or its supervisor, then retry``.
Otherwise a new owned runtime requires explicit Resume after exclusion checks.
Desktop state stores views, layout and quarantined local
input separately from runtime ownership. Closed-view input and crash diagnostics
remain recoverable outside the active-agent list.

Session/file/branch adoption quarantines old local drafts and automatic follow-ups.
Clearing Pi's queue is global/destructive; only its requester receives acknowledged
recovery of all cleared text. There is no per-client removal/provenance guarantee or
automatic resend after uncertain delivery. Dialogs use first-answer-wins; aggregate
Pi dialog abandonment remains an upstream limitation.

Workers belong to a parent's actual process identity and task lease, not an Emacs
buffer or network PID. Frontend loss does not end a request; task cancellation or
verified parent death performs owned cleanup. Worker Close requires the advertised
extension cancellation command and an exact mux/task binding. Runtime exit alone
is not final task completion: orchestration publishes terminal task evidence only
after exit, host cleanup, registry removal and name release. Failed or missing
evidence is not successful Close; no ambiguous cancellation input is replayed.

Native panels retain their host lifetimes. Creator death triggers native cleanup
through the original host only when the exact target can still be established;
uncertainty retains the target and diagnostics. A root's stop receipt does not
acknowledge asynchronous native-panel cleanup. Deck can await explicitly listed
native descendants. Native-host limitations belong in the orchestration README.
Independent forks are not subordinate tasks. Emacs restart can lose native
shells/panels; desktop restore never reruns their saved shell commands.

Canonical-path/inode claims precede managed opens and survive uncertain teardown
while either wrapper or Pi may write. Production claims are checkout/TMPDIR-independent;
test namespaces cannot access production sessions. Old/provisional claims remain
conservatively retained during uncertain transitions. Refused sockets are not death.

The guarantee is cooperative, not universal raw-Pi safety. Pi 1.5 has unguarded
storage paths and no safe general writer-freeze/handoff API. Shared `/switch`
attaches compatible RPC views; unsafe native `/switch` and RPC-to-Herdr
refuse without touching another writer. Live Pilish tree-label/navigation storage
mutations likewise refuse when no owning RPC exists. Phimacs does not fork Pi.

## Source updates

A running service and Emacs daemon reference checkout source, lazy-loaded Lisp
and generated `dist/` paths. Source removal, npm hydration or recompilation there
can affect new agents, lazy loads and supervised process recovery even without an
explicit restart. Develop in a separate worktree; update a running checkout only
when you mean to restart its services, and keep old code/state until no running
agent or recovery path needs them. Checks never use a user's running daemon.

Source edits do not replace loaded runtime code. Frontend restarts reconnect
compatible existing agents without reloading their extensions. A service restart
refreshes agents and reopens roots idle under the policy above. Pi/dependency
upgrades still require an explicit idle/stop boundary; keep old code while
running agents or saved recovery reference it. No prompt replay.
See [pimux](../packages/pimux/README.md) for durable state and service commands.
