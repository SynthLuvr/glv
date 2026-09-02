import { renameSync, writeFileSync } from "node:fs";

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

// Blocks the thread briefly; used between rename retries below.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Windows refuses a replace while a reader or an AV scan holds the
// destination open; a few short retries ride that out and are no-ops on
// POSIX, where the first rename lands.
const isRenameBusy = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
};

// Writes via a sibling temp file and a final rename so a polling reader
// only ever sees the previous contents or the complete new ones — never a
// partial or empty file, which existsSync-then-read handshakes would
// otherwise race straight into assertions.
const writeFileAtomic = (path: string, data: string | Buffer): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 5 || !isRenameBusy(err)) throw err;
      sleepSync(25);
    }
  }
};

// Reads all of stdin (the full prompt including file-path context) and
// writes it to the capture file named by the env var, when set.
const captureStdinTo = async (envVar: string): Promise<void> => {
  const captureTo = process.env[envVar];
  if (captureTo === undefined || captureTo === "") return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  writeFileAtomic(captureTo, Buffer.concat(chunks));
};

const captureTo = (envVar: string, content: string): void => {
  const path = process.env[envVar];
  if (path !== undefined && path !== "") writeFileAtomic(path, content);
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

export { captureStdinTo, captureTo, linesFromEnv, sleep, streamLines };
