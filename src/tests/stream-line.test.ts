import { describe, expect, it } from "vitest";
import { renderStreamLine } from "../views/stream-line.js";

describe("renderStreamLine", () => {
  it("renders an assistant text message as markdown HTML", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Hello **world**" }],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("stream-line");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("markdown-wrap");
    expect(html).toContain("copy-md-btn");
    expect(html).toContain('data-md="Hello **world**"');
  });

  it("renders a user prompt as plain text with a copy-as-markdown button", () => {
    const line = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "What is goose?" }],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("PROMPT");
    expect(html).toContain("What is goose?");
    // Plain-text bubble (not parsed markdown), but still copyable.
    expect(html).toContain("copy-md-btn");
    expect(html).toContain('data-md="What is goose?"');
    expect(html).not.toContain("<strong>");
  });

  it("renders thinking blocks", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me consider..." }],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("Thinking");
    expect(html).toContain("Let me consider...");
  });

  it("renders tool calls with name, extension and arguments", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [
        {
          type: "toolRequest",
          toolCall: {
            value: {
              name: "shell",
              arguments: { command: "echo hi" },
            },
          },
          _meta: { goose_extension: "developer" },
        },
      ],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("shell");
    expect(html).toContain("developer");
    expect(html).toContain("echo hi");
    expect(html).toContain("<details");
  });

  it("renders tool results", () => {
    const line = JSON.stringify({
      role: "user",
      content: [
        {
          type: "toolResponse",
          toolResult: {
            value: {
              content: [{ type: "text", text: "Build succeeded" }],
              isError: false,
            },
          },
        },
      ],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("Result");
    expect(html).toContain("Build succeeded");
  });

  it("marks error tool results with is-error class", () => {
    const line = JSON.stringify({
      role: "user",
      content: [
        {
          type: "toolResponse",
          toolResult: {
            value: {
              content: [{ type: "text", text: "File not found" }],
              isError: true,
            },
          },
        },
      ],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("is-error");
    expect(html).toContain("Error result");
    expect(html).toContain("File not found");
  });

  it("tags tool-response messages as tool activity", () => {
    const line = JSON.stringify({
      role: "user",
      content: [
        {
          type: "toolResponse",
          toolResult: {
            value: {
              content: [{ type: "text", text: "ok" }],
              isError: false,
            },
          },
        },
      ],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("⟳ TOOL");
  });

  it("renders non-JSON lines as raw text", () => {
    const html = renderStreamLine("not valid json at all");
    expect(html).toContain("stream-raw");
    expect(html).toContain("not valid json at all");
  });

  it("escapes HTML in plain-text content", () => {
    const line = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "<script>alert(1)</script>" }],
    });
    const html = renderStreamLine(line);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns empty string for lines without a content array", () => {
    const line = JSON.stringify({
      type: "session.header",
      session_id: "abc123",
    });
    expect(renderStreamLine(line)).toBe("");
  });

  it("returns empty string for lines with empty content", () => {
    const line = JSON.stringify({ role: "assistant", content: [] });
    expect(renderStreamLine(line)).toBe("");
  });

  it("handles multiple content items in one line", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "planning" },
        { type: "text", text: "Step 1" },
      ],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("Thinking");
    expect(html).toContain("planning");
    expect(html).toContain("Step 1");
  });

  it("skips content items with no renderable text", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
    expect(renderStreamLine(line)).toBe("");
  });

  it("defaults to assistant role when role is missing", () => {
    const line = JSON.stringify({
      content: [{ type: "text", text: "No role specified" }],
    });
    const html = renderStreamLine(line);
    expect(html).toContain("OUTPUT");
    expect(html).toContain("No role specified");
  });
});
