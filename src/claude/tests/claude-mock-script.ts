import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
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

// True when glv launched us in streaming-input mode (--input-format
// stream-json): user messages arrive as NDJSON lines on a long-lived stdin
// instead of one raw prompt, and each message gets its own turn.
const streamInputMode = (args: string[]): boolean =>
  argValue(args, "--input-format") === "stream-json";

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

// The terminal record claude emits once per turn in stream-json mode; glv's
// runner counts these to know when every written message has been answered
// and it can close stdin. Never committed to the transcript — the real
// result record is a stdout artifact, not a session row.
const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success" });

// The capture mirrors "the prompt text the agent received": a user-message
// line is captured decoded (its content string) rather than as the raw
// NDJSON envelope, so prompt-body assertions hold for both delivery
// dialects. Raw JSON would also escape Windows path backslashes, breaking
// substring comparisons that the raw-stdin (goose) flavor satisfies.
const decodeUserMessage = (line: string): string => {
  let parsed: {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return line;
  }
  if (parsed.type !== "user" || parsed.message?.role !== "user") return line;
  const content = parsed.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n");
  return line;
};

// Streaming-input mode (verified against claude 2.1.233): read stdin
// line-by-line; every user message is one turn — committed to the
// transcript, answered with the configured output lines, then closed with a
// result record. Messages that arrive while a turn is still open are
// queued here exactly the way claude queues them, so steering mid-turn
// degrades to a turn boundary, never a lost prompt. On stdin EOF the work
// finishes and the process exits.
const runStreamMode = async (sessionId: string | undefined): Promise<void> => {
  const capturePath = process.env.CLAUDE_MOCK_CAPTURE_STDIN ?? "";
  const logPath = process.env.CLAUDE_MOCK_STDIN_LOG ?? "";
  if (logPath !== "") writeFileSync(logPath, "");
  if (capturePath !== "") writeFileSync(capturePath, "");

  const lines = linesFromEnv("CLAUDE", DEFAULT_LINE);
  const lineDelay = Number(process.env.CLAUDE_MOCK_LINE_DELAY_MS ?? 0);
  const turnDelay = Number(process.env.CLAUDE_MOCK_TURN_DELAY_MS ?? 0);
  const initialDelay = Number(process.env.CLAUDE_MOCK_SLEEP_MS ?? 0);
  const writeDb = process.env.CLAUDE_MOCK_WRITE_DB === "1";

  const logLine = (line: string): void => {
    if (logPath !== "")
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  };

  const pending: string[] = [];
  let eof = false;
  let wake: (() => void) | undefined;
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (raw: string) => {
    const line = raw.trim();
    if (line === "") return;
    logLine(line);
    if (capturePath !== "")
      appendFileSync(capturePath, decodeUserMessage(line) + "\n");
    pending.push(line);
    wake?.();
  });
  reader.on("close", () => {
    eof = true;
    wake?.();
  });

  const nextMessage = async (): Promise<string | undefined> => {
    while (pending.length === 0 && !eof)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    return pending.shift();
  };

  let firstTurn = true;
  for (;;) {
    const message = await nextMessage();
    if (message === undefined) break;
    if (writeDb && sessionId !== undefined)
      commitLine(sessionId, message, Date.now());
    if (firstTurn && initialDelay > 0) await sleep(initialDelay);
    firstTurn = false;
    let ts = Date.now();
    for (const line of lines) {
      console.log(line);
      if (writeDb && sessionId !== undefined) commitLine(sessionId, line, ts);
      ts += 1000;
      if (lineDelay > 0) await sleep(lineDelay);
    }
    if (turnDelay > 0) await sleep(turnDelay);
    console.log(RESULT_LINE);
  }

  const exitDelay = Number(process.env.CLAUDE_MOCK_EXIT_DELAY_MS ?? 0);
  if (exitDelay > 0) await sleep(exitDelay);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  // A --resume flag means a follow-up on an existing session; otherwise this
  // is a new session whose id glv pre-assigned via --session-id. Create
  // first so the server's transcript poll detects the file promptly even
  // when a long sleep keeps the process alive afterwards. Tests that need a
  // create-timeout (session-establishment failure) skip the file entirely.
  const neverCreate = process.env.CLAUDE_MOCK_NEVER_CREATE_SESSION === "1";
  const sessionId = args.includes("--resume")
    ? argValue(args, "--resume")
    : neverCreate
      ? argValue(args, "--session-id")
      : createSession(argValue(args, "--session-id"));

  if (streamInputMode(args)) {
    // Captures happen before the line loop because stdin stays open for the
    // whole process — reading it to EOF first (the raw-prompt path) would
    // deadlock until glv closes the pipe.
    captureTo("CLAUDE_MOCK_CAPTURE_CWD", process.cwd());
    captureTo("CLAUDE_MOCK_CAPTURE_ARGS", JSON.stringify(args));
    captureTo("CLAUDE_MOCK_CAPTURE_ENV", JSON.stringify(claudeCodeEnv()));
    await runStreamMode(sessionId);
    process.exit(Number(process.env.CLAUDE_MOCK_EXIT_CODE ?? 0));
  }

  await captureStdinTo("CLAUDE_MOCK_CAPTURE_STDIN");
  captureTo("CLAUDE_MOCK_CAPTURE_CWD", process.cwd());
  captureTo("CLAUDE_MOCK_CAPTURE_ARGS", JSON.stringify(args));
  captureTo("CLAUDE_MOCK_CAPTURE_ENV", JSON.stringify(claudeCodeEnv()));

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
