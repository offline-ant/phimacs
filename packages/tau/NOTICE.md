# Tau attribution

Imported from https://github.com/offline-ant/tau at
`643c7f7ece0d62320a31ad3804fff529e193ab75` (branch `upstream-rebase`).
Upstream: https://github.com/milanglacier/pi-tau-web-server at
`5e39d8cb188222008c13402e940277e14589f91d` (v1.2.1).
Originally forked from https://github.com/deflating/tau at `5e2bce39`.

The Markdown renderer, styles and tests include the subsequent upstream fixes
`0b3fa6d`, `ecf2a52` and `92e4c01` from `milanglacier/pi-tau-web-server`.

## License notices

- **deflating/tau:** The [MIT license](LICENSE), including deflating's copyright
  notice, is copied verbatim from
  [deflating/tau at `9527996`](https://github.com/deflating/tau/blob/952799682f57550c2608a22a484d2de4fb660736/LICENSE).
- **pi-tau-web-server:** The standalone fork credits Milan Glacier and declares
  MIT in its [README](https://github.com/milanglacier/pi-tau-web-server/blob/0bbac21e2c7f7e90269849b3ff3fad1c278a860a/README.md#license)
  and [`package.json`](https://github.com/milanglacier/pi-tau-web-server/blob/0bbac21e2c7f7e90269849b3ff3fad1c278a860a/package.json#L36-L47).
  The reviewed tree has no separate license file or copyright notice for Milan's
  additions; the original notice is reproduced as written.
- **Built assets:** The build copies the KaTeX and highlight.js licenses alongside
  their files under `public/vendor/`.

## Reviewed changes not imported

Reviewed Milan's `main` through `0bbac21`. Besides the Markdown fixes above,
its changes since v1.2.1 cover documentation, workflow, a benchmark and a Pi
1.5.1 lockfile update. Phimacs pins Pi 1.5.2 in its root lockfile.

The sibling fork's [history-link fix `bbc1899`](https://github.com/Schrodinger-s-Call/pi-tau-web-server/commit/bbc1899e58725afa7ee28fef0ee338e9d158b28f)
recovers workspace IDs for project-file download and preview routes. Phimacs Tau
has neither those workspace IDs nor arbitrary project-file routes. Transcript
image attachments use the session snapshot or a link scoped to that session's
history version. No patch from that branch was imported.
