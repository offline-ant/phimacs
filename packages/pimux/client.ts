/**
 * One symmetric socket peer's bounded output queue. A slow peer can lose records
 * and bootstrap again, or disconnect, but can never pause Pi or another client.
 */
import { ALL_INCLUDES, type Include } from "./protocol.ts";

export interface Sink {
  /** Returns false when the caller should wait for the drain listener. */
  write(data: string): boolean;
  onDrain(listener: () => void): void;
  destroy(): void;
}

export interface QueueLimits {
  queueBytes: number;
  totalBytes: number;
  overflows: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = { queueBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, overflows: 3 };

type LineClass = "live" | "snapshot" | "response";
interface Item { line: string; bytes: number; kind: LineClass; endsSnapshot: boolean }

export interface ClientEvents {
  overflow(client: Client): void;
  terminal(client: Client): void;
}

export class Client {
  readonly id: number;
  include: Include[] = [...ALL_INCLUDES];
  muteGeneration: number | null = null;
  closed = false;
  private items: Item[] = [];
  private liveBytes = 0;
  private totalBytes = 0;
  private sequence: number | null = null;
  private blocked = false;
  private overflows = 0;
  private dropped = 0;
  private readonly sink: Sink;
  private readonly limits: QueueLimits;
  private readonly events: ClientEvents;

  constructor(id: number, sink: Sink, limits: QueueLimits, events: ClientEvents) {
    this.id = id;
    this.sink = sink;
    this.limits = limits;
    this.events = events;
    sink.onDrain(() => {
      this.blocked = false;
      this.pump();
    });
  }

  get queuedLines(): number { return this.items.length; }
  get queuedBytes(): number { return this.totalBytes; }

  takeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }

  enqueue(line: string, kind: "live" | "response"): void {
    if (!this.closed) this.add(line, kind, false);
  }

  enqueueSnapshot(line: string, generation: number, endsSnapshot = false): void {
    if (this.closed) return;
    if (generation !== this.sequence) {
      this.sequence = generation;
      this.keepResponses();
    }
    this.add(line, "snapshot", endsSnapshot);
  }

  private add(line: string, kind: LineClass, endsSnapshot: boolean): void {
    const bytes = Buffer.byteLength(line);
    this.items.push({ line, bytes, kind, endsSnapshot });
    this.totalBytes += bytes;
    if (kind === "live") this.liveBytes += bytes;
    this.pump();
    if (this.closed) return;
    if (this.totalBytes > this.limits.totalBytes) this.fail();
    else if (this.liveBytes > this.limits.queueBytes) this.overflow();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.items = [];
    this.totalBytes = 0;
    this.liveBytes = 0;
    this.sink.destroy();
  }

  private pump(): void {
    while (!this.blocked && !this.closed && this.items.length > 0) {
      const item = this.items.shift()!;
      this.totalBytes -= item.bytes;
      if (item.kind === "live") this.liveBytes -= item.bytes;
      if (item.endsSnapshot) this.overflows = 0;
      try { this.blocked = !this.sink.write(`${item.line}\n`); }
      catch { this.fail(); }
    }
  }

  private keepResponses(): void {
    this.items = this.items.filter((item) => item.kind === "response");
    this.totalBytes = this.items.reduce((sum, item) => sum + item.bytes, 0);
    this.liveBytes = 0;
  }

  private overflow(): void {
    this.dropped += this.items.filter((item) => item.kind === "live").length;
    this.keepResponses();
    if (++this.overflows >= this.limits.overflows) this.fail();
    else this.events.overflow(this);
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.events.terminal(this);
  }
}
