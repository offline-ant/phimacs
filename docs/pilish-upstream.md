# Pilish maintenance

`emacs/pilish/` is the maintained Phimacs frontend source. It is ordinary source,
not a submodule or a second package implementation. The complete profile and
individually installed Emacs packages consume this same fork. Keep Pilish's
GPL-3.0-or-later license, copyright headers, authorship and required notices;
the root MIT license does not relicense it.

[The import manifest](../provenance/pilish-import.json) owns the original fork
revision, its upstream base, the last incorporated upstream revision and source
selection. The initial fork snapshot is `b3fc14f969faa363bf8dbcd3b7bcf36486470acf`;
its verified upstream base is `5a83d26a44fc87cf54b52b2f9d80806964dd5634`.
The imported files remain locally maintained; do not overwrite them with an
upstream checkout or rebase the monorepo onto upstream history.

## Source selection

Import only the committed tracked tree. The manifest excludes `.github/`,
`hooks/` and `.agents/`: their repository-root workflows, hook installation and
verification instructions are not Phimacs integration mechanisms. The initial
selection has 144 files. This is an import count, not the current package size.

Do not copy `.git`, untracked changes, installed dependencies, caches, bytecode,
review recordings or generated test output. Retain required tracked assets,
including the logo. Before an update, inspect its paths against the manifest's
`rejectGeneratedPaths`; stop if upstream has added such output. Review any change
to source selection explicitly and use the same selection for import and future
updates. Do not silently expand exclusions to hide a conflict.

Keep original import metadata unchanged. Advance only
`upstream.incorporatedRevision` after an accepted update; it is not a package
version or a claim that every upstream feature has been adopted unchanged.

## Work boundaries

Use a clean disposable Phimacs worktree. Never apply these operations to a
checkout used by a running Emacs, pimux service or supervisor; see
[checkout safety](development.md#checkout-safety). Importing source, changing
selection and restarting services are separate operations.

[offline-ant/pilish](https://github.com/offline-ant/pilish) remains the
contribution vehicle for upstream PRs. It is not a parallel maintained product
tree. Keep its open PR branches; this monorepo does not close PRs, rename the
package or split it.

## Incorporate an upstream update

The commands below use Bash from a clean disposable Phimacs worktree. Choose a
reviewed full target commit, not a moving branch name. The temporary upstream
clone is a read-only maintenance input and may fetch public history; only the
needed base **blob objects**, not upstream commits or refs, enter the product
object store. There is no nested repository or vendored history in the source.

```sh
product=$PWD
manifest="$product/provenance/pilish-import.json"
scratch=$(mktemp -d)
base=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).upstream.incorporatedRevision' "$manifest")
upstream_url=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).upstream.repository' "$manifest")
target=<reviewed-full-upstream-commit>

git clone --no-checkout "$upstream_url" "$scratch/upstream"
git -C "$scratch/upstream" cat-file -e "$base^{commit}"
git -C "$scratch/upstream" cat-file -e "$target^{commit}"

mapfile -t excluded < <(node -e 'const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(m.selection.excludeDirectories.join("\n"))' "$manifest")
pathspec=(.)
for directory in "${excluded[@]}"; do
  pathspec+=(":(exclude)${directory%/}")
done

git -C "$scratch/upstream" diff --binary --full-index --no-renames \
  "$base" "$target" -- "${pathspec[@]}" > "$scratch/upstream.patch"
git -C "$scratch/upstream" diff --raw --no-abbrev --no-renames \
  "$base" "$target" -- "${pathspec[@]}" \
  | awk '$3 !~ /^0+$/ { print $3 }' | sort -u > "$scratch/base-blobs"
```

Review the patch before applying it. `--no-renames` makes path selection explicit:
a rename is a deletion and addition, so review both. Binary changes remain in the
full-index patch. Stop for unreviewed generated output or source-selection changes.
If the selected patch is empty, there is no source update to apply.

```sh
git -C "$scratch/upstream" pack-objects --stdout < "$scratch/base-blobs" \
  | git -C "$product" index-pack --stdin
git -C "$product" apply --3way --index --directory=emacs/pilish \
  "$scratch/upstream.patch"
git -C "$product" diff --cached --check
git -C "$product" diff --cached -- emacs/pilish
```

The blob transfer is needed because a snapshot import does not give Git the old
upstream blobs that a three-way merge needs. `index-pack` imports objects without
creating upstream branch refs. These commands stage the directory update in the
worktree; they do not commit or publish it. Conflicts remain visible for manual
resolution. Preserve the worktree and scratch inputs on failure; do not use broad
reset/cleanup commands to recover.

Resolve against current fork behavior and public API consumers. When upstream
supplies an equivalent feature, retain its implementation and remove the duplicate
only after checking consumer contracts. Do not keep both implementations or a
compatibility adapter. In particular, review these proposed API changes if their
upstream commits are incorporated; the links are not a live PR-status ledger:

- [#403](https://github.com/dnouri/pilish/pull/403): per-spawn environment functions
  and background-session behavior.
- [#404](https://github.com/dnouri/pilish/pull/404): structured reload outcomes and
  callback settlement.
- [#407](https://github.com/dnouri/pilish/pull/407): four-argument identity hooks,
  including pi-deck consumers.
- [#419](https://github.com/dnouri/pilish/pull/419): browser-created session names.
- [#420](https://github.com/dnouri/pilish/pull/420): widget/status replacement and
  the queue preamble.
- [#421](https://github.com/dnouri/pilish/pull/421) and
  [#422](https://github.com/dnouri/pilish/pull/422): follower/reader scrolling.

Run the affected focused Pilish suites and consumers using the prepared test
inputs in [development](development.md) and the package's [guide](../emacs/pilish/AGENTS.md).
Runtime changes also need the isolated real-Pi/faux-provider lane. Do not replace
failed native evidence with a mock-only pass or run paid inference implicitly.
After resolution and successful review, update `upstream.incorporatedRevision`
with the source change. Commit explicit paths only. Remove temporary
maintenance inputs after their evidence is no longer needed.

## Export selected fork changes to an upstream PR

Export only reviewed, upstream-ready, linear commits **after** the initial import.
Do not export the bulk snapshot, an upstream-incorporation commit or all fork
changes by default. A commit can contain Phimacs-only work, so review the filtered
patch and its message; necessary prerequisite commits must already exist on the
PR branch or be deliberately included. Preserve author attribution and GPL notices.

From the Phimacs worktree, select the first and last commits of the intended range:

```sh
product=$PWD
scratch=$(mktemp -d)
first=<first-reviewed-commit>
last=<last-reviewed-commit>
range="$first^..$last"

git -C "$product" format-patch --binary --full-index --no-renames \
  --relative=emacs/pilish --stdout "$range" -- emacs/pilish \
  > "$scratch/contribution.mbox"
git -C "$product" log --format= --raw --no-abbrev --no-renames \
  "$range" -- emacs/pilish \
  | awk '$1 ~ /^:/ && $3 !~ /^0+$/ { print $3 }' | sort -u \
  > "$scratch/export-base-blobs"
git -C "$product" pack-objects --stdout < "$scratch/export-base-blobs" \
  > "$scratch/export-base.pack"
```

Both `--relative=emacs/pilish` and the final `-- emacs/pilish` matter: the pathspec
selects package changes and the relative option strips the monorepo prefix from
the resulting patch. Inspect `diff --git` paths before continuing: package paths
must be `a/pilish-…`, `a/test/…` or other package-root paths, never
`a/emacs/pilish/…` or unrelated Phimacs paths. The blob-only pack supplies bases
for every selected commit; a patch mailbox alone does not supply those objects.

Apply the export only in a disposable upstream-based contribution checkout, at the
reviewed head of the existing PR branch. The clone operation below does not change
the existing branch or remote. `git am` creates local contribution commits in
that disposable checkout:

```sh
pr_branch=<existing-reviewed-PR-branch>
git clone --single-branch --branch "$pr_branch" \
  https://github.com/offline-ant/pilish.git "$scratch/contribution"
git -C "$scratch/contribution" index-pack --stdin < "$scratch/export-base.pack"
git -C "$scratch/contribution" am -3 "$scratch/contribution.mbox"
git -C "$scratch/contribution" diff --check
git -C "$scratch/contribution" log --oneline -n 5
```

Review and test the result against upstream's source and test contract. A conflict
or missing fork-only dependency needs a deliberate port; do not copy the full
monorepo frontend to make a PR apply. Stop and keep the disposable work on failure.
There is no push in this procedure. Review the exact resulting commits before
updating a PR branch; never force-push implicitly.
