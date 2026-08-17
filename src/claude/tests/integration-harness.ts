import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openMetaDb } from "../../glv/session-meta.js";
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
import { encodeWorkingDir } from "../store/working-dir.js";

// The claude flavor of the shared test harness: everything generic (SSE,
// browser, boot, auth seeding) lives in src/glv/tests/harness.ts; this file
// binds it to claude's transcript projects dir, meta sidecar, CLI flags, and
// mock agent.

const claudeMockScriptPath = fileURLToPath(
  new URL("./claude-mock-script.ts", import.meta.url),
);

const GLV = join(ROOT, "bin", "glv-claude");

const mockClaude = (): Promise<() => void> =>
  mockScript("claude", claudeMockScriptPath);

// The projects dir is plain JSONL the mock claude appends to while the
// server reads.
const createDatabases = (scratchDir: string): Databases => {
  const projectsDir = join(scratchDir, "projects");
  mkdirSync(projectsDir, { recursive: true });

  const metaDb = join(scratchDir, "meta.db");
  openMetaDb(metaDb).close();

  const authDb = join(scratchDir, "auth.db");
  const token = seedAuthDb(authDb);

  return {
    authDb,
    promptsDb: join(scratchDir, "prompts.db"),
    groupsDb: join(scratchDir, "groups.db"),
    token,
    flavor: { projectsDir, metaDb },
  };
};

const claudeAdapter: FlavorAdapter = {
  name: "claude",
  binPath: GLV,
  mockBinName: "claude",
  mockScriptPath: claudeMockScriptPath,
  mockEnvPrefix: "CLAUDE",
  createDatabases,
  serveArgs: (dbs) => [
    "--projects-dir",
    dbs.flavor.projectsDir,
    "--meta-db",
    dbs.flavor.metaDb,
    "--auth-db",
    dbs.authDb,
    "--prompts-db",
    dbs.promptsDb,
    "--groups-db",
    dbs.groupsDb,
    "--claude-binary",
    "claude",
  ],
  serverEnv: (dbs) => ({
    CLAUDE_MOCK_PROJECTS_DIR: dbs.flavor.projectsDir,
  }),
};

// The server reads fresh on every request, so sessions seeded here appear in
// the sidebar on the next page load without a restart. Staggered mtimes keep
// the newest-first sidebar order deterministic.
const insertSessions = (
  projectsRoot: string,
  sessions: SessionSeed[],
): void => {
  let ts = Date.now();
  for (const s of sessions) {
    const dir = join(projectsRoot, encodeWorkingDir(s.workingDir));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${s.id}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "ai-title",
        aiTitle: s.name,
        sessionId: s.id,
        cwd: s.workingDir,
        timestamp: new Date(ts).toISOString(),
      })}\n`,
    );
    utimesSync(path, new Date(ts), new Date(ts));
    ts += 1000;
  }
};

const findSessionFile = (
  projectsRoot: string,
  sessionId: string,
): string | undefined => {
  let dirs;
  try {
    dirs = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(projectsRoot, dir.name, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
};

// Seeds a transcript straight into the projects dir the server reads from.
// `content` may be a plain string or a claude content-block array.
const insertMessages = (
  projectsRoot: string,
  sessionId: string,
  messages: MessageSeed[],
): void => {
  let path = findSessionFile(projectsRoot, sessionId);
  if (path === undefined) {
    const dir = join(projectsRoot, encodeWorkingDir("/seeded"));
    mkdirSync(dir, { recursive: true });
    path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "ai-title",
        aiTitle: "seed session",
        sessionId,
        cwd: "/seeded",
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  }
  let ts = Date.now();
  const parts: string[] = [];
  for (const m of messages) {
    const t = m.createdTimestamp ?? ts;
    parts.push(
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: m.role === "user" ? "user" : "assistant",
        message: { role: m.role, content: m.content },
        uuid: m.messageId ?? randomUUID(),
        timestamp: new Date(t).toISOString(),
        sessionId,
      }),
    );
    ts += 1000;
  }
  appendFileSync(path, `${parts.join("\n")}\n`);
  utimesSync(path, new Date(), new Date(ts));
};

const startIntegrationEnv = (
  prefix: string,
  mock: MockConfig = {},
  homeDir?: string,
): Promise<IntegrationEnv> => startEnv(claudeAdapter, prefix, mock, homeDir);

const claudeFixture: FlavorFixture = {
  name: "claude",
  displayName: "Claude",
  binName: "glv-claude",
  mockReply: "mock claude reply",
  startEnv: startIntegrationEnv,
  seedSessions: (env, seeds) =>
    insertSessions(env.dbs.flavor.projectsDir, seeds),
  seedMessages: (env, sessionId, messages) =>
    insertMessages(env.dbs.flavor.projectsDir, sessionId, messages),
  toolRequest: (name, args) => ({ type: "tool_use", name, input: args }),
  toolResponse: (text, isError) => ({
    type: "tool_result",
    content: [{ type: "text", text }],
    is_error: isError,
  }),
  streamLine: (text) =>
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    }),
  // The foreign dialect for claude is goose's top-level envelope.
  foreignLine: JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "foreign reply" }],
  }),
  rawBanner: "claude is ready",
  renameSession: (env, id, name) => {
    const path = findSessionFile(env.dbs.flavor.projectsDir, id);
    if (path === undefined) return;
    appendFileSync(
      path,
      `${JSON.stringify({
        type: "ai-title",
        aiTitle: name,
        sessionId: id,
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  },
  deleteSession: (env, id) => {
    const path = findSessionFile(env.dbs.flavor.projectsDir, id);
    if (path !== undefined) rmSync(path);
  },
  readSessionField: (env, field, id) => {
    const db = new DatabaseSync(env.dbs.flavor.metaDb, { readOnly: true });
    const row = db
      .prepare(`SELECT ${field} AS v FROM session_meta WHERE id = ?`)
      .get(id) as { v: unknown } | undefined;
    db.close();
    return row?.v;
  },
};

export type { IntegrationEnv, MessageSeed, MockConfig, SessionSeed, SseEvent };
export {
  authedFetch,
  claudeFixture,
  collectSse,
  findFreePort,
  GLV,
  insertMessages,
  insertSessions,
  mockClaude,
  parseSseData,
  ROOT,
  startIntegrationEnv,
  stopProcess,
  waitForHttp,
  waitForJsonFile,
  withPage,
};
