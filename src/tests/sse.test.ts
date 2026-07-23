import { describe, expect, it } from "vitest";
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

describe("flushPreview (ring-buffer offset math)", () => {
  it("flushes the entire retained tail when starting from zero", async () => {
    const stream = createFakeStream();
    // 2 oldest lines already dropped; client connects fresh (from = 0).
    await flushPreview(
      stream,
      [textLine("c"), textLine("d"), textLine("e")],
      2,
      0,
    );
    expect(lineCount(stream)).toBe(3);
  });

  it("skips lines the stream has already sent", async () => {
    const stream = createFakeStream();
    // 2 dropped + 3 retained = 5 total; client already saw the first 4.
    await flushPreview(
      stream,
      [textLine("c"), textLine("d"), textLine("e")],
      2,
      4,
    );
    expect(lineCount(stream)).toBe(1);
  });

  it("flushes all retained lines when a burst drops unseen output", async () => {
    const stream = createFakeStream();
    // 3 dropped + 2 retained = 5 total; client only saw 1 line.
    await flushPreview(stream, [textLine("d"), textLine("e")], 3, 1);
    expect(lineCount(stream)).toBe(2);
  });

  it("flushes nothing when already up to date", async () => {
    const stream = createFakeStream();
    await flushPreview(stream, [textLine("c")], 0, 1);
    expect(lineCount(stream)).toBe(0);
  });

  it("emits nothing once the stream is aborted", async () => {
    const stream = createFakeStream();
    stream.aborted = true;
    await flushPreview(stream, [textLine("a"), textLine("b")], 0, 0);
    expect(lineCount(stream)).toBe(0);
  });
});
