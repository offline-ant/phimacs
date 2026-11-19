# pi-deck — development guide

Emacs package: project spaces (one window layout each) and an agent sidebar
for Pi sessions via Pilish. User documentation: `README.md`.

## Files

| File | Purpose |
|---|---|
| `pi-deck.el` | `pi-deck-mode` (hides the tab bar), `pi-deck-command-map`, hooks and timers |
| `pi-deck-core.el` | agent registry, state derivation (including workers waiting for the user), seen/done, priority, terminal prompt marks |
| `pi-deck-spaces.el` | space registry, hidden per-space layout tabs and remembered layouts (`pi-deck--layouts`, `pi-deck--last-space`), agent locations, space/pane commands, reveal |
| `pi-deck-workers.el` | orchestration panels beside their parent, forks assigned to the parent's space, closed-worker records, read-only views and resuming them as independent sessions |
| `pi-deck-runtime.el` | public Pilish runtime/view API, attach/discovery, reconnect, explicit Resume, opening session files, Reopen agent, stopped native-terminal views |
| `pi-deck-available.el` | live root runtimes without a view here (Pilish's runtime watch), their space, status and new marks, attach on selection |
| `pi-deck-close.el` | unconfirmed, non-waiting global Close, layout-only Hide, acknowledged parent cancellation, space and peer-view cleanup |
| `pi-deck-headers.el` | pane title bars (header lines with optional prefix, status, model/context or exit, `[J]` `[↓]` `[⑂]` (Pi) `[⤢]` `[✕]`) |
| `pi-deck-sidebar.el` | sidebar space tree, incremental text/property refresh, header summary and global cleanup button beside `pi-deck-sidebar-header-items`, shared width, narrow-frame hiding and preferences |
| `pi-deck-group-editor.el` | bottom side window for staged group creation and membership; rename and dissolve commands |
| `pi-deck-group-rows.el` | band face, terminal-cell layout, separate hover targets and status visits for group bands |
| `pi-deck-clear-immediately.el` | opt-in immediate clearing of agent-started children as they finish (space, group or global), closing exited panels through global cleanup |
| `pi-deck-usage.el` | optional foldable sidebar usage section: background `pi-deck-usage-command` runs, JSON validation, last-good numbers per account, bar rows |
| `pi-deck-finished.el` | global finished-worker record and exited-shell cleanup, inactive/active sidebar header button |
| `pi-deck-menus.el` | popup menus: right-click menus for agents, closed workers, spaces, group bands and the header summary; forking (`pi-deck-fork`) |
| `pi-deck-goto.el` | agent picker, jump, show alone, next attention/agent, dialog answering |
| `pi-deck-notify.el` | blocked/finished notifications; `pi-deck-notify-functions` hook for other deliveries (pi-sound) |
| `pi-deck-layout.el` | grid of the space's agents |
| `pi-deck-persist.el` | schema-3 runtime/draft/parent/layout persistence, view-only restore, retained failures |
| `pi-deck-restart.el` | explicit manual/supervised replacement policy, identity-checked acknowledged helper |
| `pi-deck-daemon.el` | server info (`pi-deck-daemon-info`), config reload, guarded daemon restart |
| `pi-deck-menu.el` | transient menu |
| `test/pi-deck-test.el` | Imported UI ERT suite entry; loads its per-mechanism parts below |
| `test/pi-deck-test-fixtures.el` | Shared fixtures: fake Pilish sessions, real ghostel terminals, hidden layout tabs |
| `test/pi-deck-{status,layout,ui,close,orchestration,persistence}-test.el` | Imported suite parts: status model; spaces/panes; sidebar/title bars/menus; closing; workers/forks/panels; saved state/daemon |
| `test/pi-deck-sidebar-test.el` | Stable sidebar, focus and finished-fold cleanup regressions |
| `test/pi-deck-group-{model,editor,sidebar}-test.el` | group persistence, mouse/keyboard checklist, band layout, folding and direct status visits |
| `test/pi-deck-clear-immediately-test.el` | Clear resolution, menu checkboxes, persistence, skipped worker records, closed agent panels and kept user shells |
| `test/pi-deck-usage-test.el` | Usage rows at sidebar width, kept numbers and errors, folding, real `sh` fetches and stop |
| `test/pi-deck-available-test.el` | Available runtime rows, new marks across service restarts, watch start/stop |
| `test/pi-deck-disclosure-test.el` | UI-lane space disclosure and live/finished worker-title regressions |
| `scripts/native-fixture.mjs`, `scripts/native.mjs`, `scripts/native.test.mjs` | isolated assets/install graph, owned service, real-Pi ERT and process-boundary checks |
| `test/smoke.mjs`, `test/smoke.el` (root `test/support/faux.ts`) | real Pi smoke in a disposable daemon/TTY |

Dependency order: core → spaces → runtime → available → group-rows → workers → close →
finished → clear-immediately → group-editor → headers → sidebar → usage → menus →
goto/notify/layout/persist → restart/daemon/menu → pi-deck. No cycles; forward
references use `declare-function`.

## Rules

- Pilish integration goes through public APIs and hooks
  (`pilish-activity-phase-functions`, `pilish-extension-dialog-functions`,
  `pilish-extension-status-functions`, `pilish-session-identity-functions`,
  `pilish-session-pending-dialogs`,
  `pilish-session-extension-status`, `pilish-start-session`). Needed Pilish
  changes belong in `emacs/pilish/` with focused tests,
  not in frontend workarounds. Source edits do not authorize a live reload.
- `pi-deck-agents` returns agents in creation order (`pi-deck-agent-number`);
  keep it the one stable order (saved state lists agents in it and restore
  re-tracks them in it). `pi-deck-agent-space` is the fixed home space
  (assigned, parent, directory, displaying layout only as a last resort); use
  `pi-deck--agent-tab` when you need which layout displays an agent.
- A space's layout in a frame is one hidden `tab-bar` tab whose group is the
  space name; `tab-bar-show` stays nil while `pi-deck-mode` is on. Switch
  spaces only with `pi-deck-select-space` (it remembers the layout being
  left); set tab groups with `pi-deck--set-tab-group`
  (`tab-bar-change-tab-group`'s default hook moves tabs). Remembered layouts
  are `window-state-get` of `window-main-window`, so side windows (the
  sidebar) are never part of them. Sidebar space groups are independent of
  tab groups: `:group` on a space record is its optional sidebar heading,
  not the name or owner of its layout tab.
- Never write the user's init files; preferences and state live under
  `user-emacs-directory`/var/pi-deck/.
- Tests never call paid models: ERT uses fake sessions, smoke uses Pi's faux
  provider with a private agent directory and server socket.
- Evil: the sidebar's keys live in its normal-state auxiliary map (built
  from `pi-deck-sidebar-mode-map`), which beats evil-collection's
  `special-mode` bindings; refresh is `gr` there so the `g` prefix survives.
- A chat window plus its input window is one Pilish pair (`pilish-window-pair`)
  and one pane (`pi-deck--pane-of`). Pane code uses Pilish's pair API
  (`pilish-split-input-window`, `pilish-dissolve-window-pair`,
  `pilish-repair-window-pairs`) and never pairs windows itself; split and zoom
  panes, never their halves. `pi-deck-mode` turns on `pilish-window-pairing-mode`.
- Read Pilish sessions only through its public `pilish-session-*` accessors,
  `pilish-session-exists-p` and `pilish-view-session-file`; ask Pilish for a new
  accessor instead of reading `pilish--` state.
- Pilish never guesses pairs from restored window shapes; pi-deck re-pairs
  explicitly after `window-state-put` restores and space switches
  (`pilish-repair-window-pairs`).
- Removing the selected pane (Close, Hide) and applying a restored layout leave
  focus in a pane's input, never its chat (`pi-deck--select-pane-input`); a
  sidebar-initiated Close keeps the sidebar selected.
- Never split, display in or delete the selected window when it may be a side window
  (the sidebar). Commands act on `pi-deck--main-window` / `pi-deck--pane-window` (the
  most recently used chat pair, else other non-side window, when a side window is
  selected) and `pi-deck--split-pane` (splits with the pane selected, so the new window
  never shows the sidebar). `get-largest-window`/`get-mru-window` skip dedicated pair
  windows unless asked; use these helpers instead. Select a non-side window
  (`pi-deck--select-ordinary-window`) before `delete-other-windows`;
  `pi-deck--single-window` reduces a layout to one plain window.
- The sidebar has one width for all frames and spaces: `pi-deck--sidebar-sync`
  enforces `pi-deck-sidebar-width`, and `pi-deck--on-window-size-change` adopts
  and saves a dragged width (a sidebar resized within an unchanged frame).
  Frames without `pi-deck-sidebar-min-pane-width` columns beside it hide it.
- Popup menus open on release (`mouse-3`, never `down-mouse-3`): a text
  terminal menu opened on press picks its first item at the release.
- Separate click targets in one sidebar row declare their own `mouse-face`;
  `pi-deck-sidebar--clickable` leaves such text alone, so each highlights apart.
  Inert gaps between targets have a nil `mouse-face` and `pi-deck-button` `none`.
- Group bands use `pi-deck-group-band`'s own backgrounds, never a borrowed theme
  face: themes often separate the inactive mode line only by a box, which text
  terminals do not draw.
- Immediate clearing is off by default and applies only to children with a
  parent. It is on when any of `:clear-finished` on the parent's home space
  record, that space's group in `pi-deck--group-clear-finished` (moved by rename,
  pruned when the group empties) or `pi-deck-clear-finished-immediately` says so.
  `pi-deck--remember-worker` then stores no record. Exited terminals close from
  `pi-deck-update-hook` (never a timer) through `pi-deck-close-finished-terminals`,
  the global cleanup path; `pi-deck--clear-held` keeps closing and failed ones
  from being closed again, so a failure is reported once.
- Sidebar/header ✕, menus and keys use one unconfirmed global Close
  (`pi-deck-close-agent`). Hide (`pi-deck-hide-pane`) changes layout only.
  Close space closes agents and owned descendants before forgetting its layout.
  Independent interactive forks remain peers. Close hides its agents at once
  (`pi-deck-agent-closing`, left out of `pi-deck-agents`); it disposes buffers only
  after the owning runtime/task acknowledgement, and a failed/uncertain stop lists
  them again. Never dispose views on dispatch, socket loss or timeout.
  `pilish-session-closed-functions` removes peer views/layouts idempotently without
  another stop; Pilish owns terminal buffer disposal. Frontend teardown still
  disconnects only. Failure/uncertainty retains recoverable local state.
- Header line buttons use `local-map` (header lines ignore `keymap`).
- Sidebar refresh renders into a temporary buffer and applies
  `replace-region-contents`, then copies generated text properties too (the diff
  retains old properties on unchanged characters). Never erase the displayed
  buffer or reset every window's point to a shared buffer point.
- `[J]` uses Pilish's automatic completion/focus option; explicit reveal calls
  `pilish-position-session-on-focus` because a sidebar click can return to the same
  input window before redisplay. Do not read Pilish's private answer state or force
  newly displayed chats to their end. `[↓]` remains unconditional.
- Global finished cleanup filters by `pi-deck-agent-finished-shell-p`, never
  attention status or disconnected Pi transport. It forgets worker records but
  preserves their files, closes exited terminals without expanding descendants,
  retains owner failures and never stops Pi views or live shells.
- The pseudo-space for agents without a space is labelled "other"; a real
  space may have that name, so test registration (`pi-deck-space-names`),
  never the label.
- Tab switches (space switches) can drop the pairs' atoms;
  `pi-deck--on-tab-select` repairs pairs at once so commands right after a
  space switch see them.
- State saves are event-driven (`pi-deck-schedule-save`): never add
  periodic saving. Preferences changed by commands (sidebar toggle) are
  saved with `pi-deck-save-preference`.
- The usage section runs only `pi-deck-usage-command`, asynchronously
  (`make-process`, at most one run), and holds no account or credential
  knowledge. Its timer exists only while the mode is on with the command set;
  its fold state is a session variable, like space folds.
- The state file has one owner, the server socket it records. Automatic
  saves (`pi-deck--save-now`, also used by restart and `kill-emacs-hook`) need
  `pi-deck--state-owner`, and none run during a staggered restore
  (`pi-deck--restoring`). `pi-deck-claim-state` decides ownership and
  restores once per Emacs, in a daemon only from `emacs-startup-hook` (the
  server starts after the init file; sessions spawned earlier miss the
  orchestration environment). Tests bind a fake owner in
  `pi-deck-test--with-deck`; disposable daemons never own the user's file.
- Orchestration targets are identified by `pi-orchestration-targets`
  (`:kind`), not by terminal major mode.
- A worker waiting for the user is read only from orchestration's `worker-frame`
  extension status starting with `worker:waiting`
  (`pi-deck--waiting-status-key`, `pi-deck--waiting-status-prefix`); it changes
  when a new run starts. Waiting is `blocked`, so attention, notifications and
  sounds need nothing of their own.
- A terminal whose command ended stays an agent (panels retain their buffers for
  `panel-read`); the sidebar folds it into its space's finished shells row
  (`pi-deck-agent-finished-shell-p`), whose ✕ closes those agents. Managed panels
  use public `pi-orchestration-panel-command-state`, never persistent-wrapper
  liveness; unknown managed state is not completion. Unmanaged terminals keep
  process/prompt-mark behavior. Finished workers
  are records of buffers already gone, so their ✕ only forgets the records. The
  state file keeps them with parents as buffer names; restore remaps parent
  names and reconnects task-owned views without promoting or restarting workers.
- Resuming a closed worker (`pi-deck-resume-finished-worker`) starts an ordinary
  session on its file: no orchestration target, no result to the parent.
- Available runtimes come only from Pilish's runtime watch
  (`pilish-runtime-discovery-functions`), started on enable when detached runtimes
  are configured and stopped on disable. Only roots without a tracked view (closing
  views included, `pi-deck--runtime-agent`) are listed; nothing attaches without a
  selection. Discovery can list a launching view's own runtime before its receipt
  names the mux ID; until then `pi-deck--runtime-agent` matches it by the launch's
  `:operation-id` while the launch is pending (`pilish-session-runtime-pending-p`),
  so it gets no second row. Other runtimes, of any directory, stay listed; a failed
  launch leaves its runtime listed and new. Such a launching view reads "starting", never
  disconnected, and offers no Reconnect/Resume. New marks are keyed by session file; a key returning from another
  pimux service is a restoration and keeps its mark state.
- Reopen agent (`pi-deck-reopen-agent`) picks the newest session file of the
  space's true directory, header `cwd` equal, that no tracked agent (closing
  included) has open. Workers are excluded by orchestration's markers: fresh
  workers' second line is `pi-orchestration:delegate`; inheriting workers name their
  own file as `childSession` of `pi-orchestration:delegate-runtime`. Files are read
  newest first until a match. A live discovered runtime holding the file is
  attached (`pi-deck-attach-runtime`); otherwise it starts through
  `pi-deck--open-session-file`, shared with closed-worker Resume.
- `*.elc` files are build output (`--compile` below), not tracked; the config
  loads this checkout with `load-prefer-newer`, so stale ones never shadow
  sources.

## Checks

Use a prepared Emacs directory; Pilish always comes from `emacs/pilish/` in this
checkout. See `RUNTIME.md`:

```sh
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node scripts/emacs-deck-tests.mjs
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node scripts/emacs-deck-tests.mjs --compile
```

Run those from the Phimacs root; `--ui`, `--reference` and `--selector` select
the other suites (RUNTIME.md). Compilation treats warnings as errors. No floating dependency
installer/global stamp remains. Native/smoke select the absolute host with
`PHIMACS_PI`; no sibling/source override is used. Their default lane stages only
pimux, Pilish and deck, without orchestration or task-status. They copy prepared
assets, load-test the module/grammars, start/wait/stop their own pimux service and
retain evidence with original plus cleanup errors on failure. See RUNTIME.md for
the managed opt-ins and bounded native commands.
Never use the real daemon, home grammars, personal package/native caches or live
runtime discovery to make a test pass.

## Lifecycle and runtime capability

- Only actual mode transitions install/remove resources or capture/restore previous
  settings. Disable removes owned side windows from all saved tabs, pane headers,
  terminal observers, hooks and all timers, without stopping processes.
- Save empty owned registries. An incomplete staggered restore keeps its original
  file; do not cancel a restore then overwrite its still-pending records.
- A failed save/helper preparation cannot exit Emacs. Supervised replacement needs
  its explicit command and never falls back to manual startup. Acknowledgement is
  preparation, not proof of a successor that can start only after the old owner exits.
- Deck requires `pilish-runtime` from the same Phimacs revision; there is no
  version negotiation. Schema 3 restores views only, retains
  failed records, and never replays saved input or commands. Use the public APIs
  in API.md; no private-state detection or automatic fresh-Pi fallback.
- `pilish-session-process` is a transport; use `pilish-session-runtime` for actual
  Pi identity. Parent-owned task cancellation never falls back to root stop/start.
- Save opaque public desktop state, including drafts/images/quarantine/follow-ups.
  Observe public desktop/identity hooks and local public input changes; never
  reconstruct queue ownership or silently reuse a draft for a changed branch.
- Select native checks for changes to runtime/socket boundaries. Mocked API
  tests and environmental skips do not certify the socket implementation.
  Unrelated edits need no new package directory or packed release.

## Known issues

- Layouts are per frame while open: two frames showing one space keep separate
  layouts, and `pi-deck--layouts` keeps whichever was remembered last.
- Evil's `SPC w r` (`evil-window-rotate-downwards`) with the sidebar open can leave
  two pairs showing the same session (Evil's side-window save/restore fails to put
  chat states into input-sized windows); the pairs stay consistent.
- Terminal status hooks `ghostel--osc133-marker` (ghostel internal); ghostel upgrades
  can break it.
