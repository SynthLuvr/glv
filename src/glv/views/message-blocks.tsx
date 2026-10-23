import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { raw } from "hono/utils/html";
import type {
  ContentItem,
  MessageKind,
  ParsedMessage,
  ToolCallInfo,
  ToolResultInfo,
} from "../format/index.js";
import {
  fmtRelative,
  MESSAGE_TAGS,
  messageKind,
  renderMarkdown,
  thinkingText,
  toIso,
  toolCallInfo,
  toolResultInfo,
  truncate,
} from "../format/index.js";

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

// The copy→check icon pair every copy affordance carries: ui.ts's
// delegated handler toggles the `.copied` class after a clipboard write.
const CopyCheckIcons = () => (
  <>
    {icon("icon-copy", [
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />,
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />,
    ])}
    {icon("icon-check", <path d="M20 6 9 17l-5-5" />)}
  </>
);

const CopyButton = ({ text }: { text: string }) => (
  <button
    type="button"
    class="copy-md-btn"
    data-md={text}
    title="Copy as markdown"
    aria-label="Copy as markdown"
  >
    <CopyCheckIcons />
  </button>
);

// Plain-text bubble (e.g. a prompt) paired with the hover-revealed copy
// button. Shared with the non-markdown TextBlock branch so prompts and
// outputs expose the identical copy affordance.
const CopyableText = ({ text }: { text: string }) => (
  <div class="markdown-wrap">
    <p class="message-text">{text}</p>
    <CopyButton text={text} />
  </div>
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
      <CopyButton text={text} />
    </div>
  ) : (
    <CopyableText text={text} />
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

// Machine-injected turn context is operational metadata, not conversation,
// so it collapses by default like tool activity. The stamped <current-time>
// doubles as the summary preview.
const CONTEXT_TIME = /^<current-time>\s*(.*?)\s*<\/current-time>$/m;

const ContextBlock = ({ text }: { text: string }) => (
  <details class="block context">
    <summary>
      <span class="block-icon">🧭</span>
      <span class="block-label">Turn context</span>
      <span class="block-preview">{CONTEXT_TIME.exec(text)?.[1] ?? ""}</span>
    </summary>
    <pre>{text}</pre>
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

const itemBlock = (item: ContentItem, kind: MessageKind): Child | null => {
  switch (item.type) {
    case "text":
      if (!item.text) return null;
      if (kind === "context") return <ContextBlock text={item.text} />;
      return <TextBlock text={item.text} asMarkdown={kind === "output"} />;
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

const ForkHereButton = ({
  sessionId,
  index,
  disabled,
}: {
  sessionId: string;
  index: number;
  disabled: boolean;
}) => (
  <button
    type="button"
    class="fork-here-btn"
    hx-post={`/sessions/${sessionId}/fork`}
    hx-vals={`{"cutoff":${index}}`}
    hx-target="#detail-pane"
    hx-swap="innerHTML"
    disabled={disabled ? true : undefined}
    title={
      disabled
        ? "Cannot fork here — the tool call above needs its result"
        : "Fork the session from this message"
    }
    aria-label={
      disabled ? "Cannot fork from this message" : "Fork from this message"
    }
  >
    {icon("icon-fork", [
      <circle cx="6" cy="5" r="2.6" />,
      <circle cx="18" cy="5" r="2.6" />,
      <circle cx="12" cy="19" r="2.6" />,
      <path d="M6 7.6v1a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-1" />,
      <path d="M12 12.6v4" />,
    ])}
  </button>
);

const MessageView = ({
  message,
  index,
  sessionId,
  forkUnsafe,
}: {
  message: ParsedMessage;
  index: number;
  /** The session this transcript belongs to; present only on the
   * server-rendered detail pane — live-tailed rows render no fork button
   * (the transcript is mid-run and shifting). */
  sessionId?: string;
  /** A cutoff at this message would strand a tool call (see
   * unsafeForkCutoffs) — the button renders disabled. */
  forkUnsafe?: boolean;
}) => {
  const kind = messageKind(message.role, message.items);
  const blocks = message.items
    .map((item) => itemBlock(item, kind))
    .filter((node): node is Child => node !== null);
  if (blocks.length === 0) return null;
  return (
    <article class={`message ${kind}`} data-msg-index={String(index)}>
      <div class="message-head">
        <span class={`tag ${kind}`}>{MESSAGE_TAGS[kind]}</span>
        <time datetime={toIso(message.timestamp)} title={message.timestamp}>
          {fmtRelative(message.timestamp)}
        </time>
        {sessionId !== undefined && (
          <ForkHereButton
            sessionId={sessionId}
            index={index}
            disabled={forkUnsafe === true}
          />
        )}
      </div>
      <div class="message-body">{blocks}</div>
    </article>
  );
};

const hasContent = (message: ParsedMessage): boolean => {
  const kind = messageKind(message.role, message.items);
  return message.items.some((item) => itemBlock(item, kind) !== null);
};

// Matches the initial server render so live-tailed rows blend in seamlessly.
const renderMessage = (message: ParsedMessage, index: number): string =>
  renderToString(<MessageView message={message} index={index} />);

export {
  CopyableText,
  CopyCheckIcons,
  hasContent,
  itemBlock,
  MessageView,
  renderMessage,
};
