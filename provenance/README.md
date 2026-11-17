# Third-party sources and licensing

The root MIT license covers Phimacs's own source. It does not relicense
third-party material, which keeps its own grant:

| Source | License | Destination |
|---|---|---|
| [Pilish](https://github.com/dnouri/pilish) | GPL-3.0-or-later | `emacs/pilish`; [notice](../emacs/pilish/NOTICE.md), [import manifest](pilish-import.json) |
| [self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (idea only) | MIT | `packages/extensions/extensions/self-compact.ts` |
| [Herdr](https://github.com/herdrdev/herdr) notification sounds | Apache-2.0 | `packages/sound/sounds/`; [NOTICE](../packages/sound/sounds/NOTICE) |

Phimacs maintains a modified version of Pilish. Preserve its LICENSE, source
headers and dated modified-version notice in every distribution, including
bytecode and native artifacts. [Pilish maintenance](../docs/pilish-upstream.md)
owns upstream updates and contributions.

The profile fetches third-party Emacs packages, Ghostel's module and Markdown
grammars from their own repositories during preparation. They keep their own
grants and are not redistributed here.

Never store credentials, private settings, sessions or other private state in
this repository.
