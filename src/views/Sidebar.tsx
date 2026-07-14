import type { SessionRow } from "../db.js";
import { displayName, fmtTokens } from "../format.js";

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
    <tr class={selected ? "selected" : undefined}>
      <td>
        <a href={href} hx-get={href}>
          {displayName(session.name)}
        </a>
      </td>
      <td>
        <code>{session.working_dir}</code>
      </td>
      <td>{session.updated_at}</td>
      <td>{fmtTokens(session.total_tokens)}</td>
      <td>{session.provider_name ?? "—"}</td>
    </tr>
  );
};

// Rendered as `<tbody id="session-list">` so it can be swapped out-of-band by
// htmx (re-rendered with the new selection) without reloading the page.
const SessionList = ({
  sessions,
  selectedId,
  oob = false,
}: SidebarProps & { oob?: boolean }) => (
  <tbody id="session-list" hx-swap-oob={oob ? "true" : undefined}>
    {sessions.map((session) => (
      <SessionItem session={session} selected={session.id === selectedId} />
    ))}
  </tbody>
);

const Sidebar = ({ sessions, selectedId }: SidebarProps) => (
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>Goose Sessions</h1>
    </div>
    {sessions.length === 0 ? (
      <p class="empty">No sessions found.</p>
    ) : (
      <table
        hx-target="#detail-pane"
        hx-swap="innerHTML scrollTop:top"
        hx-push-url="true"
      >
        <thead>
          <tr>
            <th>Name</th>
            <th>Working Dir</th>
            <th>Updated</th>
            <th>Tokens</th>
            <th>Provider</th>
          </tr>
        </thead>
        <SessionList sessions={sessions} selectedId={selectedId} />
      </table>
    )}
  </aside>
);

export { SessionList, Sidebar };
