import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { Command, InvalidArgumentError } from "commander";
import { resolveAuthDbPath } from "./auth/db.js";
import {
  runConfigGet,
  runConfigList,
  runConfigSet,
} from "./commands/config.js";
import { runList } from "./commands/list.js";
import { runServe } from "./commands/serve.js";
import { runView } from "./commands/view.js";
import { readConfig } from "./config.js";
import { openDb, resolveDbPath } from "./db.js";
import { resolveGroupsDbPath } from "./groups/db.js";
import { resolvePromptsDbPath } from "./prompts/db.js";
import { makeRunnerConfig } from "./runner/index.js";
import { DEFAULT_SYSTEM_PROMPT } from "./system.js";

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
  system?: string;
  rpName: string;
  rpId?: string;
  forward?: boolean;
  debug?: boolean;
};

const program = new Command();

program
  .name("glv")
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

const getAuthDbPath = (): string => resolveAuthDbPath(globalOpts().authDb);

const getPromptsDbPath = (): string =>
  resolvePromptsDbPath(globalOpts().promptsDb);

const getGroupsDbPath = (): string =>
  resolveGroupsDbPath(globalOpts().groupsDb);

const useDb = (fn: (db: DatabaseSync) => void): void => {
  const db = openDb(getDbPath());
  try {
    fn(db);
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
    useDb((db) =>
      runList(db, {
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
    useDb((db) =>
      runList(db, {
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
    useDb((db) => runView(db, sessionId));
  });

const configCmd = program
  .command("config")
  .description("Read and set fields in ~/.config/glv/config.json")
  .action(() => runConfigList());

configCmd
  .command("get <key>")
  .description("Print the value of a config field")
  .action((key: string) => runConfigGet(key));

configCmd
  .command("set <key> <value>")
  .description("Set a config field to a value")
  .action((key: string, value: string) => runConfigSet(key, value));

configCmd
  .command("list")
  .description("List all config fields")
  .action(() => runConfigList());

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
  if (value.includes("/")) {
    if (!existsSync(value))
      throw new InvalidArgumentError(`binary not found at "${value}"`);
    return value;
  }
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const found = dirs.some((dir) => existsSync(`${dir}/${value}`));
  if (!found)
    throw new InvalidArgumentError(`binary "${value}" not found on PATH`);
  return value;
};

const resolveForwardHost = (forward?: boolean): string | undefined => {
  if (!forward) return undefined;
  const { forwardHost } = readConfig();
  if (forwardHost === undefined)
    throw new Error(
      '--forward needs "forwardHost" set in ~/.config/glv/config.json',
    );
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
    "open an ssh reverse tunnel (host from ~/.config/glv/config.json)",
  )
  .option("--debug", "enable debug logging (equivalent to GLV_DEBUG=1)")
  .option(
    "--system <text>",
    "extra system instructions passed to every goose run (defaults to built-in guardrails)",
  )
  .action((opts: ServeOpts) => {
    // Writable opens first: read-only mode can't create the file, so serve
    // works before goose has ever run.
    const dbWritable = openDb(getDbPath(), { readOnly: false });
    dbWritable.exec("PRAGMA busy_timeout=5000"); // out-wait a concurrent goose write
    const db = openDb(getDbPath());
    runServe(db, dbWritable, {
      port: Number(opts.port),
      runner: makeRunnerConfig(
        opts.maxConcurrent,
        opts.gooseBinary,
        opts.system ?? DEFAULT_SYSTEM_PROMPT,
      ),
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
