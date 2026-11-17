/** Remember identity-proven descendant process groups before a Pi crash reparents them. */
import * as fs from "node:fs";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";

function processGroup(pid: number): number | undefined {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/)[2]);
  } catch { return undefined; }
}

/** Walks only Pi's own tree through each task's children list, never the whole process table. */
function descendants(root: number): number[] {
  const found: number[] = [];
  const pending = [root];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    let tasks: string[];
    try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const task of tasks) {
      let children: string;
      try { children = fs.readFileSync(`/proc/${pid}/task/${task}/children`, "utf8"); } catch { continue; }
      for (const child of children.split(" ")) {
        if (!child) continue;
        found.push(Number(child)); pending.push(Number(child));
      }
    }
  }
  return found;
}

export class OwnedToolGroups {
  private readonly groups = new Map<number, Map<number, ProcessIdentity>>();
  capture(piPid: number): void {
    for (const [group, members] of this.groups) {
      for (const [pid, identity] of members) if (processIdentityStatus(identity) === "dead") members.delete(pid);
      if (members.size === 0) this.groups.delete(group);
    }
    const ownGroup = processGroup(process.pid);
    for (const pid of descendants(piPid)) {
      const group = processGroup(pid);
      if (group === undefined || group === ownGroup) continue;
      let identity: ProcessIdentity | undefined;
      try { identity = readProcessIdentity(pid); } catch { continue; }
      if (!identity) continue;
      const members = this.groups.get(group) ?? new Map<number, ProcessIdentity>();
      members.set(pid, identity); this.groups.set(group, members);
    }
  }
  /** A live exact member must still belong to that group; PID-only evidence never authorizes a signal. */
  stop(): void {
    for (const [group, members] of this.groups) {
      if (![...members.values()].some((member) => processIdentityStatus(member) === "alive" && processGroup(member.pid) === group)) continue;
      try { process.kill(-group, "SIGKILL"); } catch { /* group already exited */ }
    }
    this.groups.clear();
  }
}
