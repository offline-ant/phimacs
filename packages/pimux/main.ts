/** Explicit launch/control CLI. RPC frontends connect directly to the returned socket. */
import { startRuntime, RuntimeOperationError, type ParentTask } from "./runtime.ts";
import { control } from "./control.ts";
import { runService } from "./service.ts";
import { runManagedTui } from "./managed-tui.ts";
export { intendedSessionFile, servesRpc } from "./host.ts";

export async function main(args: string[]): Promise<void> {
  const action = args[0];
  const json = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const controller = new AbortController();
  const cancelled = (): void => controller.abort();
  try {
    if (action === "serve") await runService();
    else if (action === "start" || action === "tui") {
      const separator = args.indexOf("--");
      const command = separator < 0 ? undefined : args[separator + 1];
      if (!command) throw new Error(`Usage: pimux ${action} ${action === "start" ? "--json [--operation-id <uuid>] " : ""}-- <absolute Pi executable> [arguments]`);
      const piArgs = args.slice(separator + 2);
      // A caller-chosen launch operation lets a frontend recognize its runtime in
      // discovery before the commitment receipt names its mux ID.
      const option = args.indexOf("--operation-id");
      const operationId = action === "start" && option >= 0 && option < separator ? args[option + 1] : undefined;
      if (operationId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)) {
        throw new Error("--operation-id must be a new lowercase UUID");
      }
      if (action === "tui") {
        const exit = await runManagedTui({ command, args: piArgs });
        process.exitCode = exit.code ?? (exit.signal ? 128 + (exit.signal === "SIGINT" ? 2 : 15) : 1);
      } else {
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, cancelled);
        const parent: ParentTask | undefined = process.env.PHIMACS_PARENT_TASK
          ? JSON.parse(process.env.PHIMACS_PARENT_TASK) as ParentTask : undefined;
        json(await startRuntime({ command, args: piArgs, signal: controller.signal,
          ...operationId ? { operationId } : {}, ...parent ? { parent } : {} }));
      }
    } else await control(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const operation = error instanceof RuntimeOperationError ? ` Operation ${error.operationId}, runtime ${error.muxId}; reconcile before retrying.` : "";
    process.stderr.write(`pimux: ${message}${operation}\n`);
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, cancelled);
  }
}
