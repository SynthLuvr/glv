import type { DatabaseSync } from "node:sqlite";
import type { SessionFilter, SessionRow } from "../db.js";
import { listSessions } from "../db.js";
import { fmtTokens, renderTable } from "../format.js";

const HEADERS = ["ID", "Name", "Working Dir", "Updated", "Tokens"];

const sessionToCells = (s: SessionRow): string[] => [
  s.id,
  s.name === "" ? "(unnamed)" : s.name,
  s.working_dir,
  s.updated_at,
  fmtTokens(s.total_tokens),
];

const runList = (db: DatabaseSync, filter: SessionFilter): void => {
  const rows = listSessions(db, filter);
  if (rows.length === 0) {
    console.log("No sessions found.");
    return;
  }
  console.log(renderTable(HEADERS, rows.map(sessionToCells)));
  console.log(`\n${rows.length} session(s) listed.`);
};

export { runList };
