import type { SessionRow } from "../sessions.js";
import {
  extractTexts,
  MESSAGE_TAGS,
  messageKind,
  type ParsedMessage,
} from "./message.js";
import { fmtTokens, truncate } from "./text.js";

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
    const tag = MESSAGE_TAGS[messageKind(msg.role, msg.items)];
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

export { displayName, formatSessionHeader, formatTranscript, renderTable };
