import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type } from "arktype";
import { type Command, InvalidArgumentError } from "commander";
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
import { resolveGroupsDbPath } from "./groups/db.js";
import type { FlavorProfile } from "./profile.js";
import { resolvePromptsDbPath } from "./prompts/db.js";
import { makeRunnerConfig } from "./runner/index.js";

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

// Resolves the agent binary: an explicit path must exist on disk; a bare
// name must be found on PATH. Windows executables carry extensions listed
// in PATHEXT, so a bare name must match any of them there.
const resolveAgentBinary = (value: string): string => {
  if (value.includes("/") || value.includes("\\")) {
    if (!existsSync(value))
      throw new InvalidArgumentError(`binary not found at "${value}"`);
    return value;
  }
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

const resolveForwardHost = (
  profile: FlavorProfile,
  forward?: boolean,
): string | undefined => {
  if (!forward) return undefined;
  const { forwardHost } = readConfig(profile.dataDirName);
  if (forwardHost === undefined)
    throw new Error('--forward needs "forwardHost" set in the glv config file');
  return forwardHost;
};

// Registers the shared `config` command tree (get/set/list) bound to the
// flavor's data directory.
const registerConfigCommands = (
  program: Command,
  profile: FlavorProfile,
): Command => {
  const configCmd = program
    .command("config")
    .description("Read and set fields in the glv config file")
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

// Reads and validates the program's global options against the flavor's
// arktype schema.
const readGlobalOpts = <T>(
  program: Command,
  schema: (raw: unknown) => T | type.errors,
): T => {
  const opts = schema(program.opts());
  if (opts instanceof type.errors)
    throw new Error(`Invalid global options: ${opts.summary}`);
  return opts;
};

// The shared `view` command: identical in every flavor.
const registerViewCommand = (
  program: Command,
  run: (sessionId: string) => void,
): Command =>
  program
    .command("view <sessionId>")
    .description("Show prompts and final outputs for a session")
    .action((sessionId: string) => run(sessionId));

// The serve options every flavor shares, appended after the flavor-specific
// binary/permission flags.
const addServeTailOptions = (cmd: Command): Command =>
  cmd
    .option("--rp-name <name>", "WebAuthn relying party name", "GLV")
    .option(
      "--rp-id <domain>",
      "WebAuthn relying party ID (defaults to the request host)",
    )
    .option(
      "--forward",
      "open an ssh reverse tunnel (host from the glv config file)",
    )
    .option("--debug", "enable debug logging (equivalent to GLV_DEBUG=1)");

// The shared tail of every serve wiring: relaying party config, tunnel
// host, and debug flag.
type ServeTailOpts = {
  rpName: string;
  rpId?: string;
  forward?: boolean;
  debug?: boolean;
};

const serveTail = (
  profile: FlavorProfile,
  opts: ServeTailOpts,
): {
  rpName: string;
  rpIdOverride?: string;
  forwardHost?: string;
  debug: boolean;
} => ({
  rpName: opts.rpName,
  rpIdOverride: opts.rpId,
  forwardHost: resolveForwardHost(profile, opts.forward),
  debug: opts.debug === true,
});

// Defaults argv to the `sessions` subcommand and turns parse failures into
// exit code 1 instead of a stack trace.
const runMain = (program: Command): void => {
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

export {
  addServeTailOptions,
  makeRunnerConfig,
  parseMaxConcurrent,
  readGlobalOpts,
  registerConfigCommands,
  registerViewCommand,
  resolveAgentBinary,
  resolveAuthDbPath,
  resolveForwardHost,
  resolveGroupsDbPath,
  resolvePromptsDbPath,
  runList,
  runMain,
  runServe,
  runView,
  serveTail,
};
