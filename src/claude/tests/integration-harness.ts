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
import { fileURLToPath } from "node:url";
import { mockBin } from "type-a-bin";
import { openMetaDb } from "../../glv/session-meta.js";
import * as harness from "../../glv/tests/harness.js";
import { encodeWorkingDir } from "../store/working-dir.js";

// The claude flavor of the shared test harness: everything generic (SSE,
// browser, boot, auth seeding) lives in src/glv/tests/harness.ts; this file
// binds it to claude's transcript projects dir, meta sidecar, CLI flags,
// and mock agent, and exports only the flavor-specific surface (shared
// helpers are imported from the glv harness by their consumers).

const claudeMockScriptPath = fileURLToPath(
  new URL("./claude-mock-script.ts", import.meta.url),
);

const GLV = join(harness.ROOT, "bin", "glv-claude.mjs");

const mockClaude = (): Promise<() => void> =>
  mockBin("claude", { file: claudeMockScriptPath });

// The projects dir is plain JSONL the mock claude appends to while the
// server reads.
const createDatabases = (scratchDir: string): harness.Databases => {
  const projectsDir = join(scratchDir, "projects");
  mkdirSync(projectsDir, { recursive: true });

  const metaDb = join(scratchDir, "meta.db");
  openMetaDb(metaDb).close();

  return harness.baseDatabases(scratchDir, { projectsDir, metaDb });
};

const claudeAdapter: harness.FlavorAdapter = {
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
    ...harness.dbOverrideArgs(dbs),
    "--claude-binary",
    "claude",
  ],
  serverEnv: (dbs) => ({
    CLAUDE_MOCK_PROJECTS_DIR: dbs.flavor.projectsDir,
  }),
};

// The server reads fresh on every request, so sessions seeded here appear
// in the sidebar on the next page load without a restart. Staggered mtimes
// keep the newest-first sidebar order deterministic.
const insertSessions = (
  projectsRoot: string,
  sessions: harness.SessionSeed[],
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
  messages: harness.MessageSeed[],
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
        message: { role: m.role, content: m.content, model: m.model },
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

const startIntegrationEnv = harness.makeStartEnv(claudeAdapter);

const claudeFixture: harness.FlavorFixture = {
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
  backdateSession: (env, id, epochMs) => {
    // claude derives updated_at from the transcript's last timestamp
    // entry, so an old one is appended as the final line.
    const path = findSessionFile(env.dbs.flavor.projectsDir, id);
    if (path === undefined) return;
    appendFileSync(
      path,
      `${JSON.stringify({ timestamp: new Date(epochMs).toISOString() })}\n`,
    );
  },
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
  assertSessionGone: (env, id) => {
    const path = findSessionFile(env.dbs.flavor.projectsDir, id);
    if (path !== undefined)
      throw new Error(`claude transcript for ${id} still exists at ${path}`);
    const meta = harness.readStoreField(
      env.dbs.flavor.metaDb,
      "session_meta",
      "name",
      id,
    );
    if (meta !== undefined)
      throw new Error(`claude meta sidecar row for ${id} still exists`);
  },
  readSessionField: (env, field, id) =>
    harness.readStoreField(env.dbs.flavor.metaDb, "session_meta", field, id),
  systemFlag: "--append-system-prompt",
  resumeFlag: "--resume",
  binaryFlag: "--claude-binary",
  binPath: GLV,
  mockAgent: mockClaude,
  defaultServeArgs: (homeDir) => [
    "--projects-dir",
    join(homeDir, ".claude", "projects"),
    "--claude-binary",
    "claude",
  ],
  defaultDbFiles: [
    "auth.db",
    "prompts.db",
    "groups.db",
    "cron.db",
    "config.db",
    "meta.db",
  ],
  assertNewRunArgs: (args) => {
    // The session id is pre-assigned, not discovered after the fact.
    const id = args[args.indexOf("--session-id") + 1];
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (id === undefined || !uuid.test(id))
      throw new Error(`pre-assigned session id missing or malformed: ${id}`);
    // Default "inherit": no flag, so claude honours settings.json.
    if (args.includes("--permission-mode"))
      throw new Error("default permission mode must not pass a flag");
  },
  assertResumeRunArgs: (args) => {
    if (args.includes("--permission-mode"))
      throw new Error("default permission mode must not pass a flag");
  },
};

export {
  claudeFixture,
  GLV,
  insertMessages,
  insertSessions,
  mockClaude,
  startIntegrationEnv,
};
