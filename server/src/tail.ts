import { open } from 'node:fs/promises';

const NEWLINE = 0x0a;

/** Reads only the new bytes of an append-only file. Keeps the byte offset and the partial last line. */
export class FileTail {
  private offset: number;
  private partial = Buffer.alloc(0);
  private skipFirstLine: boolean;

  /** Start `startBytes` before the end of the file. The first (cut) line is dropped. */
  constructor(
    private path: string,
    size: number,
    startBytes: number,
  ) {
    this.offset = Math.max(0, size - startBytes);
    this.skipFirstLine = this.offset > 0;
  }

  async readNewLines(): Promise<string[]> {
    const fh = await open(this.path, 'r');
    try {
      const { size } = await fh.stat();
      if (size < this.offset) {
        // File was truncated or replaced. Read it again from the start.
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.skipFirstLine = false;
      }
      if (size === this.offset) return [];

      const chunk = Buffer.alloc(size - this.offset);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, this.offset);
      this.offset += bytesRead;

      // Split on the last newline byte, so a multi-byte character is never cut.
      const data = Buffer.concat([this.partial, chunk.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(NEWLINE);
      if (end === -1) {
        this.partial = data;
        return [];
      }
      this.partial = Buffer.from(data.subarray(end + 1));

      const lines = data.subarray(0, end).toString('utf8').split('\n');
      if (this.skipFirstLine) {
        lines.shift();
        this.skipFirstLine = false;
      }
      return lines.filter((l) => l.length > 0);
    } finally {
      await fh.close();
    }
  }
}
