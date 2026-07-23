import { describe, expect, it } from "vitest";
import { createRingBuffer } from "../runner/index.js";
import { flushPreview } from "../server/sse.js";

// A goose NDJSON assistant-text line, which renderStreamLine renders to HTML.
const textLine = (text: string): string =>
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
  });

type RecordedWrite = { event: string; data: string; id?: string };

type FakeStream = {
  aborted: boolean;
  writes: RecordedWrite[];
  writeSSE: (msg: RecordedWrite) => Promise<void>;
};

// Only the members emit()/flushPreview() touch are needed; the structural
// SseWriter type makes the fake assignable without asserting the interface.
const createFakeStream = (): FakeStream => {
  const writes: RecordedWrite[] = [];
  return {
    aborted: false,
    writes,
    writeSSE: async (msg: RecordedWrite): Promise<void> => {
      writes.push(msg);
    },
  };
};

const lineCount = (stream: FakeStream): number =>
  stream.writes.filter((w) => w.event === "preview").length;

const lineData = (stream: FakeStream): string[] =>
  stream.writes.filter((w) => w.event === "preview").map((w) => w.data);

describe("flushPreview (ring-buffer drain)", () => {
  it("flushes the entire retained tail when starting from zero", async () => {
    const stream = createFakeStream();
    const buffer = createRingBuffer(100);
    buffer.push(textLine("a"));
    buffer.push(textLine("b"));
    const next = await flushPreview(stream, buffer, 0);
    expect(next).toBe(2);
    expect(lineCount(stream)).toBe(2);
  });

  it("skips lines the stream has already sent", async () => {
    const stream = createFakeStream();
    const buffer = createRingBuffer(100);
    buffer.push(textLine("a"));
    buffer.push(textLine("b"));
    buffer.push(textLine("c"));
    buffer.push(textLine("d"));
    const next = await flushPreview(stream, buffer, 3);
    expect(lineCount(stream)).toBe(1);
    expect(next).toBe(4);
  });

  it("flushes all retained lines when a burst drops unseen output", async () => {
    const stream = createFakeStream();
    const buffer = createRingBuffer(100);
    buffer.push(textLine("a"));
    buffer.push(textLine("b"));
    // Client only saw 1 line, so fromSeq=1 should get b.
    const next = await flushPreview(stream, buffer, 1);
    expect(lineCount(stream)).toBe(1);
    expect(next).toBe(2);
  });

  it("flushes nothing when already up to date", async () => {
    const stream = createFakeStream();
    const buffer = createRingBuffer(100);
    buffer.push(textLine("c"));
    const next = await flushPreview(stream, buffer, 1);
    expect(lineCount(stream)).toBe(0);
    expect(next).toBe(1);
  });

  it("emits nothing once the stream is aborted", async () => {
    const stream = createFakeStream();
    stream.aborted = true;
    const buffer = createRingBuffer(100);
    buffer.push(textLine("a"));
    buffer.push(textLine("b"));
    const next = await flushPreview(stream, buffer, 0);
    expect(next).toBe(false);
    expect(lineCount(stream)).toBe(0);
  });

  it("returns nextSeq matching the snapshot boundary", async () => {
    const stream = createFakeStream();
    const buffer = createRingBuffer(100);
    buffer.push(textLine("x"));
    buffer.push(textLine("y"));
    buffer.push(textLine("z"));
    const next = await flushPreview(stream, buffer, 0);
    expect(next).toBe(3);
    // A second drain from the returned cursor should yield nothing.
    const stream2 = createFakeStream();
    const next2 = await flushPreview(stream2, buffer, next as number);
    expect(lineCount(stream2)).toBe(0);
    expect(next2).toBe(3);
  });

  it("does not skip lines when the buffer evicts during iteration", async () => {
    const buffer = createRingBuffer(3);
    buffer.push(textLine("A"));
    buffer.push(textLine("B"));
    buffer.push(textLine("C"));

    let writeCount = 0;
    const stream = createFakeStream();
    stream.writeSSE = async (msg) => {
      stream.writes.push(msg);
      // Simulate producer pushing during consumer's await — triggers eviction
      if (writeCount === 0) {
        buffer.push(textLine("D")); // evicts A from the ring
        writeCount++;
      }
    };

    const next = await flushPreview(stream, buffer, 0);
    expect(next).not.toBe(false);

    const emitted = lineData(stream);

    // All 3 snapshotted lines emitted — D's eviction of A happened
    // after the snapshot, so A is still in the copy.
    expect(emitted).toHaveLength(3);

    // Next drain picks up D
    const stream2 = createFakeStream();
    const next2 = await flushPreview(stream2, buffer, next as number);
    expect(lineCount(stream2)).toBe(1);
    expect(next2).toBe(4);
  });
});
