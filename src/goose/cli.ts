import { type } from "arktype";
import { Command } from "commander";
import * as cli from "../glv/cli-shared.js";
import type { SessionStore } from "../glv/sessions.js";
import { makeGooseAgent } from "./agent.js";
import { createSessionStore, openDb, resolveDbPath } from "./db.js";
import { makeGooseLauncher } from "./launch.js";
import { makeGooseModelSource } from "./models.js";
import { gooseProfile } from "./profile.js";

type SessionsOpts = {
  type: string;
  all?: boolean;
  limit: string;
};

type LimitOpts = {
  limit: string;
};

type ServeOpts = {
  port: string;
  maxConcurrent: number;
  gooseBinary: string;
  rpName: string;
  rpId?: string;
  forward?: boolean;
  debug?: boolean;
};

const program = new Command();

program
  .name("glv-goose")
  .description("View goose sessions, prompts/outputs, and --no-session logs")
  .option("--db <path>", "goose sessions database path")
  .option("--auth-db <path>", "auth database path")
  .option("--prompts-db <path>", "saved prompts database path")
  .option("--groups-db <path>", "session groups database path")
  .option("--cron-db <path>", "scheduled runs database path")
  .option("--config-db <path>", "config database path");

const GlobalOpts = type({
  "db?": "string",
  "authDb?": "string",
  "promptsDb?": "string",
  "groupsDb?": "string",
  "cronDb?": "string",
  "configDb?": "string",
});

const globalOpts = () => cli.readGlobalOpts(program, GlobalOpts);

const getDbPath = (): string => resolveDbPath(globalOpts().db);

const getAuthDbPath = (): string =>
  cli.resolveAuthDbPath(gooseProfile.dataDirName, globalOpts().authDb);

const getPromptsDbPath = (): string =>
  cli.resolvePromptsDbPath(gooseProfile.dataDirName, globalOpts().promptsDb);

const getGroupsDbPath = (): string =>
  cli.resolveGroupsDbPath(gooseProfile.dataDirName, globalOpts().groupsDb);

const getCronDbPath = (): string =>
  cli.resolveCronDbPath(gooseProfile.dataDirName, globalOpts().cronDb);

const getConfigDbPath = (): string =>
  cli.resolveConfigDbPath(gooseProfile.dataDirName, globalOpts().configDb);

// List/view only read; one read-only handle safely backs both store roles.
const useSessions = (fn: (sessions: SessionStore) => void): void => {
  const db = openDb(getDbPath());
  try {
    fn(createSessionStore(db, db));
  } finally {
    db.close();
  }
};

program
  .command("sessions")
  .description("List goose sessions (interactive user sessions)")
  .option("--type <type>", "session type: user|hidden|sub_agent|all", "user")
  .option("--all", "include archived sessions")
  .option(
    "-n, --limit <number>",
    "number of rows to list",
    cli.parsePositiveInt,
    20,
  )
  .action((opts: SessionsOpts) => {
    useSessions((sessions) =>
      cli.runList(sessions, {
        type: opts.type,
        limit: Number(opts.limit),
        includeArchived: opts.all === true,
      }),
    );
  });

program
  .command("logs")
  .description("List sessions from goose run --no-session (hidden sessions)")
  .option(
    "-n, --limit <number>",
    "number of rows to list",
    cli.parsePositiveInt,
    20,
  )
  .action((opts: LimitOpts) => {
    useSessions((sessions) =>
      cli.runList(sessions, {
        type: "hidden",
        limit: Number(opts.limit),
        includeArchived: false,
      }),
    );
  });

cli.registerViewCommand(program, (sessionId) =>
  useSessions((sessions) => cli.runView(sessions, sessionId)),
);

cli.registerConfigCommands(program, gooseProfile);

const serveCmd = program
  .command("serve")
  .description("Start a local web viewer for goose sessions")
  .option("-p, --port <number>", "port to listen on", "3000")
  .option(
    "-c, --max-concurrent <number>",
    "max concurrent goose runs",
    cli.parsePositiveInt,
    6,
  )
  .option(
    "--goose-binary <path>",
    "path to the goose binary",
    cli.resolveAgentBinary,
    "goose",
  );

cli.addServeTailOptions(serveCmd);

serveCmd.action((opts: ServeOpts) => {
  // Writable opens first: read-only mode can't create the file, so serve
  // works before goose has ever run. Both handles wait out a concurrent
  // goose write — node:sqlite's default busy timeout is 0 (fail at once),
  // which the sidebar, transcript, and launch-poll reads must outlive.
  const dbWritable = openDb(getDbPath(), { readOnly: false });
  dbWritable.exec("PRAGMA busy_timeout=5000");
  const db = openDb(getDbPath());
  db.exec("PRAGMA busy_timeout=5000");
  const sessions = createSessionStore(db, dbWritable);
  cli.runServe(sessions, {
    port: Number(opts.port),
    profile: gooseProfile,
    runner: cli.makeRunnerConfig(
      opts.maxConcurrent,
      makeGooseAgent(opts.gooseBinary),
    ),
    models: makeGooseModelSource(opts.gooseBinary),
    makeLauncher: (runner) =>
      makeGooseLauncher(db, runner, gooseProfile.sessionTimeoutError),
    closeStore: () => {
      db.close();
      dbWritable.close();
    },
    authDbPath: getAuthDbPath(),
    promptsDbPath: getPromptsDbPath(),
    groupsDbPath: getGroupsDbPath(),
    cronDbPath: getCronDbPath(),
    configDbPath: getConfigDbPath(),
    ...cli.serveTail(opts),
  });
});

cli.runMain(program);
