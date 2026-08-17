import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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
import type { SessionStore } from "./db.js";
import { resolveGroupsDbPath } from "./groups/db.js";
import { resolvePromptsDbPath } from "./prompts/db.js";
import { makeRunnerConfig, PERMISSION_MODES } from "./runner/index.js";
import { openMetaDb, resolveMetaDbPath } from "./store/meta.js";
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
  .name("glv")
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

const globalOpts = () => {
  const opts = GlobalOpts(program.opts());
  if (opts instanceof type.errors)
    throw new Error(`Invalid global options: ${opts.summary}`);
  return opts;
};

// Opens the glv-owned meta sidecar (creating it on first use) and pairs it
// with claude's projects directory; the transcript files themselves stay
// owned — and only ever written — by the claude CLI.
const openSessionStore = (): SessionStore => ({
  root: resolveProjectsRoot(globalOpts().projectsDir),
  meta: openMetaDb(resolveMetaDbPath(globalOpts().metaDb)),
});

const useStore = (fn: (store: SessionStore) => void): void => {
  const store = openSessionStore();
  try {
    fn(store);
  } finally {
    store.meta.close();
  }
};

program
  .command("sessions")
  .description("List claude sessions (interactive user sessions)")
  .option("--all", "include archived sessions")
  .option("-n, --limit <number>", "number of rows to list", "20")
  .action((opts: SessionsOpts) => {
    useStore((store) =>
      runList(store, {
        limit: Number(opts.limit),
        includeArchived: opts.all === true,
      }),
    );
  });

program
  .command("view <sessionId>")
  .description("Show prompts and final outputs for a session")
  .action((sessionId: string) => {
    useStore((store) => runView(store, sessionId));
  });

const configCmd = program
  .command("config")
  .description("Read and set fields in the glv config file")
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

const resolveCliBinary = (value: string): string => {
  if (value.includes("/") || value.includes("\\")) {
    if (!existsSync(value))
      throw new InvalidArgumentError(`binary not found at "${value}"`);
    return value;
  }
  // Windows executables carry extensions (.exe, .cmd); PATHEXT lists the ones
  // to try, so a bare "claude" matches "claude.exe" there.
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

const parsePermissionMode = (value: string): string => {
  if (!PERMISSION_MODES.includes(value))
    throw new InvalidArgumentError(
      `must be one of: ${PERMISSION_MODES.join(", ")}`,
    );
  return value;
};

const resolveForwardHost = (forward?: boolean): string | undefined => {
  if (!forward) return undefined;
  const { forwardHost } = readConfig();
  if (forwardHost === undefined)
    throw new Error('--forward needs "forwardHost" set in the glv config file');
  return forwardHost;
};

program
  .command("serve")
  .description("Start a local web viewer for claude sessions")
  .option("-p, --port <number>", "port to listen on", "3000")
  .option(
    "-c, --max-concurrent <number>",
    "max concurrent claude runs",
    parseMaxConcurrent,
    6,
  )
  .option(
    "--claude-binary <path>",
    "path to the claude binary",
    resolveCliBinary,
    "claude",
  )
  .option(
    "--permission-mode <mode>",
    'claude permission mode for glv-launched runs; "inherit" defers to your claude settings.json',
    parsePermissionMode,
    "inherit",
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
    const store = openSessionStore();
    runServe(store, {
      port: Number(opts.port),
      runner: makeRunnerConfig(
        opts.maxConcurrent,
        opts.claudeBinary,
        opts.permissionMode,
      ),
      authDbPath: resolveAuthDbPath(globalOpts().authDb),
      promptsDbPath: resolvePromptsDbPath(globalOpts().promptsDb),
      groupsDbPath: resolveGroupsDbPath(globalOpts().groupsDb),
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
