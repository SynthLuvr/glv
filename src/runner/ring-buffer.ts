type DrainResult = { lines: string[]; nextSeq: number };

type LineBuffer = {
  push: (item: string) => void;
  drain: (fromSeq: number) => DrainResult;
  snapshot: () => string[];
};

// Fixed-capacity circular buffer: eviction is O(1) (no splice shift), and
// drain returns a synchronous snapshot so a concurrent push can't mutate the
// result mid-iteration.
const createRingBuffer = (capacity: number): LineBuffer => {
  const slots: (string | undefined)[] = Array.from({ length: capacity });
  let count = 0; // items currently retained (0..capacity)
  let totalSeq = 0; // items ever pushed (monotonic)

  const push = (item: string): void => {
    slots[totalSeq % capacity] = item;
    if (count < capacity) count++;
    totalSeq++;
  };

  const drain = (fromSeq: number): DrainResult => {
    const first = totalSeq - count;
    const start = Math.max(fromSeq, first);
    const lines: string[] = [];
    for (let seq = start; seq < totalSeq; seq++)
      lines.push(slots[seq % capacity]!);
    return { lines, nextSeq: totalSeq };
  };

  const snapshot = (): string[] => drain(0).lines;

  return { push, drain, snapshot };
};

export type { DrainResult, LineBuffer };
export { createRingBuffer };
