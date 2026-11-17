# Architecture

```text
@phimacs/extensions -> @phimacs/orchestration -> @phimacs/pimux
@phimacs/browser -> @phimacs/pimux
pi-deck -> emacs/pilish + Ghostel + Transient
optional profile -> reusable Lisp packages + pinned third-party UI
phimacs launcher -> pimux service + profile Emacs daemon (start or attach)
pimux service -> per-agent owner -> selected published Pi
Pilish clients --private Unix sockets-- per-agent owner
device phimacs client --SSH--> host phimacs; shared device sockets -> sound
```

One repository holds the maintained Pilish fork, generic npm packages, deck and
optional complete profile. One root npm lock owns the SDK/build graph. Packages
use declared public exports and acyclic dependencies. The profile consumes the
packages; packages do not load the profile or impose its appearance/key choices.
Pilish keeps its GPL license and [upstream maintenance](pilish-upstream.md) process.

The published Pi host is selected explicitly, independently of the root SDK used
to build/check Phimacs. Native assets and third-party Lisp dependencies are prepared
before startup. Both existing-config and complete-profile installation use the same
package sources at one revision; there is no version negotiation between them.

The pimux service owns managed RPC agents and workers. Protocol 2 has no
primary/creator client role. Only the top-level `phimacs` launcher or a supervisor
starts the service; Emacs packages and other frontends never do. Managed claims
exclude cooperating writers; workers remain parent-task-bound and panels remain
host-native. Service restart restores roots idle, not workers or interrupted
execution. [Lifecycle](lifecycle.md) owns Close, disconnect and recovery semantics;
the wire boundary is the [runtime contract](runtime-contract.md).

Orchestration, general extensions, browser automation and sound are explicit
selections. Browser tools are not a second chat frontend. Ordinary detached roots
need no orchestration companion or task reader. Ghostel remains a declared deck
dependency; standalone Pilish does not require it. Other devices attach over SSH
with a standalone `phimacs` client and can opt in to sharing their microphone,
speaker and notifications through sound's device-sharing protocol. Private
providers, account/device policy, credentials, sessions and deployment
supervision stay outside source.
