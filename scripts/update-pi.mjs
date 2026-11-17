// Change the root SDK pins together; dependency installation remains explicit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Update the root Pi SDK pins, without touching the global Pi or running agents. */
export function updatePi(version, root = fileURLToPath(new URL('../', import.meta.url))) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version || '')) throw new Error('Usage: npm run update:pi -- EXACT_VERSION');
  const file = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    for (const name of Object.keys(dependencies)) {
      if (/^@earendil-works\/pi-(coding-agent|agent-core|ai|tui)$/.test(name)) dependencies[name] = version;
    }
  }
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    updatePi(process.argv[2]);
    console.log(`SDK pins updated. Run npm install --ignore-scripts, compile and the affected checks; then, at an approved idle boundary, npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${process.argv[2]} and restart hosts. Running agents keep their Pi.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
