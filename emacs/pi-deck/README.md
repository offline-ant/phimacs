# pi-deck

Spaces, pane layouts and an agent sidebar for Pi inside Emacs. Pilish owns chats,
input, dialogs and rendering; Ghostel owns terminals; pi-deck owns workspace UI.
The optional orchestration companion adds managed workers, forks and panels.

Develop and run from the Phimacs checkout. Lifecycle and detached desktop
contracts have focused regressions and opt-in native checks. See [runtime/view contracts](RUNTIME.md).

## Installation boundary

pi-deck is an Emacs package (`:lisp-dir "emacs/pi-deck"` of the Phimacs repository).
Use Phimacs [checkout setup](../../docs/install.md) and either the `use-package`
lines for an existing configuration or the optional
[reference configuration](../config/README.md), whose explicit preparation installs
pinned packages before startup.
Loading pi-deck installs nothing.

The supported runtime requires Linux, Node 24+, Emacs 31.1+ with tree-sitter and
native modules, the global Pi, and the maintained Pilish package in `emacs/pilish/`. A Pilish package-version
header alone does not identify its integration API.
Ghostel 0.59.0+ with its native module, Transient 0.9.0+ and both essential
Markdown grammars are required. Authentication is explicit and never copied by setup.

Installing optional libraries does not enable their Pi tools or grant audio/device
access. Load the orchestration companion before managed sessions when selected.
The reference configuration uses its own init/state directories and a separate
user override file; it never replaces an existing `~/.emacs.d`.

## Spaces, agents and panes

- A **space** is a project directory with one window layout, stored in a hidden
  tab-bar tab. Switching spaces switches the layout; the tab bar stays hidden.
- An **agent** is a Pilish session or Ghostel terminal. It can remain tracked while
  no window shows it. Agents have a fixed home space and stable creation order;
  displaying one elsewhere does not move or reorder it.
- A **pane** is one terminal or an atomic Pilish chat/input pair. Pane commands
  split, hide and zoom pairs as a unit, never by guessing adjacent window shapes.

Create a space with `S`, switch with `s` or click its name. A new space offers Pi,
shell or Dired (`pi-deck-new-space-action`). A frame opening a space starts with its
last remembered layout, else the directory. Layouts remain frame-local while open;
the most recently remembered layout seeds another frame.

## Space groups

With two or more spaces, the sidebar offers **+ New Group** beside **+ New space**.
Click it, type a name, click the spaces you want, then click **Create (3)** to
group three checked spaces. No modifier keys are needed. The checklist shows
each space's existing group, if any. Cancel leaves everything unchanged.
A space can belong to one group or stay ungrouped. Groups organize the sidebar
only: they do not own directories, layouts or agents.

Each group heading is a full-width band with its own background, also in text
terminals: a blue-grey tint on dark backgrounds, a pale tint on light ones and
blue with 8 or 16 colors (face `pi-deck-group-band`).
Click a group's name or the blank part of its band to fold or unfold
it. Member spaces keep their usual indentation. Status buttons stay visible
when folded: in `Lace      ◉ ● 2`, one agent is blocked and two have unseen
results. The name area and each button highlight separately on hover; the
single cells between buttons do nothing. Click `● 2` to visit a result
directly without unfolding Lace.
Visiting the result clears its done mark; folding and unfolding do not.
A single result shows just `●`. When space is tight, lower-priority buttons
drop first; the sidebar header still covers all spaces.

Right-click a band for its menu: **Rename…**, **Edit members…** (the
checklist), **Dissolve group** and the group's **Clear finished workers and
shells immediately** [checkbox](#immediate-clearing). Dissolving leaves every space
open. Membership is saved with the spaces; fold state lasts for the session. The same checklist is available with
`M-x pi-deck-new-group` and `M-x pi-deck-edit-group`; Tab moves through it
and Return activates a button.

## Sidebar and attention

The sidebar is shown in frames with room for its width plus
`pi-deck-sidebar-min-pane-width`. Narrow frames hide it. `b` toggles it everywhere;
dragging its edge updates the shared saved width. Preferences never rewrite init.

Its header summarizes blocked, unseen-finished, working and waiting agents; click it for
next attention, right-click it for a menu with the global
[immediate clearing](#immediate-clearing) checkbox. The right-hand `[×]` clears finished workers and exited shells in
all spaces, including folded spaces and “other”. Worker session files stay on
disk; terminal output is discarded. Live shells, waiting/running workers and all
ordinary or disconnected Pi views are untouched. Cleanup needs no confirmation,
keeps focus when its window survives, and retains entries whose owner cleanup
fails. The button is dimmed and inactive when nothing qualifies.
`pi-deck-sidebar-header-items` adds optional buttons before cleanup. Refresh updates changed text and properties without rebuilding the
displayed buffer, preserving window cursors and scroll positions; a sidebar whose
rows all fit returns to its top. It never scrolls horizontally.
Each space lists its agents in creation order, with workers/panels under their
parent, folded finished workers and finished shells. Unassigned agents appear
under “other”. Highlighted rows are visible in the current frame.

Root agents running in pimux without a view here, such as ones another
program started, are listed dimmed after the space's agents (the space of their
directory, else “other”) with their advertised status. Selecting one attaches it;
nothing attaches by itself. One that started while Emacs ran is marked **new**
until selected; the header counts them and next attention attaches the newest
when no agent needs attention. A pimux service restart, which restores roots
under new identities, neither marks them again nor loses a mark. Workers and
forks are not listed this way: they appear through their parent or creator.

| State | Meaning |
|---|---|
| blocked | Pending dialog or worker waiting for human guidance |
| done | Work finished while unseen; cleared when visible |
| working | Sending, inference, tools, compaction or a running shell command |
| waiting | Busy, but every running tool only waits on orchestration work (`do`, `wait`, …; extension status `orchestration-waiting`) |
| idle | Awaiting input, shell prompt or exited terminal |
| unknown | Missing process/connection or unmarked terminal state |

Priority is blocked, done, working, waiting, idle, unknown. Terminal status uses OSC 133
marks; exited terminals keep their text and status. Managed panels use their public
command state: a completed command folds into finished shells while its persistent
wrapper retains the output until Close. Unknown command state is not completion.
Ghostel's private marker boundary is version-coupled and covered by integration tests.

Notifications report blocked/finished transitions while invisible. Workers and
panels do not emit ordinary finished notifications because their result belongs to
the parent. D-Bus falls back to the echo area; `pi-deck-notify-functions` supports
optional explicitly configured sound/notification integrations.

## Usage section

With `pi-deck-usage-command` set (program and arguments, run without a shell),
the sidebar ends with a foldable “usage” section: each account's label on its own
row (cut with … only when wider than the sidebar; hover shows it whole), then one
indented row per subscription window with a bar, percent used and time to reset
(`45m`, `3h15m`, `3d2h`; zero minutes or hours are omitted). Below one day,
resets show hours and minutes; from one day, days and hours. Bars take the width
the sidebar windows can display. At 75%
the bar turns to the working face, at 90% to the blocked face; hover shows the
exact local reset time. Its arrow, name, `TAB` or `RET` fold it like a space, for the session only;
`↻` fetches now. Deck runs the command in the background when the mode is enabled
and every `pi-deck-usage-interval` seconds (300), never two at once, and stops it
and its timer on disable. Without the option there is no section and no timer.
The command prints one JSON object and exits 0 when it could run at all:

```json
{"fetchedAt": 1795110000,
 "accounts": [
   {"label": "claude original", "windows": [
     {"name": "5h", "usedPercent": 63, "resetsAt": 1795110599},
     {"name": "wk", "usedPercent": 55, "resetsAt": 1795377598}]},
   {"label": "codex", "windows": [], "error": "token expired"}]}
```

Times are Unix seconds; `resetsAt` may be null. Accounts appear in output order.
An account with an `error` and no windows keeps its last numbers under a dim
“30m ago: token expired” note; numbers older than two intervals are marked the
same way. A failed run (nonzero exit, its last stderr line, invalid JSON) keeps
all numbers and shows “failed: …”. Deck knows no accounts, credentials or
endpoints: the command owns them.

## Keyboard

Bind `pi-deck-command-map` to a prefix such as `C-c d`; the reference UI also uses
leader `d` (`M-m d`, and `SPC d` with Evil).

| Key | Action |
|---|---|
| `b` | Toggle sidebar |
| `g` | Agent picker; prefix argument filters status |
| `n` | Next attention |
| `N` / `P` | Next/previous agent in stable sidebar order |
| `a` / `e` | New Pi agent / shell in the current space |
| `r` | Reopen the current space's most recently closed agent |
| `C` | Attach an existing detached runtime (no new agent) |
| `u` / `U` | Reconnect the existing runtime / explicitly Resume a stopped view |
| `f` | Fork current Pi session |
| `A` | Answer the current agent's pending dialog |
| `S` / `s` | Create/switch space |
| `R` / `K` | Rename/close space |
| `\|` / `-` | Split pane right/below |
| `z` | Zoom pane; again restores layout |
| `X` | Close agent everywhere, without confirmation |
| `x` | Hide pane without stopping its agent |
| `=` | Repair chat/input pairs |
| `l` | Grid of agents; shells optional |
| `m` / `?` | Transient menu, including state and daemon actions |

In the sidebar, `RET` visits a row, `o` shows an agent beside the current pane,
`TAB` folds, `j`/`k` or `n`/`p` move, `K` closes, `N`/`E` create an agent/shell,
`R` reopens the space's most recently closed agent, and `q` hides the sidebar. Under Evil it stays in normal state and refresh is `gr`,
so leader keys, `gg` and search continue to work.

## Mouse, dialogs and title bars

A row click jumps to its agent; double-click shows it alone; middle-click shows it
beside the current pane without leaving the sidebar. Right-click opens contextual
menus on release. Mouse clicks and drags never select text; a click that moves
acts on the row where it began. The cursor line shows only while the sidebar is
selected. A current unfolded space's name opens its directory beside the
pane. Each space's `▾`/`▸` arrow or count folds/unfolds all its sidebar children,
including nested workers/panels and finished lists; `+` offers new agent/shell and Reopen agent actions.
Folding leaves panes and work unchanged. Fold choices survive sidebar refresh,
but are not saved across Emacs restarts.

Title bars display name, status and model/context or terminal exit details.
`[J]` toggles automatic positioning on completion and session focus. Completion
shows the final answer from its beginning when following output, without moving
a reader who scrolled back. Entering the session shows the latest final answer
again, even if already read; a working session follows its latest output. Moving
between its chat and input or using the minibuffer does not retrigger this.
Pending dialogs take priority. Short answers show with the buffer end. With `[J]`
off, focusing preserves the reading position; the toggle is per session.
`[↓]` always follows latest output regardless of `[J]`, `[⑂]` forks, `[⤢]` zooms
and `[✕]` **closes the agent**, just like sidebar ✕. Double-click remains focus plus
zoom, obeying `[J]`.
Optional `pi-deck-pane-header-prefix-function` supplies a window-number prefix.

Inline dialogs wait in chat rather than interrupting another draft. Jumping to a
blocked agent focuses its question; click, Return or a choice digit answers, Tab
moves, and `C-c C-k` cancels. First-answer-wins and cross-frontend dialog closure
belong to the shared runtime/frontend contract, not a guessed local UI state.

## Workers, panels and closing

A panel opens beside its visible parent without taking focus. Workers, forks and
panels with hidden parents remain listed until revealed. Finished workers retain
session links; Open transcript is read-only and Resume explicitly opens an
independent session, returning no result to the old parent. Forgetting a finished
worker row leaves its session on disk. Closing finished shells loses their output.

### Immediate clearing

By default finished workers and exited shells stay listed until you clear them
with `[×]`. To clear them as they finish, check **Clear finished workers and
shells immediately** in a space's right-click menu, a group band's menu, or the
sidebar header's menu (**… in all spaces**). Then a worker that an agent started
leaves no finished row when it closes (its session file stays on disk), and a
panel or shell that an agent started closes as soon as its command ends, as
`[×]` would. Shells you opened yourself always stay. A failed close keeps its
entry, reports the error once and leaves it for `[×]`.

A child is cleared when any of its parent's home space, that space's group or
the global checkbox says so; agents without a space follow only the global one.
Space choices are saved with the spaces, group choices with the deck state (a
renamed group keeps its choice; a dissolved group drops it) and the global
choice as a preference (`pi-deck-clear-finished-immediately`).

Close stops the agent everywhere, without confirmation, whether idle, working or
blocked. Sidebar ✕, title-bar ✕, menu Close and keyboard Close use the same action.
Owned workers and panels close before their parent; independent forks remain peers.
Close space closes its agents and owned descendants before forgetting its layout.
Close does not wait: the agent's panes and sidebar entry disappear at once. Its
buffers are disposed after the owning runtime/task acknowledges termination; a
failed or uncertain stop lists the agent in the sidebar again, without its panes.
A dead worker whose cleanup failed is removed and its retained failure reported. Another frontend's authoritative closure
removes panes, sidebar entries and saved active views here too. Retained terminal
receipts prevent a closed agent returning as an active view after desktop restore.
Transcripts remain on disk; Pilish retains unsent local work outside the active list.
Reopen agent opens the newest session of the space's own directory (not its
subdirectories) that no tracked agent shows, stopped views included. Forks count;
orchestration workers do not. A live runtime holding it without a view here is
attached instead of started. It reads `PI_CODING_AGENT_SESSION_DIR` when set, else
Pi's default session root (`PI_CODING_AGENT_DIR`), not the `sessionDir` setting.

Hide changes layout only and never stops an agent. Closing Emacs or losing a socket
also leaves detached agents running; neither is agent Close. Reconnect never creates
an agent; Resume is explicit.

## State ownership and Emacs restart

Only the server whose socket owns `pi-deck-state-file` automatically restores or
saves it. Disposable/other Emacs instances do neither. Explicit Save can take over;
an owned but unrestored file is backed up before replacement. Saves are event-driven,
including the empty state after deleting the final space, never periodic.

Enable/disable is idempotent. Disable restores the actual previous dialog/pairing/
tab/callback settings and removes owned sidebar windows, pane headers, hooks and
all pending timers without stopping processes or changing unrelated panes.

Restart has separate `manual` and `supervised` modes. A validated, acknowledged
helper must be ready before Emacs exits, and a failed save prevents exit. The helper
waits for commitment and old PID/start-identity exit, then invokes only the selected
command. Supervised mode requires an explicit supervisor command and never starts
a manual fallback. A frontend restart may lose host-native panels/shells, but must
not send Stop Agent to detached RPC roots. See [the exact boundary](RUNTIME.md).

Schema 3 saves runtime identities, local drafts/images/recoverable queued work,
parent links and layout separately. Restore attaches an existing runtime and adopts
its authoritative current session. Verified prior-boot roots reopen idle through
Pilish's managed claims; other missing runtimes remain recoverable views with
explicit Resume. See [the desktop policy](RUNTIME.md). Native terminals become
stopped placeholders, with no shell-command replay. Failed records remain recoverable
for explicit restore retry. Other schema versions refuse.

Deck requires the Pilish of the same Phimacs revision, including `pilish-runtime`;
loading it against stock Pilish fails. Mocked contract tests do not establish
native runtime behavior.

## Development and limitations

Use a prepared Emacs package directory, explicit checkout inputs and the focused
commands in [RUNTIME.md](RUNTIME.md).
The reference configuration's tests cover private state, GUI and 256-/truecolour
terminal UI. UI-only tests do not certify full Pi/Pilish/runtime reconnect or clean
end-to-end installation. The owned harness and smoke copy explicit prepared assets and select the host
with `PHIMACS_PI`. Their default lane stages a minimal installation without
orchestration/task-status; the managed lane adds real panel/worker coverage. Both
start and clean their own pimux service. They use no personal caches, implicit
installation or unselected Pi fallback. Select native checks when the owning runtime boundary changes; ordinary
edits do not require a release build or a new package directory.

Known external boundaries remain: per-frame layouts can differ, Emacs rendering is
single-threaded, Ghostel's private terminal APIs need version-pinned tests, and
upstream Markdown/fontification/image/scrolling limitations are not fixed merely
by consolidating the repository. Third-party code retains its original licenses.
