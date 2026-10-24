import { existsSync } from "node:fs";
import { type } from "arktype";
import { type Command, InvalidArgumentError } from "commander";
import which from "which";
import { resolveAuthDbPath } from "./auth/db.js";
import { runList } from "./commands/list.js";
import { runServe } from "./commands/serve.js";
import { runView } from "./commands/view.js";
import { resolveCronDbPath } from "./cron-sessions.js";
import { resolveGroupsDbPath } from "./groups/db.js";
import { resolvePromptsDbPath } from "./prompts/db.js";
import { makeRunnerConfig } from "./runner/index.js";

const PositiveInt = type("string.numeric.parse").pipe(
  type("number.integer > 0"),
);

const parsePositiveInt = (value: string): number => {
  const result = PositiveInt(value);
  if (result instanceof type.errors)
    throw new InvalidArgumentError(
      `must be a positive integer — ${result.summary}`,
    );
  return result;
};

// Commander option parser for a closed set of values.
const parseChoice =
  (choices: readonly string[]) =>
  (value: string): string => {
    if (!choices.includes(value))
      throw new InvalidArgumentError(`must be one of: ${choices.join(", ")}`);
    return value;
  };

// Reads a string option out of commander's option bag, falling back to
// the option's default when a parser never landed a value in the record.
const optString = (
  opts: Record<string, unknown>,
  key: string,
  fallback: string,
): string => {
  const value = opts[key];
  return typeof value === "string" ? value : fallback;
};

// An explicit path must exist on disk; a bare name must be found on PATH
// (which honors PATHEXT on Windows and checks the executable bit, which
// existence checks alone miss). The caller's spelling is kept — bare
// names stay bare for execa to resolve.
const resolveAgentBinary = (value: string): string => {
  if (value.includes("/") || value.includes("\\")) {
    if (!existsSync(value))
      throw new InvalidArgumentError(`binary not found at "${value}"`);
    return value;
  }
  const found = which.sync(value, { nothrow: true });
  if (found === null)
    throw new InvalidArgumentError(`binary "${value}" not found on PATH`);
  return value;
};

const readGlobalOpts = <T>(
  program: Command,
  schema: (raw: unknown) => T | type.errors,
): T => {
  const opts = schema(program.opts());
  if (opts instanceof type.errors)
    throw new Error(`Invalid global options: ${opts.summary}`);
  return opts;
};

const registerViewCommand = (
  program: Command,
  run: (sessionId: string) => void,
): Command =>
  program
    .command("view <sessionId>")
    .description("Show prompts and final outputs for a session")
    .action((sessionId: string) => run(sessionId));

// The serve options every program shares, appended after serve's own
// agent binary/permission flags.
const addServeTailOptions = (cmd: Command): Command =>
  cmd
    .option("--rp-name <name>", "WebAuthn relying party name", "GLV")
    .option(
      "--rp-id <domain>",
      "WebAuthn relying party ID (defaults to the request host)",
    )
    .option(
      "--allow-token-bootstrap",
      "let loopback-only POST /api/tokens mint an API token with no " +
        "credential — for agents with network reach but no filesystem " +
        "access to the data dir; not safe behind a reverse proxy",
    )
    .option("--debug", "enable debug logging (equivalent to GLV_DEBUG=1)");

// Commander hands the action a plain option bag, so the tail is read
// out of unknown values with the same defaults commander's parsers
// applied — narrowed, not cast.
const serveTail = (
  opts: Record<string, unknown>,
): {
  rpName: string;
  rpIdOverride?: string;
  debug: boolean;
  allowTokenBootstrap: boolean;
} => ({
  rpName: typeof opts.rpName === "string" ? opts.rpName : "GLV",
  rpIdOverride: typeof opts.rpId === "string" ? opts.rpId : undefined,
  debug: opts.debug === true,
  allowTokenBootstrap: opts.allowTokenBootstrap === true,
});

// Raw argv can't decide "is there a subcommand" by sign alone: a global
// option's *value* (`glv --goose-db /path/sessions.db`) is also a
// non-dash token, which used to suppress the `sessions` default and fail
// with an unknown-command error. Skip the values of value-taking global
// options instead; the flag list comes from the program itself, so every
// global is covered without a hardcoded list. (commander's `required`
// means "takes a <value>", not "must be present".)
const hasSubcommandArg = (program: Command, argv: string[]): boolean => {
  const valueFlags = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) valueFlags.add(option.long);
    if (option.short !== undefined) valueFlags.add(option.short);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("-");
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && valueFlags.has(arg)) i++;
      continue;
    }
    return true;
  }
  return false;
};

// Defaults argv to the `sessions` subcommand and turns parse failures into
// exit code 1 instead of a stack trace.
const runMain = (program: Command): void => {
  const argv = process.argv.slice(2);
  if (!hasSubcommandArg(program, argv)) argv.push("sessions");
  try {
    program.parse(argv, { from: "user" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${detail}`);
    process.exitCode = 1;
  }
};

export {
  addServeTailOptions,
  makeRunnerConfig,
  optString,
  parseChoice,
  parsePositiveInt,
  readGlobalOpts,
  registerViewCommand,
  resolveAgentBinary,
  resolveAuthDbPath,
  resolveCronDbPath,
  resolveGroupsDbPath,
  resolvePromptsDbPath,
  runList,
  runMain,
  runServe,
  runView,
  serveTail,
};
