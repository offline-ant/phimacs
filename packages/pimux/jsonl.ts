/**
 * Strict JSONL framing: records end at LF only (never at U+2028/U+2029, unlike
 * `readline`), an optional CR before the LF is stripped, and a line that grows
 * past `maxBytes` without an LF is reported instead of buffered without bound.
 */
export class LineSplitter {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;
  private readonly onLine: (line: string) => void;
  private readonly maxBytes: number;
  private readonly onOverflow: () => void;

  constructor(onLine: (line: string) => void, maxBytes: number, onOverflow: () => void) {
    this.onLine = onLine;
    this.maxBytes = maxBytes;
    this.onOverflow = onOverflow;
  }

  push(chunk: Buffer): void {
    if (this.overflowed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        this.chunks.push(chunk.subarray(start));
        this.size += chunk.length - start;
        if (this.size > this.maxBytes) {
          this.overflowed = true;
          this.chunks = [];
          this.onOverflow();
        }
        return;
      }
      const piece = chunk.subarray(start, newline);
      if (this.size + piece.length > this.maxBytes) {
        this.overflowed = true;
        this.chunks = [];
        this.onOverflow();
        return;
      }
      const line = this.chunks.length === 0 ? piece : Buffer.concat([...this.chunks, piece]);
      this.chunks = [];
      this.size = 0;
      start = newline + 1;
      const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
      if (end > 0) this.onLine(line.toString("utf8", 0, end));
    }
  }
}
