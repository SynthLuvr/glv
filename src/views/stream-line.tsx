import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { messageKind, parseContent } from "../format/index.js";
import { itemBlock, tagFor } from "./message-blocks.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const renderStreamLine = (line: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "";
  }

  // Discard anything that isn't a valid message record — raw banner text,
  // scalars, and envelope wrappers alike produce no preview.
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return "";

  const items = parseContent(JSON.stringify(parsed.content));
  if (items.length === 0) return "";

  const role = typeof parsed.role === "string" ? parsed.role : "assistant";
  const kind = messageKind(role, items);
  const blocks = items
    .map((item) => itemBlock(item, kind === "output"))
    .filter((node): node is Child => node !== null);

  if (blocks.length === 0) return "";

  return renderToString(
    <article class={`message ${kind} stream-line`}>
      <div class="message-head">
        <span class={`tag ${kind}`}>{tagFor(kind)}</span>
      </div>
      <div class="message-body">{blocks}</div>
    </article>,
  );
};

export { renderStreamLine };
