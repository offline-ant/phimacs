# Pilish: maintained Phimacs modified version

**Modified-version notice — 2026-11-18.** Phimacs maintains this modified version
of Pilish. It is not an unmodified release from the upstream Pilish project.
This notice describes the maintained source as of that date.

## Source and license

- Upstream: https://github.com/dnouri/pilish, incorporated base
  `69179108707fd056885707314404efc6d0cf8d2e`.
- This Pilish package is released under **GPL-3.0-or-later**. See [LICENSE](LICENSE)
  for the GNU General Public License. Original copyright, authorship, upstream
  identity and license notices remain in the source; this notice does not
  replace them or relicense Pilish under the repository's MIT license.

The repository's [import manifest](../../provenance/pilish-import.json) records
the current incorporated upstream revision and source selection.
[Upstream maintenance](../../docs/pilish-upstream.md) describes subsequent updates
and contributions. Preserve this notice, the README notice and LICENSE with the
Pilish source in source archives and VC installations.

## Changes from upstream

This version differs from its upstream base. Its changes include detached
protocol-2 pimux transport and runtime controls; worker-task completion
evidence; desktop state and context-bound draft recovery; managed storage
integration; inline extension dialogs, chat styling, window pairing,
queue/widget display and additional session APIs.

The maintained source also incorporates Pilish into `emacs/pilish/` and
adapts package documentation, source paths and build/test entry points for one
Phimacs checkout. Build and test checks consume explicitly prepared package,
grammar and private-cache inputs instead of independently downloading Lisp/Pi
or installing repository-global Git hooks. Package-local byte-compilation
exclusions, isolated GUI/benchmark/native-storage fixtures, test-macro and
docstring corrections, and the dated package notices accompany that integration.

These changes preserve the original package identity and copyright/license
notices. This aggregate modification notice is not a claim of clearance for other
packages, assets, historical revisions or distributions.
