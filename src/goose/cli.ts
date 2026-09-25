import { type } from "arktype";
import type { Command } from "commander";
import * as cli from "../glv/cli-factory.js";
import * as cliShared from "../glv/cli-shared.js";
import type { SessionStore } from "../glv/sessions.js";
import { makeGooseAgent } from "./agent.js";
import { createSessionStore, openDb, resolveDbPath } from "./db.js";
import { makeGooseLauncher } from "./launch.js";
import { makeGooseModelSource } from "./models.js";
import { gooseProfile } from "./profile.js";

const GlobalOpts = type({
  "db?": "string",
  "authDb?": "string",
  "promptsDb?": "string",
  "groupsDb?": "string",
  "cronDb?": "string",
});

// The goose CLI as a config for the shared program factory: the globals
// and adapters are goose's; the command structure (sessions/view/logs/
// serve) comes from glv.
const program = cli.createFlavorProgram({
  programName: "glv-goose",
  description: "View goose sessions, prompts/outputs, and --no-session logs",

  globalOptions: (cmd: Command): Command =>
    cmd
      .option("--db <path>", "goose sessions database path")
      .option("--auth-db <path>", "auth database path")
      .option("--prompts-db <path>", "saved prompts database path")
      .option("--groups-db <path>", "session groups database path")
      .option("--cron-db <path>", "scheduled runs database path"),

  // List/view only read; one read-only handle safely backs both store roles.
  useStore: (fn: (sessions: SessionStore) => void): void => {
    const globals = cliShared.readGlobalOpts(program, GlobalOpts);
    const db = openDb(resolveDbPath(globals.db));
    try {
      fn(createSessionStore(db, db));
    } finally {
      db.close();
    }
  },

  sessionsOptions: (cmd: Command): Command =>
    cmd.option(
      "--type <type>",
      "session type: user|hidden|sub_agent|all",
      "user",
    ),

  sessionsFilter: (opts) => ({
    type: opts.type ?? "user",
    limit: Number(opts.limit),
    includeArchived: opts.all === true,
  }),
  sessionsDescription: "List goose sessions (interactive user sessions)",

  fixedListCommands: [
    {
      name: "logs",
      description:
        "List sessions from goose run --no-session (hidden sessions)",
      filter: { type: "hidden", limit: 20, includeArchived: false },
    },
  ],

  serve: {
    description: "Start a local web viewer for goose sessions",
    options: (cmd: Command): Command =>
      cmd.option(
        "--goose-binary <path>",
        "path to the goose binary",
        cliShared.resolveAgentBinary,
        "goose",
      ),
    action: (opts) => {
      const globals = cliShared.readGlobalOpts(program, GlobalOpts);
      // Writable opens first: read-only mode can't create the file, so serve
      // works before goose has ever run. Both handles wait out a concurrent
      // goose write — node:sqlite's default busy timeout is 0 (fail at once),
      // which the sidebar, transcript, and launch-poll reads must outlive.
      const dbWritable = openDb(resolveDbPath(globals.db), { readOnly: false });
      dbWritable.exec("PRAGMA busy_timeout=5000");
      const db = openDb(resolveDbPath(globals.db));
      db.exec("PRAGMA busy_timeout=5000");
      const sessions = createSessionStore(db, dbWritable);
      const agent = makeGooseAgent(
        typeof opts.gooseBinary === "string" ? opts.gooseBinary : "goose",
      );
      cliShared.runServe({
        port: Number(opts.port),
        agents: [
          {
            agent: gooseProfile.id,
            spec: {
              profile: gooseProfile,
              store: sessions,
              invocation: agent,
              models: makeGooseModelSource(
                typeof opts.gooseBinary === "string"
                  ? opts.gooseBinary
                  : "goose",
              ),
              makeLauncher: (runner) =>
                makeGooseLauncher(
                  db,
                  runner,
                  agent,
                  gooseProfile.sessionTimeoutError,
                ),
              closeStore: () => {
                db.close();
                dbWritable.close();
              },
            },
          },
        ],
        runner: cliShared.makeRunnerConfig(Number(opts.maxConcurrent)),
        composed: false,
        dataDirName: gooseProfile.dataDirName,
        assetsFlavor: gooseProfile.id,
        authDbPath: cliShared.resolveAuthDbPath(
          gooseProfile.dataDirName,
          globals.authDb,
        ),
        promptsDbPath: cliShared.resolvePromptsDbPath(
          gooseProfile.dataDirName,
          globals.promptsDb,
        ),
        groupsDbPath: cliShared.resolveGroupsDbPath(
          gooseProfile.dataDirName,
          globals.groupsDb,
        ),
        cronDbPath: cliShared.resolveCronDbPath(
          gooseProfile.dataDirName,
          globals.cronDb,
        ),
        ...cliShared.serveTail(opts),
      });
    },
  },
});

cliShared.runMain(program);
