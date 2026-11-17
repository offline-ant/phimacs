import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { processIdentityStatus } from '@phimacs/pimux/process-identity';
import { createPanelBinding, panelWrapperArgv, waitPanelReady, activatePanel,
  panelStatus, readPanelOutput, closePanel, rollbackPanel, savedPanelState,
} from '../../../../packages/orchestration/dist/panel-runtime.js';

// The native ERT fixture owns this creator until every exact wrapper has exited.
// A retained marker prevents the outer harness deleting uncertain panel evidence.
const root = process.env.PHIMACS_TEST_ROOT;
if (!root?.startsWith('/tmp/phimacs-test-')) throw new Error('Marked native test root required');
const pending = path.join(root, 'deck-panels-pending');
const bindings = new Map();
const closeHelper = fileURLToPath(new URL('../../../../packages/orchestration/dist/panel-close.js', import.meta.url));
fs.writeFileSync(pending, `${JSON.stringify({ creator: process.pid })}\n`, { mode: 0o600, flag: 'wx' });
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  const failures = [];
  for (const binding of bindings.values()) {
    try {
      if (!savedPanelState(binding)) {
        await rollbackPanel(binding);
        throw new Error(`Native allocation has no terminal evidence: ${binding.directory}`);
      }
      await closePanel(binding);
      fs.rmSync(binding.directory, { recursive: true });
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Panel cleanup uncertain: ${failures.map(String).join('; ')}`);
  fs.unlinkSync(pending);
  cleaned = true;
}
const input = readline.createInterface({ input: process.stdin, terminal: false });
try {
  for await (const line of input) {
    try {
      const request = JSON.parse(line);
      let result;
      if (request.operation === 'create') {
        if (!request.cwd?.startsWith(`${root}/sessions/`)) throw new Error('Panel cwd must stay in synthetic sessions');
        const panel = createPanelBinding({ cwd: request.cwd, argv: request.argv, native: { kind: 'emacs' } });
        bindings.set(panel.id, panel);
        result = { id: panel.id, spec: { kind: 'shell', name: request.name, cwd: request.cwd,
          argv: panelWrapperArgv(panel), panel,
          panelControl: [process.execPath, closeHelper, JSON.stringify(panel)], placement: 'worker',
          ...(request.parent ? { parent: { id: request.parent } } : {}),
        } };
      } else if (request.operation === 'finish') {
        await cleanup();
        process.stdout.write(`${JSON.stringify({ success: true })}\n`);
        break;
      } else {
        let panel = bindings.get(request.id);
        if (!panel) throw new Error('Unknown owned native panel');
        if (request.operation === 'activate') {
          panel = await waitPanelReady(panel);
          bindings.set(panel.id, panel);
          await activatePanel(panel);
          result = { success: true };
        } else if (request.operation === 'status') {
          result = { state: await panelStatus(panel), wrapper: processIdentityStatus(panel.process), output: readPanelOutput(panel) };
        } else throw new Error('Unknown panel fixture operation');
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`);
    }
  }
} finally {
  input.close();
  try { await cleanup(); }
  catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
