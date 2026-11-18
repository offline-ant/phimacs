# Phimacs

> **Why this exists:** For a long time I used [Herdr](https://herdr.dev), a
> terminal workspace for coding agents. When Emacs turned 50, I went back to
> Emacs and rebuilt, as Emacs packages, the Herdr features that I use. I
> [mentioned this on Hacker News](https://news.ycombinator.com/item?id=50298436#50300314),
> and people asked me to publish it. So I put the tools that I wrote over the
> past year into this one repository, to make my setup easy to try.
>
> AI agents wrote all of this code; I wrote none of it by hand. I added each
> part when I needed it, to solve a problem that I had.

Phimacs is my opinionated setup for [Pi](https://github.com/earendil-works/pi-mono)
coding agents in Emacs, inspired by Herdr. It uses
[Pilish](https://github.com/dnouri/pilish) for the Pi chat in Emacs and adds
the parts around it.

[![Phimacs demo](docs/demo/phimacs.gif)](docs/demo/README.md)

## What it adds

- **Project spaces.** Each project has its own space with its own window
  layout. A sidebar lists all agents and shows which ones need you.
- **Agents that keep running.** A background service, pimux, runs the agents.
  Closing Emacs or losing an SSH connection does not stop them. Only the Close
  command stops an agent. When the service starts again, for example after a
  reboot, your agents come back idle with their conversations. Unfinished work
  and workers do not come back.
- **Workers and terminals.** An agent can give a task to a helper agent, a
  "worker", and get the result back. It can run servers and long commands in
  terminals that you can see and use too.
- **Dictation (optional).** Speak into the chat input or any Emacs buffer: click
  the 🎤 button or press a key. It needs a speech-to-text server.

## Agent tools

Phimacs adds these tools to Pi. Each package's README explains its tools.

| Package | Tools | Complete Emacs setup | Plain `pi` |
|---|---|---|---|
| [orchestration](packages/orchestration/README.md) | `do`, `microdo`, `delegate`: give a task to a worker. `panel-start`, `panel-read`, `panel-send`, `panel-close`: terminals for the agent. `wait`: wait for output or a process. | on | on |
| [extensions](packages/extensions/README.md) | `ask`: ask you a question. `py`: run a short Python script. `prompt_history`, `self_compact`, `/tools` to turn tools on and off, and safety checks for shell commands. | [add it](docs/install.md#log-in-and-set-up) | on |
| [browser](packages/browser/README.md) | `browser`, `web_search`, `web_fetch`, `web_read`: use a browser, search and read web pages. | [add it](docs/install.md#log-in-and-set-up) | with `--browser` |
| [sound](packages/sound/README.md) | `/dictate` and Alt+V (the 🎤 button in Emacs), `/speak`. | [add it](docs/install.md#share-the-devices-microphone-speaker-and-notifications) and set up a speech server | with `--sound`, then set up a speech server |

A worker can also run on a second model: choose the model pair with
`/delegate-alt`. `fresh_look`, a worker without any context, is off until you
turn it on in `/tools`.

## Status

Early: version 0.1.0. I use it every day, but expect rough edges. It runs on
Linux only and is tested with Pi 1.5.2. Use the `main` branch.

## Get started

**With a coding agent:** point it at the [installation guide](docs/install.md).

**Without Emacs:** the agent tools also work in plain `pi` in Herdr or tmux; see
[Pi in Herdr or tmux](docs/install.md#pi-in-herdr-or-tmux-without-emacs).

### Complete Emacs setup

You need Linux, Git, a C compiler, Node 24 or newer, and Emacs 31.1 or newer
built with tree-sitter and module support.

```sh
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.2  # if you do not have Pi
git clone https://github.com/offline-ant/phimacs
cd phimacs
npm ci --ignore-scripts
npm run compile
ln -s "$PWD/bin/phimacs" ~/.local/bin/phimacs
pi                # log in with /login, choose a model with /model, then exit
phimacs setup     # once: installs Emacs packages and compiled helpers
phimacs           # opens Emacs in this terminal; add --gui for a window
```

Phimacs uses its own Emacs daemon and does not change `~/.emacs.d`. The
[installation guide](docs/install.md) explains each step and how to connect
from other computers.

### Your own Emacs configuration

Install only the packages that you want with `use-package :vc`. You do not need
the theme, completion or keys of the complete setup. See
[existing Emacs configuration](docs/install.md#existing-emacs-configuration).

## How the parts fit together

```mermaid
flowchart LR
  emacs["Emacs<br/>chats, spaces, terminals"] --> pimux["pimux<br/>keeps agents running"]
  pimux --> agents["Pi agents<br/>with Phimacs tools"]
  agents --> models["Model providers"]
```

pimux runs the agents, and Emacs only shows them. You can also open Emacs from
another computer over SSH; see the [installation guide](docs/install.md#other-devices).

## License

Phimacs's own code is MIT. The Pilish chat package in `emacs/pilish/` is a fork
of [Pilish](https://github.com/dnouri/pilish) and stays GPL-3.0-or-later.
Third-party files keep their own licenses; see
[third-party sources](provenance/README.md). Phimacs does not include my private
model providers, accounts, credentials or personal settings.

## Documentation

Using Phimacs:

- [Installation](docs/install.md)
- [Demo](docs/demo/README.md)

Contributing:

- [Development and focused checks](docs/development.md)
- [Architecture](docs/architecture.md)
- [Runtime lifecycle](docs/lifecycle.md)
- [Runtime protocol](docs/runtime-contract.md)
- [Pilish upstream maintenance](docs/pilish-upstream.md)
- [Dependency security](docs/dependency-security.md)
