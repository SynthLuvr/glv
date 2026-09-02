import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { type } from "arktype";
import { JsonObject, parseJson } from "./parse.js";

const configRoot = (): string => {
  if (platform() === "win32")
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  return join(homedir(), ".config");
};

// One scheduled run. Hand-edited for now — the file is the interface;
// glv/cron.ts validates and runs them when serve starts.
const CronJob = type({
  "name?": "string",
  schedule: "string>0",
  prompt: "string>0",
  workingDir: "string>0",
  "timezone?": "string",
  "enabled?": "boolean",
});

const Config = type({
  "forwardHost?": "string",
  "cronJobs?": type([CronJob, "[]"]),
});

type GlvConfig = typeof Config.infer;
type CronJobConfig = typeof CronJob.infer;

const CONFIG_KEYS: readonly string[] = ["forwardHost", "cronJobs"];

// Lives outside the repo so per-machine secrets (e.g. a forward host) stay
// uncommitted. Precedence mirrors the DB-path helpers: env override → default.
const resolveConfigPath = (dataDirName: string): string =>
  process.env.GLV_CONFIG ?? join(configRoot(), dataDirName, "config.json");

const readRawConfig = (dataDirName: string): Record<string, unknown> => {
  const path = resolveConfigPath(dataDirName);
  if (!existsSync(path)) return {};
  const parsed = parseJson(readFileSync(path, "utf-8"), JsonObject);
  if (!parsed.ok)
    throw new Error(`glv config at ${path} is not valid JSON: ${parsed.error}`);
  return parsed.data;
};

const validateConfig = (config: Record<string, unknown>): GlvConfig => {
  const result = Config(config);
  if (result instanceof type.errors)
    throw new Error(`invalid glv config: ${result.summary}`);
  return result;
};

const readConfig = (dataDirName: string): GlvConfig =>
  validateConfig(readRawConfig(dataDirName));

const writeConfig = (
  dataDirName: string,
  config: Record<string, unknown>,
): void => {
  validateConfig(config);
  const path = resolveConfigPath(dataDirName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
};

type ConfigFileWatch = {
  /** Stops watching; the callback never fires afterwards. */
  readonly stop: () => void;
};

// Editors write configs in bursts (and often replace the file by atomic
// rename), so events are debounced and the settled content is compared
// against the last content seen — only real changes surface.
const WATCH_DEBOUNCE_MS = 250;

// fs.watch directory events are unreliable on some filesystems (network
// mounts) and impossible before the config directory exists, so a
// content-comparing poll backs the watcher up.
const DEFAULT_WATCH_POLL_MS = 5_000;

// Test-facing override: bounds the worst-case reload latency so live
// reload is observable without waiting out the default poll.
const watchPollMs = (): number => {
  const raw = process.env.GLV_CONFIG_WATCH_POLL_MS;
  if (raw === undefined || raw === "") return DEFAULT_WATCH_POLL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WATCH_POLL_MS;
};

// The watcher's own view of the file: undefined while it is absent, so a
// later (re)creation reads as a change just like an edit.
const readConfigText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

// Calls onChange once the file settles on content it has not shown
// before. Watching the directory (not the file) survives editors that
// replace the file by rename; a missing directory just leaves the poll.
const watchConfigFile = (
  path: string,
  onChange: () => void,
): ConfigFileWatch => {
  let last = readConfigText(path);
  let stopped = false;
  let pending: NodeJS.Timeout | undefined;

  const check = (): void => {
    pending = undefined;
    if (stopped) return;
    const text = readConfigText(path);
    if (text === last) return;
    last = text;
    onChange();
  };

  const schedule = (): void => {
    if (stopped || pending !== undefined) return;
    pending = setTimeout(check, WATCH_DEBOUNCE_MS);
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(path), { persistent: true }, (_event, file) => {
      if (file !== undefined && file !== basename(path)) return;
      schedule();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    // Nothing to watch yet — the poll still notices the file appearing.
  }

  const poll = setInterval(() => {
    if (pending === undefined) check();
  }, watchPollMs());

  return {
    stop: () => {
      stopped = true;
      if (pending !== undefined) clearTimeout(pending);
      clearInterval(poll);
      watcher?.close();
    },
  };
};

export type { ConfigFileWatch, CronJobConfig };
export {
  CONFIG_KEYS,
  readConfig,
  readRawConfig,
  resolveConfigPath,
  watchConfigFile,
  writeConfig,
};
