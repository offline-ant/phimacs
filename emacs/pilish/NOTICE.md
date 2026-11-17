# Pilish: maintained Phimacs modified version

**Modified-version notice — 2026-11-16.** Phimacs maintains this modified version
of Pilish. It is not an unmodified release from the upstream Pilish project.
This notice describes the maintained source as of that date; it does not assign
new dates or authorship to pre-existing fork changes.

## Source and license

- Upstream: https://github.com/dnouri/pilish, incorporated base
  `5a83d26a44fc87cf54b52b2f9d80806964dd5634`.
- Imported fork: https://github.com/offline-ant/pilish, source revision
  `b3fc14f969faa363bf8dbcd3b7bcf36486470acf`.
- This Pilish package is released under **GPL-3.0-or-later**. See [LICENSE](LICENSE)
  for the GNU General Public License. Original copyright, authorship, upstream
  identity and license notices remain in the source; this notice does not
  replace them or relicense Pilish under the repository's MIT license.

The repository's [import manifest](../../provenance/pilish-import.json) records
immutable import metadata and the current incorporated upstream revision.
[Upstream maintenance](../../docs/pilish-upstream.md) describes subsequent updates
and contributions. Preserve this notice, the README notice and LICENSE with the
Pilish source in source archives and VC installations.

## Changes already present in the imported fork

The imported fork revision already differs from its upstream base. Its changes
include detached protocol-2 pimux transport and runtime controls; worker-task
completion evidence; desktop state and context-bound draft recovery; managed
storage integration; inline extension dialogs, chat styling, window pairing,
queue/widget display and additional session APIs. These are pre-existing fork
changes, not features newly authored by the monorepo incorporation. Their
historical dates and attribution remain with the recorded source history.

## Phimacs incorporation and maintenance changes

The maintained source additionally incorporates Pilish into `emacs/pilish/` and
adapts package documentation, source paths and build/test entry points for one
Phimacs checkout. Build and test checks consume explicitly prepared package,
grammar and private-cache inputs instead of independently downloading Lisp/Pi
or installing repository-global Git hooks. Package-local byte-compilation
exclusions, isolated GUI/benchmark/native-storage fixtures, test-macro and
docstring corrections, and the dated package notices accompany that integration.

These changes preserve the original package identity and copyright/license
notices. This aggregate modification notice is not a claim of clearance for other
packages, assets, historical revisions or distributions.
