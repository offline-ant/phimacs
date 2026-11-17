#!/usr/bin/env node
/**
 * `phimacs pi`: Pi's terminal UI as a managed agent of the pimux service.
 * Loading Pi's argument parser takes seconds, so this command has its own entry.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '@earendil-works/pi-coding-agent';
import { parseOptions } from './emacs-environment.mjs';
import { runtimeEnvironment, runtimePaths } from './runtime.mjs';
import { startService } from './run.mjs';

export async function pi(args, env = process.env) {
  const options = parseOptions([], env);
  const runtime = runtimePaths(options.root, env);
  const parsed = parseArgs(args);
  // Administrative output needs no service and allocates no runtime.
  const administrative = parsed.version || parsed.help || parsed.listModels !== undefined;
  const child = { ...runtimeEnvironment(runtime, env), PHIMACS_STATE_DIR: options.state,
    PHIMACS_EMACS_LAUNCHER: path.join(runtime.root, 'scripts/emacs-launch.mjs') };
  for (const name of Object.keys(child)) {
    if (/^(PI_ORCHESTRATION_|PI_WORKER_|PHIMACS_PARENT_TASK|PHIMACS_MANAGED_CLAIM)/.test(name)) delete child[name];
  }
  if (!administrative) await startService(options, runtime, env);
  process.execve(process.execPath, administrative ? [process.execPath, runtime.pi, ...args]
    : [process.execPath, runtime.pimux, 'tui', '--', runtime.pi, ...args], child);
  throw new Error('Pi exec returned without replacing the launcher');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  pi(process.argv.slice(2)).catch(error => { console.error(`phimacs: ${error.message}`); process.exitCode = 1; });
}
