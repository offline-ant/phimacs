#!/usr/bin/env node
import { runCli } from './cli.ts';

const controller = new AbortController();
const cancel = () => controller.abort();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, cancel);
try { process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal }); }
finally { for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, cancel); }
