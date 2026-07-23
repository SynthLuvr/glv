import { describe, expect, it } from "vitest";
import { createRingBuffer } from "../runner/ring-buffer.js";

describe("createRingBuffer", () => {
  it("push stores items and drain retrieves them in order", () => {
    const buf = createRingBuffer(10);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    const { lines, nextSeq } = buf.drain(0);
    expect(lines).toEqual(["a", "b", "c"]);
    expect(nextSeq).toBe(3);
  });

  it("drain returns empty array when nothing new since fromSeq", () => {
    const buf = createRingBuffer(10);
    buf.push("a");
    const { lines, nextSeq } = buf.drain(1);
    expect(lines).toEqual([]);
    expect(nextSeq).toBe(1);
  });

  it("push overwrites oldest when full (no element shifting)", () => {
    const buf = createRingBuffer(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d"); // evicts a
    const { lines } = buf.drain(0);
    expect(lines).toEqual(["b", "c", "d"]);
  });

  it("drain returns only retained items when old ones are evicted", () => {
    const buf = createRingBuffer(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    buf.push("e");
    // a, b evicted; only c, d, e retained.
    const { lines, nextSeq } = buf.drain(0);
    expect(lines).toEqual(["c", "d", "e"]);
    expect(nextSeq).toBe(5);
  });

  it("drain returns a copy — mutating the result does not affect the buffer", () => {
    const buf = createRingBuffer(10);
    buf.push("a");
    buf.push("b");
    const { lines } = buf.drain(0);
    lines.push("injected");
    lines[0] = "mutated";
    expect(buf.snapshot()).toEqual(["a", "b"]);
  });

  it("drain returns a copy — pushing after drain does not retroactively add to the result", () => {
    const buf = createRingBuffer(10);
    buf.push("a");
    const first = buf.drain(0);
    buf.push("b");
    expect(first.lines).toEqual(["a"]);
    const second = buf.drain(first.nextSeq);
    expect(second.lines).toEqual(["b"]);
  });

  it("nextSeq advances monotonically", () => {
    const buf = createRingBuffer(5);
    buf.push("a");
    expect(buf.drain(0).nextSeq).toBe(1);
    buf.push("b");
    expect(buf.drain(0).nextSeq).toBe(2);
    buf.push("c");
    buf.push("d");
    expect(buf.drain(0).nextSeq).toBe(4);
  });

  it("snapshot returns all retained items", () => {
    const buf = createRingBuffer(4);
    buf.push("w");
    buf.push("x");
    buf.push("y");
    buf.push("z");
    buf.push("overflow"); // evicts w
    expect(buf.snapshot()).toEqual(["x", "y", "z", "overflow"]);
  });

  it("handles capacity of 1 (edge case)", () => {
    const buf = createRingBuffer(1);
    buf.push("a");
    expect(buf.snapshot()).toEqual(["a"]);
    buf.push("b");
    expect(buf.snapshot()).toEqual(["b"]);
    buf.push("c");
    expect(buf.snapshot()).toEqual(["c"]);
    // drain from 2 should return the only retained item (c, seq=2).
    const { lines, nextSeq } = buf.drain(2);
    expect(lines).toEqual(["c"]);
    expect(nextSeq).toBe(3);
  });
});
