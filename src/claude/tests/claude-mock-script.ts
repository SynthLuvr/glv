import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
  spawnLongChild,
  streamLines,
} from "../../glv/tests/mock-common.js";
import { encodeWorkingDir } from "../store/working-dir.js";

// Stand-in for the real claude binary. A --resume flag means a follow-up,
// so no new session file is created. Behaviour is driven by env vars (sleep,
// exit code, output lines), read fresh per invocation.
const DEFAULT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "mock claude reply" }],
  },
});

const projectsRoot = (): string | undefined => {
  const dir = process.env.CLAUDE_MOCK_PROJECTS_DIR;
  return dir === undefined || dir === "" ? undefined : dir;
};

// The transcript file claude would write: under the projects root, in the
// directory named after the encoded working directory.
const transcriptPath = (sessionId: string): string | undefined => {
  const root = projectsRoot();
  if (root === undefined) return undefined;
  return join(root, encodeWorkingDir(process.cwd()), sessionId + ".jsonl");
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
const createSession = (preassigned?: string): string | undefined => {
  const id = preassigned ?? randomUUID();
  const path = transcriptPath(id);
  if (path === undefined) return id;
  mkdirSync(dirname(path), { recursive: true });
  const name = process.env.CLAUDE_MOCK_SESSION_NAME ?? "";
  writeFileSync(path, titleLine(id, name) + "\n");
  return id;
};

const claudeCodeEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      key.startsWith("CLAUDE_CODE_"),
    ),
  );

const argValue = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
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
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type,
      message,
      uuid: randomUUID(),
      timestamp: new Date(ts).toISOString(),
      cwd: process.cwd(),
      sessionId,
    }) + "\n",
  );
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  // A --resume flag means a follow-up on an existing session; otherwise this
  // is a new session whose id glv pre-assigned via --session-id. Create
  // first so the server's transcript poll detects the file promptly even
  // when a long sleep keeps the process alive afterwards.
  const sessionId = args.includes("--resume")
    ? argValue(args, "--resume")
    : createSession(argValue(args, "--session-id"));

  await captureStdinTo("CLAUDE_MOCK_CAPTURE_STDIN");
  captureTo("CLAUDE_MOCK_CAPTURE_CWD", process.cwd());
  captureTo("CLAUDE_MOCK_CAPTURE_ARGS", JSON.stringify(args));
  captureTo("CLAUDE_MOCK_CAPTURE_ENV", JSON.stringify(claudeCodeEnv()));
  spawnLongChild("CLAUDE_MOCK_SPAWN_CHILD");

  const sleepMs = Number(process.env.CLAUDE_MOCK_SLEEP_MS ?? 0);
  if (sleepMs > 0) await sleep(sleepMs);

  const lines = linesFromEnv("CLAUDE", DEFAULT_LINE);
  const delay = Number(process.env.CLAUDE_MOCK_LINE_DELAY_MS ?? 0);
  const writeDb = process.env.CLAUDE_MOCK_WRITE_DB === "1";

  await streamLines(
    lines,
    delay,
    writeDb && sessionId !== undefined
      ? (line, ts) => commitLine(sessionId, line, ts)
      : undefined,
  );

  process.exit(Number(process.env.CLAUDE_MOCK_EXIT_CODE ?? 0));
};

void main();
