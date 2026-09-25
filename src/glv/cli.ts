import { existsSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { Command } from "commander";
import which from "which";
import { makeClaudeAgent, PERMISSION_MODES } from "../claude/agent.js";
import { createSessionStore as createClaudeStore } from "../claude/db.js";
import { makeClaudeLauncher } from "../claude/launch.js";
import { makeClaudeModelSource } from "../claude/models.js";
import { claudeProfile } from "../claude/profile.js";
import { resolveProjectsRoot } from "../claude/store/working-dir.js";
import { makeGooseAgent } from "../goose/agent.js";
import {
  createSessionStore as createGooseStore,
  openDb as openGooseDb,
  openServeDbs,
  resolveDbPath as resolveGooseDbPath,
} from "../goose/db.js";
import { makeGooseLauncher } from "../goose/launch.js";
import { makeGooseModelSource } from "../goose/models.js";
import { gooseProfile } from "../goose/profile.js";
import * as cli from "./cli-shared.js";
import { runList } from "./commands/list.js";
import { type AgentServeSpec, runServe } from "./commands/serve.js";
import { runView } from "./commands/view.js";
import { prefixedInvocation } from "./composite-launcher.js";
import { createCompositeSessionStore } from "./composite-store.js";
import { dataRoot, resolveDataPath } from "./db-path.js";
import { runLegacyMigration } from "./migrate.js";
import { resolveTempBase, resolveUploadsBase } from "./server/uploads.js";
import { openMetaDb } from "./session-meta.js";
import type { SessionFilter, SessionStore } from "./sessions.js";

// The merged product's composition root: one `glv` binary serving both
// agents behind one login, one sidebar, and one schedule. This CLI is
// the only place that knows both adapters at once, so the core stays
// free of flavor branches (ADR 0007).

// The unified viewer data directory: one auth database, one prompt
// library, one group set, one cron database, one uploads/temp root.
const DATA_DIR = "glv";

const GlobalOpts = type({
  "gooseDb?": "string",
  "projectsDir?": "string",
  "authDb?": "string",
  "promptsDb?": "string",
  "groupsDb?": "string",
  "cronDb?": "string",
  "metaDb?": "string",
});

// Overrides for the glv-owned databases under the unified data directory.
type GlvDataOverrides = {
  readonly authDb?: string;
  readonly promptsDb?: string;
  readonly groupsDb?: string;
  readonly cronDb?: string;
  readonly metaDb?: string;
};

// A bare binary name must be found on PATH; an explicit path must exist.
// Unlike the serve binary flags this is a probe, not a parser error —
// the default agent set hides agents whose binary is missing instead of
// refusing to start.
const binaryAvailable = (value: string): boolean => {
  if (value.includes("/") || value.includes("\\")) return existsSync(value);
  return which.sync(value, { nothrow: true }) !== null;
};

// Which stores exist on disk right now: goose's sessions database and
// claude's projects directory. An agent whose store has never been
// created (the agent never ran) is hidden in the default set.
const gooseStoreExists = (override?: string): boolean =>
  existsSync(resolveGooseDbPath(override));
const claudeStoreExists = (override?: string): boolean =>
  existsSync(resolveProjectsRoot(override));

type AvailableAgents = {
  readonly goose: boolean;
  readonly claude: boolean;
};

// Which agents to serve: always both, each gated on its binary being
// resolvable and its store existing on disk right now. An agent that was
// never used (or whose binary is missing) is hidden, not fatal.
const resolveAgents = (
  gooseBinary: string,
  claudeBinary: string,
  globals: { readonly gooseDb?: string; readonly projectsDir?: string },
): AvailableAgents => ({
  goose: binaryAvailable(gooseBinary) && gooseStoreExists(globals.gooseDb),
  claude:
    binaryAvailable(claudeBinary) && claudeStoreExists(globals.projectsDir),
});

const program = new Command();

program
  .name("glv")
  .description("View and drive goose and claude sessions in one place")
  .option("--goose-db <path>", "goose sessions database path")
  .option("--projects-dir <path>", "claude projects (transcripts) directory")
  .option("--auth-db <path>", "auth database path")
  .option("--prompts-db <path>", "saved prompts database path")
  .option("--groups-db <path>", "session groups database path")
  .option("--cron-db <path>", "scheduled runs database path")
  .option("--meta-db <path>", "claude viewer metadata database path");

const globalOpts = () => cli.readGlobalOpts(program, GlobalOpts);

const glvDbPaths = (globals: GlvDataOverrides) => ({
  authDbPath: cli.resolveAuthDbPath(DATA_DIR, globals.authDb),
  promptsDbPath: cli.resolvePromptsDbPath(DATA_DIR, globals.promptsDb),
  groupsDbPath: cli.resolveGroupsDbPath(DATA_DIR, globals.groupsDb),
  cronDbPath: cli.resolveCronDbPath(DATA_DIR, globals.cronDb),
  claudeMetaDbPath: resolveDataPath(
    globals.metaDb,
    "GLV_META_DB",
    DATA_DIR,
    "claude-meta.db",
  ),
});

const anyDbOverride = (globals: GlvDataOverrides): boolean =>
  globals.authDb !== undefined ||
  globals.promptsDb !== undefined ||
  globals.groupsDb !== undefined ||
  globals.cronDb !== undefined ||
  globals.metaDb !== undefined;

// The one-time adoption of the per-flavor data directories. Skipped
// entirely while any glv-owned database is overridden (tests, custom
// setups): those databases are not the unified defaults, so migrating
// into them would be a surprise.
const migrateLegacyDirs = (globals: GlvDataOverrides): void => {
  if (anyDbOverride(globals)) return;
  const paths = glvDbPaths(globals);
  const { adopted, notices } = runLegacyMigration(
    [
      { agent: gooseProfile.id, dataDirName: gooseProfile.dataDirName },
      { agent: claudeProfile.id, dataDirName: claudeProfile.dataDirName },
    ],
    {
      authDb: paths.authDbPath,
      promptsDb: paths.promptsDbPath,
      groupsDb: paths.groupsDbPath,
      cronDb: paths.cronDbPath,
      claudeMetaDb: paths.claudeMetaDbPath,
      uploadsDir: resolveUploadsBase(DATA_DIR),
      tempDir: resolveTempBase(DATA_DIR),
    },
  );
  for (const name of adopted)
    console.log(`glv: adopted legacy data directory ${join(dataRoot(), name)}`);
  for (const notice of notices) console.log(`glv: ${notice}`);
};

const gooseSpec = (
  gooseBinary: string,
  dbOverride: string | undefined,
): AgentServeSpec => {
  const { db, dbWritable } = openServeDbs(dbOverride);
  const rawInvocation = makeGooseAgent(gooseBinary);
  return {
    profile: gooseProfile,
    store: createGooseStore(db, dbWritable),
    invocation: prefixedInvocation(rawInvocation, gooseProfile.id),
    models: makeGooseModelSource(gooseBinary),
    makeLauncher: (runner) =>
      makeGooseLauncher(
        db,
        runner,
        rawInvocation,
        gooseProfile.sessionTimeoutError,
        gooseProfile.id,
      ),
    closeStore: () => {
      db.close();
      dbWritable.close();
    },
  };
};

const claudeSpec = (
  claudeBinary: string,
  permissionMode: string,
  globals: { readonly projectsDir?: string; readonly metaDb?: string },
): AgentServeSpec => {
  const root = resolveProjectsRoot(globals.projectsDir);
  const meta = openMetaDb(glvDbPaths(globals).claudeMetaDbPath);
  const rawInvocation = makeClaudeAgent(claudeBinary, permissionMode);
  const store = createClaudeStore(root, meta);
  return {
    profile: claudeProfile,
    store,
    invocation: prefixedInvocation(rawInvocation, claudeProfile.id),
    models: makeClaudeModelSource(),
    makeLauncher: (runner) =>
      makeClaudeLauncher(
        root,
        store,
        runner,
        rawInvocation,
        claudeProfile.sessionTimeoutError,
        claudeProfile.id,
      ),
    closeStore: () => meta.close(),
  };
};

// A read-only composite over the available agents' stores for the
// listing commands; ids list namespaced so `glv view` accepts them
// verbatim. Listing never spawns an agent, so availability is store
// presence alone: an agent whose store is missing is skipped, not fatal.
const openListStore = (globals: {
  readonly gooseDb?: string;
  readonly projectsDir?: string;
  readonly metaDb?: string;
}): { readonly sessions: SessionStore; readonly close: () => void } => {
  const closers: (() => void)[] = [];
  const entries: { readonly agent: string; readonly store: SessionStore }[] =
    [];
  if (gooseStoreExists(globals.gooseDb)) {
    const db = openGooseDb(resolveGooseDbPath(globals.gooseDb));
    closers.push(() => db.close());
    entries.push({
      agent: gooseProfile.id,
      store: createGooseStore(db, db),
    });
  }
  if (claudeStoreExists(globals.projectsDir)) {
    const meta = openMetaDb(glvDbPaths(globals).claudeMetaDbPath);
    closers.push(() => meta.close());
    entries.push({
      agent: claudeProfile.id,
      store: createClaudeStore(resolveProjectsRoot(globals.projectsDir), meta),
    });
  }
  return {
    sessions: createCompositeSessionStore(entries),
    close: () => {
      for (const close of closers) close();
    },
  };
};

const serveCmd = program
  .command("serve")
  .description("Start the local web viewer for goose and claude sessions")
  .option(
    "--goose-binary <path>",
    "path to the goose binary",
    cli.resolveAgentBinary,
    "goose",
  )
  .option(
    "--claude-binary <path>",
    "path to the claude binary",
    cli.resolveAgentBinary,
    "claude",
  )
  .option(
    "--permission-mode <mode>",
    'claude permission mode for glv-launched runs; "inherit" defers to your claude settings.json',
    cli.parseChoice(PERMISSION_MODES),
    "inherit",
  )
  .option("-p, --port <number>", "port to listen on", "3000")
  .option(
    "-c, --max-concurrent <number>",
    "max concurrent agent runs across both agents",
    cli.parsePositiveInt,
    6,
  );

cli.addServeTailOptions(serveCmd);

serveCmd.action((opts: Record<string, unknown>) => {
  const globals = globalOpts();
  const gooseBinary = cli.optString(opts, "gooseBinary", "goose");
  const claudeBinary = cli.optString(opts, "claudeBinary", "claude");
  const permissionMode = cli.optString(opts, "permissionMode", "inherit");
  const available = resolveAgents(gooseBinary, claudeBinary, globals);

  migrateLegacyDirs(globals);

  const specs: AgentServeSpec[] = [];
  if (available.goose) specs.push(gooseSpec(gooseBinary, globals.gooseDb));
  if (available.claude)
    specs.push(claudeSpec(claudeBinary, permissionMode, globals));
  if (specs.length === 0) {
    console.error(
      "Error: no agent is available. Install an agent, or point at one " +
        "with --goose-binary/--claude-binary and its data with " +
        "--goose-db/--projects-dir.",
    );
    process.exitCode = 1;
    return;
  }
  for (const name of ["goose", "claude"] as const)
    if (!available[name])
      console.log(
        `glv: agent ${name} is not available (binary or data missing) — serving without it`,
      );

  const paths = glvDbPaths(globals);
  runServe({
    port: Number(opts.port),
    agents: specs,
    dataDirName: DATA_DIR,
    assetsFlavor: "glv",
    runner: cli.makeRunnerConfig(Number(opts.maxConcurrent)),
    authDbPath: paths.authDbPath,
    promptsDbPath: paths.promptsDbPath,
    groupsDbPath: paths.groupsDbPath,
    cronDbPath: paths.cronDbPath,
    ...cli.serveTail(opts),
  });
});

program
  .command("sessions")
  .description("List sessions from every served agent")
  .option("--type <type>", "session type: user|hidden|sub_agent|all", "user")
  .option("--all", "include archived sessions")
  .option(
    "-n, --limit <number>",
    "number of rows to list",
    cli.parsePositiveInt,
    20,
  )
  .action((opts: { type: string; all?: boolean; limit: string }) => {
    const globals = globalOpts();
    const store = openListStore(globals);
    try {
      const filter: SessionFilter = {
        type: opts.type,
        limit: Number(opts.limit),
        includeArchived: opts.all === true,
      };
      runList(store.sessions, filter);
    } finally {
      store.close();
    }
  });

cli.registerViewCommand(program, (sessionId) => {
  const store = openListStore(globalOpts());
  try {
    runView(store.sessions, sessionId);
  } finally {
    store.close();
  }
});

// goose's --no-session logs, offered whenever goose's store is readable.
program
  .command("logs")
  .description("List sessions from goose run --no-session (hidden sessions)")
  .option(
    "-n, --limit <number>",
    "number of rows to list",
    cli.parsePositiveInt,
    20,
  )
  .action((opts: { limit: string }) => {
    const globals = globalOpts();
    if (!gooseStoreExists(globals.gooseDb)) {
      console.log("No sessions found.");
      return;
    }
    const db = openGooseDb(resolveGooseDbPath(globals.gooseDb));
    try {
      runList(createGooseStore(db, db), {
        type: "hidden",
        limit: Number(opts.limit),
        includeArchived: false,
      });
    } finally {
      db.close();
    }
  });

cli.runMain(program);
