import type { Child } from "hono/jsx";
import { raw } from "hono/utils/html";
import type { SessionRow } from "../db.js";
import type {
  ContentItem,
  MessageKind,
  ParsedMessage,
  ToolCallInfo,
  ToolResultInfo,
} from "../format.js";
import {
  displayName,
  fmtRelative,
  fmtTokens,
  messageKind,
  renderMarkdown,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
  truncate,
  truncateMiddle,
} from "../format.js";

const jsonString = (value: object, pretty: boolean): string => {
  try {
    return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const formatToolArgs = (args: unknown, pretty: boolean): string => {
  if (typeof args === "string") return args;
  if (args === null) return "null";
  if (typeof args === "number" || typeof args === "boolean")
    return String(args);
  if (typeof args === "object") return jsonString(args, pretty);
  return "";
};

const TextBlock = ({
  text,
  asMarkdown,
}: {
  text: string;
  asMarkdown: boolean;
}) =>
  asMarkdown ? (
    <div class="markdown">{raw(renderMarkdown(text))}</div>
  ) : (
    <p class="message-text">{text}</p>
  );

const ThinkingBlock = ({ text }: { text: string }) => (
  <details class="block thinking">
    <summary>
      <span class="block-icon">💭</span>
      <span class="block-label">Thinking</span>
    </summary>
    <div class="block-content">{text}</div>
  </details>
);

const ToolCallBlock = ({ info }: { info: ToolCallInfo }) => {
  const body = formatToolArgs(info.args, true);
  const preview = truncate(formatToolArgs(info.args, false), 90);
  return (
    <details class="block tool-call">
      <summary>
        <span class="block-icon">🔧</span>
        <span class="tool-name">{info.name}</span>
        {info.extension !== null && (
          <span class="tool-ext">{info.extension}</span>
        )}
        <span class="block-preview">{preview}</span>
      </summary>
      <pre>
        <code>{body}</code>
      </pre>
    </details>
  );
};

const ToolResultBlock = ({ info }: { info: ToolResultInfo }) => (
  <details
    class={`block tool-result${info.isError ? " is-error" : ""}`}
    open={info.isError ? true : undefined}
  >
    <summary>
      <span class="block-icon">{info.isError ? "⚠️" : "📋"}</span>
      <span class="block-label">
        {info.isError ? "Error result" : "Result"}
      </span>
      <span class="block-preview">
        {truncate(info.text.replace(/\s+/g, " ").trim(), 100)}
      </span>
    </summary>
    <pre>{info.text}</pre>
  </details>
);

const renderThinking = (item: ContentItem): Child | null => {
  const text = thinkingText(item);
  return text === undefined ? null : <ThinkingBlock text={text} />;
};

const renderToolCall = (item: ContentItem): Child | null => {
  const info = toolCallInfo(item);
  return info === undefined ? null : <ToolCallBlock info={info} />;
};

const renderToolResult = (item: ContentItem): Child | null => {
  const info = toolResultInfo(item);
  return info === undefined ? null : <ToolResultBlock info={info} />;
};

// Walk a message's content items in order, rendering each by type so the full
// conversation (text, reasoning, tool calls, tool results) is visible.
const itemBlock = (item: ContentItem, markdown: boolean): Child | null => {
  if (item.type === "text")
    return item.text !== undefined && item.text !== "" ? (
      <TextBlock text={item.text} asMarkdown={markdown} />
    ) : null;
  if (item.type === "thinking") return renderThinking(item);
  if (item.type === "toolRequest") return renderToolCall(item);
  if (item.type === "toolResponse") return renderToolResult(item);
  return null;
};

const tagFor = (kind: MessageKind): string => {
  if (kind === "prompt") return "▸ PROMPT";
  if (kind === "output") return "◆ OUTPUT";
  return "⟳ TOOL";
};

const MessageView = ({ message }: { message: ParsedMessage }) => {
  const kind = messageKind(message.role, message.items);
  const blocks = message.items
    .map((item) => itemBlock(item, kind === "output"))
    .filter((node): node is Child => node !== null);
  if (blocks.length === 0) return null;
  return (
    <article class={`message ${kind}`}>
      <div class="message-head">
        <span class={`tag ${kind}`}>{tagFor(kind)}</span>
        <time title={message.timestamp}>{fmtRelative(message.timestamp)}</time>
      </div>
      <div class="message-body">{blocks}</div>
    </article>
  );
};

const hasContent = (message: ParsedMessage): boolean =>
  message.items.some((item) => itemBlock(item, false) !== null);

const MetaChip = ({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) => (
  <div class="meta-chip" title={title ?? value}>
    <span class="meta-label">{label}</span>
    <span class={`meta-value${mono ? " mono" : ""}`}>{value}</span>
  </div>
);

const TranscriptHeader = ({
  session,
  messageCount,
}: {
  session: SessionRow;
  messageCount: number;
}) => (
  <header class="session-header">
    <h2>{displayName(session.name)}</h2>
    <div class="session-meta">
      <MetaChip label="ID" value={session.id} mono />
      <MetaChip
        label="Working dir"
        value={truncateMiddle(session.working_dir, 48)}
        mono
        title={session.working_dir}
      />
      <MetaChip
        label="Created"
        value={fmtRelative(session.created_at)}
        title={session.created_at}
      />
      <MetaChip
        label="Updated"
        value={fmtRelative(session.updated_at)}
        title={session.updated_at}
      />
      <MetaChip label="Messages" value={String(messageCount)} />
      <MetaChip label="Tokens" value={fmtTokens(session.total_tokens)} />
      {session.provider_name !== null && (
        <MetaChip label="Provider" value={session.provider_name} />
      )}
    </div>
  </header>
);

const Transcript = ({
  session,
  messages,
}: {
  session: SessionRow;
  messages: ParsedMessage[];
}) => {
  const visible = messages.filter(hasContent);
  return (
    <div class="detail-inner">
      <TranscriptHeader session={session} messageCount={visible.length} />
      {visible.length === 0 ? (
        <p class="empty">This session has no messages.</p>
      ) : (
        visible.map((message) => <MessageView message={message} />)
      )}
    </div>
  );
};

const DetailPlaceholder = () => (
  <div class="placeholder">
    <h2>No session selected</h2>
    <p>Choose a session from the sidebar to read its transcript.</p>
  </div>
);

const NotFoundDetail = ({ id }: { id: string }) => (
  <div class="placeholder">
    <h2>Session not found</h2>
    <p>
      No session matches <code>{id}</code>.
    </p>
  </div>
);

export { DetailPlaceholder, NotFoundDetail, Transcript };
