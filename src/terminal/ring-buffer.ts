/**
 * Fixed-capacity byte-ish ring of string chunks. Used to replay recent PTY
 * output when a browser reattaches to an existing terminal session.
 */
export interface RingBuffer {
  push(chunk: string): void;
  toString(): string;
}

export function createRingBuffer(capacityBytes: number): RingBuffer {
  let data = "";

  return {
    push(chunk: string): void {
      if (!chunk) return;
      data += chunk;
      if (data.length > capacityBytes) {
        data = data.slice(data.length - capacityBytes);
      }
    },
    toString(): string {
      return data;
    }
  };
}
