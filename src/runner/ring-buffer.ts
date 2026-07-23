type DrainResult = { lines: string[]; nextSeq: number };

type LineBuffer = {
  push: (item: string) => void;
  drain: (fromSeq: number) => DrainResult;
  snapshot: () => string[];
};

// A fixed-capacity circular buffer that evicts the oldest item via modular
// arithmetic (advancing `head`) rather than `Array.splice` (which shifts every
// element and breaks index-based iteration). `drain` snapshots a contiguous
// range of items synchronously — no `await` yield point — so a concurrent
// `push` can never mutate the returned array mid-iteration.
const createRingBuffer = (capacity: number): LineBuffer => {
  const slots: (string | undefined)[] = new Array(capacity);
  let head = 0; // index of oldest retained item
  let count = 0; // items currently retained
  let totalSeq = 0; // items ever pushed (monotonic)

  const push = (item: string): void => {
    slots[(head + count) % capacity] = item;
    if (count === capacity) head = (head + 1) % capacity;
    else count++;
    totalSeq++;
  };

  const drain = (fromSeq: number): DrainResult => {
    const firstRetained = totalSeq - count;
    const start = Math.max(fromSeq, firstRetained);
    const lines: string[] = [];
    for (let seq = start; seq < totalSeq; seq++)
      lines.push(slots[(head + (seq - firstRetained)) % capacity]!);
    return { lines, nextSeq: totalSeq };
  };

  const snapshot = (): string[] => drain(0).lines;

  return { push, drain, snapshot };
};

export type { DrainResult, LineBuffer };
export { createRingBuffer };
