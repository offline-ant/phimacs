---
name: peer-agents
description: "Inspect, wait for, read or message other top-level Pi agents in the same project or deck space, not your own workers: \"check the adjacent agent\", \"wait for it to finish\", \"what did it conclude\", \"tell the other agent…\". Covers pimux-managed agents in the Emacs deck through `pimux agent`. Herdr panes use the herdr skill; your own workers use do/delegate results."
---

# Peer agents

`pimux agent` is a command-line frontend of managed Pi runtimes, beside Pilish.
Every command prints one JSON value. Failures are `{"error":{"code","message",…}}`
with exit code 1, `timeout` exits 2 and `agent_exited` exits 3. Full contract:
the "Agent client" section of `phimacs/packages/pimux/README.md`.

## 1. List peers

```bash
pimux agent list
```

Peers are the root agents and interactive forks in your own cwd, newest
activity first, excluding you and every worker. Each entry has `muxId`, `status`
(`idle`, `working`, `blocked`), `blocked`, `title` (session name or first
prompt), `sessionFile`, `startedAt` and `updatedAt`. `--all` lists every managed
agent, marking yours with `"self": true`.

Choose the target:
- One peer: use it.
- Several: "the adjacent agent" is the working one. If none or several are
  working, show the titles and ask the user. Never guess.
- None: say so. Native `pi` processes and herdr panes are not listed.

Pass the full `muxId` (a unique prefix also works).

## 2. Wait

```bash
pimux agent wait <muxId> --timeout 600000
```

Without `--until`, this returns when the agent is idle or blocked; an agent that
is already idle matches immediately. `--next-turn` ignores the current state and
waits for a run that starts after attaching, then for that run to settle: use it
when the user is about to prompt the peer. `--until idle|working|blocked`
(repeatable) selects exact states. Always pass a timeout below your bash tool's
limit; re-run on `timeout` (exit 2) if the user wants you to keep waiting. Never
use sleep loops.

`blocked` means the peer waits for its user (a dialog, or a worker waiting for
input). Report it with the `blocked` detail; do not answer it. `agent_exited`
means the peer ended; report its receipt.

## 3. Read

```bash
pimux agent read <muxId>
pimux agent read <muxId> --messages 6 --format text
```

The default prints the last user `prompt`, the assistant's last `answer` after
it, and `inFlight` streaming text while it works. `--messages N` gives the last
N user/assistant text messages; tool output and thinking are not included. If
you need more detail, read its `sessionFile` (Pi JSONL) selectively.

## 4. Prompt, only when the user asks

```bash
pimux agent prompt <muxId> --wait --timeout 600000 -- "message text"
```

This submits once. It refuses a `blocked` agent (`agent_blocked`) and a working
one (`agent_working`) unless the user asked to `--steer` it or queue a
`--follow-up`. `--wait` returns when that prompt's run settles, including its
`answer`. `prompt_uncertain` or `agent_prompt_stalled` means delivery is unknown:
read the peer first and never resend automatically.

## Never

- Stop, close, abort or restart another agent, or answer its dialogs.
- Prompt a peer without the user's request, or prompt yourself (`self_target`).
- Treat a `timeout` as the peer having finished.
