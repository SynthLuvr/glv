import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

// Behaviour shared by the per-flavor mock agent scripts (goose-mock-script,
// claude-mock-script). Everything is driven by env vars named
// `<prefix>_MOCK_*` so the harness can script each invocation.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The env-driven output lines: the default line when none is configured,
// else the newline-joined custom lines (empty entries dropped). A lines
// *file* takes precedence and is re-read on every invocation, so one
// environment can walk a suite through refusal and recovery.
const linesFromEnv = (prefix: string, defaultLine: string): string[] => {
  const file = process.env[prefix + "_MOCK_LINES_FILE"];
  const custom =
    file !== undefined && file !== ""
      ? readLinesFile(file)
      : (process.env[prefix + "_MOCK_LINES"] ?? "");
  return (custom === "" ? [defaultLine] : custom.split("\n")).filter(
    (line) => line !== "",
  );
};

// A missing or unreadable lines file falls back to the default line —
// a half-written fixture must not fake a silent agent.
const readLinesFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

// Synchronous sleep — Node has none built in, so block on a shared
// buffer. Used between rename retries below.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Windows rejects a rename while a reader or antivirus scan holds the
// destination open; brief retries ride that out and are no-ops on POSIX.
const isRenameBusy = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
};

// Writes via a sibling temp file and a final rename so a polling reader
// sees only the previous or the complete new contents — never a partial
// write.
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

// Suffix of the append-only transcript written alongside every capture
// file: each captured invocation is appended there, newline-terminated.
// The main capture always holds only the latest invocation, and the
// always-on suggestion ask is itself an invocation — it lands right
// after a session's reply and overwrites the prompt the suite is
// asserting on. Readers that must still see an earlier prompt read the
// transcript instead, where nothing is ever lost.
const TRANSCRIPT_SUFFIX = ".invocations";

const stdinTranscriptPath = (capturePath: string): string =>
  `${capturePath}${TRANSCRIPT_SUFFIX}`;

// Reads all of stdin (the full prompt including file-path context) and
// writes it to the capture file named by the env var, when set.
const captureStdinTo = async (envVar: string): Promise<void> => {
  const captureTo = process.env[envVar];
  if (captureTo === undefined || captureTo === "") return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const content = Buffer.concat(chunks);
  writeFileAtomic(captureTo, content);
  // Appends are small single writes; a concurrent invocation's append
  // can interleave but never loses an already-written entry.
  appendFileSync(
    stdinTranscriptPath(captureTo),
    Buffer.concat([content, Buffer.from("\n")]),
  );
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

export {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
  stdinTranscriptPath,
  streamLines,
};
