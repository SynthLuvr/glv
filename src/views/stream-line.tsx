import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { messageKind, parseContent } from "../format/index.js";
import { tryParseJson } from "../parse.js";
import { itemBlock, tagFor } from "./message-blocks.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const renderStreamLine = (line: string): string => {
  const parsed = tryParseJson(line);
  // Only message records with a content array preview; raw stdout is
  // discarded. claude stream-json nests role/content under "message".
  if (parsed === null || !isRecord(parsed)) return "";
  const message = parsed.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return "";

  const items = parseContent(JSON.stringify(message.content));
  if (items.length === 0) return "";

  const role = typeof message.role === "string" ? message.role : "assistant";
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
