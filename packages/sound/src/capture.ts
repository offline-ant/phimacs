import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import type { CaptureCommand } from './settings.ts';

export interface Capture {
  readonly device: string;
  readonly stream: Readable;
  /** Idempotently stop owned capture resources, never a caller's process. */
  close(): void;
}
export interface CaptureSource { open(signal: AbortSignal): Capture | Promise<Capture> }

export function streamCapture(stream: Readable, device = 'PCM stream'): CaptureSource {
  return {
    open(signal) {
      signal.throwIfAborted();
      const close = () => stream.destroy();
      signal.addEventListener('abort', close, { once: true });
      return { device, stream, close() { signal.removeEventListener('abort', close); stream.destroy(); } };
    },
  };
}

export function fileCapture(file: string): CaptureSource {
  return {
    open(signal) {
      signal.throwIfAborted();
      return streamCapture(fs.createReadStream(file), 'PCM file').open(signal);
    },
  };
}

/** Spawn exactly the configured argv, without a shell or ambient device discovery. */
export function commandCapture(command: CaptureCommand): CaptureSource {
  return {
    async open(signal) {
      signal.throwIfAborted();
      const child = spawn(command.command, command.args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const stream = new PassThrough();
      let stopping = false;
      let killTimer: NodeJS.Timeout | undefined;
      const close = () => {
        if (stopping) return;
        stopping = true;
        child.stdout.destroy();
        stream.destroy();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 1_000);
          killTimer.unref();
        }
      };
      child.once('close', (code, exitSignal) => {
        clearTimeout(killTimer);
        if (stopping || signal.aborted) return;
        if (code !== 0 || exitSignal) stream.destroy(new Error('Configured audio capture command failed.'));
        else stream.end();
      });
      signal.addEventListener('abort', close, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        signal.throwIfAborted();
        child.stdout.on('error', (error: Error) => stream.destroy(error));
        // Delay successful EOF until exit status is known, not merely stdout EOF.
        child.stdout.pipe(stream, { end: false });
        return { device: 'capture command', stream,
          close() { signal.removeEventListener('abort', close); close(); } };
      } catch (error) {
        signal.removeEventListener('abort', close);
        close();
        throw error;
      }
    },
  };
}
