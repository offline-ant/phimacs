# Dependency security

- Agents run the selected published Pi unmodified. The current host/root SDK
  baseline is **1.5.2**. Phimacs does not rewrite Pi's CLI/RPC bundle.
- The root npm lock describes external SDK dependencies, not all copies embedded
  in the published host bundle. A clean `npm audit` is not a host-bundle audit.
- One root graph pins exact development requirements and overrides to select a
  single SDK/typebox identity. Extension packages use Pi host peers and the
  host-module bridge; they must not install independent nested SDK copies.
- `.npmrc` disables lifecycle scripts. `prepack` therefore does not guarantee
  fresh output; explicitly compile before packing and inspect artifact contents.
  An isolated dependency-closure install must not resolve unpublished internal
  names from a registry. [Installation](install.md#local-npm-artifacts) owns the
  artifact recipe; [development](development.md#installation-checks) owns checks.
- Pi updates take upstream's dependency fixes. Review transport/matcher release
  notes, including undici changes, and run focused faux regressions. See
  [Pi updates](development.md#pi-updates). Do not substitute a global CLI upgrade
  for SDK/private-adapter review, or upgrade a running deployment implicitly.
- A separate HTTP/proxy/TLS/glob matrix against the bundled host remains
  unverified. Ordinary focused tests and npm audit do not establish that matrix.
- Preserve dependency/asset grants, including minimatch's BlueOak-1.0.0 license
  and Pilish's GPL. [Third-party sources](../provenance/README.md) lists the
  incorporated third-party grants.

Credentials, project trust and provider usage remain explicit user decisions.
Tests use synthetic inference and owned state, not personal browser profiles,
account tokens or the user's Emacs daemon.
