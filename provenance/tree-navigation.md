# Tree-navigation implementation inputs

The current `packages/pimux/tree-navigate.ts` was authored independently by an
isolated `claude-agent/claude-opus-5-5` worker. Its task supplied the behavioral
contract below and permitted public Pi SDK documentation/type declarations only.
The worker was explicitly prohibited from reading project source, Tau source,
the preceding implementation, notices or tests. Integration changed whitespace,
added file/export comments and a documented callback-narrowing type assertion,
not the navigation algorithm.

## Supplied behavior

Register the command named by `TREE_NAVIGATE_COMMAND`. Accept one entry ID,
optionally preceded by `--summarize`; reject flags, missing/extra arguments,
non-idle agents and nonexistent entries. Call `ctx.navigateTree` in the same
session, letting Pi apply its message-to-parent rule. Report cancellation.
Observe `session_tree` only during the operation and clear the observation after
success or failure. If the leaf changes without an actual branch summary,
append `TREE_NAVIGATION_MARKER_TYPE` with `{navigatedTo: entryId}` so reopening
retains the position. A summary already persists the position. Do not write
editor text, submit model input or create another file/session.

## Public inputs inspected by the author

Pi coding-agent 1.5.2 documentation and type declarations:

- `docs/extensions.md`: event lifecycle, `session_before_tree`/`session_tree`,
  `ctx.navigateTree`, and `ExtensionAPI` import examples.
- `dist/core/extensions/types.d.ts`: extension/command contexts,
  `SessionTreeEvent`, registered commands and the extension API.
- `dist/core/agent-session.d.ts`: `navigateTree` declaration and doc comment.
- `dist/core/session-manager.d.ts`: read-only session accessors.
- `dist/index.d.ts`: the public `SessionTreeEvent` export.

The author reported using no compiled SDK implementation, pi-ai source or other
project implementation. The isolated author's source and input report were
reviewed before integration. Subsequent integration tests exercise the public
behavior, including real managed Pi navigation and session-file persistence.

This is a factual input record, not a legal clearance opinion. Historical
source attribution is retained in [pimux's NOTICE](../packages/pimux/NOTICE.md);
replacing current source does not change material in earlier Git revisions.
