import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { type } from "arktype";
import { parseJson } from "../parse.js";

// The run-wide registry of live `glv ... serve` processes the test
// harness boots (issue #360): every detached serve spawn appends its pid
// and exact argv to a per-worker file under a per-run directory that
// lives OUTSIDE the per-test scratch dirs — those are removed by
// cleanup while a leaked server outlives them. Vitest's global teardown
// kills what this run left alive (any worker death that skipped
// per-test cleanup — OOM, shard cancel, Ctrl-C), and global setup reaps
// previous runs' leftovers so a SIGKILLed run self-heals on the next
// test run. Killing is strictly identity-checked — a recorded pid is
// only signalled while its command line still matches the recorded
// argv — so a recycled pid never gets an innocent process killed;
// unverifiable pids are left alone.

const IS_WIN = platform() === "win32";

// Shared root for every run's registry directory: under the OS temp dir
// like the scratch dirs, but outside them — it must outlive the
// per-test cleanup that removes those.
const REGISTRY_ROOT = join(tmpdir(), "glv-serve-registry");

// Set by vitest global setup and inherited by the forked workers, which
// is how every worker's appends land in the same run directory. Unset
// (pnpm shots, ad-hoc harness drives) falls back to a private ad-hoc
// directory.
const RUN_DIR_ENV = "GLV_SERVE_REGISTRY_RUN_DIR";

// A recorded serve younger than this is presumed to belong to a run
// still in flight (a second checkout's suite, a concurrent `pnpm shots`)
// and is spared by the boot sweeps. One hour comfortably covers the
// longest honest local run while still reaping the day-old zombie
// fleets the issue describes.
const STALE_SERVE_AGE_MS = 60 * 60 * 1000;

// One registry line: the serve's pid, the argv it was spawned with
// (launcher path first, `serve` second), and its spawn time in epoch ms.
type ServeEntry = {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly startedAt: number;
};

const ServeEntryLine = type({
  pid: "number",
  argv: "string[]",
  startedAt: "number",
});

// A torn or foreign line is skipped, never fatal — the registry guards
// tests, it must not break them.
const parseEntry = (line: string): ServeEntry | undefined => {
  const parsed = parseJson(line, ServeEntryLine);
  return parsed.ok ? parsed.data : undefined;
};

const readServeEntries = (file: string): ServeEntry[] => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        const entry = parseEntry(line);
        return entry === undefined ? [] : [entry];
      });
  } catch {
    return [];
  }
};

const registryFilesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Signal 0 probes liveness: success (or EPERM — exists but not ours)
// means alive; ESRCH means gone.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err !== "object" || err === null || !("code" in err))
      return false;
    return err.code === "EPERM";
  }
};

// The live process's command line minus the executable, or null when it
// cannot be read. Linux: /proc; macOS and other POSIX: ps; Windows:
// PowerShell's CIM query (the recorded argv comparison is loosened
// there — see matchesRecordedArgv).
const argvOf = (pid: number): string | null => {
  if (IS_WIN) {
    const probed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (probed.status !== 0 || probed.stdout === null) return null;
    return probed.stdout.trim();
  }
  if (platform() === "linux")
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter((part) => part !== "")
        .slice(1)
        .join(" ");
    } catch {
      return null;
    }

  const listed = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (listed.status !== 0 || listed.stdout === null) return null;
  const command = listed.stdout.trim();
  // ps renders the executable too; strip it so every platform compares
  // the same shape (the launcher path first, `serve` second).
  return command.startsWith(process.execPath)
    ? command.slice(process.execPath.length).replace(/^\s+/, "")
    : command;
};

// Identity check before any kill: the live process must still be the
// recorded serve. POSIX compares the full recorded argv exactly — a
// recycled pid runs something else, and another checkout's serve has a
// different launcher path and different scratch paths, so neither
// matches. Windows strips quoting from the CIM command line and can
// only check the shape (node ... glv.mjs serve ...), the best its
// tooling offers.
const matchesRecordedArgv = (pid: number, argv: readonly string[]): boolean => {
  const live = argvOf(pid);
  if (live === null || live === "") return false;
  if (IS_WIN)
    return (
      live.replaceAll('"', "").includes("glv.mjs") && live.includes("serve")
    );
  return live === argv.join(" ");
};

type ServeProcess = {
  readonly pid: number;
  readonly command: string;
  readonly startedAtMs: number;
};

// Every harness scratch dir is mkdtemp'd under tmpdir() with a
// "glv"-prefixed name, and every flag pointing a database or store at
// one therefore starts with this prefix. Production serve resolves its
// databases under the platform data dir instead, which is what makes
// the signature below unambiguous (issue #360's suggested orphan match).
const SCRATCH_ARG_PREFIX = `${tmpdir()}${IS_WIN ? "\\" : "/"}glv`;

// The unambiguous signature of a harness-booted serve: the merged
// launcher, a `serve` verb, and at least one argument pointing under
// the scratch area — production serve never does that.
const isHarnessServeCommand = (command: string): boolean => {
  if (!command.includes("glv.mjs")) return false;
  if (!/(^|\s)serve(\s|$)/.test(command)) return false;
  return command.split(/\s+/).some((arg) => arg.startsWith(SCRATCH_ARG_PREFIX));
};

// Parses "Thu Oct 23 09:30:12 2026" (ps lstart) or a CIM
// "20261023093012.000000+120" timestamp into epoch ms.
const parseStartTime = (raw: string): number | undefined => {
  const cim = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (cim !== null)
    return new Date(
      Number(cim[1]),
      Number(cim[2]) - 1,
      Number(cim[3]),
      Number(cim[4]),
      Number(cim[5]),
      Number(cim[6]),
    ).getTime();
  const psParsed = Date.parse(raw);
  return Number.isNaN(psParsed) ? undefined : psParsed;
};

const PS_LINE =
  /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

const collectServeProcesses = (
  output: string | null,
  parseLine: (line: string) => ServeProcess | undefined,
): ServeProcess[] => {
  const found: ServeProcess[] = [];
  if (output === null) return found;
  for (const line of output.split("\n")) {
    const proc = parseLine(line);
    if (proc !== undefined) found.push(proc);
  }
  return found;
};

const parseCimLine = (line: string): ServeProcess | undefined => {
  const parts = line.split("|");
  if (parts.length < 3) return undefined;
  const pid = Number(parts[0]);
  const startedAtMs = parseStartTime(parts[1] ?? "");
  if (!Number.isInteger(pid) || pid <= 0 || startedAtMs === undefined)
    return undefined;
  const command = parts.slice(2).join("|").replaceAll('"', "");
  return isHarnessServeCommand(command)
    ? { pid, command, startedAtMs }
    : undefined;
};

const parsePsLine = (line: string): ServeProcess | undefined => {
  const parsed = line.match(PS_LINE);
  if (parsed === null) return undefined;
  const pid = Number(parsed[1]);
  const startedAtMs = parseStartTime((parsed[2] ?? "").trim());
  if (!Number.isInteger(pid) || pid <= 0 || startedAtMs === undefined)
    return undefined;
  const command = parsed[3] ?? "";
  return isHarnessServeCommand(command)
    ? { pid, command, startedAtMs }
    : undefined;
};

// Enumerates node processes whose command line looks like a harness
// serve. POSIX: ps; Windows: PowerShell's CIM query.
const listHarnessServeProcesses = (): ServeProcess[] => {
  if (IS_WIN) {
    const probed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          'ForEach-Object { "$($_.ProcessId)|$($_.CreationDate)|$($_.CommandLine)" }',
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (probed.status !== 0) return [];
    return collectServeProcesses(probed.stdout, parseCimLine);
  }
  const listed = spawnSync(
    "ps",
    ["-ax", "-ww", "-o", "pid=", "-o", "lstart=", "-o", "command="],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (listed.status !== 0) return [];
  return collectServeProcesses(listed.stdout, parsePsLine);
};

// Worker threads share one pid; a distinct file per (pid, thread) keeps
// every writer sole owner of its file, which is what makes the
// rewrite-on-unregister below race-free.
const workerToken =
  threadId === 0 ? `${process.pid}` : `${process.pid}-${threadId}`;

let adhocDir: string | undefined;

const runDir = (): string => {
  const fromEnv = process.env[RUN_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    mkdirSync(fromEnv, { recursive: true });
    return fromEnv;
  }
  if (adhocDir === undefined) {
    mkdirSync(REGISTRY_ROOT, { recursive: true });
    adhocDir = mkdtempSync(join(REGISTRY_ROOT, "adhoc-"));
  }
  return adhocDir;
};

const registryFileFor = (dir: string): string =>
  join(dir, `${workerToken}.jsonl`);

// This worker's recorded serves, live or not — what a mid-run teardown
// sweep would act on.
const currentServeEntries = (): ServeEntry[] =>
  readServeEntries(registryFileFor(runDir()));

const workerServeRegistryFile = (): string => registryFileFor(runDir());

// Pids recorded as alive-and-recent somewhere in the registry — an
// in-flight run's servers, which the orphan sweep must not touch even
// when the process table says they are old enough.
const liveRegisteredPids = (minAgeMs: number): Set<number> => {
  const pids = new Set<number>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(REGISTRY_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REGISTRY_ROOT, entry.name));
  } catch {
    return pids;
  }
  for (const dir of dirs)
    for (const file of registryFilesIn(dir))
      for (const entry of readServeEntries(file))
        if (isAlive(entry.pid) && Date.now() - entry.startedAt < minAgeMs)
          pids.add(entry.pid);
  return pids;
};

// Kills the serve's whole process group (the launcher leads it; its
// esbuild service child rides along): SIGTERM with a grace window,
// then SIGKILL — the same escalation stopProcess applies to a live
// ChildProcess. Windows taskkill walks the tree.
const killServeGroup = async (pid: number): Promise<void> => {
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // group already gone — nothing to escalate
    }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(pid)) signalGroup("SIGKILL");
};

// Called by spawnLauncher for every serve boot. Failures only warn: a
// registry hiccup must never fail a test.
const registerServeSpawn = (pid: number, argv: readonly string[]): void => {
  try {
    appendFileSync(
      registryFileFor(runDir()),
      `${JSON.stringify({ pid, argv, startedAt: Date.now() })}\n`,
    );
  } catch (err) {
    console.warn(`serve registry: failed to record serve pid ${pid}:`, err);
  }
};

// Called on the serve's exit (however it exits): sole writer of this
// file rewrites it without the pid, and an emptied registry directory
// is dropped so the boot sweep has nothing stale to chew on.
const unregisterServeExit = (pid: number): void => {
  try {
    const dir = runDir();
    const file = registryFileFor(dir);
    const rest = readServeEntries(file).filter((entry) => entry.pid !== pid);
    if (rest.length === 0) {
      rmSync(file, { force: true });
      // Non-recursive: fails with ENOTEMPTY while sibling workers still
      // have files here, which is exactly right.
      rmSync(dir, { force: true });
      return;
    }
    writeFileSync(
      file,
      `${rest.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  } catch {
    // a stale entry only costs the next sweep a liveness check
  }
};

// Kills a recorded serve when its pid is still alive and still the
// recorded process; returns whether an identifiable process was left
// alive (untouched, or surviving the kill), so the caller knows to keep
// the registry directory.
const reapServe = async (
  entry: ServeEntry,
  action: string,
): Promise<boolean> => {
  if (!isAlive(entry.pid)) return false;
  if (!matchesRecordedArgv(entry.pid, entry.argv)) {
    console.warn(
      `serve-registry ${action}: pid ${entry.pid} is alive but no ` +
        "longer the recorded serve — leaving it alone",
    );
    return true;
  }
  console.warn(
    `serve-registry ${action}: killing serve pid ${entry.pid} ` +
      `(registered ${Math.round((Date.now() - entry.startedAt) / 60000)} min ago)`,
  );
  await killServeGroup(entry.pid);
  return isAlive(entry.pid);
};

type SweepOptions = {
  /** Recorded serves younger than this are spared (live runs). */
  readonly minAgeMs?: number;
  /** Registry root to sweep; defaults to the shared one. */
  readonly root?: string;
  /** Directory to leave untouched (the current run's). */
  readonly keepDir?: string;
};

// One run directory of the boot sweep: kill each recorded serve still
// alive, identity-checked, and older than the threshold. Young live
// entries (a concurrently running second checkout) spare the directory.
const reapStaleDir = async (
  dir: string,
  minAgeMs: number,
): Promise<boolean> => {
  let aliveLeft = false;
  for (const file of registryFilesIn(dir))
    for (const entry of readServeEntries(file)) {
      if (isAlive(entry.pid) && Date.now() - entry.startedAt < minAgeMs) {
        aliveLeft = true;
        continue;
      }
      if (await reapServe(entry, "sweep")) aliveLeft = true;
    }
  return aliveLeft;
};

// The boot-time sweep: reap what PREVIOUS runs left — for every other
// run directory under the root, kill its stale recorded serves and drop
// the directory when nothing alive remains in it.
const sweepStaleServes = async (options: SweepOptions = {}): Promise<void> => {
  const minAgeMs = options.minAgeMs ?? STALE_SERVE_AGE_MS;
  const root = options.root ?? REGISTRY_ROOT;
  const keep = options.keepDir ?? process.env[RUN_DIR_ENV] ?? "";
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return; // no registry root — nothing has leaked yet
  }
  for (const dir of dirs) {
    if (dir === keep) continue;
    const aliveLeft = await reapStaleDir(dir, minAgeMs);
    if (!aliveLeft) rmSync(dir, { recursive: true, force: true });
  }
};

// The boot-time orphan sweep: serve processes nobody registered — the
// fleets leaked before the registry existed, exactly like the one the
// issue found. Skips anything a live run has registered and group-kills
// the rest once older than the threshold. Fail-open: a pid that cannot
// be identified or dated is never signalled.
const sweepOrphanedServes = async (
  options: SweepOptions = {},
): Promise<void> => {
  const minAgeMs = options.minAgeMs ?? STALE_SERVE_AGE_MS;
  const protectedPids = liveRegisteredPids(minAgeMs);
  for (const candidate of listHarnessServeProcesses()) {
    if (protectedPids.has(candidate.pid)) continue;
    if (Date.now() - candidate.startedAtMs < minAgeMs) continue;
    console.warn(
      `serve-registry orphan sweep: killing unregistered serve pid ` +
        `${candidate.pid} (${candidate.command.slice(0, 120)})`,
    );
    await killServeGroup(candidate.pid);
  }
};

// The teardown sweep: everything recorded under the target (a single
// worker file, or the whole run directory) is this run's, so age plays
// no part — kill what is alive and identity-checked, then drop the
// directory. Runs after the workers are gone, so only never-cleaned-up
// serves remain recorded.
const killRegisteredServes = async (target: string): Promise<void> => {
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    return; // nothing recorded — nothing to do
  }
  const files = isDir ? registryFilesIn(target) : [target];
  for (const file of files)
    for (const entry of readServeEntries(file))
      await reapServe(entry, "teardown");
  if (isDir) rmSync(target, { recursive: true, force: true });
};

// Vitest global setup calls this before any worker forks; the path is
// handed to the workers through the environment (RUN_DIR_ENV).
const createServeRunDir = (): string => {
  mkdirSync(REGISTRY_ROOT, { recursive: true });
  return mkdtempSync(join(REGISTRY_ROOT, "run-"));
};

export {
  createServeRunDir,
  currentServeEntries,
  killRegisteredServes,
  listHarnessServeProcesses,
  RUN_DIR_ENV,
  registerServeSpawn,
  sweepOrphanedServes,
  sweepStaleServes,
  unregisterServeExit,
  workerServeRegistryFile,
};
