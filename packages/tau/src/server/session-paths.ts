// Trust-boundary path checks for session files and exported HTML.

import path from 'node:path';
import fs from 'node:fs';
import { canonicalSessionPath } from '@phimacs/pimux/ownership';
import { SESSIONS_DIR, expandHome } from './config.js';
import type { StatusError } from './types.js';

export function resolveSessionFile(filePath: string) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath required');
  const resolved = canonicalSessionPath(filePath);
  const root = canonicalSessionPath(SESSIONS_DIR);
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith('.jsonl')) {
    throw new Error('Invalid session file');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw Object.assign(new Error('Session not found'), { status: 404 });
  return resolved;
}

export function isWithinPath(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveExportOutputPath(outputPath: string, sessionFile: string) {
  if (!outputPath || typeof outputPath !== 'string') throw new Error('outputPath required');
  const sessionDir = path.dirname(path.resolve(sessionFile));
  const sessionDirReal = fs.realpathSync(sessionDir);
  const expanded = expandHome(outputPath);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(sessionDir, expanded);
  if (!isWithinPath(sessionDir, resolved) || path.extname(resolved).toLowerCase() !== '.html') {
    const err = new Error('Export outputPath must be an .html file in the session directory') as StatusError;
    err.status = 403;
    throw err;
  }
  const parentDir = path.dirname(resolved);
  let parentReal;
  try { parentReal = fs.realpathSync(parentDir); } catch {
    const err = new Error('Export output directory not found') as StatusError;
    err.status = 404;
    throw err;
  }
  if (!isWithinPath(sessionDirReal, parentReal) || (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())) {
    const err = new Error('Export outputPath must stay inside the session directory') as StatusError;
    err.status = 403;
    throw err;
  }
  return resolved;
}
