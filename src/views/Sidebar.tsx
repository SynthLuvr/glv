import type { SessionRow } from "../db.js";
import {
  displayName,
  fmtRelative,
  fmtTokens,
  truncateMiddle,
} from "../format.js";

type SidebarProps = {
  sessions: SessionRow[];
  selectedId: string | undefined;
};

const SessionItem = ({
  session,
  selected,
}: {
  session: SessionRow;
  selected: boolean;
}) => {
  const href = `/sessions/${session.id}`;
  return (
    <a
      class={`session-item${selected ? " selected" : ""}`}
      href={href}
      hx-get={href}
    >
      <span class="session-name">{displayName(session.name)}</span>
      <span class="session-sub">
        <time title={session.updated_at}>
          {fmtRelative(session.updated_at)}
        </time>
        {session.provider_name !== null && (
          <span class="provider-badge">{session.provider_name}</span>
        )}
        {session.total_tokens !== null && (
          <span class="token-count">{fmtTokens(session.total_tokens)}</span>
        )}
      </span>
      <span class="session-dir" title={session.working_dir}>
        {truncateMiddle(session.working_dir, 42)}
      </span>
    </a>
  );
};

// Rendered as `<div id="session-list">` so it can be swapped out-of-band by
// htmx (re-rendered with the new selection) without reloading the page.
const SessionList = ({
  sessions,
  selectedId,
  oob = false,
}: SidebarProps & { oob?: boolean }) => (
  <div
    id="session-list"
    class="session-list"
    hx-target="#detail-pane"
    hx-swap="innerHTML scrollTop:top"
    hx-push-url="true"
    hx-swap-oob={oob ? "true" : undefined}
  >
    {sessions.map((session) => (
      <SessionItem session={session} selected={session.id === selectedId} />
    ))}
  </div>
);

const Sidebar = ({ sessions, selectedId }: SidebarProps) => (
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>Goose Sessions</h1>
      <span class="session-count">{sessions.length}</span>
    </div>
    {sessions.length === 0 ? (
      <p class="empty">No sessions found.</p>
    ) : (
      <SessionList sessions={sessions} selectedId={selectedId} />
    )}
  </aside>
);

export { SessionList, Sidebar };
