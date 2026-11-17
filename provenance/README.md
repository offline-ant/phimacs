# Source provenance and licensing

Imports are reviewed snapshots, not merged histories. Phimacs maintains the
selected source after import. One repository does not imply one license.

| Source | Revision | License | Destination |
|---|---|---|---|
| https://github.com/offline-ant/pi-ant | `56e781d93c652efc535c3ca464dafa9d546a0e52` | MIT | `packages/extensions`, `packages/orchestration`, `packages/pimux` |
| https://github.com/offline-ant/pi-deck | `4adbaea5778e1f75c96c2f08db0722da67f7b176` | MIT | `emacs/pi-deck` |
| https://github.com/offline-ant/pi-browser | `084a3da9b9a817ab7d4b5ec165c6ebe7a0e77033` | MIT | `packages/browser` |
| pi-sound | `2a2d29b2e04dedb2ec304e689f8ed1066f8f03b2` | MIT | `packages/sound`; [details](../packages/sound/PROVENANCE.md) |
| https://github.com/offline-ant/pilish, upstream https://github.com/dnouri/pilish | `b3fc14f969faa363bf8dbcd3b7bcf36486470acf` | GPL-3.0-or-later | `emacs/pilish`; [import manifest](pilish-import.json) |
| https://github.com/disler/self-compact-pi-agent | idea only | MIT | `packages/extensions/extensions/self-compact.ts` |
| Herdr notification sounds | see `packages/sound/sounds/NOTICE` | Apache-2.0 | `packages/sound/sounds/` |

The Pilish manifest owns its original fork/upstream base and source-selection
rules. [Pilish's modified-version notice](../emacs/pilish/NOTICE.md) identifies the
maintained changes and their dated notice. [Pilish maintenance](../docs/pilish-upstream.md)
owns upstream update and contribution procedures. The old public fork remains an unarchived contribution
vehicle for open PRs, not a second maintained product source after cutover.

Package-local attribution remains in [pimux's notice](../packages/pimux/NOTICE.md),
[sound provenance](../packages/sound/PROVENANCE.md) and its asset NOTICE/license.
The independently authored current navigation implementation's input record is
[tree navigation](tree-navigation.md). Neither a replacement nor relocation of a
README entry is legal clearance for historical imported material.

Root MIT covers applicable original tooling, not third-party relicensing. Preserve
Pilish's GPL, original source headers, modified-source notices and all other grants
in actual distributions. Review corresponding-source obligations before shipping
bytecode/native artifacts. The profile fetches third-party packages, Ghostel's
module and Markdown grammars from their own repositories during preparation; these
retain their own grants. They are not relicensed by the MIT profile.

## Public history

The public repository starts from one reviewed snapshot, tagged `v0.1.0`. Earlier
development history, which also contained Tau and the replaced navigation
extension, is not public. Original Phimacs work names `offline-ant` as copyright
holder; imported third-party notices keep their own holders. Review each later
release's exact tree for permissions, notices, source obligations and secrets;
any upstream license grant must cover the revision actually redistributed.
Passing tests are not an audit.

A 2026-11-16 pre-publication audit scanned this tree, the earlier development
history and the imported Pilish fork range with gitleaks 8.28.0
and trufflehog 3.90.8 (no verification calls), plus targeted private-data searches.
Its findings were test fixtures, public commit IDs and the RFC 6455 sample key.
No live credential appeared. Every locked npm dependency declares an MIT, ISC,
Apache-2.0, BSD, BlueOak-1.0.0, Unlicense or 0BSD license. The pinned Emacs
packages are GPL-3.0 except the MIT Dracula theme. None of them, nor Ghostel's
module or the Markdown grammars, are redistributed here. The earlier history
contains Tau-derived code under `packages/tau/` and the replaced navigation
extension. Its upstreams declare MIT, but one supplies no license file. This is
an engineering record, not legal clearance. On 2026-11-17 the same scanners
checked the exact `v0.1.0` tree again: gitleaks found nothing; trufflehog's seven
unverified matches were test-fixture URL credentials on example and loopback hosts
and one pinned package commit hash.

Never store credentials, private settings, profiles, sessions, recovery exports,
device policy or runtime state here. Review the chosen source/history/artifact
surface for them; `.gitignore` and filename searches are not a security clearance.
