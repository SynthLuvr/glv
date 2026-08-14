import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeWorkingDir } from "../store/working-dir.js";

// Stand-in for the real claude binary. A --resume flag means a follow-up,
// so no new session file is created. Behaviour is driven by env vars (sleep,
// exit code, output lines), read fresh per invocation.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "mock claude reply" }],
  },
});

const linesFromEnv = (): string[] => {
  const custom = process.env.CLAUDE_MOCK_LINES ?? "";
  return (custom === "" ? [DEFAULT_LINE] : custom.split("\n")).filter(
    (line) => line !== "",
  );
};

const projectsRoot = (): string | undefined => {
  const dir = process.env.CLAUDE_MOCK_PROJECTS_DIR;
  return dir === undefined || dir === "" ? undefined : dir;
};

// The transcript file claude would write: under the projects root, in the
// directory named after the encoded working directory.
const transcriptPath = (sessionId: string): string | undefined => {
  const root = projectsRoot();
  if (root === undefined) return undefined;
  return join(root, encodeWorkingDir(process.cwd()), `${sessionId}.jsonl`);
};

const titleLine = (sessionId: string, title: string): string =>
  JSON.stringify({
    type: "ai-title",
    aiTitle: title,
    sessionId,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  });

// Creates the session's transcript file the way claude does when a run
// starts — before any output exists — so the server's file poll finds it.
// A session name, when requested, rides along as an ai-title line.
const createSession = (): string | undefined => {
  const id = randomUUID();
  const path = transcriptPath(id);
  if (path === undefined) return id;
  mkdirSync(dirname(path), { recursive: true });
  const name = process.env.CLAUDE_MOCK_SESSION_NAME ?? "";
  writeFileSync(path, `${titleLine(id, name)}\n`);
  return id;
};

const sessionIdFromArgs = (args: string[]): string | undefined => {
  const idx = args.indexOf("--resume");
  return idx >= 0 ? args[idx + 1] : undefined;
};

// Persists a streamed NDJSON event as a transcript line, the way claude
// appends to the session file as it runs.
const commitLine = (sessionId: string, line: string, ts: number): void => {
  const path = transcriptPath(sessionId);
  if (path === undefined) return;
  let type = "assistant";
  let message: unknown = { role: "assistant", content: [] };
  try {
    const parsed = JSON.parse(line) as { type?: unknown; message?: unknown };
    if (typeof parsed.type === "string") type = parsed.type;
    if (parsed.message !== undefined) message = parsed.message;
  } catch {
    // malformed JSON is never committed — stdout still shows it verbatim
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type,
      message,
      uuid: randomUUID(),
      timestamp: new Date(ts).toISOString(),
      cwd: process.cwd(),
      sessionId,
    })}\n`,
  );
};

// Prints each line to stdout, spacing them by `delay` so a tailing consumer
// sees them arrive one at a time rather than in a single burst. `writeDb`
// persists each line to the session transcript as it is produced.
const streamLines = async (
  sessionId: string | undefined,
  lines: string[],
  delay: number,
  writeDb: boolean,
): Promise<void> => {
  let ts = Date.now();
  for (const line of lines) {
    console.log(line);
    if (writeDb && sessionId !== undefined) commitLine(sessionId, line, ts);
    ts += 1000;
    if (delay > 0) await sleep(delay);
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const isResume = args.includes("--resume");

  // Create first so the server's session poll detects the file promptly even
  // when a long sleep keeps the process alive afterwards.
  const sessionId = isResume ? sessionIdFromArgs(args) : createSession();

  // Optionally capture stdin (the full prompt including file-path context)
  // so upload tests can verify what claude received.
  const captureTo = process.env.CLAUDE_MOCK_CAPTURE_STDIN;
  if (captureTo !== undefined && captureTo !== "") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    writeFileSync(captureTo, Buffer.concat(chunks));
  }

  // Optionally capture the working directory claude was spawned in so
  // temp-dir tests can verify the session ran in the expected location.
  const captureCwd = process.env.CLAUDE_MOCK_CAPTURE_CWD;
  if (captureCwd !== undefined && captureCwd !== "")
    writeFileSync(captureCwd, process.cwd());

  // Optionally capture claude's argv so --append-system-prompt tests can
  // verify the flags passed to it.
  const captureArgs = process.env.CLAUDE_MOCK_CAPTURE_ARGS;
  if (captureArgs !== undefined && captureArgs !== "")
    writeFileSync(captureArgs, JSON.stringify(args));

  // Spawn a long-lived descendant so session-stop tests can verify the whole
  // process tree (not just claude) is reaped. Its PID is written to the file.
  const spawnChildTo = process.env.CLAUDE_MOCK_SPAWN_CHILD;
  if (spawnChildTo !== undefined && spawnChildTo !== "") {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 2 ** 30)"],
      { stdio: "ignore" },
    );
    if (child.pid !== undefined) writeFileSync(spawnChildTo, String(child.pid));
  }

  const sleepMs = Number(process.env.CLAUDE_MOCK_SLEEP_MS ?? 0);
  if (sleepMs > 0) await sleep(sleepMs);

  const lines = linesFromEnv();
  const delay = Number(process.env.CLAUDE_MOCK_LINE_DELAY_MS ?? 0);
  const writeDb = process.env.CLAUDE_MOCK_WRITE_DB === "1";

  await streamLines(sessionId, lines, delay, writeDb);

  process.exit(Number(process.env.CLAUDE_MOCK_EXIT_CODE ?? 0));
};

void main();
