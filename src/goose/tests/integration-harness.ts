import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  authedFetch,
  collectSse,
  type Databases,
  type FlavorAdapter,
  type FlavorFixture,
  findFreePort,
  type IntegrationEnv,
  type MessageSeed,
  type MockConfig,
  mockScript,
  parseSseData,
  ROOT,
  type SessionSeed,
  type SseEvent,
  seedAuthDb,
  startEnv,
  stopProcess,
  waitForHttp,
  waitForJsonFile,
  withPage,
} from "../../glv/tests/harness.js";

// The goose flavor of the shared test harness: everything generic (SSE,
// browser, boot, auth seeding) lives in src/glv/tests/harness.ts; this file
// binds it to goose's SQLite sessions DB, CLI flags, and mock agent.

// Both tables must exist before the server starts: the sidebar queries them
// and the mock goose inserts into them.
const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tokens INTEGER,
  metadata_json TEXT
);
`;

const INSERT_SESSION_SQL =
  "INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at) " +
  "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))";

const INSERT_MESSAGE_SQL =
  "INSERT INTO messages (message_id, session_id, role, content_json, " +
  "created_timestamp, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now'))";

const gooseMockScriptPath = fileURLToPath(
  new URL("./goose-mock-script.ts", import.meta.url),
);

const GLV = join(ROOT, "bin", "glv-goose");

const mockGoose = (): Promise<() => void> =>
  mockScript("goose", gooseMockScriptPath);

// WAL lets a test process (or the mock goose) write while the server reads,
// without SQLITE_BUSY.
const createDatabases = (scratchDir: string): Databases => {
  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
  sdb.close();

  const authDb = join(scratchDir, "auth.db");
  const token = seedAuthDb(authDb);

  return {
    authDb,
    promptsDb: join(scratchDir, "prompts.db"),
    groupsDb: join(scratchDir, "groups.db"),
    token,
    flavor: { sessionsDb },
  };
};

const gooseAdapter: FlavorAdapter = {
  name: "goose",
  binPath: GLV,
  mockBinName: "goose",
  mockScriptPath: gooseMockScriptPath,
  mockEnvPrefix: "GOOSE",
  createDatabases,
  serveArgs: (dbs) => [
    "--db",
    dbs.flavor.sessionsDb,
    "--auth-db",
    dbs.authDb,
    "--prompts-db",
    dbs.promptsDb,
    "--groups-db",
    dbs.groupsDb,
    "--goose-binary",
    "goose",
  ],
  serverEnv: (dbs) => ({ GOOSE_SESSIONS_DB: dbs.flavor.sessionsDb }),
};

// The server reads fresh on every request, so sessions inserted here appear
// in the sidebar on the next page load without a restart.
const insertSessions = (dbPath: string, sessions: SessionSeed[]): void => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const stmt = db.prepare(INSERT_SESSION_SQL);
  for (const s of sessions) stmt.run(s.id, s.name, s.workingDir);
  db.close();
};

// Seeds a transcript straight into the goose sessions DB the server reads
// from. `content` may be a raw JSON string or an array of content items.
const insertMessages = (
  dbPath: string,
  sessionId: string,
  messages: MessageSeed[],
): void => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const stmt = db.prepare(INSERT_MESSAGE_SQL);
  let ts = Date.now();
  for (const m of messages) {
    const contentJson =
      typeof m.content === "string"
        ? (m.content as string)
        : JSON.stringify(m.content);
    stmt.run(
      m.messageId ?? null,
      sessionId,
      m.role,
      contentJson,
      m.createdTimestamp ?? ts,
    );
    ts += 1000;
  }
  db.close();
};

const startIntegrationEnv = (
  prefix: string,
  mock: MockConfig = {},
  homeDir?: string,
): Promise<IntegrationEnv> => startEnv(gooseAdapter, prefix, mock, homeDir);

const gooseFixture: FlavorFixture = {
  name: "goose",
  displayName: "Goose",
  binName: "glv-goose",
  mockReply: "mock goose reply",
  startEnv: startIntegrationEnv,
  seedSessions: (env, seeds) =>
    insertSessions(env.dbs.flavor.sessionsDb, seeds),
  seedMessages: (env, sessionId, messages) =>
    insertMessages(env.dbs.flavor.sessionsDb, sessionId, messages),
  toolRequest: (name, args) => ({
    type: "toolRequest",
    toolCall: { value: { name, arguments: args } },
  }),
  toolResponse: (text, isError) => ({
    type: "toolResponse",
    toolResult: {
      value: { content: [{ type: "text", text }], isError },
    },
  }),
  streamLine: (text) =>
    JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text }],
    }),
  // The foreign dialect for goose is claude's message-nested envelope.
  foreignLine: JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "foreign reply" }],
    },
  }),
  rawBanner: "goose is ready",
  renameSession: (env, id, name) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb);
    db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
    db.close();
  },
  deleteSession: (env, id) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    db.close();
  },
  readSessionField: (env, field, id) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb, {
      readOnly: true,
    });
    const row = db
      .prepare(`SELECT ${field} AS v FROM sessions WHERE id = ?`)
      .get(id) as { v: unknown } | undefined;
    db.close();
    return row?.v;
  },
};

export type { IntegrationEnv, MessageSeed, MockConfig, SessionSeed, SseEvent };
export {
  authedFetch,
  collectSse,
  findFreePort,
  GLV,
  gooseFixture,
  insertMessages,
  insertSessions,
  mockGoose,
  parseSseData,
  ROOT,
  SESSIONS_SCHEMA,
  startIntegrationEnv,
  stopProcess,
  waitForHttp,
  waitForJsonFile,
  withPage,
};
