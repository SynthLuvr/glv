import { existsSync } from "node:fs";
import { type } from "arktype";
import { type Command, InvalidArgumentError } from "commander";
import which from "which";
import { resolveAuthDbPath } from "./auth/db.js";
import {
  runConfigGet,
  runConfigList,
  runConfigSet,
} from "./commands/config.js";
import { runList } from "./commands/list.js";
import { runServe } from "./commands/serve.js";
import { runView } from "./commands/view.js";
import { resolveConfigDbPath } from "./config.js";
import { resolveCronDbPath } from "./cron-sessions.js";
import { resolveGroupsDbPath } from "./groups/db.js";
import type { FlavorProfile } from "./profile.js";
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

const registerConfigCommands = (
  program: Command,
  profile: FlavorProfile,
): Command => {
  const configCmd = program
    .command("config")
    .description("Read and set fields in the glv config database")
    .action(() => runConfigList(profile.dataDirName));

  configCmd
    .command("get <key>")
    .description("Print the value of a config field")
    .action((key: string) => runConfigGet(profile.dataDirName, key));

  configCmd
    .command("set <key> <value>")
    .description("Set a config field to a value")
    .action((key: string, value: string) =>
      runConfigSet(profile.dataDirName, key, value),
    );

  configCmd
    .command("list")
    .description("List all config fields")
    .action(() => runConfigList(profile.dataDirName));

  return configCmd;
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

// The serve options every flavor shares, appended after the
// flavor-specific binary/permission flags.
const addServeTailOptions = (cmd: Command): Command =>
  cmd
    .option("--rp-name <name>", "WebAuthn relying party name", "GLV")
    .option(
      "--rp-id <domain>",
      "WebAuthn relying party ID (defaults to the request host)",
    )
    .option(
      "--forward",
      "open an ssh reverse tunnel (host: config set forwardHost)",
    )
    .option("--debug", "enable debug logging (equivalent to GLV_DEBUG=1)");

type ServeTailOpts = {
  rpName: string;
  rpId?: string;
  forward?: boolean;
  debug?: boolean;
};

const serveTail = (
  opts: ServeTailOpts,
): {
  rpName: string;
  rpIdOverride?: string;
  forward: boolean;
  debug: boolean;
} => ({
  rpName: opts.rpName,
  rpIdOverride: opts.rpId,
  forward: opts.forward === true,
  debug: opts.debug === true,
});

// Raw argv can't decide "is there a subcommand" by sign alone: a global
// option's *value* (`glv-goose --db /path/sessions.db`) is also a non-dash
// token, which used to suppress the `sessions` default and fail with an
// unknown-command error. Skip the values of value-taking global options
// instead; the flag list comes from the program itself, so each flavor's
// globals are covered without a hardcoded list. (commander's `required`
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
  parsePositiveInt,
  readGlobalOpts,
  registerConfigCommands,
  registerViewCommand,
  resolveAgentBinary,
  resolveAuthDbPath,
  resolveConfigDbPath,
  resolveCronDbPath,
  resolveGroupsDbPath,
  resolvePromptsDbPath,
  runList,
  runMain,
  runServe,
  runView,
  serveTail,
};
