import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { JsonObject, parseJson } from "./parse.js";

const configRoot = (): string => {
  if (platform() === "win32")
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  return join(homedir(), ".config");
};

// One scheduled run. `schedule` is a cron pattern ("0 9 * * 1-5") or an
// ISO 8601 local datetime ("2026-09-03T09:00") for a fire-once run.
// Hand-editable in the file; the web UI's Scheduled runs section reads
// and writes the same entries.
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

// Read-modify-write helpers for the cron jobs array specifically. They
// preserve every other config key (and any unknown future ones), and the
// final write validates the whole file so a bad job can never be written.

const readCronJobs = (dataDirName: string): CronJobConfig[] =>
  readConfig(dataDirName).cronJobs ?? [];

const writeCronJobs = (
  dataDirName: string,
  jobs: readonly CronJobConfig[],
): void => {
  const config = readRawConfig(dataDirName);
  config.cronJobs = [...jobs];
  writeConfig(dataDirName, config);
};

// Appends a job. The caller owns duplicate-name detection so it can shape
// the user-facing error; this stays mechanical.
const appendCronJob = (dataDirName: string, job: CronJobConfig): void =>
  writeCronJobs(dataDirName, [...readCronJobs(dataDirName), job]);

// Removes a job by its resolved name (unnamed entries resolve to
// cron-<index+1>, matching the scheduler); false when nothing matched.
const deleteCronJob = (dataDirName: string, name: string): boolean => {
  const jobs = readCronJobs(dataDirName);
  const kept = jobs.filter(
    (job, index) => (job.name?.trim() || `cron-${index + 1}`) !== name,
  );
  if (kept.length === jobs.length) return false;
  writeCronJobs(dataDirName, kept);
  return true;
};

// A job whose display name has been resolved (unnamed config entries
// default to cron-<index+1>); what the UI renders and mutates.
type NamedCronJob = CronJobConfig & { readonly name: string };

export type { CronJobConfig, NamedCronJob };
export {
  appendCronJob,
  CONFIG_KEYS,
  deleteCronJob,
  readConfig,
  readCronJobs,
  readRawConfig,
  writeConfig,
  writeCronJobs,
};
