import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { selectedEmacs } from '../scripts/emacs-packages.mjs';

const root = path.resolve(import.meta.dirname, '..');
const prepared = process.env.PHIMACS_TEST_EMACS_DIR;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const lisp = value => JSON.stringify(value);

/** A staged profile with no optional package directories or checkout fallback.
 * The synthetic executables exercise startup/configuration only, not runtime transport.
 */
async function profileFixture(action, { companion = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-profile-'));
  try {
    const checkout = path.join(directory, 'checkout');
    const state = path.join(directory, 'state');
    const home = path.join(directory, 'home');
    await fs.mkdir(state, { mode: 0o700 });
    await fs.mkdir(home, { mode: 0o700 });
    const copy = (source, destination) => fs.cp(source, destination, {
      // Copy order must not make a source newer than its bytecode.
      recursive: true, dereference: true, preserveTimestamps: true,
      filter: file => !['.git', '.cache', 'gnupg'].includes(path.basename(file)),
    });
    await copy(prepared, path.join(state, 'emacs'));
    for (const source of ['emacs/config', 'emacs/pilish', 'emacs/pi-deck',
      ...(companion ? ['packages/orchestration/emacs'] : [])]) {
      await copy(path.join(root, source), path.join(checkout, source));
    }
    const write = async (file, text, mode = 0o600) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, { mode });
    };
    const pi = path.join(directory, 'tools/pi');
    await write(pi, '#!/bin/sh\nexit 0\n', 0o700);
    await write(path.join(checkout, 'packages/pimux/bin/pimux'),
      '#!/bin/sh\nprintf \'{"type":"agents","agents":[]}\\n\'\nexec /bin/cat\n', 0o700);
    const user = path.join(home, 'config/phimacs/user.el');
    await write(user, `;;; -*- lexical-binding: t; -*-\n(setq phimacs-enable-orchestration nil)\n`);
    await write(path.join(home, '.emacs.d/init.el'), '(error "Borrowed personal init")\n');
    const { emacs, path: searchPath } = selectedEmacs();
    const env = {
      PATH: searchPath, HOME: home, TMPDIR: directory,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_DATA_HOME: path.join(home, 'data'), PHIMACS_STATE_DIR: state,
      PHIMACS_PI: pi, PI_CODING_AGENT_DIR: path.join(home, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(directory, 'sessions'),
      PIMUX_DIR: path.join(directory, 'mux'), PHIMACS_USER_FILE: user,
      TERM: 'xterm-256color', GDK_BACKEND: 'x11', GIT_TERMINAL_PROMPT: '0', EMACSLOADPATH: '',
    };
    const runBatch = forms => spawnSync(emacs, ['-Q', '--batch',
      '-l', path.join(checkout, 'emacs/config/init.el'), '--eval', forms], {
      env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    await action({ directory, checkout, state, home, user, pi, env, emacs, write, runBatch });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('preparation compiles available sources offline with both optional companions absent',
  { skip: !prepared, timeout: 20_000 }, () => profileFixture(async ({ checkout, state, user, env, emacs, write, runBatch }) => {
    const script = path.join(checkout, 'scripts/emacs-packages.mjs');
    await fs.mkdir(path.dirname(script));
    await fs.copyFile(path.join(root, 'scripts/emacs-packages.mjs'), script);
    for (const source of ['emacs/pilish', 'emacs/pi-deck', 'emacs/config/lisp']) {
      const directory = path.join(checkout, source);
      for (const file of await fs.readdir(directory)) {
        if (file.endsWith('.elc')) await fs.unlink(path.join(directory, file));
      }
    }
    for (const absent of ['packages/orchestration', 'packages/sound', 'node_modules', 'scripts/runtime.mjs']) {
      await assert.rejects(fs.stat(path.join(checkout, absent)), { code: 'ENOENT' });
    }
    const override = ';;; -*- lexical-binding: t; -*-\n(error "Preparation loaded personal overrides")\n';
    await write(user, override);
    const result = spawnSync('unshare', ['-Urn', process.execPath, script, '--state', state], {
      env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /\bWarning\b|Error:/, 'preparation compiles without warnings');
    for (const compiled of ['emacs/pilish/pilish-runtime.elc', 'emacs/pi-deck/pi-deck.elc',
      'emacs/config/lisp/phimacs-pi.elc', 'emacs/config/lisp/phimacs-ui.elc']) {
      assert.ok((await fs.stat(path.join(checkout, compiled))).size > 0, compiled);
    }
    await assert.rejects(fs.stat(path.join(checkout, 'emacs/config/lisp/phimacs-dictation.elc')), { code: 'ENOENT' });
    for (const absent of ['packages/orchestration', 'packages/sound', 'node_modules']) {
      await assert.rejects(fs.stat(path.join(checkout, absent)), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(user, 'utf8'), override, 'preparation neither loads nor replaces overrides');
    await assert.rejects(fs.stat(path.join(state, 'deck/state.eld')), { code: 'ENOENT' });
    await write(user, ';;; -*- lexical-binding: t; -*-\n(setq phimacs-enable-orchestration nil)\n');
    const startup = spawnSync('unshare', ['-Urn', emacs, '-Q', '--batch', '-l',
      path.join(checkout, 'emacs/config/init.el'), '--eval',
      '(princ (json-serialize (list :ready (if phimacs--pi-enabled t :false) :task (if pilish-runtime-task-status-executable t :false))))'], {
      env, encoding: 'utf8', timeout: 8_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(startup.status, 0, `${startup.error?.message ?? ''}\n${startup.stdout}\n${startup.stderr}`);
    assert.deepEqual(JSON.parse(startup.stdout), { ready: true, task: false });
    for (const [selection, source] of [
      ['phimacs-enable-orchestration t', 'orchestration'],
      ['phimacs-enable-orchestration nil phimacs-enable-sound t', 'sound'],
    ]) {
      await write(user, `;;; -*- lexical-binding: t; -*-\n(setq ${selection})\n`);
      const failure = runBatch('(kill-emacs 0)');
      assert.notEqual(failure.status, 0, `enabled missing ${source} must refuse normal startup`);
      assert.ok((failure.stdout + failure.stderr).includes(`Missing checkout Lisp package: ${path.join(checkout, 'packages', source, 'emacs')}`));
    }
  }));

test('direct full profile persists with orchestration and sound physically absent',
  { skip: !prepared, timeout: 20_000 }, () => profileFixture(async ({ directory, checkout, state, env, emacs, write }) => {
    await assert.rejects(fs.stat(path.join(checkout, 'packages/orchestration')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(checkout, 'packages/sound')), { code: 'ENOENT' });
    const evidence = path.join(directory, 'evidence.json');
    const probe = path.join(directory, 'probe.el');
    await write(probe, `;;; -*- lexical-binding: t; -*-\n(condition-case condition (progn
      (unless (and phimacs--pi-enabled phimacs--ui-enabled pi-deck-mode)
        (error "Incomplete profile"))
      (when (or (locate-library "pi-orchestration") (locate-library "pi-sound")
                (executable-find "phimacs-task-status") pilish-runtime-task-status-executable)
        (error "Optional component leaked into the staged profile"))
      (unless (and (process-live-p server-process)
                   (equal pi-deck--state-owner server-name))
        (error "Direct profile does not own persistence"))
      (with-temp-buffer
        (let ((status (call-process "emacs" nil t nil "-Q" "--batch" "-l"
                       ${lisp(path.join(checkout, 'emacs/config/early-init.el'))}
                       "--eval" "(progn (require 'phimacs-environment) (phimacs-start-server))")))
          (unless (and (not (= status 0))
                       (string-match-p "already owned or unavailable" (buffer-string))
                       (process-live-p server-process))
            (error "A second profile did not preserve the live endpoint"))))
      (if (equal (getenv "PHIMACS_TEST_PROFILE_PHASE") "0")
          (let ((pi-deck-new-space-action 'dired))
            (when (pi-deck-space "persisted") (error "Fresh profile inherited deck state"))
            (pi-deck-create-space ${lisp(directory)} "persisted"))
        (unless (pi-deck-space "persisted")
          (error "Direct profile did not automatically restore its saved space")))
      (with-temp-file ${lisp(evidence)}
        (insert (json-encode
          (list (cons 'owner pi-deck--state-owner)
                (cons 'spaces (vconcat (pi-deck-space-names)))
                (cons 'pilish (symbol-file 'pilish-configure-runtime 'defun))
                (cons 'pi pilish-runtime-pi-executable)
                (cons 'pimux pilish-runtime-pimux-executable)
                (cons 'libraries (mapcar (lambda (name) (cons name (locate-library name)))
                                        '("pi-deck" "vertico" "corfu" "ghostel")))
                (cons 'module-auto (if ghostel-module-auto-install t :json-false))
                (cons 'grammars (symbol-name pilish-essential-grammar-action))))))
      (kill-emacs 0))
      (error (message "%s" (error-message-string condition)) (kill-emacs 1)))\n`);
    for (let phase = 0; phase < 2; phase++) {
      const command = [emacs, `--init-directory=${path.join(checkout, 'emacs/config')}`,
        '--no-splash', '-nw', '-l', probe].map(quote).join(' ');
      const result = spawnSync('script', ['-q', '-e', '-c', command, '/dev/null'], {
        env: { ...env, PHIMACS_TEST_PROFILE_PHASE: String(phase) },
        encoding: 'utf8', timeout: 8_000, maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
      const record = JSON.parse(await fs.readFile(evidence, 'utf8'));
      assert.equal(record.owner, path.join(state, 'sockets/phimacs'));
      assert.deepEqual(record.spaces, ['persisted']);
      assert.ok(record.pilish.startsWith(path.join(checkout, 'emacs/pilish/')));
      assert.ok(record.pilish.endsWith('.elc'), 'prepared checkout Pilish loads bytecode');
      assert.equal(record.pi, env.PHIMACS_PI);
      assert.equal(record.pimux, path.join(checkout, 'packages/pimux/bin/pimux'));
      for (const [name, file] of Object.entries(record.libraries)) {
        const origin = name === 'pi-deck' ? checkout : path.join(state, 'emacs');
        assert.ok(file.startsWith(origin + path.sep), `${name}: ${file} escaped staged sources`);
      }
      assert.equal(record['module-auto'], false);
      assert.equal(record.grammars, 'warn');
      const saved = await fs.readFile(path.join(state, 'deck/state.eld'), 'utf8');
      assert.match(saved, /:name "persisted"/);
      assert.ok(saved.includes(record.owner));
    }
    await assert.rejects(fs.stat(path.join(env.PI_CODING_AGENT_DIR, 'settings.json')), { code: 'ENOENT' });
  }));

test('selected orchestration validates its missing task executable after user overrides',
  { skip: !prepared, timeout: 20_000 }, () => profileFixture(async ({ user, write, runBatch }) => {
    await write(user, ';;; -*- lexical-binding: t; -*-\n(setq phimacs-enable-orchestration t)\n');
    const result = runBatch('(kill-emacs 0)');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Cannot find executable .*worker-task-cli\.js/);
  }, { companion: true }));

test('failed deck enable cleans its newly owned profile endpoint and preserves the error',
  { skip: !prepared, timeout: 20_000 }, () => profileFixture(async ({ directory, state, user, write, runBatch }) => {
    const evidence = path.join(directory, 'failure.json');
    await write(user, `;;; -*- lexical-binding: t; -*-
      (setq phimacs-enable-orchestration nil)
      (with-eval-after-load 'pi-deck
        (advice-add 'pi-deck-mode :before
                    (lambda (&rest _) (error "Synthetic deck enable failure"))))
      (with-eval-after-load 'phimacs-pi
        (advice-add 'phimacs-enable-pi :around
          (lambda (function &rest arguments)
            (condition-case condition (apply function arguments)
              (error
               (with-temp-file ${lisp(evidence)}
                 (insert (json-encode
                   (list :error (error-message-string condition)
                         :live (if (and server-process (process-live-p server-process)) t :json-false)
                         :socket (if (file-exists-p server-name) t :json-false)))))
               (signal (car condition) (cdr condition)))))))\n`);
    const result = runBatch('(kill-emacs 0)');
    assert.notEqual(result.status, 0);
    const record = JSON.parse(await fs.readFile(evidence, 'utf8'));
    assert.equal(record.error, 'Synthetic deck enable failure');
    assert.equal(record.live, false);
    assert.equal(record.socket, false);
    await assert.rejects(fs.stat(path.join(state, 'deck/state.eld')), { code: 'ENOENT' });
  }));

test('profile refuses a frontend host that differs from the selected service host',
  { skip: !prepared, timeout: 20_000 }, () => profileFixture(async ({ directory, user, write, runBatch }) => {
    const other = path.join(directory, 'tools/other-pi');
    await write(other, '#!/bin/sh\nexit 0\n', 0o700);
    await write(user, `;;; -*- lexical-binding: t; -*-\n(setq phimacs-enable-orchestration nil phimacs-pi-program ${lisp(other)})\n`);
    const result = runBatch('(kill-emacs 0)');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /phimacs-pi-program differs from PHIMACS_PI/);
  }));
