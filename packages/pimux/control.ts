/** SDK-free discovery/control CLI; launch commands use the separate entry point. */
import { agentCommand } from "./agent-cli.ts";
import { listRuntimes, lookupRuntime, lookupTerminalReceipt, stopRuntime, watchRuntimes } from "./runtime-control.ts";
import { resolveRuntime } from "./service-client.ts";

function option(args: string[], key: string): string | undefined {
  const at = args.indexOf(key);
  return at < 0 ? undefined : args[at + 1];
}

export async function control(args: string[]): Promise<void> {
  const json = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const action = args[0];
  if (action === "agent") {
    const { output, exitCode } = await agentCommand(args.slice(1));
    if (typeof output === "string") process.stdout.write(output ? `${output}\n` : "");
    else json(output);
    process.exitCode = exitCode;
  } else if (action === "list") json(listRuntimes());
  else if (action === "watch") await watchRuntimes();
  else if (action === "lookup") {
    const file = option(args, "--session");
    if (!file) throw new Error("Usage: pimux lookup --json --session <absolute path>");
    const claim = lookupRuntime(file);
    // Claim tokens are internal capabilities, not public discovery fields.
    json(claim ? { file: claim.file, owner: claim.owner } : null);
  } else if (action === "receipt") {
    const muxId = option(args, "--id");
    if (!muxId || muxId.startsWith("--")) throw new Error("Usage: pimux receipt --json --id <muxId>");
    json(lookupTerminalReceipt(muxId));
  } else if (action === "resolve") {
    const muxId = option(args, "--id");
    if (!muxId) throw new Error("Usage: pimux resolve --json --id <muxId>");
    json(await resolveRuntime(muxId));
  } else if (action === "stop") {
    const muxId = option(args, "--id");
    if (!muxId) throw new Error("Usage: pimux stop --json --id <muxId>");
    json(await stopRuntime(muxId));
  } else throw new Error("Usage: pimux serve; pimux {start|list|watch|lookup|resolve|receipt|stop} --json; pimux agent {list|get|read|wait|prompt|model}; pimux tui -- <absolute Pi executable> [arguments]");
}
