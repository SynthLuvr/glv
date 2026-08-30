import { type } from "arktype";
import { isRecord } from "../parse.js";
import type { MessageRow } from "../sessions.js";
import type { ToolRun } from "./duration.js";
import { parseTimestamp } from "./text.js";

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

// Argument keys that carry a tool timeout, paired with their unit: goose's
// shell tools take seconds (timeout_secs), claude's Bash takes minutes
// under bare `timeout`. Unknown spellings simply leave the timeout leg off.
const TIMEOUT_ARG_KEYS: ReadonlyArray<readonly [string, boolean]> = [
  ["timeout_secs", false],
  ["timeout_sec", false],
  ["timeout_seconds", false],
  ["timeout", true],
];

const timeoutFromArgs = (args: unknown): number | undefined => {
  if (!isRecord(args)) return undefined;
  for (const [key, minutes] of TIMEOUT_ARG_KEYS) {
    const raw = args[key];
    if (raw === undefined) continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value) && value > 0)
      return minutes ? value * 60 : value;
  }
  return undefined;
};

// A tool call is in flight when the newest message is an assistant row
// carrying tool requests: the answering toolResponse always lands as its
// own (user-role) row, so any row after the request means it finished.
// Trailing empty rows are skipped so a half-written transcript still reads;
// anything else at the tail (a prompt, a plain reply) means no pending call.
const pendingTool = (
  messages: readonly ParsedMessage[],
): ToolRun | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.items.length === 0) continue;
    if (message.role === "user") return undefined;
    const infos = message.items
      .map(toolCallInfo)
      .filter((info): info is ToolCallInfo => info !== undefined);
    if (infos.length === 0) return undefined;
    const startMs = parseTimestamp(message.timestamp);
    if (Number.isNaN(startMs)) return undefined;
    const timeouts = infos
      .map((info) => timeoutFromArgs(info.args))
      .filter((t): t is number => t !== undefined);
    const last = infos[infos.length - 1];
    return {
      name: last.name,
      count: infos.length,
      startMs,
      timeoutSec: timeouts.length === 0 ? undefined : Math.max(...timeouts),
    };
  }
  return undefined;
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

// Resuming a goose session compacts the replayed history into user
// messages shaped [thinking, text]: the model's reasoning about the
// summary plus the compacted text (verified in a real sessions.db).
// Authored prompts never carry thinking items, so a user message with
// one is machine-injected replay, not a prompt.
const isCompactedSummary = (items: readonly ContentItem[]): boolean =>
  items.some((item) => item.type === "thinking");

// A user-role message that only carries a tool response is really tool
// activity, not a prompt — label it neutrally instead of mis-tagging it.
const messageKind = (role: string, items: ContentItem[]): MessageKind => {
  if (items.some((item) => item.type === "toolResponse")) return "tool";
  if (role !== "user") return "output";
  if (isTurnContextMessage(items)) return "context";
  if (isCompactedSummary(items)) return "summary";
  return "prompt";
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
  pendingTool,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
};
