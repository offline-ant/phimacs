# Demo

[phimacs.gif](phimacs.gif) shows Phimacs in a terminal, with real models.
Replay the recording with `asciinema play docs/demo/phimacs.cast`.

1. Emacs is open with two project spaces, `stats` and `notes`.
2. In `stats`, two tests fail. The agent gives each fix to its own worker. Both
   workers run at the same time, under the agent in the sidebar.
3. In `notes`, a second agent answers a short question.
4. Back in `stats`, the workers are done. The agent checks the diff and
   confirms that all tests pass.

The agents use Codex (GPT-6.2), a standard Pi provider. Any model that you are
logged in to works.

Render the GIF with [agg](https://github.com/asciinema/agg):

```sh
agg --text-font-family "DejaVu Sans Mono,Noto Sans Symbols,Noto Sans Symbols 2,FreeMono" \
  --font-size 14 --theme github-dark --speed 1.5 --fps-cap 15 \
  --last-frame-duration 5 docs/demo/phimacs.cast docs/demo/phimacs.gif
```
