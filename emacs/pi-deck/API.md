# Pilish desktop API consumed by deck

Deck uses the Pilish of the same Phimacs revision, including `pilish-runtime`,
without version negotiation. It never reads `pilish--` state or treats a network
process ID as the Pi PID.

- `pilish-session-runtime(buffer)` returns a serializable normalized plist with
  `:protocol`, `:mux-id`, `:socket`, `:pid` (wrapper), `:pi-pid`, `:pi-start-time`,
  `:pi-boot-id`, `:operation-id` (launch), `:session-file` and `:state`. A launch
  awaiting its receipt has `:operation-id` but no `:mux-id` yet. A plain unshared
  session returns nil.
  A saved disconnected runtime retains its identity. Only authoritative termination
  reports `:state "stopped"` for such an owner; disconnection is not proof of worker
  completion. A view whose launch settled without an identity is a stopped view
  with no owner to reconnect. Resume still uses managed claims before opening its
  history; `pilish-close-session` retires it without a stop.
  A fully synchronized socket view reports `:state "live"` (not `"connected"`).
  Discovery activity labels are not the view's snapshot/readiness state.
- `pilish-session-desktop-state(buffer)` returns `:directory`, `:name`,
  `:session-file`, `:runtime`, `:draft`, `:images`, `:followups`, `:quarantine` and
  `:leaf-id`. It must be safe for ordinary Lisp-data serialization.
- `pilish-restore-session-state(state)` returns a background chat. It attaches the
  specified live runtime and adopts its authoritative current file
  and branch. Verified prior-boot roots reopen idle through managed claims under
  [Pilish's desktop policy](../pilish/RUNTIME.md#desktop-state-and-input-recovery).
  Other missing owners become unavailable; views without a runtime identity
  become stopped/resumable. A state without its detached runtime plist is invalid
  and is not restored. Saved work is never replayed.
  It returns nil for an authoritatively terminated runtime, using retained terminal
  evidence, rather than resurrecting an active placeholder. Deck drops that saved
  record and its buffer references from remembered layouts.
- `pilish-list-runtimes()` returns normalized runtime plists (same `:mux-id` and
  `:session-file` names), including placements/parents when available.
- `pilish-attach-runtime(runtime &optional name)` attaches without starting Pi.
- `pilish-runtime-watch-start()`/`pilish-runtime-watch-stop()` follow live
  discovery; `pilish-runtime-discovery-functions(runtimes failure)` delivers each
  snapshot of those plists (plus `:started-at`, `:session-name`, `:blocked`), or
  nil and a diagnostic when the watch fails. Deck starts it on enable only when
  `pilish-runtime-configured-p`, and lists roots without a view; see
  [Pilish's live discovery](../pilish/RUNTIME.md#live-discovery).
- `pilish-session-runtime-pending-p(buffer)` is non-nil while a launch or service
  reconnection is in flight. Deck shows such a view as starting/connecting, not
  disconnected and offers no Reconnect/Resume. Until the receipt names the mux ID,
  the pending view holds the discovered runtime carrying its `:operation-id`
  (from `pilish-session-runtime`), which therefore gets no available row.
- `pilish-reconnect-runtime(buffer &optional callback)` reconnects only.
- `pilish-resume-stopped-session(buffer &optional callback)` is an explicit managed
  launch of a stopped conversation. It sends no prompt. The owning API refuses
  active/uncertain owners and task-owned worker promotion.
- `pilish-stop-runtime(buffer &optional callback)` performs identity-bound stop,
  reconciles its terminal receipt, and never signals a bare Pi PID.

The last three callbacks receive **one argument**: nil after acknowledged success,
or an error string after failure/uncertainty. They run exactly once, including
synchronous failures. Deck retains views/drafts/layout on failed stop and does not
remove them while acknowledgement is pending. After authoritative termination,
observer/cleanup errors still retire the view: Pilish retains the errors and unsent
work in recovery, and the completion reports failure rather than complete success.

`pilish-close-session(buffer &optional callback)` closes an agent everywhere,
without confirmation, settling only after termination. Its internal disposal-only
counterpart `pilish-disconnect-session(buffer)` is for frontend/orchestration teardown
and acknowledged cleanup; it never stops a committed detached runtime.
`pilish-session-closed-functions(chat)` notifies deck before authoritative terminal
buffer disposal, with public accessors still available. It never runs for socket
loss or frontend teardown. Deck removes views/layouts idempotently without another
stop, while Pilish owns buffer disposal and recovery of unsent local work.

Existing identity/activity/dialog hooks continue to notify deck.
Local draft text changes are observed through
the public input buffer's local change hook; if images, suspended follow-ups or
quarantine change without an input edit or identity/activity notification, Pilish
must emit `pilish-session-desktop-state-functions` with the chat buffer as its
single argument. Deck subscribes to this public notification to schedule a save.

Schema 3 stores this opaque desktop state separately from layout buffer names and
stable target/parent metadata; other schema versions refuse.
`pilish-position-session-on-focus(chat-buffer)` applies the session's automatic
positioning option in the selected frame without displaying a hidden chat or
changing input focus/drafts. Deck calls it on explicit reveal, since selecting a
sidebar and returning to the same input before redisplay may not trigger Emacs's
selection observer. Pending dialogs and a disabled `pilish-jump-to-answer` preserve
the view; enabled focus revisits the latest answer or follows active output.
The maintained `emacs/pilish/` package implements this API and the desktop contract.

Pi worker Close uses `pilish-close-session`, not the frontend's local target
registry. Pilish validates the durable owning-task binding and completion evidence
before requiring a live transport. Complete task evidence retires even a restored
or disconnected view; missing, changed, pending or failed evidence retains it.
A stopped runtime receipt alone is not owning-task completion. A view marked as a
worker by deck must retain its public worker runtime identity; missing identity
fails explicitly rather than falling through to root Stop.

Native panel cancellation uses the orchestration API:
`pi-orchestration-stop-target(id &optional callback)` calls `callback(error)` once,
with nil only after actual terminal acknowledgement, or an error string on failure.
A dispatch return value is never exit evidence.

Managed shell panels use `pi-orchestration-panel-command-state(buffer)` (also
`:command-state` in `pi-orchestration-targets`): `"held"`, `"running"`, `"exited"`
or `"unknown"`, nil for unmanaged buffers. The command's exit, not its persistent
wrapper's liveness, determines finished-shell folding. Unknown managed state is
never completion. Ordinary unmanaged terminals retain process/prompt-mark behavior.
