import { type } from "arktype";
import type { MessageRow } from "../sessions.js";

const ContentItem = type({
  type: "string",
  "text?": "string",
});

type ContentItem = typeof ContentItem.infer;

// ContentItem is intentionally permissive so any item type parses through.
// The richer shapes below are asserted per-accessor (never cast) so the
// viewer stays robust across schema drift between agent versions.
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

// Runtime guard over raw (unvalidated) tool-result content, so the same
// text-extraction strategy serves both validated items and raw arrays.
const isTextItem = (item: unknown): item is { text: string } =>
  item !== null &&
  typeof item === "object" &&
  (item as { type?: unknown }).type === "text" &&
  typeof (item as { text?: unknown }).text === "string";

const extractTexts = (items: readonly unknown[]): string[] =>
  items.flatMap((item) => (isTextItem(item) ? [item.text] : []));

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return extractTexts(content).join("\n");
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

type MessageKind = "prompt" | "output" | "tool" | "context" | "summary";

const MESSAGE_TAGS: Record<MessageKind, string> = {
  prompt: "▸ PROMPT",
  output: "◆ OUTPUT",
  tool: "⟳ TOOL",
  context: "◇ CONTEXT",
  summary: "◌ SUMMARY",
};

// goose injects each turn's context as its own user message that is
// nothing but this block; prompts that merely mention the tag stay prompts.
const isTurnContextMessage = (items: readonly ContentItem[]): boolean =>
  items.length === 1 &&
  items[0].type === "text" &&
  /^\s*<turn-context>[\s\S]*<\/turn-context>\s*$/.test(items[0].text ?? "");

// A user-role message that only carries a tool response is really tool
// activity, not a prompt — label it neutrally instead of mis-tagging it.
// Resuming a goose session compacts the replayed history into user-role
// messages shaped [thinking, text]: the model's reasoning about the
// summary plus the compacted text (verified in a real sessions.db, e.g.
// session 20260829_80). Authored prompts never carry thinking items, so
// any user message with one is machine-injected replay, not a prompt.
const messageKind = (role: string, items: ContentItem[]): MessageKind => {
  if (items.some((item) => item.type === "toolResponse")) return "tool";
  if (role === "user" && isTurnContextMessage(items)) return "context";
  if (role === "user" && items.some((item) => item.type === "thinking"))
    return "summary";
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
  MESSAGE_TAGS,
  messageKind,
  parseContent,
  parseMessage,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
};
