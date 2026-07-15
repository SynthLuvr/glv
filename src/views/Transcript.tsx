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
import type { RunHandle } from "../runner.js";

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

const CopyIcon = () => (
  <svg
    class="icon-copy"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

const CheckIcon = () => (
  <svg
    class="icon-check"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

// Hover-reveal "copy as markdown" affordance. `.markdown` is wrapped so the
// absolutely-positioned button gets a positioning context without disturbing
// the markdown's first/last-child margin resets. The raw source rides along in
// `data-md` so the copy yields markdown, not the rendered prose.
const TextBlock = ({
  text,
  asMarkdown,
}: {
  text: string;
  asMarkdown: boolean;
}) =>
  asMarkdown ? (
    <div class="markdown-wrap">
      <div class="markdown">{raw(renderMarkdown(text))}</div>
      <button
        type="button"
        class="copy-md-btn"
        data-md={text}
        title="Copy as markdown"
        aria-label="Copy as markdown"
      >
        <CopyIcon />
        <CheckIcon />
      </button>
    </div>
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

const itemBlock = (item: ContentItem, markdown: boolean): Child | null => {
  switch (item.type) {
    case "text":
      return item.text ? (
        <TextBlock text={item.text} asMarkdown={markdown} />
      ) : null;
    case "thinking": {
      const text = thinkingText(item);
      return text !== undefined ? <ThinkingBlock text={text} /> : null;
    }
    case "toolRequest": {
      const info = toolCallInfo(item);
      return info !== undefined ? <ToolCallBlock info={info} /> : null;
    }
    case "toolResponse": {
      const info = toolResultInfo(item);
      return info !== undefined ? <ToolResultBlock info={info} /> : null;
    }
    default:
      return null;
  }
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
    <button
      type="button"
      class="archive-btn"
      hx-post={`/sessions/${session.id}/archive`}
      hx-target="#detail-pane"
      hx-swap="innerHTML"
      hx-confirm="Archive this session? It will be hidden from the sidebar."
    >
      Archive
    </button>
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

const SubmittedPrompt = ({ prompt }: { prompt: string }) => (
  <article class="message prompt submitted-prompt">
    <div class="message-head">
      <span class="tag prompt">▸ PROMPT</span>
    </div>
    <div class="message-body">
      <p class="message-text">{prompt}</p>
    </div>
  </article>
);

const PromptBar = ({
  sessionId,
  run,
}: {
  sessionId: string;
  run?: RunHandle;
}) => {
  const busy = isRunActive(run);
  return (
    <form
      class="prompt-bar"
      hx-post={`/sessions/${sessionId}/prompt`}
      hx-target="#detail-pane"
      hx-swap="innerHTML"
    >
      {run?.status === "queued" && run.queuePosition !== undefined && (
        <p class="status-hint queued">
          Queued, waiting… (position {run.queuePosition})
        </p>
      )}
      {run?.status === "running" && <p class="status-hint running">Running…</p>}
      {run?.status === "error" && run.error !== undefined && (
        <p class="status-hint error">{run.error}</p>
      )}
      <div class="prompt-input-row">
        <textarea
          name="prompt"
          placeholder="Ask goose…"
          disabled={busy ? true : undefined}
          class="prompt-input"
          rows={2}
        />
        {busy ? (
          <button
            type="button"
            class="stop-btn"
            hx-post={`/sessions/${sessionId}/stop`}
            hx-target="#detail-pane"
            hx-swap="innerHTML"
          >
            Stop
          </button>
        ) : (
          <button type="submit" class="send-btn">
            Send
          </button>
        )}
      </div>
    </form>
  );
};

const isRunActive = (run: RunHandle | undefined): boolean =>
  run !== undefined && (run.status === "queued" || run.status === "running");

const Transcript = ({
  session,
  messages,
  run,
  prompt,
}: {
  session: SessionRow;
  messages: ParsedMessage[];
  run?: RunHandle;
  prompt?: string;
}) => {
  const visible = messages.filter(hasContent);
  const isEmpty = visible.length === 0 && prompt === undefined;
  return (
    <div
      class="detail-inner"
      data-session-id={session.id}
      data-run-status={run?.status}
    >
      <TranscriptHeader session={session} messageCount={visible.length} />
      {isEmpty ? (
        <p class="empty">This session has no messages.</p>
      ) : (
        visible.map((message) => <MessageView message={message} />)
      )}
      {prompt !== undefined && <SubmittedPrompt prompt={prompt} />}
      {isRunActive(run) && <div id="live-output" class="live-output"></div>}
      <PromptBar sessionId={session.id} run={run} />
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

export { DetailPlaceholder, itemBlock, NotFoundDetail, Transcript, tagFor };
