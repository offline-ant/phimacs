// Resolve checkout-owned executables and the global Pi host.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHost } from '@phimacs/pimux/host-identity';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');

/** Resolve one checkout graph and the global Pi. Never install dependencies or start processes. */
export function runtimePaths(root = sourceRoot, env = process.env) {
  root = fs.realpathSync(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const host = resolveHost(env);
  return {
    root, pi: host.executable, version: host.version,
    library: manifest.dependencies['@earendil-works/pi-coding-agent'],
    pimux: path.join(root, 'packages/pimux/bin/pimux'),
    taskStatus: path.join(root, 'packages/orchestration/dist/worker-task-cli.js'),
    deck: path.join(root, 'emacs/pi-deck'),
  };
}

/** Bind new children to the checkout; existing runtimes retain their identity. */
export function runtimeEnvironment(runtime, env = process.env) {
  return { ...env, PHIMACS_ROOT: runtime.root, PHIMACS_PI: runtime.pi };
}
