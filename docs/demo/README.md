# Terminal showcase

[phimacs.cast](phimacs.cast) is an asciinema recording (about two minutes) of the
complete profile in a terminal, with real model inference.
[phimacs.gif](phimacs.gif) is the same recording at 1.25× speed, with pauses
shortened to two seconds, for the README. Replay the recording with:

```sh
asciinema play docs/demo/phimacs.cast
```

The GIF was made with [agg](https://github.com/asciinema/agg) 1.9.0:

```sh
agg --text-font-family "DejaVu Sans Mono,Noto Sans Symbols,Noto Sans Symbols 2,FreeMono" \
  --font-size 14 --theme github-dark --speed 1.25 --fps-cap 15 \
  --idle-time-limit 2 --last-frame-duration 5 docs/demo/phimacs.cast docs/demo/phimacs.gif
```

It shows:

1. A tiny Git project with a failing test, then the Pi, Emacs and Node versions.
2. `phimacs setup` run again: it is idempotent and takes a few seconds once the
   first, networked run has prepared the state.
3. `phimacs --no-frame` starts the pimux service and the Emacs daemon and says
   that agents outlive Emacs; `phimacs status` shows both, and `phimacs` opens a
   terminal frame.
4. A new deck space starts a root agent. It delegates the fix to a worker on the
   alternate model; the sidebar shows the worker running under its root. The
   worker's result is shown collapsed, as text with its details folded away, and
   the root checks the diff and replies.
5. The worker's read-only transcript opens from the sidebar. An unsent draft is
   left in the input, then Emacs quits entirely. `phimacs status` shows the agent
   idle in the service, without Emacs.
6. A second shell plays another machine, the "laptop": it has only the standalone
   client and `PHIMACS_HOST=pc`. `phimacs` there starts the Emacs daemon on the
   host and opens a frame with the same agent, its history and the draft. Nothing
   is replayed.
7. Explicit Close stops the agent; `phimacs stop` saves and quits Emacs and stops
   the service. Back on the host, the test passes.

Recorded on 2026-11-17 with Pi 1.5.2, Emacs 31.1 (a PGTK build running as a
daemon without a display) and Node 24.22.1, after following the
[installation guide](../install.md) in a fresh trial environment. The slow first
`phimacs setup` ran before the recording. Paid inference:

- Root: `claude-agent/claude-opus-5-5`, from a **private** Claude Agent SDK
  provider that is not part of Phimacs and is not shipped.
- Worker: `openai-codex/gpt-6.1-sol`, a stock Pi provider. It is the
  orchestration alternate model (`/delegate-alt`, see the
  [orchestration README](../../packages/orchestration/README.md)).

Any pair of logged-in models works the same way. The "pc" and the "laptop" are
two shells on one machine; the laptop reaches the host through a local sshd under
the SSH alias `pc`, as [other devices](../install.md#other-devices) describes.
Paths are neutral trial directories. The recording contains no credentials or
personal settings. A script typed the keystrokes; the recording driver is not
part of the repository.
