# Runtime/view integration boundary

## Desktop, not process persistence

Deck schema 3 stores opaque public Pilish desktop state (runtime identity, current
session/branch, local draft/images, suspended follow-ups and quarantine) separately
from spaces, window layouts and stable target/parent links. Restoration calls
`pilish-restore-session-state`, never `pilish-start-session` or a shell launcher.
The frontend validates the exact live runtime and adopts its authoritative snapshot,
including a session file moved by another frontend. Pilish also reopens verified
prior-boot roots idle through managed claims; its [desktop policy](../pilish/RUNTIME.md#desktop-state-and-input-recovery)
owns the boot-evidence checks and failure handling. Other missing runtimes yield
stopped/unavailable views with explicit Resume; reconnect never means restart.

Saved buffer names are remapped to restored names in layouts and parent links.
Runtime discovery attaches by mux identity, not a stale filename; an already
tracked runtime, including one whose Close is pending, is never attached twice
(attaching a closing view refuses). Live roots without a view are only listed
from Pilish's runtime watch; they attach on explicit selection. A same-named view serving
a different runtime is never adopted. Failed restore records remain serialized in
`:unrestored`, preserving their drafts and identities for explicit retry.

Native terminals/panels restore as stopped placeholders. No saved shell command is
reexecuted. Explicit Resume of an ordinary shell confirms its command; managed
workers/panels require their parent's recovery protocol. Worker identity and parent
metadata survive absence of a local orchestration registry; a disconnected worker
is not promoted into an independent root or falsely recorded as finished.

Other schema versions refuse.

## Local and global actions

- Hide changes layout only.
- Close stops an agent everywhere without confirmation, including busy agents.
  Sidebar/title-bar ✕ and menu/keyboard Close have the same meaning.
- Close space closes its agents and owned descendants before forgetting layouts.
  Independent forks are peers, not owned children.
- Reconnect attaches the same existing runtime, without starting Pi or replaying
  accepted/uncertain input.
- Resume explicitly requests a managed start for a stopped conversation, without
  submitting a prompt. Parent-owned workers cannot use root Resume.
- Close uses Pilish's identity-bound acknowledged stop or the owning orchestration
  cancellation protocol. Dispatch is not acknowledgement. Views/layouts are removed
  only after authoritative termination; failure/uncertainty retains local state.
  Pi workers use public Pilish Close even when their local orchestration target
  is missing or transport unavailable. Only durable owning-task evidence permits
  retirement: `complete`, or `failed` once pimux's terminal receipt proves the
  worker ended, when Close reports the retained failure without listing the
  removed agent again. A stopped runtime receipt alone never does; uncertain task
  evidence retains the view and local work. Native panels and registered targets still use the
  orchestration owner. A root or interactive fork whose target the local registry
  no longer lists (after a frontend restart) uses its identity-bound runtime stop.
  A stopped view without a runtime identity has nothing to stop; Pilish Close retires it and
  keeps its unsent work in recovery. No bare Pi PID is signalled. Terminal
  notifications clean peer views idempotently without sending another stop. Retained terminal evidence also omits closed saved
  views from restoration; unknown owners remain recoverable unavailable views.
- Frontend teardown and transport loss disconnect only. They never mean agent Close.

The public frontend contract and callback shape are in [API.md](API.md).
Deck loads `pilish-runtime` from the same Phimacs revision; loading it against
stock Pilish fails. Mocked contract tests do not establish native/end-to-end
runtime behavior.

## Enable/disable and frontend restart

Repeated enable/disable does not overwrite previous settings. Disable restores
the actual previous dialog/pairing/tab/callback settings, removes owned windows,
headers, draft observers and hooks, and cancels timers without stopping agents.
Owned empty state is saved; incomplete staggered restoration cannot overwrite its
remaining records. State writes use private temporary files and atomic rename.

Manual and supervised restart retain their separate verified helper handoff.
Commands and the helper's Linux identity are checked before Emacs exits. The helper
waits for commitment and old owner exit; supervised mode has no manual fallback.
Failed save/helper preparation keeps Emacs running. Post-exit successor failure is
recorded, not hidden behind an automatic retry. Socket clients are not Emacs-owned
Pi children; warnings distinguish host-native panels/shells that will be lost.

## Focused verification

Select a prepared Emacs directory (`node scripts/emacs-packages.mjs --state DIR`
writes `DIR/emacs`; see [development](../../docs/development.md)) and finish
compilation before these checks. Tests never install packages, fetch archives or
borrow home caches. Pilish and deck always come from this monorepo. Run from the
Phimacs root:

```sh
export PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs
node scripts/emacs-deck-tests.mjs              # deck public-API desktop contract regressions
node scripts/emacs-deck-tests.mjs --ui         # imported UI/terminal and optional host contracts
node scripts/emacs-deck-tests.mjs --reference  # profile deck lifecycle
node scripts/emacs-deck-tests.mjs --compile    # warnings are errors
node --test emacs/pi-deck/scripts/native.test.mjs  # isolation, readiness and cleanup errors

export PHIMACS_PI=/absolute/path/to/the/selected/pi
node emacs/pi-deck/scripts/native.mjs          # real Pi/faux; orchestration physically absent
PHIMACS_NATIVE_ORCHESTRATION=1 node emacs/pi-deck/scripts/native.mjs  # includes managed panels
export PHIMACS_TEST_XVFB=/absolute/Xvfb
node emacs/pi-deck/test/smoke.mjs              # orchestration-absent daemon/TTY restart and Close
PHIMACS_SMOKE_ORCHESTRATION=1 node emacs/pi-deck/test/smoke.mjs  # additional panels/worker-result lane
```

The two explicit native commands are long-test exceptions: allow 5 minutes for
native ERT and 6 minutes for daemon/TTY smoke. The ordinary harness tests finish
within 20 seconds each. Do not run compilation concurrently with copying native
inputs; partial compiled artifacts refuse before service launch.

Add `--selector REGEXP` to run part of a suite. `--preflight` is a read-only API
check, not a downloader. The prepared directory supplies only third-party
packages, Ghostel's module and the two essential Markdown grammars. Each native
fixture copies these assets into its marked test root and checks them by loading
the module and grammars in Emacs. No `provision.json` is required or invented:
the preparation script does not emit such a receipt, and successful file copying
alone is not ABI validation. This check establishes local loadability, not a fresh
network-provisioning or source-license audit.

The default native/smoke lane copies the selected Pi host/dependency graph, pimux
artifacts, Pilish and deck into a separate minimal product tree. There is no
orchestration companion, task-status CLI, sound, browser package or profile there.
Restricted PATH/load-path and positive absence checks prevent checkout/installed
package fallback. Real prompts, desktop reconnect and acknowledged Close run in
that installation. Managed opt-ins additionally load this checkout's orchestration
and run genuine panel/worker journeys; their private Pi settings select only faux
provider resources. Xvfb is explicit and owned by the smoke. The fixture selects
an absent private session bus, so GTK on that display cannot autolaunch a D-Bus
session or accessibility services outside fixture ownership.

Home, native cache, agent/session roots, profile state, discovery sockets and the
pimux journal all stay in a marked isolated namespace. The harness explicitly
starts its foreground `pimux serve`, waits for readiness, and stops its exact
runtimes before the service. Frontend probes use `--alternate-editor=false`, never
an empty alternate editor that would start another daemon. Cleanup signals only
owned process identities, and only after a requested `kill-emacs` has had its
grace period: a signal during Emacs's own shutdown can deadlock it. Errors retain both the original failure and cleanup
failures plus private evidence. Frontend edits need no new prepared package set.

The mocked desktop tests establish deck's public contract, not the owning socket
implementation. The native regressions additionally exercise real Pi/faux,
independent socket input, moved-session desktop adoption and draft quarantine,
zero-client survival, missing-owner stopped views, explicit Resume, in-place tree
navigation (prefill, persistence across Resume, branch summary), acknowledged
unconfirmed idle/busy Close, omission of authoritatively closed saved views and
no native-shell command replay. Real persistent-wrapper panel tests also verify
finished commands stay listed with live wrappers, sidebar Close acknowledges
wrapper exit, and space Close settles owned children before their parent/layout.
The daemon/TTY smoke verifies
manual Emacs replacement and ordinary exit/start reconnect to the same mux/Pi.
Both lanes use the actual owning public APIs, not stubs. The disposable
cross-frontend lane and its opt-in command belong in
[development](../../docs/development.md). Run checks for the affected boundary;
ordinary changes need no whole-product gate.
Known upstream rendering/image/scrolling/platform limitations remain separately
classified; environmental skips are never reported as passing tests.
