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

type MessageKind = "prompt" | "output" | "tool";

// A user-role message that only carries a tool response is really tool
// activity, not a prompt — label it neutrally instead of mis-tagging it.
const messageKind = (role: string, items: ContentItem[]): MessageKind => {
  if (items.some((item) => item.type === "toolResponse")) return "tool";
  return role === "user" ? "prompt" : "output";
};

// Matches the target of a `cd <dir>` inside a shell command. Stops at a space
// or shell metacharacter so chained commands (`cd /x && git status`) yield just
// the directory.
const CD_TARGET = /\bcd\s+([^&|;\s]+)/g;

const isStringRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (args: unknown, key: string): string | undefined => {
  if (!isStringRecord(args)) return undefined;
  const value = args[key];
  return typeof value === "string" ? value : undefined;
};

const dirsFromCommand = (command: string): string[] => {
  const out: string[] = [];
  for (const match of command.matchAll(CD_TARGET))
    if (match[1].startsWith("/")) out.push(match[1]);
  return out;
};

// Absolute working-directory signals from a tool call: a `cd <path>` in a shell
// command plus `cwd`/`path`/`working_dir` args. Relative paths are ignored —
// they can't be matched to a worktree root.
const dirsFromToolCall = (info: ToolCallInfo): string[] => {
  const out: string[] = [];
  for (const key of ["cwd", "path", "working_dir"] as const) {
    const value = stringField(info.args, key);
    if (value !== undefined && value.startsWith("/")) out.push(value);
  }
  const command = stringField(info.args, "command");
  if (command !== undefined) out.push(...dirsFromCommand(command));
  return out;
};

// Working-directory paths referenced in a transcript, ordered
// most-recent-first. Lets git discovery recover the branch a session actually
// worked in when it was launched from a different worktree (e.g. goose run
// from `main`, then `git worktree add` and work there).
const extractCandidatePaths = (
  messages: readonly ParsedMessage[],
): string[] => {
  const ordered: string[] = [];
  for (const message of messages)
    for (const item of message.items) {
      const info = toolCallInfo(item);
      if (info !== undefined) ordered.push(...dirsFromToolCall(info));
    }
  return ordered.reverse();
};

export type {
  ContentItem,
  MessageKind,
  ParsedMessage,
  ToolCallInfo,
  ToolResultInfo,
};
export {
  extractCandidatePaths,
  extractTexts,
  messageKind,
  parseContent,
  parseMessage,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
};
