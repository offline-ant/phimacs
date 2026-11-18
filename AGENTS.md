# Phimacs development

To install or set up Phimacs for a user, follow docs/install.md. The rest of
this file is for development.

Phimacs is a checkout-based workspace. Read README.md and docs/development.md.
The root package.json and package-lock.json own the npm graph and supported Pi.

- Generic packages and the maintained Pilish fork (`emacs/pilish/`) live here.
  Private providers and personal integrations stay outside this repository. The
  opt-in profile (`emacs/config/`) consumes these packages; packages never
  depend on the profile.
- A running deployment can load code directly from its checkout. Develop and
  test in a separate worktree; do not recompile or reinstall a checkout that
  serves running agents, and never restart or reload a user's running service
  or Emacs as a test.
- Install with scripts disabled. Compile/check the affected packages and run
  focused regressions. Unrelated native assets and product-wide acceptance are
  not required for ordinary edits.
- Preserve licenses and attribution; record each third-party import's source and
  license in provenance/README.md.
- Keep credentials, sessions, profiles, device policy and private integrations
  outside source.
- Keep the runtime guarantees in docs/lifecycle.md: one managed writer,
  identity-bound Close, disconnect-only frontend loss, no input replay.
- Test as docs/development.md says: disposable homes, endpoints, claims and
  faux providers; native lanes are opt-in. Claims protect cooperating managed
  paths, not arbitrary raw Pi/storage operations.
- No compatibility shims, broad Git cleanup, force pushes or implicit commits.
