# Cross-package integration tests

Tests combining extensions with orchestration belong here rather than inside a
runtime package. `../support/orchestration.ts` exposes test fixtures only; it is
not a runtime package export and must not enter release artifacts.

After dependency hydration and compilation, run the affected focused tests:

```sh
node scripts/test.mjs test/integration/ask.test.ts test/integration/error-prompt.test.ts test/integration/self-compact.test.ts
node scripts/test.mjs test/integration/herdr-finish-native.test.ts test/integration/switch-native.test.ts test/integration/switch-emacs-native.test.ts
```

These commands use faux inference or report native lanes skipped. A skipped lane
is not end-to-end evidence. Native switch and host prerequisites belong to the
[orchestration guide](../../packages/orchestration/README.md).

## Equal-client lifecycle and installed combinations

`sharing.test.mjs` runs real Pi, Pilish and deck with in-process faux inference.
It stages a selected host dependency closure and this checkout's sources below a marked
private test root. It uses no browser frontend, sibling Pilish checkout, private
provider, personal package directory or operational service.

Finish compilation before starting this lane: staging while another process
replaces `dist/` does not produce a consistent staged tree.

```sh
PHIMACS_SHARING=1 \
PHIMACS_PI=/absolute/selected/pi \
PHIMACS_TEST_EMACS_DIR=/absolute/prepared-state/emacs \
PHIMACS_TEST_XVFB=/usr/bin/Xvfb \
  timeout 600 node --test --test-concurrency=1 test/integration/sharing.test.mjs
```

This is an explicit long-test lane, outside the default focused run. The selected
Pi must match the root SDK version. Prepare dependency assets explicitly with
`scripts/emacs-packages.mjs`; the tests copy them and validate the module/grammars
by loading them in disposable Emacs. A copied directory without a receipt is not
reported as receipt-certified. No installation or network-backed model call takes
place during the journeys.

The lane covers:

- Two independent Emacs processes attached to one mux/Pi identity; prompts,
  streaming/steering, model state and matching snapshot/live generations.
- Shared dialogs with one winning answer, shared queues with requester-only
  recovery, and draft quarantine on branch/file changes.
- A second client attaching mid-tool, loss of its creating client, and accepted
  work completing with zero clients. Frontend restoration sends no saved input.
- Service restart producing one idle successor, both views adopting it, old
  context rejection, and old identity-bound Close not stopping its successor.
- Unconfirmed Close from either Emacs while idle, busy or dialog-blocked;
  authoritative peer/view/sidebar disposal and closed-desktop omission.
- A complete managed profile started through the actual `phimacs` launcher in a TTY, and a
  complete orchestration-absent profile started by literal `--init-directory` in
  a TTY. Both complete a prompt, save/restore automatically, retain the same
  runtime across direct/launcher transitions, and acknowledge Close. These are
  not synthetic-executable startup probes.
- Failing profile driver loading and losing the TTY launcher before profile
  initialization. An exec-only recorder journals the process before profile Lisp;
  cleanup settles its exact identity even if no Emacs server became available.

The minimal journeys physically omit orchestration, task-status, general
extensions, sound, browser tools, profile source and unrelated Lisp UI packages.
Only Pilish/deck's declared Lisp dependency closure remains. The absent-profile journey
adds only the profile; its orchestration companion, CLI and Pi package remain
unreachable. The managed-profile journey adds orchestration, not private or other
optional packages. Source/executable origins and compiled frontend loading are
asserted. GUI appearance remains in the existing display lane, not a Cartesian
product of every lifecycle journey. The PGTK Emacs 32 snapshot requires an
additional owned display frame for `emacsclient` evaluation in a TTY process;
the profile fixture creates it explicitly for every build. This lane passed on
Emacs 31.1 and 32.0.50; it verifies actual TTY frames, not terminal-only PGTK
operation. [Development](../../docs/development.md#emacs-build-selection-and-qualification)
owns Emacs build selection.

Each fixture owns its service, display, Emacs processes, agent/session directories,
server sockets, discovery, durable journal and marked cooperative claims. An
alternate socket alone is not isolation. Cleanup closes exact owned runtimes
before their service, retains both original and cleanup errors, and retains
failure evidence when uncertain. Frontends never auto-start pimux. Do not use the
user's daemon, credentials, registry or display to make a test pass. The
launcher's own start/attach, stop and device-sharing suites are listed in
[development](../../docs/development.md#emacs-preparation-and-focused-checks).

## Device sharing over real OpenSSH

`ssh-share.test.mjs` is an explicit opt-in lane, run after compilation. It skips
with its reason when unselected or when `sshd`, `ssh`, `ssh-keygen`, `socat` or
`pgrep` is missing:

```sh
PHIMACS_SSH_SHARE=1 timeout 180 node --test test/integration/ssh-share.test.mjs
```

It starts a user-level sshd on a random localhost port with a disposable host key,
authorized key and configuration; no system sshd or `~/.ssh` file is used or
changed. The device side is the real `phimacs share` with real ssh and socat; the
host side is the compiled `pi-sound` CLI. The lane covers speech playback with its
one-sample probe, `play done`, `notify` and dictation, each delivery settling only
on the device's `ok` status line after its player or notifier finished. A failing
player or notifier, including at the probe, is reported with its exit code and
nothing is synthesized after a failed probe. A killed device listener must not report a
delivery; the share then reconnects under a new ID, and SIGTERM releases the remote
and local sockets without leaving a process. As on a real host, SSH commands run
through the account's login shell and its startup files. Recording stand-ins
replace `parecord`, `pacat` and `notify-send`, and a local HTTP server the speech
and transcription backends, so this is no audio-device or provider evidence.
