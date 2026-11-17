import { createBashToolDefinition as createPiBashToolDefinition, type BashToolOptions } from "@earendil-works/pi-coding-agent";

/** Native bash execution with the shared Phimacs timeout policy. */
export function createBashToolDefinition(cwd: string, options?: BashToolOptions): ReturnType<typeof createPiBashToolDefinition> {
  const base = createPiBashToolDefinition(cwd, options);
  const timeout = {
    ...base.parameters.properties.timeout,
    description: "Timeout in seconds. Optional; defaults to 900 (15 minutes).",
  };
  return {
    ...base,
    description: `${base.description} Usually omit \`timeout\`; it defaults to 900 seconds (15 minutes). Set it explicitly when a command needs a different limit.`,
    parameters: {
      ...base.parameters,
      properties: {
        ...base.parameters.properties,
        timeout,
      },
    },
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return base.execute(toolCallId, { ...params, timeout: params.timeout === undefined ? 900 : params.timeout }, signal, onUpdate, ctx);
    },
  };
}
