import { VERSION } from '@earendil-works/pi-coding-agent';
import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeRuntimeLauncher } from './runtime-launcher.ts';
import { PI_COMMAND, LiveSessionManager, handleRpcCommand, resolvePiCommand,
  _setExecFileForTest, _clearModelListCacheForTest } from '../bin/tau.js';
import { runtimeHost } from '../bin/config.js';

const installedPi = fs.realpathSync(fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))));
after(() => { _setExecFileForTest(null); fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }); });

test('the default Pi command is the physical global pi on PATH unless PHIMACS_PI overrides it', () => {
  assert.equal(PI_COMMAND, installedPi);
  assert.equal(resolvePiCommand({}, { PHIMACS_PI: installedPi }), installedPi);
  const bin = path.join(runtimeEnvironment.root, 'global-bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(installedPi, path.join(bin, 'pi'));
  assert.equal(resolvePiCommand({}, { PATH: bin }), installedPi);
  assert.deepEqual(runtimeHost(), { executable: installedPi, version: VERSION });
});

test('explicit flags and environment select a validated installed host, resolving symlink aliases', () => {
  const alias = path.join(runtimeEnvironment.root, 'selected-pi');
  fs.symlinkSync(installedPi, alias);
  assert.equal(resolvePiCommand({}, { TAU_PI_COMMAND: alias }), installedPi);
  assert.equal(resolvePiCommand({ 'pi-command': alias }, { TAU_PI_COMMAND: 'untrusted-path-wrapper' }), installedPi);
});

test('arbitrary PATH wrappers are refused instead of being invoked', () => {
  assert.throws(() => resolvePiCommand({ 'pi-command': 'pi' }, {}), /absolute runtime executable/);
  assert.throws(() => resolvePiCommand({}, { TAU_PI_COMMAND: 'wrapper --unsafe' }), /absolute runtime executable/);
});

test('a missing absolute host fails before launch with its exact selected path', () => {
  const missing = path.join(runtimeEnvironment.root, 'missing-pi');
  assert.throws(() => resolvePiCommand({}, { TAU_PI_COMMAND: missing }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ENOENT/);
    assert.ok(error.message.includes(missing));
    return true;
  });
});

test('managed session startup passes the validated absolute host to the common launcher', async t => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  t.after(async () => { await manager.shutdown(); await launcher.close(); });
  const session = await manager.create({ cwd, model: undefined, sessionFile: undefined, args: undefined, env: undefined });
  assert.equal(launcher.calls.length, 1);
  assert.equal(launcher.calls[0].command, installedPi);
  assert.equal(session.transport?.kind, 'pimux');
});

test('the model list uses the runtime host and preserves slashful provider model IDs', async t => {
  _clearModelListCacheForTest();
  _setExecFileForTest((file: string, args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, installedPi);
    assert.deepEqual(args, ['--list-models']);
    callback(null, 'provider      model               context  max-out  thinking  images\nfx            nested/model        128K     16K      yes       no\n', '');
  });
  t.after(() => _setExecFileForTest(null));
  const response = await handleRpcCommand({ type: 'get_available_models' });
  assert.equal(response.success, true);
  assert.deepEqual(response.data.models, [{ provider: 'fx', id: 'nested/model', context: '128K', maxOutput: '16K', thinking: true, images: false }]);
});
