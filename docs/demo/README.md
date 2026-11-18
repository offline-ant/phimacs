# Demo

[phimacs.gif](phimacs.gif) shows Phimacs in a terminal, with real models.
[phimacs.cast](phimacs.cast) is the same demo as an asciinema recording:

```sh
asciinema play docs/demo/phimacs.cast
```

It shows:

1. Emacs is open with two project spaces, `stats` and `notes`.
2. In `stats`, two tests fail. The agent gives each fix to its own worker, and
   both workers run at the same time. The sidebar shows them under the agent.
3. In `notes`, a second agent answers a short question.
4. Back in `stats`, the workers finish. The agent checks the changes and
   confirms that all tests pass.

The agents use `openai-codex/gpt-6.2-astra`, a standard Pi provider. You can
choose another model in Pi; its answers may differ.

The GIF was made with [agg](https://github.com/asciinema/agg):

```sh
agg --text-font-family "DejaVu Sans Mono,Noto Sans Symbols,Noto Sans Symbols 2,FreeMono" \
  --font-size 14 --theme github-dark --speed 1.5 --fps-cap 15 \
  --last-frame-duration 5 docs/demo/phimacs.cast docs/demo/phimacs.gif
```
