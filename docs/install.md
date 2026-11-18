# Installation

Phimacs installs in three ways from one checkout: its Pi packages for plain `pi`
in Herdr or tmux, the complete Emacs profile, or packages for your existing Emacs
configuration. None requires private providers, personal settings or a
machine-specific service supervisor.

The complete profile needs four steps: clone and compile, log in to a provider,
run `phimacs setup` once, then run `phimacs`.

## Pi in Herdr or tmux, without Emacs

Plain `pi` in a [Herdr](https://herdr.dev) or tmux pane can use managed workers,
panels and forks, the general extensions, and optionally the browser tools and
sound. This needs neither Emacs nor the pimux service. It needs Linux, Git,
Node 24+ and Pi 1.5.2 on PATH; setup never installs or upgrades Pi:

```sh
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.2
git clone https://github.com/offline-ant/phimacs
phimacs/bin/phimacs setup pi      # add --browser and/or --sound for those packages
pi
```

`setup pi` is newer than release v0.1.0: use `main` or a later release tag. It:

1. checks Node and the `pi` on PATH, and warns when Pi's major.minor version
   differs from the tested one;
2. refuses, changing nothing, while Pi already loads another copy of these
   packages or the archived `pi-ant`/`pi-browser` ones, from its settings or its
   `extensions/` directory, and prints the exact `pi remove` command or file;
3. runs `npm ci --ignore-scripts`, which downloads the whole root dependency graph
   (including the Pi SDK), and compiles only pimux, orchestration and extensions,
   plus browser and sound when selected or already registered;
4. registers each package with `pi install ABSOLUTE-PATH` in Pi's user settings
   (`~/.pi/agent/settings.json`, or `PI_CODING_AGENT_DIR`). Other entries and
   their filters stay; registered packages are skipped.

Pi loads the packages from the checkout, so keep it in place. `--sound` enables no
recording or speech backend; the [sound README](../packages/sound/README.md) says
how to configure one. The [browser README](../packages/browser/README.md) lists
what its tools need.

Orchestration uses the Herdr or tmux pane Pi runs in for workers and panels;
`/orchestration-host status` shows it. Outside both, worker tools report that
there is no host. If you saved a tool selection with `/tools`, it stays exact:
enable new tools there. `phimacs pi` is an optional variant of `pi` that also holds
a writer claim on its conversation, as orchestration does for its workers, so no
second cooperating Pi opens it; plain `pi` behaves like stock Pi.

For Herdr's agent states and the extensions'
[finish prompts](../packages/extensions/README.md#herdr-finish-prompts), install
Herdr's own Pi integration once with `herdr integration install pi`. Herdr 0.9.0
writes `extensions/herdr-agent-state.ts` into Pi's agent directory, honoring
`PI_CODING_AGENT_DIR`, and refuses while that directory does not exist yet;
`setup pi` creates it. Phimacs is checked with Herdr 0.9.0 and 0.9.5.

**Update:** Pi agents and workers load code from the checkout, so let them finish
and exit them first. Then run `git -C phimacs pull` and `phimacs/bin/phimacs setup pi`
again.

**Uninstall:** `pi remove` each registered path, as `setup pi` lists at its end,
for example `pi remove "$PWD/phimacs/packages/orchestration"`, then delete the
clone. Authentication, sessions and other settings stay.

### Updating from pi-ant or pi-browser

The archived `pi-ant` and `pi-browser` repositories continue here. Agents and
workers that run the old code cannot move to the new code, so let them finish and
exit them first. Then clone and run `setup pi` as above: it refuses while the old
packages are configured and prints the `pi remove` commands for them, for example:

```sh
pi remove /path/to/pi-ant/orchestration
pi remove /path/to/pi-ant
pi remove /path/to/pi-browser
```

`pi remove` changes only the package list; authentication, sessions and other
settings stay. The packages moved:

| Old path | New path |
|---|---|
| `pi-ant/orchestration` | `packages/orchestration` |
| `pi-ant` | `packages/extensions` |
| `pi-browser` | `packages/browser` |

Tau, its web frontend, is gone, and with it `/switch tau` and `/rec-setting` (the
[sound](../packages/sound/README.md) package's `/dictate-setting` replaces it).
`/take` is gone too. From a Pi in Herdr or tmux, `/switch` refuses to hand over
the session; it only attaches another frontend to a detached Emacs agent. Tools
added since, such as `microdo`, `py` (which needs `uv`) and `prompt_history`, stay
off under a saved `/tools` selection until you enable them there.

## Requirements and source

The detached workspace targets Linux, Node 24+ and Emacs 31.1+ with tree-sitter
and native-module support. Git and a C build toolchain are needed for explicit
package/Markdown grammar preparation. Pi host and root SDK are tested together
at **1.5.2**. Checks pass on Emacs **31.1** and **32.0.50**;
[development](development.md#emacs-build-selection-and-qualification) lists the
lanes. Pilish's declared standalone requirements are in its
[package documentation](../emacs/pilish/README.org).

These instructions use `main`; the v0.1.0 release does not have all the features
described here.

```sh
git clone --branch main https://github.com/offline-ant/phimacs phimacs
cd phimacs
npm ci --ignore-scripts
npm run compile
```

The root lock owns the npm graph. The full checkout install includes optional
packages; it is not a minimal artifact installation. No lifecycle script runs
implicitly: `.npmrc` disables scripts, including `prepack`. Compile explicitly
before packing or using generated JavaScript.

Put the checkout's `bin/` on PATH, or link `bin/phimacs` into a directory on PATH;
the script finds its checkout through the link. For example, create
`~/.local/bin` if it is missing and add it to PATH in your shell startup file:

```sh
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
ln -s "$PWD/bin/phimacs" "$HOME/.local/bin/phimacs"
```

Keep the checkout in place: the launcher runs from it. Do not put checkout `node_modules/.bin` on PATH: it also contains
an SDK `pi`.

A running service and Emacs daemon load code from their checkout. Do not
reinstall, recompile or remove source there while they run; see
[checkout safety](development.md#checkout-safety).

## Isolated trial environment

Use fresh private state and a separately installed published Pi. A different HOME
alone does not isolate a global npm installation. This example, run from the
checkout, selects an explicit disposable npm prefix and does not alter an existing
global Pi:

```sh
umask 077
trial=$(mktemp -d)
export HOME="$trial/home"
export XDG_CONFIG_HOME="$trial/config"
export XDG_CACHE_HOME="$trial/cache"
export XDG_DATA_HOME="$trial/data"
export XDG_STATE_HOME="$trial/xdg-state"
export XDG_RUNTIME_DIR="$trial/runtime"
export PHIMACS_STATE_DIR="$trial/state"
export PIMUX_DIR="$trial/mux"
export PHIMACS_SHARE_DIR="$trial/share"
export PI_CODING_AGENT_DIR="$trial/agent"
export PI_CODING_AGENT_SESSION_DIR="$trial/sessions"
export PHIMACS_USER_FILE="$trial/user.el"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$PHIMACS_STATE_DIR" "$PIMUX_DIR" \
  "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR"
printf ';;; Trial overrides -*- lexical-binding: t; -*-\n' > "$PHIMACS_USER_FILE"

for name in ${!PI_ORCHESTRATION_@} ${!PI_WORKER_@} ${!PHIMACS_PARENT_@} \
    ${!PHIMACS_PIMUX_SUPERVISOR_@} ${!PHIMACS_SUPERVISOR_@}; do
  unset "$name"
done
unset PHIMACS_HOST PHIMACS_SHARE PI_REMOTE PI_NESTED PHIMACS_MANAGED_CLAIM \
  PIMUX_DISCOVERY PHIMACS_DAEMON_MODE PHIMACS_SERVER_SOCKET PHIMACS_SERVER_NAME \
  EMACSLOADPATH
npm install --global --prefix "$trial/npm" --ignore-scripts \
  @earendil-works/pi-coding-agent@1.5.2
export PHIMACS_PI="$(realpath "$trial/npm/bin/pi")"
export PATH="$PWD/bin:$trial/npm/bin:$PATH"
"$PHIMACS_PI" --version
```

`PHIMACS_PI` selects the host for the service and the default frontend
`phimacs-pi-program`; a conflicting frontend selection is an error.

The namespaces have different owners:

| Selection | Owned state |
|---|---|
| `PHIMACS_STATE_DIR` | Emacs profile state **and pimux's durable journal/restore intents** |
| `PIMUX_DIR` | Ephemeral runtime sockets/discovery, not the journal |
| `PHIMACS_SHARE_DIR` | Sockets of [shared devices](#other-devices) |
| `PI_CODING_AGENT_DIR` | Pi settings, authentication and default session policy |
| `PI_CODING_AGENT_SESSION_DIR` | Explicit conversation storage |
| `PHIMACS_PI` | Exact published Pi executable used by service/frontends |

`phimacs` passes these selections to the service and Emacs daemon it starts. A
service or daemon that already runs keeps the environment it started with, so
never point a trial at an existing journal or endpoint. Fixed per-user writer
claims still protect the same canonical conversation across these namespaces; an
alternate socket does not permit a second writer. A normal installation may
deliberately reuse its usual Pi agent directory instead of this trial setup.

For another terminal, carry the exact trial selections rather than rely on its
login environment. Save only the non-secret variables to a private file and
source it there:

```sh
declare -p HOME PATH XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME \
  XDG_RUNTIME_DIR PHIMACS_STATE_DIR PIMUX_DIR PHIMACS_SHARE_DIR PI_CODING_AGENT_DIR \
  PI_CODING_AGENT_SESSION_DIR PHIMACS_PI PHIMACS_USER_FILE > "$trial/environment.sh"
```

## Log in and set up

Run the selected Pi interactively and use `/login` for a stock supported provider,
then select its model with `/model`. Exit that session afterwards. No private
provider, copied credential file or account reader is required. Authentication
is not a paid inference test; any actual provider prompt is your explicit action.
The commands below use `PHIMACS_PI` when you set it (as in the trial environment),
else the `pi` on PATH.

```sh
"${PHIMACS_PI:-pi}"
phimacs setup
```

`phimacs setup` is the one-time networked step. It creates the private state
directory (mode 0700), then installs the [pinned packages](../emacs/config/lisp/phimacs-packages.el)
into `STATE/emacs`, Ghostel's native module and the two Markdown grammars through
their own installers, and byte-compiles checkout Lisp, including optional companion
sources that are present. It downloads and builds; existing installations are kept.
Prepare changed pins into new state.

Setup then reads your override file. When orchestration is enabled, the profile
default, it registers the orchestration Pi extension with
`"$PHIMACS_PI" install <checkout>/packages/orchestration`, which adds it to Pi's
settings in `PI_CODING_AGENT_DIR`. For ordinary detached roots only, put
`(setq phimacs-enable-orchestration nil)` in the override file first; then no
task-status executable, orchestration extension or Emacs companion is needed.
Setup can be rerun safely.

The state directory must be yours with mode 0700. Setup and startup refuse one
with group/other access and name it; create it with `mkdir -m 700`, under
`umask 077`, or fix it with `chmod 700`. Bytecode is written next to checkout
sources, so setup is a build step in the checkout.

Pi can execute tools and load project resources; review its project-trust prompts.
Do not turn an unknown project into a trusted installation fixture.

### Optional Pi packages

The general extensions (`ask`, `py`, `/tools` and more), the browser tools and
sound are separate selections. From the checkout, run only the commands for the
packages that you want:

```sh
"${PHIMACS_PI:-pi}" install "$PWD/packages/extensions"
"${PHIMACS_PI:-pi}" install "$PWD/packages/browser"
"${PHIMACS_PI:-pi}" install "$PWD/packages/sound"
```

Sound also needs a [configured backend](../packages/sound/README.md#configuration).
For the 🎤 button and keys in Emacs, put `(setq phimacs-enable-sound t)` in the
override file, and set `pi-sound-program` to the checkout's
`packages/sound/dist/main.js` unless `pi-sound` is on PATH.

## Start Phimacs

```sh
phimacs              # terminal frame
phimacs --gui        # graphical frame
phimacs --no-frame   # start or attach everything without a frame
```

`phimacs` starts or attaches everything, then opens a frame:

1. **Checks.** If no Emacs daemon answers at `STATE/sockets/phimacs` (or an explicit
   absolute `PHIMACS_SERVER_SOCKET`), it first
   checks Pi, Emacs and setup, before anything starts. Missing setup reports
   `run phimacs setup` and leaves nothing running; it never installs anything.
2. **pimux service.** If none answers, it starts one in the background (log in
   `STATE/pimux.log`) and waits for readiness. On the first start it says that
   journaled root agents are restored idle and that nothing is replayed, and it
   lists any root that failed to restore. A second `phimacs` started at the same
   time waits for that service instead of starting another.
3. **Emacs daemon.** It starts the profile daemon if none answers. If that fails
   after this command started pimux, the error says that pimux is still running
   (with its process ID) and that `phimacs stop` stops it.
4. **Frame.** A terminal client frame, or a graphical one with `--gui`. Arguments
   after `--` go to `emacsclient`.

When both already answer as this checkout's, the frame opens without the full
checks; endpoint identity and permissions are still verified. `phimacs` attaches
only to a service that was started from this checkout and keeps its journal in
this `PHIMACS_STATE_DIR`, and whose reported process is running and holds that
state's service leases. It refuses, with recovery steps, a service without that
identity (such as a bare `pimux serve`), one from another checkout or another
state directory, one whose process identity is invalid, dead or not the lease
holder, a socket that does not answer and an owner whose liveness is uncertain.
A service that another `phimacs stop` is stopping is refused while that command
runs; a stop whose command has died is undone first. Nothing is removed or
replaced automatically; see
[safe endpoint recovery](../emacs/config/README.md#recover-a-stale-emacs-endpoint).

Run `phimacs` from a project directory: that directory is the default for a new
deck space (`M-m d S`). Quit the client frame with `M-m q q`, or the whole Emacs
daemon with `M-m q Q`. Agents keep running in the service either way, and
accepted work can continue and incur usage without a visible frontend. The
[demo](demo/README.md) shows two projects at work at the same time.

`phimacs pi [ARGS]` instead opens Pi's own terminal UI under pimux's writer claim.
It starts neither the service nor Emacs, and the terminal owns its lifetime; see
[Pi in Herdr or tmux](#pi-in-herdr-or-tmux-without-emacs).

Or use the alternative init directory directly, without a daemon:

```sh
emacs --init-directory="$PWD/emacs/config"
```

This never starts pimux; start it first with `phimacs --no-frame` (which also
starts the profile daemon) or `phimacs service pimux`. Direct startup establishes
the same stable private server before deck claims persistence, even without
orchestration, and refuses an existing or uncertain endpoint; use `phimacs` to
attach to a running instance. The profile never replaces `~/.emacs.d`. Its
[README](../emacs/config/README.md) owns UI, startup options and private overrides.

### Status and stop

```sh
phimacs status         # add --json for a machine-readable form
phimacs stop           # add --force to stop busy agents and workers too
```

`phimacs status` starts nothing. It shows the selected Pi, the service with its
agents by state, journaled roots and **failed root restorations** with their
errors, the Emacs daemon, what setup is missing, whether the orchestration
extension is registered, and [device](#other-devices) connections. A ready service
does not prove that every root was restored.

`phimacs stop` saves and quits the Emacs daemon, then stops the service. It first
refuses while an Emacs file buffer has unsaved changes; `--force` never overrides
that. It stops only the service it would attach to, as one operation bound to
that service's exact process and to the `phimacs stop` process itself. A second
stop is refused while the first runs
(`pimux stop ID by live process PID is already in progress`); a stop whose command
died is undone by the next stop or `phimacs`. Unforced, the service then
closes agent input: prompts, steering and other frontend input are refused with
`pimux service stopping; input was not forwarded`, while aborts and dialog answers
still pass. It refuses while an agent is working or blocked, a launch is pending,
or a worker or other non-root agent exists, because those are not restored, and
also when an agent cannot be shown idle in time; a refusal reopens input. A prompt
that an already disconnected frontend sent still blocks it until Pi answers.
`--force` stops busy agents and workers too. Idle root agents stay journaled and
come back idle with the next `phimacs`.
[Runtime lifecycle](lifecycle.md#starting-and-stopping-the-service) owns these rules.

## Other devices

Other machines use the same command over SSH. The machine that runs Phimacs (the
host) keeps Emacs, the service and all agents; a device only needs Bash and
OpenSSH, not a checkout or Node. Remote use opens terminal frames; graphical
frames from another machine are not part of Phimacs.

SSH runs remote commands non-interactively through the host user's login shell.
Do not rely on interactive shell configuration: `phimacs` must be on the host's
non-interactive PATH, or use its absolute host path below and set
`PHIMACS_REMOTE_COMMAND` on the device to that path; it is quoted, so `~` is not
expanded. Conversely, configuration that a shell reads for every session, such as
fish's `config.fish`, sets its variables in every remote command too, including
`PHIMACS_*` and `PI_*` selections. Keep the host's selections there consistent
with what its service and Emacs use, or keep them out of it.

On each device, install the standalone client from the host. `HOST` is an SSH
destination, ideally an alias from `~/.ssh/config`:

```sh
mkdir -p ~/.local/bin
ssh HOST phimacs client > phimacs.tmp
PHIMACS_HOST=HOST bash phimacs.tmp client install ~/.local/bin/phimacs
rm phimacs.tmp
```

`client install` downloads into a temporary file, checks it (`bash -n` and the
client marker line) and only then replaces the target, so a failed download keeps
the working client. Run `phimacs client install` again to update it. Then set the
host in the device's shell startup file:

```sh
export PHIMACS_HOST=HOST
```

With `PHIMACS_HOST` set, every command except `share` and `client install` runs on
the host: `phimacs`, `phimacs status`, `phimacs pi` and so on. Run from a terminal,
frames, `pi` and `pimux` get one on the host (`ssh -t`); other commands do not.
Arguments are passed through unchanged, whatever the host's login shell. `--local`
as the first argument ignores `PHIMACS_HOST`, for example on the host itself when
shared dotfiles set it everywhere.

### Share the device's microphone, speaker and notifications

A device can lend its microphone, speaker and desktop notifications to the host,
for dictation, deck sounds, speech playback and deck notifications. This is
opt-in on both sides.

On the host, add and enable sound as [optional Pi packages](#optional-pi-packages)
describes, and set `"share": true` in `PI_CODING_AGENT_DIR/voice.json`
instead of a `capture` command, together with a transcription backend for
dictation. With `share` selected there is no fallback
to the host's own devices: no connected device is an error.

On the device:

```sh
PHIMACS_SHARE=1 phimacs   # share while this frame runs
phimacs share             # share persistently, reconnecting, until stopped
```

`PHIMACS_SHARE=1` shares for the duration of a remote frame or `phimacs pi`
session, unless a persistent `phimacs share` to the same host already runs.
`phimacs share` suits desktop autostart; one runs per device user and host.
Both match the host by the exact `PHIMACS_HOST` string, so an alias and its
`user@host` form count as different hosts. Session shares log to
`~/.local/state/phimacs-client/share.log` (below `XDG_STATE_HOME` when set).

The device needs Bash 5.1 or newer and `socat`, and `flock` (util-linux) for
`phimacs share`. Each kind needs its tool: `parecord` (microphone) and `pacat`
(speaker) from PulseAudio or PipeWire's Pulse server, and `notify-send`
(notifications). A missing tool is named and that kind is not shared. The host's
sshd must permit remote Unix-socket forwarding: `AllowStreamLocalForwarding` must
be `yes` (the default) or `remote`, and `AllowTcpForwarding no` blocks these
forwards too.

Each connection forwards three Unix sockets over one SSH connection into the
host's share directory, `PHIMACS_SHARE_DIR` or `/tmp/phimacs-share-<uid>` (mode
0700). The newest connected device wins for each kind. Keep the default unless
the same value reaches SSH commands, the service and Emacs on the host. After
playing a sound or showing a notification, the device answers with one status
line, `ok` or `error CODE`, and closes; only `ok` counts as delivered. Failures
are reported, for example `Shared speaker device NAME failed: player exited 1`.
A close without a status line is reported as uncertain delivery, and a device that
does not close in time as an error. Speech is first probed with one silent sample,
so nothing is synthesized for a device that cannot play.
[Sound](../packages/sound/README.md#device-sharing) owns the protocol.
`phimacs status` lists the device connections, newest first.

**Trust:** every process running as your user on the host, including agents and
the tools they run, can use the forwarded sockets. It can record from the device
microphone for as long as it keeps a connection open, play audio and show
notifications. The device does not ask before each use. Share only with a host
whose processes you trust with your microphone, and stop sharing when you do not
need it.

## Supervisors

A supervisor can own the service and the Emacs daemon instead of `phimacs`. Its
run scripts use foreground commands that keep their process ID:

```sh
phimacs service pimux   # the pimux service
phimacs service emacs   # the profile daemon (requires phimacs setup)
```

Run scripts must select the same environment as your shell: `PHIMACS_STATE_DIR`,
`PHIMACS_PI`, `PIMUX_DIR`, `PI_CODING_AGENT_DIR` and any other selections above.
Then tell `phimacs` how to start and stop them, so that it never starts its own
copy and `phimacs stop` is not undone by a restart:

| Variable | Meaning |
|---|---|
| `PHIMACS_PIMUX_SUPERVISOR_COMMAND` | Supervisor program for the service |
| `PHIMACS_PIMUX_SUPERVISOR_ARGS` | JSON string array that starts it and waits |
| `PHIMACS_PIMUX_SUPERVISOR_STOP_ARGS` | JSON string array that stops it |
| `PHIMACS_DAEMON_MODE` | `supervised` for the Emacs daemon (default `manual`) |
| `PHIMACS_SUPERVISOR_COMMAND` | Supervisor program for the Emacs daemon |
| `PHIMACS_SUPERVISOR_ARGS` | JSON string array that starts it |
| `PHIMACS_SUPERVISOR_STOP_ARGS` | JSON string array that stops it |

Example with [runit](https://smarden.org/runit/) user services in `~/service`:

```sh
# ~/service/phimacs-pimux/run (phimacs-emacs is the same with "service emacs")
#!/bin/sh
exec 2>&1
. "$HOME/.config/phimacs/environment.sh"
exec /absolute/phimacs/bin/phimacs --local service pimux
```

```sh
# Shell environment of every phimacs invocation on the host
export SVDIR="$HOME/service"
export PHIMACS_PIMUX_SUPERVISOR_COMMAND=sv
export PHIMACS_PIMUX_SUPERVISOR_ARGS='["-w","30","start","phimacs-pimux"]'
export PHIMACS_PIMUX_SUPERVISOR_STOP_ARGS='["-w","30","stop","phimacs-pimux"]'
export PHIMACS_DAEMON_MODE=supervised
export PHIMACS_SUPERVISOR_COMMAND=sv
export PHIMACS_SUPERVISOR_ARGS='["-w","30","start","phimacs-emacs"]'
export PHIMACS_SUPERVISOR_STOP_ARGS='["-w","30","stop","phimacs-emacs"]'
```

A failed supervisor start never falls back to an unsupervised process, and
`phimacs` never restarts a service that answers. Keep the service's durable state
across restarts; never delete its journal to bypass an uncertain owner.

A daemon that `phimacs` starts receives no display from its caller, and some
graphical Emacs builds cannot run a daemon without one. `phimacs service emacs`
keeps the supervisor's `DISPLAY` and `WAYLAND_DISPLAY`, so run such a build
supervised with a persistent display.

## Existing Emacs configuration

Compile the checkout and log in as above. Without the profile, `phimacs` would
start the profile's Emacs daemon, so run only the service: `phimacs service pimux`
in its own terminal, or under a [supervisor](#supervisors). `phimacs status` and
`phimacs stop` work as described above.

Install package dependencies with your normal package manager. For fully pinned
preparation, run `node scripts/emacs-packages.mjs --state /absolute/private-state`,
the preparation step of `phimacs setup` without its Pi extension registration. It
installs the complete third-party set but does not enable the profile's UI.
Keep that extra dependency tree separate from
your normal `package-user-dir`, where the VC package clones are installed.
Activate the prepared dependencies/native assets from your own init:

```elisp
(require 'package)
(add-to-list 'package-directory-list "/absolute/private-state/emacs/elpa")
(package-initialize)
(add-to-list 'treesit-extra-load-path "/absolute/private-state/emacs/tree-sitter")
(setq ghostel-module-directory "/absolute/private-state/emacs/ghostel/"
      ghostel-module-auto-install nil
      pilish-essential-grammar-action 'warn)
```

Install the maintained Pilish **before deck**, from the same repository and
revision. package-vc clones `:rev` with `git clone --branch`, which accepts a
branch or tag; a full commit hash works too. Stock/archive Pilish may have a numerically newer version while
lacking the detached runtime; pi-deck refuses to load against it. The explicit
`:vc` source matters; a package-version constraint is not sufficient.

```elisp
(use-package pilish
  :vc (:url "https://github.com/offline-ant/phimacs" :rev "main"
       :lisp-dir "emacs/pilish")
  :demand t
  :config
  (pilish-configure-runtime :pi-executable "/absolute/selected/pi"
                            :pimux-executable "/absolute/phimacs/packages/pimux/bin/pimux"))
(use-package pi-deck
  :vc (:url "https://github.com/offline-ant/phimacs" :rev "main"
       :lisp-dir "emacs/pi-deck")
  :commands pi-deck-mode)
```

Enable `M-x pi-deck-mode` and choose your own keys. For automatic deck persistence,
start your own private Emacs server **before** enabling deck; retain its stable
endpoint across restarts. The packages do not select the profile's theme, completion
framework or daemon policy. Without detached configuration, Pilish can be used in
its explicit standalone mode; missing pimux never triggers an automatic fallback.

Managed workers/panels additionally need `pi-orchestration` from
`:lisp-dir "packages/orchestration/emacs"`, the selected Pi extension and its
absolute task reader. Supply `:task-status-executable` to
`pilish-configure-runtime` only for that integration. Sound's companion is at
`:lisp-dir "packages/sound/emacs"`; neither companion is required for roots.

On the supported package-vc path, `:lisp-dir` scopes byte-compilation to that
package's subtree, not the monorepo. Pilish's local `.elpaignore` excludes its test,
script and benchmark sources. The literal offline installation fixture in
[development](development.md#installation-checks) verifies source revision,
bytecode origins and scope, and that pi-deck refuses a Pilish without its runtime.

## Local npm artifacts

The `@phimacs/*` packages are not published to a registry. Use the compiled
checkout paths above, or compile and pack the **whole selected dependency closure**
before installing artifacts. Orchestration needs the matching pimux tarball;
the general extension bundle also needs orchestration. Do not install one tarball
and let npm search a registry for unpublished internal dependencies.

```sh
# Network preparation: published host and its lock/cache, in this prefix only.
npm install --prefix "$trial/tools" --cache "$trial/npm-cache" --ignore-scripts \
  --save-exact --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.2
mkdir -p "$trial/packs" "$trial/npm-seed"
cp "$trial/tools/package.json" "$trial/tools/package-lock.json" "$trial/npm-seed/"
npm run compile --workspace=@phimacs/pimux
npm run compile --workspace=@phimacs/orchestration
npm pack --ignore-scripts --pack-destination "$trial/packs" \
  --workspace=@phimacs/pimux --workspace=@phimacs/orchestration
# Internal closure: both tarballs together, with all registry access disabled.
npm install --prefix "$trial/tools" --cache "$trial/npm-cache" --ignore-scripts \
  --legacy-peer-deps --offline --registry=http://127.0.0.1:9 \
  --replace-registry-host=never --no-audit --no-fund \
  "$trial/packs/phimacs-pimux-0.1.0.tgz" \
  "$trial/packs/phimacs-orchestration-0.1.0.tgz"
```

This uses one disposable prefix project, not another committed development graph.
The saved `npm-seed` contains only the public host's manifest/lock for isolated
installation checks. Keep that lock for the offline stage: a cache warmed against
npmjs does not supply metadata under a different registry URL. A fresh prefix
must first receive the same locked public dependency closure. An artifact check
must verify CLI and Pi extension loading away from checkout resolution. See
[installation checks](development.md#installation-checks) for the verification
lane; a pack dry-run alone does not establish an independent installation.
