import { type } from "arktype";
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

const parseContent = (contentJson: string): ContentItem[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return [];
  }
  try {
    return ContentItem.array().assert(parsed);
  } catch {
    return [];
  }
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

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

const fmtTokens = (n: number | null): string =>
  n === null ? "-" : n.toLocaleString("en-US");

const formatSessionHeader = (s: SessionRow): string => {
  const name = s.name === "" ? "(unnamed)" : s.name;
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
    const marker = msg.role === "user" ? "▸" : "◆";
    const label = msg.role === "user" ? "PROMPT" : "OUTPUT";
    lines.push(`${marker} ${label}  [${msg.timestamp}]`);
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

export type { ContentItem, ParsedMessage };
export {
  extractTexts,
  fmtTokens,
  formatSessionHeader,
  formatTranscript,
  parseContent,
  parseMessage,
  renderTable,
  truncate,
};
