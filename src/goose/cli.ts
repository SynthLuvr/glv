import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type } from "arktype";
import { Command, InvalidArgumentError } from "commander";
import { resolveAuthDbPath } from "../glv/auth/db.js";
import {
  runConfigGet,
  runConfigList,
  runConfigSet,
} from "../glv/commands/config.js";
import { runList } from "../glv/commands/list.js";
import { runServe } from "../glv/commands/serve.js";
import { runView } from "../glv/commands/view.js";
import { readConfig } from "../glv/config.js";
import { resolveGroupsDbPath } from "../glv/groups/db.js";
import { resolvePromptsDbPath } from "../glv/prompts/db.js";
import { makeRunnerConfig } from "../glv/runner/index.js";
import type { SessionStore } from "../glv/sessions.js";
import { makeGooseAgent } from "./agent.js";
import { createSessionStore, openDb, resolveDbPath } from "./db.js";
import { makeGooseLauncher } from "./launch.js";
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
  .option("--groups-db <path>", "session groups database path");

const GlobalOpts = type({
  "db?": "string",
  "authDb?": "string",
  "promptsDb?": "string",
  "groupsDb?": "string",
});

const globalOpts = () => {
  const opts = GlobalOpts(program.opts());
  if (opts instanceof type.errors)
    throw new Error(`Invalid global options: ${opts.summary}`);
  return opts;
};

const getDbPath = (): string => resolveDbPath(globalOpts().db);

const getAuthDbPath = (): string =>
  resolveAuthDbPath(gooseProfile.dataDirName, globalOpts().authDb);

const getPromptsDbPath = (): string =>
  resolvePromptsDbPath(gooseProfile.dataDirName, globalOpts().promptsDb);

const getGroupsDbPath = (): string =>
  resolveGroupsDbPath(gooseProfile.dataDirName, globalOpts().groupsDb);

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
  .option("-n, --limit <number>", "number of rows to list", "20")
  .action((opts: SessionsOpts) => {
    useSessions((sessions) =>
      runList(sessions, {
        type: opts.type,
        limit: Number(opts.limit),
        includeArchived: opts.all === true,
      }),
    );
  });

program
  .command("logs")
  .description("List sessions from goose run --no-session (hidden sessions)")
  .option("-n, --limit <number>", "number of rows to list", "20")
  .action((opts: LimitOpts) => {
    useSessions((sessions) =>
      runList(sessions, {
        type: "hidden",
        limit: Number(opts.limit),
        includeArchived: false,
      }),
    );
  });

program
  .command("view <sessionId>")
  .description("Show prompts and final outputs for a session")
  .action((sessionId: string) => {
    useSessions((sessions) => runView(sessions, sessionId));
  });

const configCmd = program
  .command("config")
  .description("Read and set fields in the glv config file")
  .action(() => runConfigList(gooseProfile.dataDirName));

configCmd
  .command("get <key>")
  .description("Print the value of a config field")
  .action((key: string) => runConfigGet(gooseProfile.dataDirName, key));

configCmd
  .command("set <key> <value>")
  .description("Set a config field to a value")
  .action((key: string, value: string) =>
    runConfigSet(gooseProfile.dataDirName, key, value),
  );

configCmd
  .command("list")
  .description("List all config fields")
  .action(() => runConfigList(gooseProfile.dataDirName));

const MaxConcurrent = type("string.numeric.parse").pipe(
  type("number.integer > 0"),
);

const parseMaxConcurrent = (value: string): number => {
  const result = MaxConcurrent(value);
  if (result instanceof type.errors)
    throw new InvalidArgumentError(
      `must be a positive integer (e.g. 6) — ${result.summary}`,
    );
  return result;
};

const resolveGooseBinary = (value: string): string => {
  if (value.includes("/") || value.includes("\\")) {
    if (!existsSync(value))
      throw new InvalidArgumentError(`binary not found at "${value}"`);
    return value;
  }
  // Windows executables carry extensions (.exe, .cmd); PATHEXT lists the ones
  // to try, so a bare "goose" matches "goose.exe" there.
  const exts = (process.env.PATHEXT ?? "")
    .split(delimiter)
    .map((e) => e.trim())
    .filter(Boolean);
  const candidates = exts.length === 0 ? [value] : exts.map((e) => value + e);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const found = candidates.some((name) =>
    dirs.some((dir) => existsSync(join(dir, name))),
  );
  if (!found)
    throw new InvalidArgumentError(`binary "${value}" not found on PATH`);
  return value;
};

const resolveForwardHost = (forward?: boolean): string | undefined => {
  if (!forward) return undefined;
  const { forwardHost } = readConfig(gooseProfile.dataDirName);
  if (forwardHost === undefined)
    throw new Error('--forward needs "forwardHost" set in the glv config file');
  return forwardHost;
};

program
  .command("serve")
  .description("Start a local web viewer for goose sessions")
  .option("-p, --port <number>", "port to listen on", "3000")
  .option(
    "-c, --max-concurrent <number>",
    "max concurrent goose runs",
    parseMaxConcurrent,
    6,
  )
  .option(
    "--goose-binary <path>",
    "path to the goose binary",
    resolveGooseBinary,
    "goose",
  )
  .option("--rp-name <name>", "WebAuthn relying party name", "GLV")
  .option(
    "--rp-id <domain>",
    "WebAuthn relying party ID (defaults to the request host)",
  )
  .option(
    "--forward",
    "open an ssh reverse tunnel (host from the glv config file)",
  )
  .option("--debug", "enable debug logging (equivalent to GLV_DEBUG=1)")
  .action((opts: ServeOpts) => {
    // Writable opens first: read-only mode can't create the file, so serve
    // works before goose has ever run.
    const dbWritable = openDb(getDbPath(), { readOnly: false });
    dbWritable.exec("PRAGMA busy_timeout=5000"); // out-wait a concurrent goose write
    const db = openDb(getDbPath());
    const sessions = createSessionStore(db, dbWritable);
    runServe(sessions, {
      port: Number(opts.port),
      profile: gooseProfile,
      runner: makeRunnerConfig(
        opts.maxConcurrent,
        makeGooseAgent(opts.gooseBinary),
      ),
      makeLauncher: (runner) =>
        makeGooseLauncher(db, runner, gooseProfile.sessionTimeoutError),
      closeStore: () => {
        db.close();
        dbWritable.close();
      },
      authDbPath: getAuthDbPath(),
      promptsDbPath: getPromptsDbPath(),
      groupsDbPath: getGroupsDbPath(),
      rpName: opts.rpName,
      rpIdOverride: opts.rpId,
      forwardHost: resolveForwardHost(opts.forward),
      debug: opts.debug === true,
    });
  });

const main = (): void => {
  const argv = process.argv.slice(2);
  const hasSubcommand = argv.some((a) => !a.startsWith("-"));
  if (!hasSubcommand) argv.push("sessions");
  try {
    program.parse(argv, { from: "user" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${detail}`);
    process.exitCode = 1;
  }
};

main();
