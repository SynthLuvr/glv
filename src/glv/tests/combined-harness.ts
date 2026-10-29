import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  claudeFixture,
  insertMessages as insertClaudeMessages,
  insertSessions as insertClaudeSessions,
} from "../../claude/tests/integration-harness.js";
import {
  gooseFixture,
  insertMessages as insertGooseMessages,
  insertSessions as insertGooseSessions,
  SESSIONS_SCHEMA,
} from "../../goose/tests/integration-harness.js";
import type {
  Databases,
  IntegrationEnv,
  MessageSeed,
  MockConfig,
  SessionSeed,
} from "./harness.js";
import * as harness from "./harness.js";

// The combined fixture of ADR 0007's testing plan: one `glv serve`
// process with both mock agents, exercising the composite store, the
// agent picker, and the namespaced id space end to end. The per-flavor
// suites keep their single-agent bindings; this harness is what the
// identity-sensitive combined suites boot.

const gooseMockScriptPath = fileURLToPath(
  new URL("../../goose/tests/goose-mock-script.ts", import.meta.url),
);
const claudeMockScriptPath = fileURLToPath(
  new URL("../../claude/tests/claude-mock-script.ts", import.meta.url),
);

const GLV_BIN = join(harness.ROOT, "bin", "glv.mjs");

const createDatabases = (scratchDir: string): Databases => {
  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
  sdb.close();

  const projectsDir = join(scratchDir, "projects");
  mkdirSync(projectsDir, { recursive: true });

  return harness.baseDatabases(scratchDir, { sessionsDb, projectsDir });
};

const combinedAdapter: harness.FlavorAdapter = {
  name: "combined",
  binPath: GLV_BIN,
  mockBinName: "goose",
  mockScriptPath: gooseMockScriptPath,
  mockEnvPrefix: "GOOSE",
  mockEnvPrefixes: ["GOOSE", "CLAUDE"],
  extraMocks: [{ name: "claude", file: claudeMockScriptPath }],
  createDatabases,
  serveArgs: (dbs) => [
    "--goose-db",
    dbs.flavor.sessionsDb,
    "--projects-dir",
    dbs.flavor.projectsDir,
    ...harness.dbOverrideArgs(dbs),
    "--goose-binary",
    "goose",
    "--claude-binary",
    "claude",
  ],
  serverEnv: (dbs) => ({
    GOOSE_SESSIONS_DB: dbs.flavor.sessionsDb,
    CLAUDE_MOCK_PROJECTS_DIR: dbs.flavor.projectsDir,
  }),
};

const startCombinedEnv = harness.makeStartEnv(combinedAdapter);

// Seeds goose sessions straight into the sessions DB; ids surface as
// "goose:<id>" through the composite store.
const seedGooseSessions = (env: IntegrationEnv, seeds: SessionSeed[]): void =>
  insertGooseSessions(env.dbs.flavor.sessionsDb, seeds);

const seedGooseMessages = (
  env: IntegrationEnv,
  sessionId: string,
  messages: MessageSeed[],
): void => insertGooseMessages(env.dbs.flavor.sessionsDb, sessionId, messages);

// Seeds claude sessions into the projects dir; ids surface as
// "claude:<id>".
const seedClaudeSessions = (env: IntegrationEnv, seeds: SessionSeed[]): void =>
  insertClaudeSessions(env.dbs.flavor.projectsDir, seeds);

const seedClaudeMessages = (
  env: IntegrationEnv,
  sessionId: string,
  messages: MessageSeed[],
): void =>
  insertClaudeMessages(env.dbs.flavor.projectsDir, sessionId, messages);

// Backdates a session's update timestamp (epoch ms) in the named agent's
// store, each in its native spelling — goose's sessions DB and claude's
// transcript's final timestamp line. Ordering tests use these to stage
// cross-agent recency the seeds alone (all "now") cannot express.
const backdateGooseSession = (
  env: IntegrationEnv,
  sessionId: string,
  epochMs: number,
): void => gooseFixture.backdateSession(env, sessionId, epochMs);

const backdateClaudeSession = (
  env: IntegrationEnv,
  sessionId: string,
  epochMs: number,
): void => claudeFixture.backdateSession(env, sessionId, epochMs);

export type { MockConfig };
export {
  backdateClaudeSession,
  backdateGooseSession,
  seedClaudeMessages,
  seedClaudeSessions,
  seedGooseMessages,
  seedGooseSessions,
  startCombinedEnv,
};
