import { type } from "arktype";
import { marked } from "marked";
import type { MessageRow, SessionRow } from "./db.js";

const ContentItem = type({
  type: "string",
  "text?": "string",
});

type ContentItem = typeof ContentItem.infer;

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

// ContentItem only models the `text` block in its schema, but real goose
// messages carry thinking blocks, tool calls and tool results too. These
// accessors read those richer shapes defensively (casting through a record)
// so the viewer stays robust across schema drift between goose versions.
const asRecord = (item: ContentItem): Record<string, unknown> =>
  item as Record<string, unknown>;

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content)
    if (entry !== null && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string")
        parts.push(obj.text);
    }

  return parts.join("\n");
};

const thinkingText = (item: ContentItem): string | undefined => {
  if (item.type !== "thinking") return;
  const text = asRecord(item).thinking;
  return typeof text === "string" ? text : undefined;
};

type ToolCallInfo = {
  name: string;
  args: unknown;
  extension: string | null;
};

const toolCallInfo = (item: ContentItem): ToolCallInfo | undefined => {
  if (item.type !== "toolRequest") return;
  const call = asRecord(item).toolCall as
    | { value?: Record<string, unknown> }
    | undefined;
  const value = call?.value;
  const name =
    value !== undefined && typeof value.name === "string" ? value.name : "tool";
  const meta = asRecord(item)._meta as
    | { goose_extension?: unknown }
    | undefined;
  const extension =
    meta !== undefined && typeof meta.goose_extension === "string"
      ? meta.goose_extension
      : null;
  return { name, args: value?.arguments ?? {}, extension };
};

type ToolResultInfo = {
  text: string;
  isError: boolean;
};

const toolResultInfo = (item: ContentItem): ToolResultInfo | undefined => {
  if (item.type !== "toolResponse") return;
  const result = asRecord(item).toolResult as
    | { value?: Record<string, unknown> }
    | undefined;
  const value = result?.value;
  const isError =
    value !== undefined && typeof value.isError === "boolean"
      ? value.isError
      : false;
  return { text: contentToText(value?.content), isError };
};

type MessageKind = "prompt" | "output" | "tool";

// A user-role message that only carries a tool response is really tool
// activity, not a prompt — label it neutrally instead of mis-tagging it.
const messageKind = (role: string, items: ContentItem[]): MessageKind => {
  if (items.some((item) => item.type === "toolResponse")) return "tool";
  return role === "user" ? "prompt" : "output";
};

// Assistant prose is Markdown; render it to HTML. The data comes from the
// user's own local session logs, so marked's output is trusted as-is.
const renderMarkdown = (md: string): string =>
  marked.parse(md, { gfm: true, breaks: true }) as string;

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const truncateMiddle = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = Math.floor((max - 1) * 0.4);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
};

const fmtTokens = (n: number | null): string =>
  n === null ? "-" : n.toLocaleString("en-US");

const formatDate = (epoch: number, now: number): string => {
  const date = new Date(epoch);
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (date.getFullYear() !== new Date(now).getFullYear())
    options.year = "numeric";
  return date.toLocaleDateString("en-US", options);
};

const fmtRelative = (timestamp: string, now: number = Date.now()): string => {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return timestamp;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return formatDate(then, now);
};

const displayName = (name: string): string =>
  name === "" ? "(unnamed)" : name;

const formatSessionHeader = (s: SessionRow): string => {
  const name = displayName(s.name);
  const lines = [
    `Session: ${s.id} — ${name}`,
    `Working dir: ${s.working_dir}`,
    `Updated: ${s.updated_at}`,
    `Tokens: ${fmtTokens(s.total_tokens)}`,
  ];
  if (s.provider_name !== null) lines.push(`Provider: ${s.provider_name}`);
  return lines.join("\n");
};

const formatTranscript = (messages: ParsedMessage[]): string => {
  const lines: string[] = [];
  for (const msg of messages) {
    const texts = extractTexts(msg.items);
    if (texts.length === 0) continue;
    const tag = msg.role === "user" ? "▸ PROMPT" : "◆ OUTPUT";
    lines.push(`${tag}  [${msg.timestamp}]`);
    lines.push(texts.join("\n"));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
};

const renderTable = (
  headers: string[],
  rows: string[][],
  maxColumnWidth = 40,
): string => {
  const widths = headers.map((header, i) => {
    const cellLens = rows.map((r) => r[i]?.length ?? 0);
    return Math.min(Math.max(header.length, ...cellLens), maxColumnWidth);
  });
  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => truncate(c, widths[i]).padEnd(widths[i])).join("  ");
  return [fmtRow(headers), ...rows.map(fmtRow)].join("\n");
};

export type {
  ContentItem,
  MessageKind,
  ParsedMessage,
  ToolCallInfo,
  ToolResultInfo,
};
export {
  contentToText,
  displayName,
  extractTexts,
  fmtRelative,
  fmtTokens,
  formatSessionHeader,
  formatTranscript,
  messageKind,
  parseContent,
  parseMessage,
  renderMarkdown,
  renderTable,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
  truncate,
  truncateMiddle,
};
