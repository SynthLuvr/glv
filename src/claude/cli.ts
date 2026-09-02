import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { Command, InvalidArgumentError } from "commander";
import * as cli from "../glv/cli-shared.js";
import { steeringDisabled } from "../glv/commands/serve.js";
import { openMetaDb, resolveMetaDbPath } from "../glv/session-meta.js";
import type { SessionStore } from "../glv/sessions.js";
import { makeClaudeAgent, PERMISSION_MODES } from "./agent.js";
import { createSessionStore } from "./db.js";
import { makeClaudeLauncher } from "./launch.js";
import { claudeProfile } from "./profile.js";
import { resolveProjectsRoot } from "./store/working-dir.js";

type SessionsOpts = {
  all?: boolean;
  limit: string;
};

type ServeOpts = {
  port: string;
  maxConcurrent: number;
  claudeBinary: string;
  permissionMode: string;
  rpName: string;
  rpId?: string;
  forward?: boolean;
  debug?: boolean;
};

const program = new Command();

program
  .name("glv-claude")
  .description("View claude sessions, prompts/outputs, and live runs")
  .option("--projects-dir <path>", "claude projects (transcripts) directory")
  .option("--auth-db <path>", "auth database path")
  .option("--prompts-db <path>", "saved prompts database path")
  .option("--groups-db <path>", "session groups database path")
  .option("--meta-db <path>", "viewer metadata database path");

const GlobalOpts = type({
  "projectsDir?": "string",
  "authDb?": "string",
  "promptsDb?": "string",
  "groupsDb?": "string",
  "metaDb?": "string",
});

const globalOpts = () => cli.readGlobalOpts(program, GlobalOpts);

// Opens the glv-owned meta sidecar (creating it on first use) and pairs it
// with claude's projects directory; the transcript files themselves stay
// owned — and only ever written — by the claude CLI.
type ClaudeSessionStore = {
  readonly root: string;
  readonly meta: DatabaseSync;
  readonly sessions: SessionStore;
};

const openSessionStore = (): ClaudeSessionStore => {
  const root = resolveProjectsRoot(globalOpts().projectsDir);
  const meta = openMetaDb(
    resolveMetaDbPath(claudeProfile.dataDirName, globalOpts().metaDb),
  );
  return { root, meta, sessions: createSessionStore(root, meta) };
};

const useStore = (fn: (sessions: SessionStore) => void): void => {
  const store = openSessionStore();
  try {
    fn(store.sessions);
  } finally {
    store.meta.close();
  }
};

program
  .command("sessions")
  .description("List claude sessions (interactive user sessions)")
  .option("--all", "include archived sessions")
  .option(
    "-n, --limit <number>",
    "number of rows to list",
    cli.parsePositiveInt,
    20,
  )
  .action((opts: SessionsOpts) => {
    useStore((sessions) =>
      cli.runList(sessions, {
        type: "user",
        limit: Number(opts.limit),
        includeArchived: opts.all === true,
      }),
    );
  });

cli.registerViewCommand(program, (sessionId) =>
  useStore((sessions) => cli.runView(sessions, sessionId)),
);

cli.registerConfigCommands(program, claudeProfile);

const parsePermissionMode = (value: string): string => {
  if (!PERMISSION_MODES.includes(value))
    throw new InvalidArgumentError(
      `must be one of: ${PERMISSION_MODES.join(", ")}`,
    );
  return value;
};

const serveCmd = program
  .command("serve")
  .description("Start a local web viewer for claude sessions")
  .option("-p, --port <number>", "port to listen on", "3000")
  .option(
    "-c, --max-concurrent <number>",
    "max concurrent claude runs",
    cli.parsePositiveInt,
    6,
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
    parsePermissionMode,
    "inherit",
  );

cli.addServeTailOptions(serveCmd);

serveCmd.action((opts: ServeOpts) => {
  const store = openSessionStore();
  cli.runServe(store.sessions, {
    port: Number(opts.port),
    profile: claudeProfile,
    runner: cli.makeRunnerConfig(
      opts.maxConcurrent,
      makeClaudeAgent(
        opts.claudeBinary,
        opts.permissionMode,
        !steeringDisabled(),
      ),
    ),
    makeLauncher: (runner) =>
      makeClaudeLauncher(
        store.root,
        store.sessions,
        runner,
        claudeProfile.sessionTimeoutError,
      ),
    closeStore: () => store.meta.close(),
    authDbPath: cli.resolveAuthDbPath(
      claudeProfile.dataDirName,
      globalOpts().authDb,
    ),
    promptsDbPath: cli.resolvePromptsDbPath(
      claudeProfile.dataDirName,
      globalOpts().promptsDb,
    ),
    groupsDbPath: cli.resolveGroupsDbPath(
      claudeProfile.dataDirName,
      globalOpts().groupsDb,
    ),
    ...cli.serveTail(claudeProfile, opts),
  });
});

cli.runMain(program);
