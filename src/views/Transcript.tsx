import type { SessionRow } from "../db.js";
import type { ParsedMessage } from "../format.js";
import { displayName, extractTexts, fmtTokens } from "../format.js";

const MetaItem = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const TranscriptHeader = ({ session }: { session: SessionRow }) => (
  <header class="session-header">
    <h2>{displayName(session.name)}</h2>
    <dl class="session-meta">
      <MetaItem label="ID" value={session.id} />
      <MetaItem label="Working dir" value={session.working_dir} />
      <MetaItem label="Updated" value={session.updated_at} />
      <MetaItem label="Tokens" value={fmtTokens(session.total_tokens)} />
      {session.provider_name !== null && (
        <MetaItem label="Provider" value={session.provider_name} />
      )}
    </dl>
  </header>
);

const MessageView = ({ message }: { message: ParsedMessage }) => {
  const texts = extractTexts(message.items);
  const isUser = message.role === "user";
  return (
    <article class={`message ${isUser ? "prompt" : "output"}`}>
      <div class="message-head">
        <span class="tag">{isUser ? "▸ PROMPT" : "◆ OUTPUT"}</span>
        <time>{message.timestamp}</time>
      </div>
      <div class="message-body">{texts.join("\n")}</div>
    </article>
  );
};

const Transcript = ({
  session,
  messages,
}: {
  session: SessionRow;
  messages: ParsedMessage[];
}) => {
  const visible = messages.filter((m) => extractTexts(m.items).length > 0);
  return (
    <div class="detail-inner">
      <TranscriptHeader session={session} />
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
