import { type } from "arktype";
import type { MessageRow } from "../db.js";

const ContentItem = type({
  type: "string",
  "text?": "string",
});

type ContentItem = typeof ContentItem.infer;

// ContentItem is intentionally permissive so any item type parses through.
// The richer shapes below are asserted per-accessor (never cast) so the
// viewer stays robust across schema drift between goose versions.
const ThinkingItem = type({
  type: "'thinking'",
  "thinking?": "string",
});

const ToolRequestItem = type({
  type: "'toolRequest'",
  "toolCall?": {
    "value?": {
      "name?": "string",
      "arguments?": "unknown",
    },
  },
  "_meta?": {
    "goose_extension?": "string",
  },
});

const ToolResponseItem = type({
  type: "'toolResponse'",
  "toolResult?": {
    "value?": {
      "content?": "unknown",
      "isError?": "boolean",
    },
  },
});

const TextEntry = type({
  type: "'text'",
  text: "string",
});

type ParsedMessage = {
  role: string;
  timestamp: string;
  items: ContentItem[];
};

const ContentItems = type("string")
  .pipe((content, ctx) => {
    try {
      return JSON.parse(content);
    } catch {
      return ctx.error("invalid content_json");
    }
  })
  .pipe(ContentItem.array());

const parseContent = (contentJson: string): ContentItem[] => {
  const out = ContentItems(contentJson);
  if (out instanceof type.errors) return [];
  return out;
};

const parseMessage = (row: MessageRow): ParsedMessage => ({
  role: row.role,
  timestamp: row.timestamp,
  items: parseContent(row.content_json),
});

const extractTexts = (items: ContentItem[]): string[] =>
  items.flatMap((item) =>
    item.type === "text" && item.text !== undefined ? [item.text] : [],
  );

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    const parsed = TextEntry(entry);
    if (parsed instanceof type.errors) continue;
    parts.push(parsed.text);
  }
  return parts.join("\n");
};

const thinkingText = (item: ContentItem): string | undefined => {
  if (item.type !== "thinking") return;
  const parsed = ThinkingItem(item);
  if (parsed instanceof type.errors) return undefined;
  return parsed.thinking;
};

type ToolCallInfo = {
  name: string;
  args: unknown;
  extension: string | null;
};

const toolCallInfo = (item: ContentItem): ToolCallInfo | undefined => {
  if (item.type !== "toolRequest") return;
  const parsed = ToolRequestItem(item);
  if (parsed instanceof type.errors) return undefined;
  const value = parsed.toolCall?.value;
  return {
    name: value?.name ?? "tool",
    args: value?.arguments ?? {},
    extension: parsed._meta?.goose_extension ?? null,
  };
};

type ToolResultInfo = {
  text: string;
  isError: boolean;
};

const toolResultInfo = (item: ContentItem): ToolResultInfo | undefined => {
  if (item.type !== "toolResponse") return;
  const parsed = ToolResponseItem(item);
  if (parsed instanceof type.errors) return undefined;
  const value = parsed.toolResult?.value;
  return {
    text: contentToText(value?.content),
    isError: value?.isError === true,
  };
};

type MessageKind = "prompt" | "output" | "tool";

// A user-role message that only carries a tool response is really tool
// activity, not a prompt — label it neutrally instead of mis-tagging it.
const messageKind = (role: string, items: ContentItem[]): MessageKind => {
  if (items.some((item) => item.type === "toolResponse")) return "tool";
  return role === "user" ? "prompt" : "output";
};

export type {
  ContentItem,
  MessageKind,
  ParsedMessage,
  ToolCallInfo,
  ToolResultInfo,
};
export {
  extractTexts,
  messageKind,
  parseContent,
  parseMessage,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
};
