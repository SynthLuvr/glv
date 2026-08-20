import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// Behaviour shared by the per-flavor mock agent scripts (goose-mock-script,
// claude-mock-script). Everything is driven by env vars named
// `<prefix>_MOCK_*` so the harness can script each invocation.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The env-driven output lines: the default line when none are configured,
// else the newline-joined custom lines (empty entries dropped).
const linesFromEnv = (prefix: string, defaultLine: string): string[] => {
  const custom = process.env[prefix + "_MOCK_LINES"] ?? "";
  return (custom === "" ? [defaultLine] : custom.split("\n")).filter(
    (line) => line !== "",
  );
};

// Reads all of stdin (the full prompt including file-path context) and
// writes it to the capture file named by the env var, when set.
const captureStdinTo = async (envVar: string): Promise<void> => {
  const captureTo = process.env[envVar];
  if (captureTo === undefined || captureTo === "") return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  writeFileSync(captureTo, Buffer.concat(chunks));
};

const captureTo = (envVar: string, content: string): void => {
  const path = process.env[envVar];
  if (path !== undefined && path !== "") writeFileSync(path, content);
};

// Spawns a long-lived descendant so session-stop tests can verify the whole
// process tree (not just the agent) is reaped; its PID is written to the
// capture file.
const spawnLongChild = (envVar: string): void => {
  const to = process.env[envVar];
  if (to === undefined || to === "") return;
  // On Windows the mock agent is a hard link of node.exe, so the harness's
  // NODE_OPTIONS preload would redirect this child back into the mock
  // script — a fork chain of phantom agents. Dropping the targets variable
  // from its env makes the preload no-op; the 120s timer bounds the
  // child's life so a descendant missed by a stop cannot outlive the suite.
  const env = { ...process.env };
  delete env.GLV_MOCK_BIN_TARGETS;
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 120000)"],
    { stdio: "ignore", env },
  );
  if (child.pid !== undefined) writeFileSync(to, String(child.pid));
};

// Prints each line to stdout, spacing them by `delay` so a tailing consumer
// sees them arrive one at a time rather than in a single burst; `commit`
// persists each line as it is produced.
const streamLines = async (
  lines: string[],
  delay: number,
  commit?: (line: string, ts: number) => void,
): Promise<void> => {
  let ts = Date.now();
  for (const line of lines) {
    console.log(line);
    commit?.(line, ts);
    ts += 1000;
    if (delay > 0) await sleep(delay);
  }
};

export {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
  spawnLongChild,
  streamLines,
};
