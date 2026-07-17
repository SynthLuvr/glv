import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
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
  fmtRelative,
  fmtTokens,
  messageKind,
  renderMarkdown,
  shortenHome,
  thinkingText,
  toolCallInfo,
  toolResultInfo,
  truncate,
  truncateMiddle,
} from "../format.js";
import { detectPrUrl, prLabel } from "../pr.js";
import type { RunHandle } from "../runner.js";
import { SessionTitleWrap } from "./Rename.js";

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

const icon = (cls: string, children: Child) => (
  <svg
    class={cls}
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

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
        {icon("icon-copy", [
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />,
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />,
        ])}
        {icon("icon-check", <path d="M20 6 9 17l-5-5" />)}
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

const MessageView = ({
  message,
  index,
}: {
  message: ParsedMessage;
  index: number;
}) => {
  const kind = messageKind(message.role, message.items);
  const blocks = message.items
    .map((item) => itemBlock(item, kind === "output"))
    .filter((node): node is Child => node !== null);
  if (blocks.length === 0) return null;
  return (
    <article class={`message ${kind}`} data-msg-index={String(index)}>
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

// Matches the initial server render so live-tailed rows blend in seamlessly.
const renderMessage = (message: ParsedMessage, index: number): string =>
  renderToString(<MessageView message={message} index={index} />);

const MetaChip = ({
  id,
  label,
  value,
  mono = false,
  title,
}: {
  id?: string;
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) => (
  <div id={id} class="meta-chip" title={title ?? value}>
    <span class="meta-label">{label}</span>
    <span class={`meta-value${mono ? " mono" : ""}`}>{value}</span>
  </div>
);

// Link to the session's primary PR. The URL renders instantly from offline
// detection; the colored state is swapped in lazily via htmx, so any failure
// (unknown state, network error) leaves a plain link.
const PrChip = ({ sessionId, url }: { sessionId: string; url: string }) => {
  const errorHandler = {
    // hono/jsx can't emit the `::` attribute directly, so spread it. On
    // error, drop the status pill so the chip degrades to a plain link.
    "hx-on::response-error": "this.querySelector('#pr-state')?.remove()",
  };
  return (
    <a
      class="pr-chip"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      hx-get={`/sessions/${sessionId}/pr-state?url=${encodeURIComponent(url)}`}
      hx-trigger="load"
      hx-target="#pr-state"
      hx-swap="outerHTML"
      {...errorHandler}
    >
      <svg
        class="pr-icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
      <span class="pr-num">{prLabel(url)}</span>
      <span id="pr-state" class="pr-state pr-state-loading">
        <span
          class="pr-dot pr-dot-loading"
          aria-label="Loading PR status"
        ></span>
      </span>
    </a>
  );
};

const TranscriptHeader = ({
  session,
  messageCount,
  prUrl,
}: {
  session: SessionRow;
  messageCount: number;
  prUrl?: string;
}) => (
  <header class="session-header">
    <div class="session-header-top">
      <SessionTitleWrap session={session} />
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
    </div>
    <div class="session-meta">
      <MetaChip label="ID" value={session.id} mono />
      <MetaChip
        label="Working dir"
        value={truncateMiddle(shortenHome(session.working_dir), 48)}
        mono
        title={session.working_dir}
      />
      <MetaChip
        label="Created"
        value={fmtRelative(session.created_at)}
        title={session.created_at}
      />
      <MetaChip
        id="meta-updated"
        label="Updated"
        value={fmtRelative(session.updated_at)}
        title={session.updated_at}
      />
      <MetaChip
        id="meta-messages"
        label="Messages"
        value={String(messageCount)}
      />
      <MetaChip
        id="meta-tokens"
        label="Tokens"
        value={fmtTokens(session.total_tokens)}
      />
      {session.provider_name !== null && (
        <MetaChip label="Provider" value={session.provider_name} />
      )}
      {prUrl !== undefined && <PrChip sessionId={session.id} url={prUrl} />}
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
  const visible = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => hasContent(entry.message));
  const isEmpty = visible.length === 0 && prompt === undefined;
  const prUrl = detectPrUrl(messages);
  return (
    <div
      class="detail-inner"
      data-session-id={session.id}
      data-run-status={run?.status}
    >
      <TranscriptHeader
        session={session}
        messageCount={visible.length}
        prUrl={prUrl}
      />
      {isEmpty ? (
        <p class="empty">This session has no messages.</p>
      ) : (
        <div id="messages">
          {visible.map((entry) => (
            <MessageView message={entry.message} index={entry.index} />
          ))}
        </div>
      )}
      {prompt !== undefined && <SubmittedPrompt prompt={prompt} />}
      {isRunActive(run) && <div id="live-output" class="live-output"></div>}
      <PromptBar sessionId={session.id} run={run} />
    </div>
  );
};

const NewSessionForm = ({
  workingDir,
  dirs,
  error,
}: {
  workingDir: string;
  dirs: string[];
  error?: string;
}) => (
  <div class="detail-inner new-session">
    <h2>New Session</h2>
    <p class="new-session-sub">
      Start a fresh goose run. The session appears in the sidebar the moment
      goose creates it.
    </p>
    <form
      class="new-session-form"
      hx-post="/sessions"
      hx-target="#detail-pane"
      hx-swap="innerHTML"
      hx-disabled-elt="button[type=submit]"
    >
      {error !== undefined && <p class="status-hint error">{error}</p>}
      <label class="form-field">
        <span class="form-label">Working directory</span>
        <input
          type="text"
          name="working_dir"
          list="recent-dirs"
          value={shortenHome(workingDir)}
          class="form-input"
          autocomplete="off"
          spellcheck={false}
        />
        <datalist id="recent-dirs">
          {dirs.map((dir) => (
            <option value={shortenHome(dir)} />
          ))}
        </datalist>
      </label>
      <label class="form-field">
        <span class="form-label">Prompt</span>
        <textarea
          name="prompt"
          class="form-input prompt-input"
          rows={5}
          placeholder="What do you want goose to do?"
          autofocus
        />
      </label>
      <div class="form-actions">
        <button type="submit" class="send-btn">
          Start session
        </button>
      </div>
    </form>
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

export {
  hasContent,
  itemBlock,
  NewSessionForm,
  NotFoundDetail,
  renderMessage,
  Transcript,
  tagFor,
};
