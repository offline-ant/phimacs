# Phimacs

An Emacs workspace for Pi agents: Pilish chat, pi-deck project spaces and a
persistent pimux runtime. Managed workers, browser tools and sound are optional.

Use the same packages in any of three ways:

- **Keep your Emacs configuration:** install the packages you want with
  `use-package :vc`; no profile theme, completion stack or key scheme is required.
- **Try the complete profile:** run `phimacs`. It starts or attaches the pimux
  service and a dedicated Emacs daemon, then opens a terminal frame (`--gui` for a
  graphical one). `emacs --init-directory=…/emacs/config` also works. The profile
  does not replace `~/.emacs.d`.
- **Use plain `pi` in Herdr or tmux, without Emacs:** workers, panels and the
  general extensions, with Node 24+ and Pi on PATH:

  ```sh
  git clone https://github.com/offline-ant/phimacs
  phimacs/bin/phimacs setup pi
  pi
  ```

  [Pi in Herdr or tmux](docs/install.md#pi-in-herdr-or-tmux-without-emacs) covers
  options, updates and moving from `pi-ant` or `pi-browser`.

[Installation](docs/install.md) owns the ordered setup: clone and compile, provider
login, `phimacs setup` once for pinned packages and native assets, then `phimacs`.
Normal startup installs nothing. Other machines run the same command over SSH and
can share their microphone, speaker and notifications. Closing Emacs disconnects
views; explicit agent Close stops the agent everywhere. See the
[runtime lifecycle](docs/lifecycle.md).

The detached workspace targets Linux, Node 24+ and Emacs 31.1+ with tree-sitter
and native modules. The tested Pi host/SDK baseline is 1.5.2. Checks pass on
Emacs 31.1 and 32.0.50; [development](docs/development.md#emacs-build-selection-and-qualification)
lists the lanes.

A two-minute [terminal showcase](docs/demo/README.md) shows the complete profile
with real models: `phimacs setup` and `phimacs`, a root agent delegating to a
worker, quitting Emacs while the agent keeps running, reopening the same agent and
draft from another machine over SSH, and explicit Close.

One repository contains the maintained Pilish fork, reusable packages and optional
profile. Pilish remains GPL-3.0-or-later; other code and assets keep their licenses.
Private providers, account/device policy, credentials and personal settings are
not part of this product.

- [Development and focused checks](docs/development.md)
- [Architecture](docs/architecture.md)
- [Runtime protocol](docs/runtime-contract.md)
- [Pilish upstream maintenance](docs/pilish-upstream.md)
- [Dependency security](docs/dependency-security.md)
- [Third-party sources and licensing](provenance/README.md)
