import type { SessionRow } from "../db.js";
import { fmtTokens } from "../format.js";

type SessionsPageProps = {
  sessions: SessionRow[];
};

const displayName = (name: string): string =>
  name === "" ? "(unnamed)" : name;

type SessionItemProps = {
  session: SessionRow;
};

const SessionItem = ({ session }: SessionItemProps) => (
  <tr>
    <td title={session.id}>{displayName(session.name)}</td>
    <td>
      <code>{session.working_dir}</code>
    </td>
    <td>{session.updated_at}</td>
    <td>{fmtTokens(session.total_tokens)}</td>
    <td>{session.provider_name ?? "—"}</td>
  </tr>
);

type SessionsTableProps = {
  sessions: SessionRow[];
};

const SessionsTable = ({ sessions }: SessionsTableProps) => (
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
        <SessionItem session={session} />
      ))}
    </tbody>
  </table>
);

const SessionsPage = ({ sessions }: SessionsPageProps) => (
  <main>
    <h1>Goose Sessions</h1>
    {sessions.length === 0 ? (
      <p class="empty">No sessions found.</p>
    ) : (
      <SessionsTable sessions={sessions} />
    )}
  </main>
);

export type { SessionItemProps, SessionsPageProps, SessionsTableProps };
export { SessionItem, SessionsPage, SessionsTable };
