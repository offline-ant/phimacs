# Demo

[phimacs.gif](phimacs.gif) shows Phimacs in a terminal, with real models.
[phimacs.cast](phimacs.cast) is the same demo as an asciinema recording:

```sh
asciinema play docs/demo/phimacs.cast
```

It shows:

1. A new space in Emacs starts an agent for a small project with a failing test.
2. The agent gives the fix to a worker on a second model. The sidebar shows the
   worker under its agent. The agent checks the worker's change and replies.
3. You type a next message but do not send it. Emacs quits. `phimacs status` shows that the agent still runs.
4. A second machine runs `phimacs` over SSH. It opens the same agent, with its
   history and the unsent text in the input.

The agent uses Claude Opus 5.5 through a private provider that is not part of
Phimacs. The worker uses GPT-6.1 Sol, a standard Pi provider. Any two models
that you are logged in to work the same way. Both machines are shells on one
computer, connected through SSH.

The GIF was made with [agg](https://github.com/asciinema/agg):

```sh
agg --text-font-family "DejaVu Sans Mono,Noto Sans Symbols,Noto Sans Symbols 2,FreeMono" \
  --font-size 14 --theme github-dark --speed 1.5 --fps-cap 15 \
  --last-frame-duration 2 docs/demo/phimacs.cast docs/demo/phimacs.gif
```
