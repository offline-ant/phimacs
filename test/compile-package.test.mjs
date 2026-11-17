import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../scripts/compile-package.mjs', import.meta.url));
const postSteps = ['--copy', 'extensions/template.md', '--executable', 'cli.js'];
// The files every complete build of the fixture contains.
const built = ['a.d.ts', 'a.js', 'b.d.ts', 'b.js', 'cli.d.ts', 'cli.js', 'extensions/template.md'];

/** A minimal package whose sources all carry VERSION, plus an installed old dist/. */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-compile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'tsconfig.emit.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], strict: true,
    declaration: true, rootDir: '.', outDir: 'dist' }, include: ['*.ts'] }));
  fs.mkdirSync(path.join(root, 'extensions'));
  fs.mkdirSync(path.join(root, 'dist/extensions'), { recursive: true });
  for (const file of [...built, 'stale.js']) fs.writeFileSync(path.join(root, 'dist', file), 'old\n');
  return root;
}

function writeSources(root, version, { broken = false } = {}) {
  for (const name of ['a', 'b', 'cli']) {
    fs.writeFileSync(path.join(root, `${name}.ts`), `export const ${name}: string = ${broken && name === 'b' ? 1 : JSON.stringify(version)};\n`);
  }
  fs.writeFileSync(path.join(root, 'extensions/template.md'), `${version}\n`);
}

function compile(root) {
  const child = spawn(process.execPath, [compiler, ...postSteps], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
  return { child, exit };
}

/** Classify dist/ as absent, the old or new complete tree, or anything else (partial). */
function observe(root, version) {
  const dist = path.join(root, 'dist');
  try {
    const before = fs.statSync(dist).ino;
    const files = fs.readdirSync(dist, { recursive: true })
      .filter(file => fs.statSync(path.join(dist, file)).isFile()).sort();
    const contents = files.map(file => fs.readFileSync(path.join(dist, file), 'utf8'));
    // A swap during this read is not an observation of either tree.
    if (fs.statSync(dist).ino !== before) return 'moved';
    if (files.join() === [...built, 'stale.js'].sort().join() && contents.every(text => text === 'old\n')) return 'old';
    const executable = (fs.statSync(path.join(dist, 'cli.js')).mode & 0o111) !== 0;
    if (files.join() === [...built].sort().join() && executable
      && files.every((file, index) => file.endsWith('.d.ts') || contents[index].includes(version))) return 'new';
    return 'partial';
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

const leftovers = root => fs.readdirSync(root).filter(name => name.startsWith('.dist-'));
const snapshot = root => fs.readdirSync(path.join(root, 'dist'), { recursive: true }).sort()
  .map(file => [file, fs.statSync(path.join(root, 'dist', file)).isFile()
    ? fs.readFileSync(path.join(root, 'dist', file), 'utf8') : null]);

test('a successful compile replaces dist/ completely, post-step files included, while readers see whole trees', { timeout: 20_000 }, async t => {
  const root = fixture(t);
  writeSources(root, 'v2');
  const seen = [];
  const { exit } = compile(root);
  let finished = false;
  exit.then(() => { finished = true; });
  while (!finished) {
    const state = observe(root, 'v2');
    if (state !== 'moved' && seen.at(-1) !== state) seen.push(state);
    await yieldToLoop();
  }
  const result = await exit;
  assert.equal(result.code, 0, result.output);
  assert.equal(observe(root, 'v2'), 'new');
  assert.equal(fs.existsSync(path.join(root, 'dist/stale.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'dist/extensions/template.md'), 'utf8'), 'v2\n');
  assert.notEqual(fs.statSync(path.join(root, 'dist/cli.js')).mode & 0o111, 0);
  // Readers only ever saw the complete old tree, then the complete new one. The
  // two renames can leave dist/ absent for an instant, never partially written.
  assert.equal(seen.includes('partial'), false, `observed ${seen.join(' -> ')}`);
  assert.deepEqual(seen.filter(state => state !== 'absent'), ['old', 'new']);
  assert.deepEqual(leftovers(root), []);
});

test('a failed compile keeps the previous dist/ and leaves no staging directory', { timeout: 20_000 }, async t => {
  const root = fixture(t);
  writeSources(root, 'v2', { broken: true });
  const before = snapshot(root);
  const result = await compile(root).exit;
  assert.notEqual(result.code, 0);
  assert.match(result.output, /error TS2322/);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(leftovers(root), []);
});

test('an interrupted compile keeps the previous dist/ and leaves no staging directory', { timeout: 20_000 }, async t => {
  const root = fixture(t);
  writeSources(root, 'v2');
  const before = snapshot(root);
  const { child, exit } = compile(root);
  while (leftovers(root).length === 0) await yieldToLoop();
  child.kill('SIGTERM');
  const result = await exit;
  assert.equal(result.code, 1);
  assert.match(result.output, /interrupted by SIGTERM; dist\/ was left unchanged/);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(leftovers(root), []);
});
