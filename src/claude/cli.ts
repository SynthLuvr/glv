import { type DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { type Command, InvalidArgumentError } from "commander";
import * as cli from "../glv/cli-factory.js";
import * as cliShared from "../glv/cli-shared.js";
import { openMetaDb, resolveMetaDbPath } from "../glv/session-meta.js";
import type { SessionStore } from "../glv/sessions.js";
import { makeClaudeAgent, PERMISSION_MODES } from "./agent.js";
import { createSessionStore } from "./db.js";
import { makeClaudeLauncher } from "./launch.js";
import { claudeProfile } from "./profile.js";
import { resolveProjectsRoot } from "./store/working-dir.js";

const GlobalOpts = type({
  "projectsDir?": "string",
  "authDb?": "string",
  "promptsDb?": "string",
  "groupsDb?": "string",
  "cronDb?": "string",
  "metaDb?": "string",
});

const parsePermissionMode = (value: string): string => {
  if (!PERMISSION_MODES.includes(value))
    throw new InvalidArgumentError(
      `must be one of: ${PERMISSION_MODES.join(", ")}`,
    );
  return value;
};

// Opens the glv-owned meta sidecar (creating it on first use) and pairs it
// with claude's projects directory; the transcript files themselves stay
// owned — and only ever written — by the claude CLI.
const openSessionStore = (): {
  readonly root: string;
  readonly meta: DatabaseSync;
  readonly sessions: SessionStore;
} => {
  const globals = cliShared.readGlobalOpts(program, GlobalOpts);
  const root = resolveProjectsRoot(globals.projectsDir);
  const meta = openMetaDb(
    resolveMetaDbPath(claudeProfile.dataDirName, globals.metaDb),
  );
  return { root, meta, sessions: createSessionStore(root, meta) };
};

// The claude CLI as a config for the shared program factory: the globals
// and adapters are claude's; the command structure (sessions/view/serve)
// comes from glv.
const program = cli.createFlavorProgram({
  programName: "glv-claude",
  description: "View claude sessions, prompts/outputs, and live runs",

  globalOptions: (cmd: Command): Command =>
    cmd
      .option(
        "--projects-dir <path>",
        "claude projects (transcripts) directory",
      )
      .option("--auth-db <path>", "auth database path")
      .option("--prompts-db <path>", "saved prompts database path")
      .option("--groups-db <path>", "session groups database path")
      .option("--cron-db <path>", "scheduled runs database path")
      .option("--meta-db <path>", "viewer metadata database path"),

  useStore: (fn: (sessions: SessionStore) => void): void => {
    const store = openSessionStore();
    try {
      fn(store.sessions);
    } finally {
      store.meta.close();
    }
  },

  sessionsFilter: (opts) => ({
    type: "user",
    limit: Number(opts.limit),
    includeArchived: opts.all === true,
  }),
  sessionsDescription: "List claude sessions (interactive user sessions)",

  serve: {
    description: "Start a local web viewer for claude sessions",
    options: (cmd: Command): Command =>
      cmd
        .option(
          "--claude-binary <path>",
          "path to the claude binary",
          cliShared.resolveAgentBinary,
          "claude",
        )
        .option(
          "--permission-mode <mode>",
          'claude permission mode for glv-launched runs; "inherit" defers to your claude settings.json',
          parsePermissionMode,
          "inherit",
        ),
    action: (opts) => {
      const store = openSessionStore();
      const agent = makeClaudeAgent(
        typeof opts.claudeBinary === "string" ? opts.claudeBinary : "claude",
        typeof opts.permissionMode === "string"
          ? opts.permissionMode
          : "inherit",
      );
      const globals = cliShared.readGlobalOpts(program, GlobalOpts);
      cliShared.runServe({
        port: Number(opts.port),
        agents: [
          {
            agent: claudeProfile.id,
            spec: {
              profile: claudeProfile,
              store: store.sessions,
              invocation: agent,
              models: undefined,
              makeLauncher: (runner) =>
                makeClaudeLauncher(
                  store.root,
                  store.sessions,
                  runner,
                  agent,
                  claudeProfile.sessionTimeoutError,
                ),
              closeStore: () => store.meta.close(),
            },
          },
        ],
        runner: cliShared.makeRunnerConfig(Number(opts.maxConcurrent)),
        composed: false,
        dataDirName: claudeProfile.dataDirName,
        assetsFlavor: claudeProfile.id,
        authDbPath: cliShared.resolveAuthDbPath(
          claudeProfile.dataDirName,
          globals.authDb,
        ),
        promptsDbPath: cliShared.resolvePromptsDbPath(
          claudeProfile.dataDirName,
          globals.promptsDb,
        ),
        cronDbPath: cliShared.resolveCronDbPath(
          claudeProfile.dataDirName,
          globals.cronDb,
        ),
        groupsDbPath: cliShared.resolveGroupsDbPath(
          claudeProfile.dataDirName,
          globals.groupsDb,
        ),
        ...cliShared.serveTail(opts),
      });
    },
  },
});

cliShared.runMain(program);
