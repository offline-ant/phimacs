# Tau

Experimental browser frontend for Phimacs. Start it with
[`phimacs service tau`](../../docs/install.md#tau-experimental). It is built
from this checkout and is not a separate npm release or Git download. See
[NOTICE.md](NOTICE.md) for licensing and the tracked upstream revisions.

## Development

Run these commands from a development worktree root, not an active deployment.

```sh
npm ci --ignore-scripts
npm run compile
npm run check
```

To exercise it without touching your sessions, run the sharing test. It launches
its own pimux, a real Pi with a faux provider, authenticated Tau, a second socket
client and a disposable Chromium profile. It closes a tab during a turn and also
restarts Tau without restarting the agent. It uses Playwright's Chromium or a
system Chromium. Set `CHROMIUM_BINARY` and pass it to `env -i` below if you need
a different executable.

```sh
trial_home=$(mktemp -d)
env -i HOME="$trial_home" TMPDIR="$trial_home" PATH=/usr/bin:/bin \
  node --import ./scripts/pi-test-imports.mjs --test packages/tau/test/e2e/pimux-share.e2e.ts
rmdir "$trial_home"
```

For an interactive trial, start a separate pimux in the [isolated trial
environment](../../docs/install.md#isolated-trial-environment). In another
terminal with those same selections, run `bin/phimacs --local service tau`.
Open `http://127.0.0.1:3001` on the host. The default settings require no
password on loopback.

## Network access

Tau uses `openssl` to create its local certificate authority and HTTPS
certificate. HTTPS is available at `https://127.0.0.1:3443` by default. For
access from a phone, set `TAU_HOST` to a trusted network or VPN address and supply
nonempty `TAU_USER` and `TAU_PASS` privately to Tau only. The network listener
is HTTPS; plain HTTP always stays on IPv4 loopback. A non-loopback bind and
the browser settings cannot disable authentication for a network listener.
Set `TAU_AUTH_ENABLED=true` to force and lock authentication even if Pi's
`settings.json` would disable it. Configured credentials enable authentication
by default, including on loopback. There is no built-in password. Trust the
public CA certificate at `PI_CODING_AGENT_DIR/tau/tls/ca.crt` on each device
(`~/.pi/agent/tau/tls/ca.crt` by default); do not copy the CA's private key.
Microphone access requires a secure origin.

Open the HTTPS address in the browser without a username or password in the
URL. If authentication is enabled, enter your credentials on the Tau sign-in
page. The form submits to `POST /login`; on success Tau sets a session cookie
and opens the app. API clients can still send HTTP Basic authentication in
the `Authorization` header. A default localhost setup still needs no password.

`TAU_PORT` and `TAU_HTTP_PORT` select exact ports (or use `--port` and
`--http-port`). An occupied port fails startup; use `0` only to request an
ephemeral port, such as in a test. Put runit definitions and credentials in
private deployment configuration, not this repository.

## Using Tau

The layout follows [pi-deck](../../emacs/pi-deck/README.md). The left sidebar lists
live pimux agents, from pimux's in-process discovery watch, by directory in creation
order, workers and panels under their parent and finished workers folded. A root
agent whose conversation was not running when Tau started (one another program
started since) is marked new until a browser shows it; a pimux restart reopening a
known conversation under a new id does not mark it again. The header counts blocked,
done, new and working agents and opens the next one needing attention: blocked, then
done, then new. A directory's `+` starts an agent there and
`+ New agent…` asks for another directory. History, at its foot, lists saved
sessions no agent runs, filtered by title; opening one resumes it as an agent, or
follows it read-only while another Pi owns it. Each browser shows one agent, named
in its URL (`#agent=<muxId>`). The header carries that agent's name and status,
model, context, session tree and a ⋯ menu for usage, HTML export, settings and
Close. Connection state appears only when not connected. On a phone the sidebar is
a drawer.

Use **+ New Group** to name a group and choose directories. Each directory
can belong to one group; choosing it again moves it. The group's slate band
folds its directories, while each status badge opens the newest matching agent
without unfolding it. A badge shows a number only when more than one agent
matches. Use **⋯** to rename the group, edit its members, or dissolve it.
Dissolving moves the directories back to the main list; it does not close
anything. Membership stays in this browser, even after the last agent in a
directory exits. It does not sync with Emacs, and folding is local to the tab.

Tau and Pilish are equal protocol-2 clients of agents owned by the separate
foreground `pimux serve` service. They never start that service: launches wait up
to ten seconds for readiness and report how to bring it up if unavailable.
Tau requests only root agents. Set `PHIMACS_SERVER_SOCKET` to the Phimacs launcher's
absolute Emacs socket to use the Emacs orchestration host for a new root's workers
and panels. Without it, new roots support chat without a host. Attaching to an
existing agent never changes its host. Tau itself is not an orchestration host.
Closing a view/server disconnects; Close/Stop Agent is identity-bound and global.
Managed Emacs panels appear under their creating Pi. Their Close button hides the
row immediately, then waits for the exact panel's native cleanup. A failure or
lost acknowledgement lists the panel again if it is still registered and shows
the error; Tau does not resend Close.
Each browser socket declares the live session it shows (`{"type":"view"}`); an
attached view no browser shows for 30 seconds is released (disconnected, never
stopped). An agent that finishes while no browser shows it is `done` until shown.
Service restart restores roots idle with fresh extensions, not workers or
interrupted execution. Existing Tau views resolve their service successor and
reattach with a new authoritative boundary; service absence retains an unavailable
view. An old process receipt alone cannot remove a root awaiting restoration.
Drafts are context-bound and stale input is quarantined, never retargeted/replayed.

## Dictation runtime

Wait for **Listening** before speaking. Tau does not send or queue audio
while preparing the speech backend. Tap the microphone again to cancel
preparation or, once listening, to finish the transcript.

Each recording runs the same `@phimacs/sound` dictation as Emacs, with the
`voice.json` settings described in the [sound README](../sound/README.md):
ending with the send word (default "send") or pausing after speech stops the
recording and submits the transcript; ending with the clear word (default
"clear stop") discards it. In send mode a hand-stopped transcript is submitted
too. Tau inserts the text in `dictatedFormat` (default `(dictated) %s`) and
submits it once through the composer; when the agent cannot take input the
text stays in the composer.

Tau reads Pi's `voice.json` for each new microphone connection and uses the
built-in transcription backends by default. A deployment can supply other
backends with a private Node ESM entrypoint: import `startCli` from the compiled
`packages/tau/bin/tau.js` and call `startCli(runtime)` with its
[`@phimacs/sound` runtime](../sound/README.md#explicit-composition). Run that entrypoint
in place of the usual foreground command. Tau does not discover backends from Pi
extensions or fall back when the selected backend is unavailable.

## Upstream maintenance

Take upstream fixes selectively and record the reviewed revision and ported
commits in [NOTICE.md](NOTICE.md). Keep the
[service-owned runtime lifecycle](../../docs/lifecycle.md): upstream owns a Pi
per tab, while Phimacs Tau attaches to pimux-owned agents. Do not import its
session manager. Develop the runnable copy here; use a separate fork only
when preparing an upstream contribution.
