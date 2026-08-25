import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import {
  MESSAGE_TAGS,
  messageKind,
  parseContent,
} from "../../glv/format/index.js";
import { isRecord, JsonObject, parseJson } from "../../glv/parse.js";
import type { StreamEnvelope } from "../profile.js";
import { itemBlock } from "./message-blocks.js";

const renderStreamLine = (line: string, envelope: StreamEnvelope): string => {
  const parsed = parseJson(line, JsonObject);
  // Only message records with a content array preview; raw stdout is
  // discarded. The agent's stream dialect decides the envelope: records in
  // any other shape are foreign and dropped — support for stray top-level
  // envelopes in nested-dialect streams was deliberately removed.
  if (!parsed.ok) return "";
  const record = parsed.data;
  const message =
    envelope === "message"
      ? isRecord(record.message)
        ? record.message
        : undefined
      : record;
  if (message === undefined || !Array.isArray(message.content)) return "";

  const items = parseContent(JSON.stringify(message.content));
  if (items.length === 0) return "";

  const role = typeof message.role === "string" ? message.role : "assistant";
  const kind = messageKind(role, items);
  const blocks = items
    .map((item) => itemBlock(item, kind))
    .filter((node): node is Child => node !== null);

  if (blocks.length === 0) return "";

  return renderToString(
    <article class={`message ${kind} stream-line`}>
      <div class="message-head">
        <span class={`tag ${kind}`}>{MESSAGE_TAGS[kind]}</span>
      </div>
      <div class="message-body">{blocks}</div>
    </article>,
  );
};

export { renderStreamLine };
