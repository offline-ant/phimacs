# Demos

## Space groups

[Watch the GIF](space-groups.gif) or replay the terminal recording:

```sh
asciinema play docs/demo/space-groups.cast
```

An agent checks trail opening times in `trail-data` while the guide is open in
`field-guide`. Use **+ New Group** to put both spaces in **Trail Map**, then
fold the group. When the agent finishes, click the result dot on the right of
its band: the answer opens without unfolding the group. The recording also
shows the group's auto-clear menu and the guide with the opening time added.

The recording uses the compiled deck and Pilish with a local scripted provider
and sample trail data. See [Space groups](../../emacs/pi-deck/README.md#space-groups)
for the controls.

## Parallel workers

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

## Render the GIFs

From the repository root, with [agg](https://github.com/asciinema/agg):

```sh
agg --text-font-family "DejaVu Sans Mono,Noto Sans Symbols,Noto Sans Symbols 2,FreeMono" \
  --font-size 15 --theme github-dark --speed 1 --last-frame-duration 3 \
  docs/demo/space-groups.cast docs/demo/space-groups.gif

agg --text-font-family "DejaVu Sans Mono,Noto Sans Symbols,Noto Sans Symbols 2,FreeMono" \
  --font-size 14 --theme github-dark --speed 1.5 --fps-cap 15 \
  --last-frame-duration 5 docs/demo/phimacs.cast docs/demo/phimacs.gif
```
