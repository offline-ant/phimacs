import { VERSION } from '@earendil-works/pi-coding-agent';
import { runtimeEnvironment } from './runtime-environment.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PI_COMMAND, resolvePiCommand, loadTauSettings, runtimeHost } from '../bin/config.js';

after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
test('default Pi is a physical absolute host with its package version', () => {
  assert.ok(path.isAbsolute(PI_COMMAND));
  assert.equal(fs.realpathSync(PI_COMMAND), PI_COMMAND);
  assert.equal(runtimeHost().version, VERSION);
  assert.equal(loadTauSettings().host, '127.0.0.1');
});
test('relative commands are refused and a missing global pi is reported before launch', () => {
  assert.throws(() => resolvePiCommand({ 'pi-command': 'pi' }, {}), /absolute runtime executable/);
  assert.throws(() => resolvePiCommand({}, { PATH: '/nonexistent' }), /No global pi on PATH/);
  assert.equal(resolvePiCommand({}, { TAU_PI_COMMAND: PI_COMMAND }), PI_COMMAND);
});
