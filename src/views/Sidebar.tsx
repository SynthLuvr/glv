import type { SessionRow } from "../db.js";
import { fmtTokens } from "../format.js";

const displayName = (name: string): string =>
  name === "" ? "(unnamed)" : name;

const SessionItem = ({
  session,
  selected,
}: {
  session: SessionRow;
  selected: boolean;
}) => (
  <tr class={selected ? "selected" : undefined}>
    <td>
      <a href={`/sessions/${session.id}`}>{displayName(session.name)}</a>
    </td>
    <td>
      <code>{session.working_dir}</code>
    </td>
    <td>{session.updated_at}</td>
    <td>{fmtTokens(session.total_tokens)}</td>
    <td>{session.provider_name ?? "—"}</td>
  </tr>
);

const Sidebar = ({
  sessions,
  selectedId,
}: {
  sessions: SessionRow[];
  selectedId: string | undefined;
}) => (
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>Goose Sessions</h1>
    </div>
    {sessions.length === 0 ? (
      <p class="empty">No sessions found.</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Working Dir</th>
            <th>Updated</th>
            <th>Tokens</th>
            <th>Provider</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <SessionItem
              session={session}
              selected={session.id === selectedId}
            />
          ))}
        </tbody>
      </table>
    )}
  </aside>
);

export { Sidebar };
