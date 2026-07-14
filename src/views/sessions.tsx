import type { SessionRow } from "../db.js";
import { fmtTokens } from "../format.js";

const displayName = (name: string): string =>
  name === "" ? "(unnamed)" : name;

const SessionItem = ({ session }: { session: SessionRow }) => (
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

const SessionsTable = ({ sessions }: { sessions: SessionRow[] }) => (
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

const SessionsPage = ({ sessions }: { sessions: SessionRow[] }) => (
  <main>
    <h1>Goose Sessions</h1>
    {sessions.length === 0 ? (
      <p class="empty">No sessions found.</p>
    ) : (
      <SessionsTable sessions={sessions} />
    )}
  </main>
);

export { SessionsPage };
