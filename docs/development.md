# Development

One root `package.json` and `package-lock.json` own the npm graph and supported Pi
SDK. Exact root requirements/overrides select one physical SDK/typebox identity;
Pi-host peers stay `*`. Do not add package-local locks, vendored npm archives or
another development installer. Pilish is ordinary source at `emacs/pilish/`.

```sh
npm ci --ignore-scripts
npm run compile --workspace=@phimacs/pimux
npm run check --workspace=@phimacs/pimux
node scripts/test.mjs packages/pimux/host.test.ts
```

Compile prerequisites first when a package uses their generated declarations.
A package compile builds into a hidden sibling directory and replaces `dist/` by
two renames only after success; a failed or interrupted compile keeps the previous
`dist/`. Post-build files use `scripts/compile-package.mjs`'s `--copy` and
`--executable` options so they are in place before the swap.
Package tsconfigs share the root config; root compile/check visit workspaces in
manifest order. Root commands are conveniences, not substitutes for focused
package checks. Package READMEs own those checks. Emacs-only edits need no unrelated
browser/sound build or product-wide acceptance run.

## Checkout safety

The `phimacs` service and Emacs daemon run directly from their checkout and load
Lisp lazily. Removing source, hydrating npm after workspace changes, recompiling
`dist/` or preparing bytecode there can affect new agents and supervised recovery
without an explicit restart.

Develop and verify changes in a separate worktree, not the checkout your running
Phimacs uses. Update that checkout only when you mean to restart its services,
and keep its journals, sessions and recovery inputs. A pinned worktree that you
switch to at a restart works too. Never use your running Emacs daemon, browser
profile, package/native cache or runtime registry for tests.
[Lifecycle](lifecycle.md) owns runtime guarantees.

Run checks from a clean environment, for example `env -i HOME="$HOME"
PATH=/usr/bin:/bin`, when your shell belongs to a running Phimacs: its
`PHIMACS_*`, `PIMUX_*` and `PI_*` variables select live state, and some harnesses
pass the caller's environment to their children.

## Pi updates

```sh
npm run update:pi -- EXACT_VERSION
npm install --ignore-scripts
npm run compile
npm run check
```

Review upstream API/dependency changes against Pilish, generic extensions and
private adapters; run affected faux regressions. Agents use the selected published
Pi, not the SDK executable under checkout `node_modules/.bin`. Record the exact
host version checked with each root pin. The current baseline is 1.5.2 for both.
The launcher's major/minor warning is not proof that another version is supported.

When agents are idle, install the published host
`@earendil-works/pi-coding-agent@EXACT_VERSION` separately, with scripts disabled.
Updating only the host is incomplete; running agents retain their startup version.
Checks instead use an explicit disposable npm prefix, not your global prefix.
Changing HOME alone does not isolate npm installation.

## Emacs preparation and focused checks

Prepare one new private test state directory explicitly with the preparation
step of `phimacs setup`. It creates a missing directory with mode 0700 and refuses
an existing one with group/other access; create it yourself only with
`mkdir -m 700` or under `umask 077`:

```sh
node scripts/emacs-packages.mjs --state /absolute/test-state
export PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs
```

The shared declaration file pins third-party packages. Preparation uses their
installers for Ghostel's module and both essential Markdown grammars, then
byte-compiles checkout Lisp, including available optional companion sources.
Preparation inventories source independently of runtime feature selection and does
not load personal overrides. Bytecode is written next to checkout sources, so
preparation is also subject to [checkout safety](#checkout-safety). Normal startup
and test activation do no installation. Prepare changed pins into new state;
never delete or reuse your own package cache to make a check pass.

Tests activate prepared third-party dependencies but load Pilish, deck and selected
companions from this checkout. They do not select a sibling Pilish clone.
Use synthetic session/claim roots, private state/server/discovery namespaces and
faux inference. [Installation](install.md#isolated-trial-environment) owns the full
selection boundary, including pimux's durable journal; a private socket alone is
not isolation.

```sh
node --test test/runtime.test.mjs test/reference-config.test.mjs
node --test test/reference-launcher.test.mjs test/reference-profile.test.mjs
node scripts/emacs-deck-tests.mjs --preflight
node scripts/emacs-deck-tests.mjs --reference
```

The launcher has two suites. `test/launcher.test.mjs` covers the Bash script's
remote dispatch and argument quoting through real sh, bash and fish, atomic
client installation and device sharing, with recording `ssh`, `socat` and `sv`
stand-ins and real Unix sockets. `test/launcher-service.test.mjs` starts real
pimux services in a disposable namespace: start or attach, a concurrent start,
refused endpoints (no owner, no answer, rootless, other checkout or state), a
supervised service, stop refusal, input gating, resume of a lost drain reply and
`--force`, and preflight before pimux starts. Its real-Emacs tests (concurrent
launches, unsaved edits blocking stop, `service emacs` keeping the supervisor's
display) need `PHIMACS_TEST_EMACS_DIR`, and an Emacs build that runs a daemon
without a display (see below):

```sh
node --test test/launcher.test.mjs
EMACS=/absolute/emacs-31.1/bin/emacs PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node --test test/launcher-service.test.mjs
```

The opt-in `PHIMACS_SSH_SHARE=1` lane in the
[integration guide](../test/integration/README.md) shares a device through a
disposable user-level sshd with real ssh and socat. No test uses a real audio
device or runit supervisor.

Select affected deck suites/compilation as its [guide](../emacs/pi-deck/AGENTS.md)
says. For focused Pilish suites, create a private native cache and use the prepared
packages/grammars, never its former independent network installer:

```sh
mkdir -m 700 /absolute/test-state/pilish-cache
make -C emacs/pilish PILISH_TEST_CACHE_DIR=/absolute/test-state/pilish-cache \
  test-runtime test-drafts test-session-api
```

The same root runner runs the orchestration companion's ERT suites and Pilish's
real Pi/faux native lane; the native lane needs compiled orchestration,
`PHIMACS_PI` and Xvfb:

```sh
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs node scripts/emacs-deck-tests.mjs --orchestration
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs PHIMACS_PI=/absolute/selected/pi \
  node scripts/emacs-deck-tests.mjs --pilish-native
```

[The Pilish guide](../emacs/pilish/AGENTS.md) owns selectors and additional lanes.
Its declared standalone Emacs minimum is distinct from the complete profile's
31.1+ requirement. No root CI framework is implied by local commands.

### Emacs build selection and qualification

Each harness runs one Emacs build: `EMACS` (a path or a name on PATH), else `emacs`
on the caller's PATH. `EMACSCLIENT` defaults to the client beside it. Fixtures with
a restricted PATH put that build's directory first, so nested `emacs`/`emacsclient`
calls run the same build (`selectedEmacs` in `scripts/emacs-packages.mjs`). The
Pilish Makefile uses the same `EMACS` variable. To qualify another build, put its
`bin/` first on PATH and prepare a fresh state with `--emacs` set to that build.
Preparation rewrites checkout bytecode with the preparing build.

Emacs **31.1** (GNU release tarball, signature verified, PGTK with native
compilation, tree-sitter and modules) passed in a clean environment: preparation
and launcher preflight; profile, launcher and literal `:vc` installation tests;
GUI/TTY startup and display lanes; deck default, reference and compile lanes;
deck native and smoke lanes, minimal and managed; the Pilish build, runtime,
drafts, session API, grammar, fake-integration and storage lanes; orchestration
panel, contextual and Emacs-switch native lanes; and the sharing lane. A private
native compilation of all checkout package sources reported no warnings. The same
lanes pass on **32.0.50**. On both builds the UI deck suite passes and
the full Pilish unit suite (`make test`) passes with 0 unexpected results: 3039 of
3047 tests with prepared inputs, where tests that need the optional json/html/python
grammars skip; 3044 when those grammars are added to `GRAMMAR_DIR` as the
[Pilish guide](../emacs/pilish/AGENTS.md) describes. Other automated TTY journeys
create an owned display frame. The release Emacs 31.1 build runs the profile
daemon without any display, as `phimacs` starts it. The tested 32.0.50 PGTK
snapshot starts such a daemon, but every client evaluation fails with "Frames are
not in use or not initialized", even for a bare `emacs -Q --fg-daemon`. The two
real-daemon launcher tests probe the selected build that way and skip with that
proof; any other probe result runs them.

## Installation checks

Physically absent means unreachable through package directories, Lisp load paths,
PATH and module resolution—not a disabled flag in a populated checkout. Installed
checks stage only selected source/artifacts, use synthetic providers, and verify
actual public boundaries. Skipped/environment-blocked lanes are unverified.

Literal existing-configuration installation:

```sh
PHIMACS_TEST_EMACS_DIR=/absolute/test-state/emacs \
  node --test test/install/existing-config.test.mjs
```

The fixture copies this checkout's Lisp into a disposable local Git snapshot, commits
only that fixture, and installs with literal `use-package :vc` forms from its
`file://` URL at the exact snapshot revision. It changes no product commit/ref.
Third-party dependencies are preprovided; archives are empty, URL retrieval is
forbidden and Git allows only the file protocol. Assertions cover maintained
Pilish before deck, compiled/library origins, package-vc `:lisp-dir` scoping,
Pilish `.elpaignore`, a competing date-versioned archive descriptor and that
pi-deck refuses to load against a Pilish without `pilish-runtime`. It does not certify a
remote release URL or run model inference.

Installed npm closure checks use a separately prepared disposable npm cache:

```sh
PHIMACS_INSTALL=1 PHIMACS_TEST_NPM_CACHE=/absolute/disposable-npm-cache \
  PHIMACS_TEST_NPM_SEED=/absolute/stock-pi-seed \
  node --test --test-concurrency=1 test/install/closure.test.mjs
```

This is an explicit long lane; allow six minutes for its two bounded cases.
Prepare the cache and public-host-only seed manifest/lock before the offline run;
the [artifact recipe](install.md#local-npm-artifacts) gives commands. The seed uses
an exact Pi requirement and contains no internal package dependencies. npm metadata
cache keys include the registry URL, so a normally warmed cache alone cannot serve
host-name lookup at an unreachable registry. The fixture stages the seed lock in
its new prefix without copying node_modules, compiles/packs selected packages, and
installs matching local tarballs together using `--offline`, an unreachable
registry and unchanged resolved registry URLs. It checks real installed
CLI/extension loading, no checkout links or nested host SDKs, absent optional
packages, synthetic prompt and owned cleanup. A pack dry-run alone is not that evidence.

`phimacs setup pi` runs in a fresh clone of this checkout, including its uncommitted
changes, with a disposable `HOME` and `PI_CODING_AGENT_DIR` and the installed `pi`:

```sh
node --test test/pi-packages.test.mjs test/install/setup-pi.test.mjs
PHIMACS_SETUP_PI=1 node --test test/install/setup-pi.test.mjs
```

The default run checks the refusals before any build. The explicit long lane
(allow ten minutes; it runs `npm ci` three times, from the caller's npm cache
or `PHIMACS_TEST_NPM_CACHE`, preferring cached packages) checks registration,
an unchanged rerun, `--browser --sound`, the loaded commands from Pi's RPC mode,
no sound configuration, and the printed uninstall commands.

## Native integration lanes

Select deliberately and use only prepared inputs and fixture-owned services,
displays, endpoints and state. These are explicit bounded long-test exceptions;
keep them out of ordinary focused commands. Sharing allows ten minutes:

```sh
PHIMACS_SHARING=1 PHIMACS_TEST_XVFB=/usr/bin/Xvfb \
  node --test --test-concurrency=1 test/integration/sharing.test.mjs
```

The retained sharing lane must cover two managed clients, zero-client survival,
drafts, reconnect, identity-bound peer Close and one idle successor after service
restart, without a second browser frontend. A fixture must start/wait/clean up its
own pimux service; frontends never gain an autostart policy for test convenience.
[Integration documentation](../test/integration/README.md) owns the other native
flags and acquired inputs. Profile startup/display lanes are documented in the
[profile README](../emacs/config/README.md). Their synthetic/startup coverage is
not evidence of real provider or native runtime behavior.

Ordinary tests finish within 20 seconds; ordinary commands time out within 60.
Use readiness/events, not fixed sleeps. Real-provider demonstrations use paid
inference: run them deliberately and record them as separate evidence. Never
substitute paid inference or a full suite for a focused failing boundary.

## npm packages

Publishable package source lives under `packages/`; registry publication is a
separate release step. Exact internal dependencies identify one compatible release.
Pi extensions first load their uncompiled `host-modules.ts` entry, then compiled
extensions, sharing Pi's actual SDK through pimux's host-module bridge. Keep its
imports and peer declarations in step; process-global registries hold shared state.

`.npmrc` disables lifecycle scripts, so a `prepack` declaration does **not** prove
fresh output. Explicitly compile each selected package/prerequisite before
`npm pack --ignore-scripts`. Inspect exports, executables, assets, required license
and NOTICE files in the resulting artifact. Use the tested dependency-closure
installation, not a registry lookup for an unpublished `@phimacs/*` dependency.

## Upstream and publication

[Pilish maintenance](pilish-upstream.md) owns its recorded base/import selection,
directory updates and export of reviewed changes to upstream PRs. The public fork
remains an unarchived contribution vehicle; do not freeze open PR branches or
maintain a second patched product tree. Keep useful owning package test structure.

[Third-party sources](../provenance/README.md) lists incorporated third-party
material and its licenses. Review each release's exact tree for license notices, source obligations
and secrets. No local test result certifies license clearance or secret scanning.
