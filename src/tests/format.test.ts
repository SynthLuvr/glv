import { describe, expect, it } from "vitest";
import {
  extractTexts,
  formatTranscript,
  parseContent,
  renderTable,
  truncate,
} from "../format.js";
import type { ParsedMessage } from "../types.js";

describe("parseContent", () => {
  it("parses an array of content items", () => {
    const items = parseContent(JSON.stringify([{ type: "text", text: "hi" }]));
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("hi");
  });

  it("returns empty array for invalid json", () => {
    expect(parseContent("not json")).toEqual([]);
  });

  it("returns empty array for non-array json", () => {
    expect(parseContent(JSON.stringify({ type: "text" }))).toEqual([]);
  });
});

describe("extractTexts", () => {
  it("keeps only text items", () => {
    const items = parseContent(
      JSON.stringify([
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "toolRequest", id: "1" },
        { type: "text", text: "world" },
      ]),
    );
    expect(extractTexts(items)).toEqual(["hello", "world"]);
  });
});

describe("formatTranscript", () => {
  it("shows prompts and outputs, skipping tool-only messages", () => {
    const messages: ParsedMessage[] = [
      {
        role: "user",
        timestamp: "t1",
        items: [{ type: "text", text: "do thing" }],
      },
      {
        role: "assistant",
        timestamp: "t2",
        items: [
          { type: "thinking", thinking: "plan" },
          { type: "toolRequest", id: "1" },
        ],
      },
      {
        role: "user",
        timestamp: "t3",
        items: [{ type: "toolResponse", id: "1" }],
      },
      {
        role: "assistant",
        timestamp: "t4",
        items: [{ type: "text", text: "done" }],
      },
    ];
    const out = formatTranscript(messages);
    expect(out).toContain("PROMPT");
    expect(out).toContain("do thing");
    expect(out).toContain("OUTPUT");
    expect(out).toContain("done");
    expect(out).not.toContain("plan");
    expect((out.match(/PROMPT/g) ?? []).length).toBe(1);
    expect((out.match(/OUTPUT/g) ?? []).length).toBe(1);
  });

  it("returns empty string when there are no text messages", () => {
    const messages: ParsedMessage[] = [
      { role: "user", timestamp: "t", items: [{ type: "toolResponse" }] },
    ];
    expect(formatTranscript(messages)).toBe("");
  });
});

describe("renderTable", () => {
  it("renders a header row followed by data rows", () => {
    const out = renderTable(
      ["ID", "Name"],
      [
        ["1", "a"],
        ["22", "bb"],
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[1]).toContain("1");
    expect(lines[2]).toContain("22");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("truncates long strings with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});
