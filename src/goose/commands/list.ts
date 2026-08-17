import type {
  SessionFilter,
  SessionRow,
  SessionStore,
} from "../../glv/sessions.js";
import { fmtTokens, renderTable } from "../format/index.js";

const HEADERS = ["ID", "Name", "Working Dir", "Updated", "Tokens"];

const sessionToCells = (s: SessionRow): string[] => [
  s.id,
  s.name === "" ? "(unnamed)" : s.name,
  s.working_dir,
  s.updated_at,
  fmtTokens(s.total_tokens),
];

const runList = (sessions: SessionStore, filter: SessionFilter): void => {
  const rows = sessions.listSessions(filter);
  if (rows.length === 0) {
    console.log("No sessions found.");
    return;
  }
  console.log(renderTable(HEADERS, rows.map(sessionToCells)));
  console.log(`\n${rows.length} session(s) listed.`);
};

export { runList };
