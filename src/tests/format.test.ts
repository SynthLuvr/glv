import { describe, expect, it } from "vitest";
import type { ContentItem } from "../format.js";
import {
  fmtRelative,
  messageKind,
  renderMarkdown,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
  truncateMiddle,
} from "../format.js";

// The accessors narrow the permissive ContentItem shape; tests build raw items
// and cast through unknown so they read like real parsed content blocks.
const item = (obj: Record<string, unknown>): ContentItem =>
  obj as unknown as ContentItem;

describe("renderMarkdown", () => {
  it("renders headings, bold and inline code", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** `code`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = 1;");
  });

  it("passes plain text through as a paragraph", () => {
    expect(renderMarkdown("just text")).toContain("just text");
  });
});

describe("fmtRelative", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const ago = (ms: number): string => new Date(now - ms).toISOString();

  it("says 'just now' for very recent times", () => {
    expect(fmtRelative(ago(20_000), now)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(fmtRelative(ago(5 * 60_000), now)).toBe("5m ago");
  });

  it("formats hours", () => {
    expect(fmtRelative(ago(3 * 3_600_000), now)).toBe("3h ago");
  });

  it("formats days", () => {
    expect(fmtRelative(ago(2 * 86_400_000), now)).toBe("2d ago");
  });

  it("formats weeks", () => {
    expect(fmtRelative(ago(14 * 86_400_000), now)).toBe("2w ago");
  });

  it("falls back to the raw value when unparseable", () => {
    expect(fmtRelative("not-a-date", now)).toBe("not-a-date");
  });
});

describe("messageKind", () => {
  it("classifies user text as a prompt", () => {
    expect(messageKind("user", [item({ type: "text", text: "hi" })])).toBe(
      "prompt",
    );
  });

  it("classifies assistant text as output", () => {
    expect(messageKind("assistant", [item({ type: "text", text: "hi" })])).toBe(
      "output",
    );
  });

  it("classifies tool responses as tool activity regardless of role", () => {
    expect(messageKind("user", [item({ type: "toolResponse", id: "1" })])).toBe(
      "tool",
    );
  });
});

describe("toolCallInfo", () => {
  it("extracts name, arguments and extension", () => {
    const info = toolCallInfo(
      item({
        type: "toolRequest",
        toolCall: {
          status: "success",
          value: { name: "shell", arguments: { command: "ls" } },
        },
        _meta: { goose_extension: "developer" },
      }),
    );
    expect(info).toEqual({
      name: "shell",
      args: { command: "ls" },
      extension: "developer",
    });
  });

  it("defaults the name to 'tool' when missing", () => {
    const info = toolCallInfo(
      item({ type: "toolRequest", toolCall: { value: {} } }),
    );
    expect(info?.name).toBe("tool");
    expect(info?.extension).toBeNull();
  });

  it("returns undefined for non-tool-request items", () => {
    expect(toolCallInfo(item({ type: "text", text: "x" }))).toBeUndefined();
  });
});

describe("toolResultInfo", () => {
  it("extracts text and isError from content", () => {
    const info = toolResultInfo(
      item({
        type: "toolResponse",
        toolResult: {
          status: "success",
          value: {
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        },
      }),
    );
    expect(info).toEqual({ text: "ok", isError: false });
  });

  it("flags error results", () => {
    const info = toolResultInfo(
      item({
        type: "toolResponse",
        toolResult: {
          value: {
            content: [{ type: "text", text: "boom" }],
            isError: true,
          },
        },
      }),
    );
    expect(info?.isError).toBe(true);
  });

  it("returns undefined for non-tool-response items", () => {
    expect(toolResultInfo(item({ type: "text" }))).toBeUndefined();
  });
});

describe("thinkingText", () => {
  it("extracts the reasoning text", () => {
    expect(
      thinkingText(item({ type: "thinking", thinking: "reasoning" })),
    ).toBe("reasoning");
  });

  it("returns undefined for other item types", () => {
    expect(thinkingText(item({ type: "text", text: "x" }))).toBeUndefined();
  });
});

describe("truncateMiddle", () => {
  it("leaves short strings untouched", () => {
    expect(truncateMiddle("/tmp/alpha", 40)).toBe("/tmp/alpha");
  });

  it("keeps the start and end of long strings", () => {
    const out = truncateMiddle("abcdefghijklmnopqrstuvwxyz", 11);
    expect(out).toHaveLength(11);
    expect(out).toContain("…");
    expect(out.startsWith("abcdef")).toBe(true);
    expect(out.endsWith("xyz")).toBe(true);
  });
});
