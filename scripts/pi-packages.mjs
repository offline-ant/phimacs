// This checkout's Pi packages in Pi's user settings, shared by `phimacs setup` and
// `phimacs setup pi`. Node built-ins only: `setup pi` runs it in a fresh clone
// before anything is compiled.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Registrable Pi packages, in compile order after their pimux dependency. */
export const PI_PACKAGES = ['orchestration', 'extensions', 'browser', 'sound'];

/** Archived packages that @phimacs/* replaced, by manifest name; pi-ant and pi-browser are also their repositories. */
const ARCHIVED = new Set(['pi-ant', 'pi-orchestration', 'pi-browser']);

/** Warn when the host Pi's major.minor differs from the SDK this checkout builds against. */
export function hostVersionWarning(runtime) {
  const minor = version => version.split('.').slice(0, 2).join('.');
  return minor(runtime.version) === minor(runtime.library) ? undefined
    : `Global Pi ${runtime.version} differs from the checkout's SDK ${runtime.library}; run npm run update:pi -- ${runtime.version}`;
}

const home = env => env.HOME || os.homedir();
const expandHome = (file, env) => file === '~' ? home(env) : file.startsWith('~/') ? path.join(home(env), file.slice(2)) : file;

/** Pi's agent directory, as Pi selects it. */
export function agentDirectory(env = process.env) {
  return env.PI_CODING_AGENT_DIR ? path.resolve(expandHome(env.PI_CODING_AGENT_DIR, env)) : path.join(home(env), '.pi', 'agent');
}

/** The first `pi` in the absolute directories of PATH, as a shell would run it. */
export function findPi(env = process.env) {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(directory, 'pi');
    if (!path.isAbsolute(directory)) continue;
    try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; }
    if (fs.statSync(file).isFile()) return file;
  }
  return undefined;
}

const real = file => { try { return fs.realpathSync(file); } catch { return undefined; } };

/** Names of the package.json files at FILE and above it, nearest first; nothing for a missing path. */
function enclosingPackages(file) {
  let directory = real(file);
  if (!directory) return [];
  if (!fs.statSync(directory).isDirectory()) directory = path.dirname(directory);
  const names = [];
  for (;;) {
    try {
      const { name } = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (typeof name === 'string') names.push(name);
    } catch { /* no readable manifest here */ }
    const parent = path.dirname(directory);
    if (parent === directory) return names;
    directory = parent;
  }
}

const replaced = name => name.startsWith('@phimacs/') || ARCHIVED.has(name);
const npmName = spec => spec.startsWith('@') ? spec.split('@').slice(0, 2).join('@') : spec.split('@')[0];
/** WORD as one POSIX shell word. */
export const shell = word => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** Pi 1.5.2 reads `git:` sources and https, http and ssh URLs as Git; other non-npm sources are local paths. */
const gitSource = source => source.startsWith('git:') || /^(https?|ssh):\/\//.test(source);

/** The repository name of a Git source as Pi 1.5.2 splits it: without `#fragment`, `@ref` (refs may contain slashes), trailing slash or `.git`. */
export function gitRepository(source) {
  const url = source.replace(/^git:/, '').trim().split('#')[0];
  const scp = /^git@[^:]+:(.+)$/.exec(url);
  let repository;
  if (scp) repository = scp[1];
  else if (url.includes('://')) {
    try { repository = new URL(url).pathname; } catch { return undefined; }
  } else repository = url.slice(url.indexOf('/') + 1);
  return repository.split('@')[0].replace(/\/+$/, '').replace(/\.git$/, '').split('/').at(-1);
}

/** Whether Pi's ignore files in DIRECTORY exclude its top-level entry NAME: gitignore rules, the last match wins. */
function ignored(directory, name, isDirectory) {
  let result = false;
  for (const file of ['.gitignore', '.ignore', '.fdignore']) {
    let lines;
    try { lines = fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/); } catch { continue; }
    for (const line of lines) {
      let pattern = line.trim();
      if (!pattern || pattern.startsWith('#')) continue;
      const negated = pattern.startsWith('!');
      pattern = negated || pattern.startsWith('\\') ? pattern.slice(1) : pattern;
      if (pattern.endsWith('/')) {
        if (!isDirectory) continue;
        pattern = pattern.replace(/\/+$/, '');
      }
      pattern = pattern.replace(/^\//, '').replace(/^\*\*\//, '');
      if (!pattern.includes('/') && path.matchesGlob(name, pattern)) result = !negated;
    }
  }
  return result;
}

/** Extension files Pi resolves for DIRECTORY: its manifest's `pi.extensions` that exist, else index.ts or index.js. */
function directoryExtensions(directory) {
  try {
    const { pi } = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const files = (Array.isArray(pi?.extensions) ? pi.extensions : []).map(file => path.resolve(directory, file)).filter(file => fs.existsSync(file));
    if (files.length) return files;
  } catch { /* no readable manifest */ }
  const index = ['index.ts', 'index.js'].map(name => path.join(directory, name)).find(file => fs.existsSync(file));
  return index ? [index] : undefined;
}

/** Files Pi 1.5.2 auto-loads from AGENT/extensions, each with the entry there that brings it in. */
function autoExtensions(agent) {
  const directory = path.join(agent, 'extensions');
  if (!fs.existsSync(directory)) return [];
  const own = directoryExtensions(directory);
  if (own) return own.map(file => ({ file, entry: file }));
  const found = [];
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const entry = path.join(directory, name);
    let stats;
    try { stats = fs.statSync(entry); } catch { continue; }
    if (ignored(directory, name, stats.isDirectory())) continue;
    if (stats.isFile() && /\.[tj]s$/.test(name)) found.push({ file: entry, entry });
    else if (stats.isDirectory()) for (const file of directoryExtensions(entry) ?? []) found.push({ file, entry });
  }
  return found;
}

/** Whether the `!`, `+` and `-` entries of the user `extensions` setting leave auto-loaded FILE enabled, as Pi applies them. */
function enabledBySettings(file, patterns, agent) {
  const relative = path.relative(agent, file);
  const glob = pattern => [relative, path.basename(file), file].some(candidate => path.matchesGlob(candidate, pattern));
  const exact = pattern => [relative, file].includes(pattern.replace(/^\.\//, ''));
  let enabled = !patterns.some(pattern => pattern.startsWith('!') && glob(pattern.slice(1)));
  if (patterns.some(pattern => pattern.startsWith('+') && exact(pattern.slice(1)))) enabled = true;
  if (patterns.some(pattern => pattern.startsWith('-') && exact(pattern.slice(1)))) enabled = false;
  return enabled;
}

/**
 * This checkout's registered Pi packages and every other settings entry or
 * auto-loaded user extension that loads a copy of a @phimacs/* package or a package
 * it replaced: string and object `packages` entries (local, npm, Git), local
 * `extensions` entries and entries of AGENT/extensions, through symlinks and from
 * files inside a package. Unreadable settings are an error.
 */
export function inspectPiPackages(root, env = process.env) {
  const agent = agentDirectory(env);
  const settingsFile = path.join(agent, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read Pi settings ${settingsFile}: ${error.message}`); }
  const ours = new Map(PI_PACKAGES.map(name => [real(path.join(root, 'packages', name)), name]).filter(([directory]) => directory));
  const registered = [];
  const conflicts = [];
  const local = source => path.resolve(agent, expandHome(source.trim(), env));
  for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string') continue;
    if (source.startsWith('npm:')) {
      const name = npmName(source.slice(4).trim());
      if (replaced(name)) conflicts.push({ source, name, remove: `pi remove ${shell(source)}` });
    } else if (gitSource(source.trim())) {
      const name = gitRepository(source.trim());
      if (ARCHIVED.has(name)) conflicts.push({ source, name, remove: `pi remove ${shell(source)}` });
    } else {
      const file = local(source);
      const name = real(file) && ours.get(real(file));
      if (name) registered.push(name);
      else {
        const other = enclosingPackages(file).find(replaced);
        if (other) conflicts.push({ source, name: other, remove: `pi remove ${shell(file)}` });
      }
    }
  }
  // Direct extension files and directories; `!` and `-` entries only exclude, `+` includes exactly.
  const extensions = (Array.isArray(settings.extensions) ? settings.extensions : []).filter(entry => typeof entry === 'string');
  for (const entry of extensions) {
    if (/^[!-]/.test(entry)) continue;
    const other = enclosingPackages(local(entry.replace(/^\+/, ''))).find(replaced);
    if (other) conflicts.push({ source: entry, name: other, remove: `delete ${JSON.stringify(entry)} from "extensions" in ${settingsFile}` });
  }
  const reported = new Set();
  for (const { file, entry } of autoExtensions(agent)) {
    if (reported.has(entry) || !enabledBySettings(file, extensions, agent)) continue;
    const other = enclosingPackages(file).find(replaced);
    if (!other) continue;
    reported.add(entry);
    conflicts.push({ source: entry, name: other, remove: fs.lstatSync(entry).isSymbolicLink() ? `rm ${shell(entry)}`
      : `move ${shell(entry)} out of ${shell(path.dirname(entry))}` });
  }
  return { settingsFile, registered, conflicts };
}

/** The refusal for CONFLICTS, with the exact commands that resolve them. */
export function conflictReport(conflicts, settingsFile) {
  return [`${settingsFile} already loads other copies of these packages, so Pi would register their tools twice:`,
    ...conflicts.map(({ source, name }) => `  ${source} (${name})`),
    'Pi\'s settings are unchanged. Remove those copies, then run this setup again:',
    ...conflicts.map(({ remove }) => `  ${remove}`)].join('\n');
}

/**
 * Register SELECTED packages of ROOT with `pi install ABSOLUTE-PATH` in the user
 * settings, skipping registered ones; refuse before any change while another copy is
 * configured. PI is the command prefix that runs Pi. Returns the settings file.
 */
export function registerPiPackages({ root, selected, pi, env = process.env, log = console.log, run = spawnSync }) {
  const { settingsFile, registered, conflicts } = inspectPiPackages(root, env);
  if (conflicts.length) throw new Error(conflictReport(conflicts, settingsFile));
  for (const name of selected) {
    const directory = path.join(root, 'packages', name);
    if (registered.includes(name)) { log(`The ${name} Pi package is already registered.`); continue; }
    log(`Registering the ${name} Pi package: pi install ${shell(directory)}`);
    const result = run(pi[0], [...pi.slice(1), 'install', directory], { stdio: 'inherit', timeout: 120_000, env });
    if (result.error || result.status !== 0) throw new Error(`pi install ${directory} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
  return settingsFile;
}
