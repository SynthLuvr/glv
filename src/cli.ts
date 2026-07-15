import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { Command } from "commander";
import { runList } from "./commands/list.js";
import { runServe } from "./commands/serve.js";
import { runView } from "./commands/view.js";
import { openDb, resolveDbPath } from "./db.js";
import { makeRunnerConfig } from "./runner.js";

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
  maxConcurrent: string;
  gooseBinary: string;
};

const program = new Command();

program
  .name("glv")
  .description("View goose sessions, prompts/outputs, and --no-session logs")
  .option("--db <path>", "goose sessions database path");

const GlobalOpts = type({
  "db?": "string",
});

const getDbPath = (): string => {
  const opts = GlobalOpts(program.opts());
  if (opts instanceof type.errors)
    throw new Error(`Invalid global options: ${opts.summary}`);
  return resolveDbPath(opts.db);
};

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

program
  .command("serve")
  .description("Start a local web viewer for goose sessions")
  .option("-p, --port <number>", "port to listen on", "3000")
  .option("-c, --max-concurrent <number>", "max concurrent goose runs", "6")
  .option("--goose-binary <path>", "path to the goose binary", "goose")
  .action((opts: ServeOpts) => {
    const db = openDb(getDbPath(), { readOnly: false });
    runServe(db, {
      port: Number(opts.port),
      runner: makeRunnerConfig(Number(opts.maxConcurrent), opts.gooseBinary),
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
