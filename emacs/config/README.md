# Optional complete Emacs profile

This directory is an alternative init directory, not a replacement for
`~/.emacs.d`. It loads Phimacs's reusable packages and adds opinionated UI choices.
To keep your own configuration, use the package installation instructions in
[checkout setup](../../docs/install.md).

The profile includes Dracula, ordinary Emacs keys with an `M-m` leader, numbered
windows, Vertico/Orderless/Marginalia/Consult/Embark, Corfu/Cape, a small mode line
and a Messages/Help bottom panel. `M-m` replaces `back-to-indentation`. Pilish uses
Pi-style chat blocks, inline dialogs, fitted paired input, steering, answer jumping
and queue controls. Pi-deck supplies project spaces and the agent sidebar.

Orchestration is enabled by default. Sound, Evil and OSC 52 clipboard access are
opt-in. Browser tools and private providers are not profile dependencies.

## Prepare before startup

Follow [checkout setup](../../docs/install.md) for the exact Node, Emacs and Pi
requirements, compilation and provider login.
The supported profile needs Emacs 31.1+ with tree-sitter and native modules; its
checks pass on 31.1 and 32.0.50.

Prepare the private state directory explicitly, once:

```sh
phimacs setup
```

The state directory is `PHIMACS_STATE_DIR`, else `phimacs` below `XDG_STATE_HOME`
(`~/.local/state/phimacs`). Setup also registers the orchestration Pi extension
unless your overrides disable orchestration.

The state directory must be yours with mode 0700. Preparation creates a missing one
that way; for an existing directory use `mkdir -m 700`, `umask 077` or `chmod 700`.
Preparation and startup otherwise refuse it and name the directory.

[lisp/phimacs-packages.el](lisp/phimacs-packages.el) owns the third-party package
list and full Git revision pins. Preparation installs those packages, including
Evil's optional dependencies, below `STATE/emacs/elpa`. It uses the upstream
installers for Ghostel's native module and the two essential Markdown grammars,
then byte-compiles this checkout's Lisp packages. Compilation writes ignored
`.elc` build outputs next to their sources, not user configuration or runtime state.
Existing installed packages are not upgraded; prepare changed pins in fresh state.
Package signature checking can start a GnuPG agent for `STATE/emacs/elpa/gnupg`;
preparation stops it on success and failure and reports a failed stop.
Preparation does not load your override file or personal package directories.
It inventories the source checkout and compiles optional companions only when
their source directories exist. It does not choose runtime activation settings:
normal startup still refuses an explicitly enabled companion whose source is missing.

Pilish, pi-deck and selected companions load from this same checkout. There is no
separate Pilish clone, pin or checkout override. Stock archive Pilish is excluded
from profile activation because it lacks the detached integration contract.

Normal startup only activates prepared packages. It never clones packages,
downloads a terminal module or builds grammars. Missing packages/assets produce
the preparation command. Interactive chat and terminal creation also keep automatic
asset installation off. Explicit preparation can use the network and native build
tools; ordinary startup cannot silently become that preparation step.

## Run

Use the same selected state and Pi host for setup, pimux and Emacs:

```sh
export PHIMACS_STATE_DIR=/absolute/private-state
export PHIMACS_PI=/absolute/path/to/the/selected/pi
phimacs              # start or attach pimux and the daemon, then a terminal frame
phimacs --gui        # graphical client frame
phimacs --no-frame   # start or attach without opening a frame
```

[Installation](../../docs/install.md#start-phimacs) describes what `phimacs`
starts, `phimacs status` and `phimacs stop`.

Or start an independent non-daemon Emacs:

```sh
emacs --init-directory=/absolute/phimacs/emacs/config
```

The direct invocation starts a private Emacs server before deck claims its state,
even when orchestration is disabled. It uses the same stable endpoint as the
launcher: `STATE/sockets/SERVER`, where `SERVER` defaults to `phimacs`. Set
`PHIMACS_SERVER_NAME` consistently for a different dedicated name. An explicit
absolute `PHIMACS_SERVER_SOCKET` replaces that endpoint for both `phimacs` and the
profile; it is deployment configuration, and its directory must be private (0700). Direct startup refuses an existing or uncertain endpoint; it does
not take over another Emacs. Use `phimacs` to open a client of an existing one.

Before starting a daemon, `phimacs` checks Pi, pimux, Emacs capabilities, setup and
private state. It does not install packages or require the optional task reader
before your Lisp overrides have selected orchestration. `phimacs` starts or
attaches pimux; the direct invocation never starts it.

### Recover a stale Emacs endpoint

Endpoint refusal is deliberate. A failed `emacsclient` probe or timeout does not
prove the server is dead. Confirm the selected state/server path, then verify that
the intended Emacs process and its supervising service are stopped and the exact
endpoint is unowned.

Never unlink a live or uncertain endpoint, delete profile/deck state or remove the
pimux journal. Only after proving that exact socket stale and unowned may you
remove that socket alone, then deliberately start the selected launch mode again.
If ownership remains uncertain, keep the endpoint and inspect it; there is no
automatic takeover or state-reset recovery.

### Executable selection

- `PHIMACS_PI` selects the actual global Pi host for the launcher/service and is
  the default for `phimacs-pi-program`. Without it, the global `pi` on PATH is used.
  A conflicting frontend override is an error; use the same host for both sides.
- `phimacs-pimux-program` defaults to this checkout's absolute pimux executable.
- `phimacs-task-status-program` defaults to the checkout's compiled worker-task
  reader. It is resolved only when orchestration is selected, after overrides.

Do not prepend `node_modules/.bin` to PATH: it also contains the checkout SDK's
`pi`, which can replace the intended host selection. Existing-configuration users
retain the reusable packages' explicit executable options.

## Private overrides and state

`$XDG_CONFIG_HOME/phimacs/user.el` (default `~/.config/phimacs/user.el`) loads before
package activation and feature selection. `PHIMACS_USER_FILE` selects another
explicit file. Neither is generated or replaced by upgrades. For example:

```elisp
;;; user.el -*- lexical-binding: t; -*-
(setq phimacs-enable-orchestration nil) ; ordinary detached roots need no companion/CLI
(setq phimacs-enable-evil t)            ; Evil; SPC leader and fd to leave Insert
(setq phimacs-enable-osc52 t)           ; explicit terminal clipboard permission
(setq phimacs-enable-sound t)           ; an explicitly configured capture/backend
```

These are startup choices, not a hot-unloading system. Sound's source path and
wiring are absent when disabled. Enabled sound adds dictation keys, input/question
buttons and deck notifications through public hooks; its commands need an explicit
CLI/backend. See [sound](../../packages/sound/README.md) for configuration and
behavior. Browser tools remain an explicit Pi package selection.

Installed packages, native caches, Customize, TRAMP/Transient files and logs live
under `STATE/emacs`; deck state/preferences live under `STATE/deck`. The source
configuration receives no runtime files. A deliberate `package-directory-list`
override may activate your own packages, but the public profile needs none.

**A trial must isolate more than the Emacs state:**

- `PHIMACS_STATE_DIR` selects both profile state and pimux's durable journal.
- `PIMUX_DIR` selects runtime discovery/sockets, not that journal.
- `PI_CODING_AGENT_DIR` selects Pi authentication/settings; explicitly choose or
  clear `PI_CODING_AGENT_SESSION_DIR` for conversation storage.
- Select the same `PHIMACS_PI` for login, service and frontend. Use a trial override
  file rather than inheriting your normal `PHIMACS_USER_FILE` or external socket.

Use fresh directories for trial checks. Do not share an operational journal,
server endpoint, native cache or personal package installation. Per-user writer
claims still protect the same canonical conversation across namespaces; an
alternate socket is not permission for a second writer. The full ordered trial
recipe belongs in [checkout setup](../../docs/install.md).

## Runtime and Emacs lifetime

The profile loads Pilish, pi-deck and the companions from this checkout, so they
always match; it never falls back to plain Pi. With orchestration disabled, no task reader, companion or worker
extension is required for ordinary roots. Worker operations still refuse without
their task evidence; missing integration never turns a worker into a root.

Agent Close is unconfirmed, identity-bound and global. Closing Emacs or a view only
disconnects: accepted agent work can continue and incur usage. Desktop restore
reconnects authoritative runtimes without replaying prompts, follow-ups or shell
commands. Native shells/panels can be lost with their Emacs host. The owning
[runtime lifecycle](../../docs/lifecycle.md) defines these guarantees.

Manual mode starts an owned foreground daemon detached from its caller, without
the caller's display. Supervised mode (`PHIMACS_DAEMON_MODE=supervised`) uses only
the explicit `PHIMACS_SUPERVISOR_COMMAND` with `PHIMACS_SUPERVISOR_ARGS` and
`PHIMACS_SUPERVISOR_STOP_ARGS`, whose run script uses `phimacs service emacs`,
which keeps the supervisor's `DISPLAY` and `WAYLAND_DISPLAY`; it never falls back
to an unmanaged daemon. No supervisor is installed implicitly;
see [supervisors](../../docs/install.md#supervisors). Restart prepares a helper, saves state and waits for the exact old
process identity to exit. Failure/uncertainty is reported, not retried by launching
another writer. Existing unavailable sockets are never unlinked as startup cleanup.
All `emacsclient` probes disable alternate-editor fallback.

Graphical PGTK daemons can terminate if a display they used disappears, and some
PGTK builds cannot run a daemon without any display. Run such a build supervised,
with a persistent display that its supervisor selects. Persistent remote
displays are optional deployment choices, not imposed services.

`phimacs stop` refuses while a file buffer has unsaved changes, even with
`--force`; save or revert them first.

## Focused checks

Use a prepared disposable directory as `PHIMACS_TEST_EMACS_DIR`; never use the
user's daemon or live packages/caches. Own-source packages always come from this
checkout. From the checkout:

```sh
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node --test test/reference-config.test.mjs test/reference-launcher.test.mjs test/reference-profile.test.mjs
```

The staged profile tests prepare and compile copied minimal sources with both
companions absent in a network-isolated namespace. They also physically omit
orchestration/sound for startup, verify conditional program lookup and selected-host
agreement, and exercise literal direct startup, live-endpoint refusal and automatic
state save/restore. The offline preparation regression additionally requires
`unshare -Urn` support; with prepared inputs selected, unavailable user/network
namespaces fail the check rather than silently skipping it. They use synthetic command
fixtures for startup, not real runtime transport. The separate native startup and
display lanes are selected with `PHIMACS_REFERENCE_STARTUP=1` and
`PHIMACS_REFERENCE_DISPLAY=1`; broader runtime tests belong to the owning lifecycle
and package harnesses. Environment-skipped lanes are not passing evidence.

Original profile code is MIT. Pilish and fetched third-party packages retain their
own licenses; the profile's license does not relicense those packages or assets.
