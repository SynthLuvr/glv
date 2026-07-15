import {
  type ContentItem,
  type MessageKind,
  messageKind,
  parseContent,
  renderMarkdown,
  type ToolCallInfo,
  type ToolResultInfo,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
  truncate,
} from "../format.js";

const tagFor = (kind: MessageKind): string => {
  if (kind === "prompt") return "▸ PROMPT";
  if (kind === "output") return "◆ OUTPUT";
  return "⟳ TOOL";
};

const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const formatArgs = (args: unknown, pretty: boolean): string => {
  if (typeof args === "string") return args;
  if (args === null) return "null";
  if (typeof args === "number" || typeof args === "boolean")
    return String(args);
  if (typeof args === "object")
    try {
      return pretty ? JSON.stringify(args, null, 2) : JSON.stringify(args);
    } catch {
      return "[unserializable]";
    }

  return "";
};

const renderTextItem = (text: string, markdown: boolean): string =>
  markdown
    ? `<div class="markdown">${renderMarkdown(text)}</div>`
    : `<p class="message-text">${escapeHtml(text)}</p>`;

const renderThinkingItem = (text: string): string =>
  `<details class="block thinking">` +
  `<summary><span class="block-icon">💭</span> ` +
  `<span class="block-label">Thinking</span></summary>` +
  `<div class="block-content">${escapeHtml(text)}</div></details>`;

const renderToolCallItem = (info: ToolCallInfo): string => {
  const ext =
    info.extension !== null
      ? `<span class="tool-ext">${escapeHtml(info.extension)}</span>`
      : "";
  const preview = escapeHtml(truncate(formatArgs(info.args, false), 90));
  const body = escapeHtml(formatArgs(info.args, true));
  return (
    `<details class="block tool-call">` +
    `<summary><span class="block-icon">🔧</span> ` +
    `<span class="tool-name">${escapeHtml(info.name)}</span> ${ext}` +
    `<span class="block-preview">${preview}</span></summary>` +
    `<pre><code>${body}</code></pre></details>`
  );
};

const renderToolResultItem = (info: ToolResultInfo): string => {
  const icon = info.isError ? "⚠️" : "📋";
  const label = info.isError ? "Error result" : "Result";
  const cls = info.isError ? "block tool-result is-error" : "block tool-result";
  const open = info.isError ? " open" : "";
  const preview = escapeHtml(
    truncate(info.text.replace(/\s+/g, " ").trim(), 100),
  );
  return (
    `<details class="${cls}"${open}>` +
    `<summary><span class="block-icon">${icon}</span> ` +
    `<span class="block-label">${label}</span>` +
    `<span class="block-preview">${preview}</span></summary>` +
    `<pre>${escapeHtml(info.text)}</pre></details>`
  );
};

const renderItem = (item: ContentItem, markdown: boolean): string | null => {
  switch (item.type) {
    case "text":
      if (item.text === undefined || item.text === "") return null;
      return renderTextItem(item.text, markdown);
    case "thinking": {
      const text = thinkingText(item);
      return text !== undefined ? renderThinkingItem(text) : null;
    }
    case "toolRequest": {
      const info = toolCallInfo(item);
      return info !== undefined ? renderToolCallItem(info) : null;
    }
    case "toolResponse": {
      const info = toolResultInfo(item);
      return info !== undefined ? renderToolResultItem(info) : null;
    }
    default:
      return null;
  }
};

// Renders a single goose stream-json NDJSON line as an HTML fragment.
// Lines without renderable content return "" (silently skipped by the caller).
// Non-JSON lines fall back to a raw <pre>-style block for visibility.
const renderStreamLine = (line: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return `<p class="stream-raw">${escapeHtml(line)}</p>`;
  }

  if (typeof parsed !== "object" || parsed === null)
    return `<p class="stream-raw">${escapeHtml(line)}</p>`;

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return "";

  const items = parseContent(JSON.stringify(obj.content));
  if (items.length === 0) return "";

  const role = typeof obj.role === "string" ? obj.role : "assistant";
  const kind = messageKind(role, items);
  const blocks = items
    .map((item) => renderItem(item, kind === "output"))
    .filter((html): html is string => html !== null);

  if (blocks.length === 0) return "";

  return (
    `<article class="message ${kind} stream-line">` +
    `<div class="message-head">` +
    `<span class="tag ${kind}">${tagFor(kind)}</span>` +
    `</div>` +
    `<div class="message-body">${blocks.join("")}</div>` +
    `</article>`
  );
};

export { renderStreamLine };
