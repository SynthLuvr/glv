import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

const GLV = join(harness.ROOT, "bin", "glv.mjs");

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
  // There is no agent-choice flag, so the fixture stays single-agent by
  // pinning goose's store override at a path that never exists: on a
  // host with a real goose data directory, the default both-agents set
  // would otherwise leak it into this fixture's sidebar.
  serveArgs: (dbs) => [
    "--projects-dir",
    dbs.flavor.projectsDir,
    "--goose-db",
    join(dirname(dbs.flavor.projectsDir), "no-goose-sessions.db"),
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
  binName: "glv",
  dataDirName: "glv",
  viewId: (id) => `claude:${id}`,
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
  // claude's stream-json failure record: headless runs print the failure
  // as the final result record with is_error set.
  refusalRecord: (detail) =>
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: detail,
    }),
  // claude's clean headless verdict, printed before the kill epilogue.
  cleanResultRecord: () =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      result: "mock claude reply",
    }),
  // The kill epilogue claude 2.1.289 streams when no Monitor task is
  // pending: the plain background tasks the turn outlived are killed,
  // each announced as a stopped task_notification, and the process
  // exits 0.
  killedTaskRecords: (summary) => [
    JSON.stringify({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    }),
    JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "bib06qe7n",
      patch: { status: "killed", end_time: 1793266070123 },
    }),
    JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "bib06qe7n",
      status: "stopped",
      summary,
    }),
  ],
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
  snapshotStore: (env, id) => {
    const path = findSessionFile(env.dbs.flavor.projectsDir, id);
    return path === undefined ? "" : readFileSync(path, "utf8");
  },
  // A resolvable pin for the suggestions model test: claude's source
  // resolves the documented alias statically, so "claude:haiku" needs
  // no config and lands as a single --model flag.
  suggestionModelPin: {
    value: "claude:claude:haiku",
    flags: ["--model", "haiku"],
  },
  systemFlag: "--append-system-prompt",
  resumeFlag: "--resume",
  binaryFlag: "--claude-binary",
  binPath: GLV,
  mockAgent: mockClaude,
  defaultServeArgs: (homeDir) => {
    // The projects root must exist for serve to count claude as
    // available — there is no single-agent escape hatch anymore.
    mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });
    return [
      "--projects-dir",
      join(homeDir, ".claude", "projects"),
      "--claude-binary",
      "claude",
    ];
  },
  defaultDbFiles: [
    "auth.db",
    "prompts.db",
    "groups.db",
    "cron.db",
    "suggestions.db",
    "stop-notices.db",
    "claude-meta.db",
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
