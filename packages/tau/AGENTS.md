# Tau development

Tau is an experimental Phimacs workspace, private to npm and not separately
released. Use the root dependency graph; never vendor Phimacs tarballs or add
a nested lockfile.
Read [README.md](README.md) for checks and upstream imports.

- Browser/server shutdown disconnects only. Agent Close requires authoritative
  runtime/task exit; uncertain delivery or socket failure never permits replay
  or a second writer. Keep drafts tied to their captured file/branch.
- Model provider and id are separate fields. Never split ids on slashes.
- Passwordless startup is loopback-only. Never permit a non-loopback bind or
  live toggle to disable authentication. Only the exact normalized `/api/health`
  is public under `/api/`. The standalone browser sign-in form and `POST /login`
  must not serve app data before authentication.
- Network TLS retains the existing CA; plain HTTP stays loopback-only.
- `src/public/sw.ts` lists browser modules. Update its cache name when browser
  assets change; `test/service-worker.test.ts` checks the list.
- Tests use synthetic state, faux inference and disposable browsers. Never
  use production services, profiles, discovery or paid providers.
