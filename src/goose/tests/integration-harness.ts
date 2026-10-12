import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { mockBin } from "type-a-bin";
import {
  TWO_PROVIDER_CONFIG_YAML,
  writeGooseConfig,
} from "../../glv/tests/goose-config.js";
import * as harness from "../../glv/tests/harness.js";

// The goose flavor of the shared test harness: everything generic (SSE,
// browser, boot, auth seeding) lives in src/glv/tests/harness.ts; this file
// binds it to goose's SQLite sessions DB, CLI flags, and mock agent, and
// exports only the flavor-specific surface (shared helpers are imported
// from the glv harness by their consumers).

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
  model_config_json TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP,
  parent_session_id TEXT
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
  "INSERT INTO sessions (id, name, session_type, working_dir, created_at, " +
  "updated_at, provider_name, model_config_json) " +
  "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'), ?, ?)";

const INSERT_MESSAGE_SQL =
  "INSERT INTO messages (message_id, session_id, role, content_json, " +
  "created_timestamp, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now'))";

const gooseMockScriptPath = fileURLToPath(
  new URL("./goose-mock-script.ts", import.meta.url),
);

const GLV = join(harness.ROOT, "bin", "glv.mjs");

const mockGoose = (): Promise<() => void> =>
  mockBin("goose", { file: gooseMockScriptPath });

// WAL lets a test process (or the mock goose) write while the server reads,
// without SQLITE_BUSY.
const createDatabases = (scratchDir: string): harness.Databases => {
  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
  sdb.close();
  return harness.baseDatabases(scratchDir, { sessionsDb });
};

const gooseAdapter: harness.FlavorAdapter = {
  name: "goose",
  binPath: GLV,
  mockBinName: "goose",
  mockScriptPath: gooseMockScriptPath,
  mockEnvPrefix: "GOOSE",
  createDatabases,
  // There is no agent-choice flag, so the fixture stays single-agent by
  // pinning claude's store override at a path that never exists: on a
  // host with a real ~/.claude, the default both-agents set would
  // otherwise leak it into this fixture's sidebar. The goose sessions
  // database is --goose-db (the merged CLI's spelling) and session ids
  // list namespaced ("goose:<id>").
  serveArgs: (dbs) => [
    "--goose-db",
    dbs.flavor.sessionsDb,
    "--projects-dir",
    join(dirname(dbs.flavor.sessionsDb), "no-claude-projects"),
    ...harness.dbOverrideArgs(dbs),
    "--goose-binary",
    "goose",
  ],
  serverEnv: (dbs) => ({ GOOSE_SESSIONS_DB: dbs.flavor.sessionsDb }),
};

// The server reads fresh on every request, so sessions inserted here appear
// in the sidebar on the next page load without a restart.
const insertSessions = (
  dbPath: string,
  sessions: harness.SessionSeed[],
): void => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const stmt = db.prepare(INSERT_SESSION_SQL);
  for (const s of sessions)
    stmt.run(
      s.id,
      s.name,
      s.workingDir,
      s.providerName ?? null,
      s.model === undefined ? null : JSON.stringify({ model_name: s.model }),
    );
  db.close();
};

// Seeds a transcript straight into the goose sessions DB the server reads
// from. `content` may be a raw JSON string or an array of content items.
const insertMessages = (
  dbPath: string,
  sessionId: string,
  messages: harness.MessageSeed[],
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

const startIntegrationEnv = harness.makeStartEnv(gooseAdapter);

const gooseFixture: harness.FlavorFixture = {
  name: "goose",
  displayName: "Goose",
  binName: "glv",
  dataDirName: "glv",
  viewId: (id) => `goose:${id}`,
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
  backdateSession: (env, id, epochMs) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb);
    db.prepare(
      "UPDATE sessions SET updated_at = datetime(? / 1000, 'unixepoch') WHERE id = ?",
    ).run(epochMs, id);
    db.close();
  },
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
  assertSessionGone: (env, id) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb, {
      readOnly: true,
    });
    try {
      const session = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
      const message = db
        .prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1")
        .get(id);
      if (session !== undefined)
        throw new Error(`goose sessions row for ${id} still exists`);
      if (message !== undefined)
        throw new Error(`goose messages rows for ${id} still exist`);
    } finally {
      db.close();
    }
  },
  readSessionField: (env, field, id) =>
    harness.readStoreField(env.dbs.flavor.sessionsDb, "sessions", field, id),
  snapshotStore: (env, id) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb, {
      readOnly: true,
    });
    try {
      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
      const messages = db
        .prepare(
          "SELECT * FROM messages WHERE session_id = ? " +
            "ORDER BY created_timestamp, id",
        )
        .all(id);
      return JSON.stringify({ session, messages });
    } finally {
      db.close();
    }
  },
  // A resolvable pin for the suggestions model test: the fake-home
  // goose config names the zai provider, so "zai:glm-5.1" resolves and
  // the ask's argv carries goose's provider+model flag pair.
  suggestionModelPin: {
    value: "goose:zai:glm-5.1",
    flags: ["--provider", "zai", "--model", "glm-5.1"],
    prepareHome: (home) => writeGooseConfig(home, TWO_PROVIDER_CONFIG_YAML),
  },
  // goose's --no-session helper runs leave a hidden session row (and
  // message rows); the product's cleanup sweep must leave none behind.
  ephemeralTraceCount: (env) => {
    const db = new DatabaseSync(env.dbs.flavor.sessionsDb, {
      readOnly: true,
    });
    try {
      const sessions = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sessions WHERE session_type = 'hidden'",
        )
        .get();
      const messages = db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE session_id IN " +
            "(SELECT id FROM sessions WHERE session_type = 'hidden')",
        )
        .get();
      const count = (row: unknown): number => {
        if (typeof row !== "object" || row === null) return 0;
        return "n" in row && typeof row.n === "number" ? row.n : 0;
      };
      return count(sessions) + count(messages);
    } finally {
      db.close();
    }
  },
  systemFlag: "--system",
  resumeFlag: "--session-id",
  binaryFlag: "--goose-binary",
  binPath: GLV,
  mockAgent: mockGoose,
  // Prepares goose's sessions DB under the fake HOME (the CLI needs a store
  // to read) and returns the serve argv pointing at it.
  defaultServeArgs: (homeDir) => {
    const sessionsDb = join(homeDir, "sessions.db");
    const sdb = new DatabaseSync(sessionsDb);
    sdb.exec("PRAGMA journal_mode=WAL");
    sdb.exec(SESSIONS_SCHEMA);
    sdb.close();
    return ["--goose-db", sessionsDb, "--goose-binary", "goose"];
  },
  defaultDbFiles: [
    "auth.db",
    "prompts.db",
    "groups.db",
    "cron.db",
    "suggestions.db",
  ],
};

export {
  GLV,
  gooseFixture,
  gooseMockScriptPath,
  insertMessages,
  insertSessions,
  SESSIONS_SCHEMA,
  startIntegrationEnv,
};
