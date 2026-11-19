/** Exports run in the live session's owning Pi. */
import fs from 'node:fs';
import path from 'node:path';
import { isRecord, type InputContext } from '@phimacs/pimux/protocol';
import type { PiRpcSession } from './sessions.js';

export async function exportSession(file: string, output: string, session: PiRpcSession, inputContext?: InputContext): Promise<string> {
  // Pi's public export_html command calls AgentSession.exportToHtml(), which
  // reads both the complete tree and the in-memory leaf from its own manager.
  // A JSONL copy cannot encode a branch move that appended no entry.
  if (!session.referencesSessionFile(file)) throw new Error('Runtime moved to another conversation; export was not sent');
  const response = await session.send({ type: 'export_html', outputPath: output,
    ...(inputContext ? { pimuxContext: inputContext } : {}) }, { timeoutMs: 30000 });
  if (response.success !== true) throw new Error(typeof response.error === 'string' ? response.error : 'The owning Pi refused the HTML export');
  const result = isRecord(response.data) ? response.data : {};
  if (typeof result.path !== 'string' || path.resolve(result.path) !== path.resolve(output)
    || !fs.existsSync(output)) throw new Error('The owning Pi did not produce the requested HTML export');
  return output;
}
