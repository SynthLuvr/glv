import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  capturePromptTo,
  captureStdinTo,
  captureTo,
  linesFromEnv,
  readStdin,
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

// The bookkeeping line claude opens a headless transcript with — it
// carries the working dir and a timestamp but no title.
const openingLine = (sessionId: string): string =>
  JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    sessionId,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  });

// Creates the session's transcript file the way claude does when a run
// starts — before any output exists — so the server's file poll finds it.
// Like real claude 2.1.289 under --print, it carries no title: one is
// only written when the run asks for it (see answerTitleRequest).
const createSession = (preassigned?: string): string | undefined => {
  const id = preassigned ?? randomUUID();
  const path = transcriptPath(id);
  if (path === undefined) return id;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, openingLine(id) + "\n");
  return id;
};

type StdinFrames = {
  /** The prompt text, unwrapped from its user frame. */
  prompt: string;
  /** Request id of a persisting generate_session_title request, if any. */
  titleRequestId: string | undefined;
};

// Under `--input-format stream-json` real claude reads NDJSON frames: the
// prompt in a user frame, control requests alongside it. Anything else
// is a raw-text prompt.
const decodeStdin = (raw: string, streamJson: boolean): StdinFrames => {
  if (!streamJson) return { prompt: raw, titleRequestId: undefined };
  const frames = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const prompts = frames.flatMap((frame) => {
    const message = frame.message as { content?: unknown } | undefined;
    return frame.type === "user" && typeof message?.content === "string"
      ? [message.content]
      : [];
  });
  const titleRequest = frames.find((frame) => {
    const request = frame.request as Record<string, unknown> | undefined;
    return (
      frame.type === "control_request" &&
      request?.subtype === "generate_session_title" &&
      request.persist === true
    );
  });
  return {
    prompt: prompts.join("\n"),
    titleRequestId:
      typeof titleRequest?.request_id === "string"
        ? titleRequest.request_id
        : undefined,
  };
};

// Answers a persisting title request the way claude does: the title
// (CLAUDE_MOCK_SESSION_NAME stands in for the model's) is appended to the
// transcript as an ai-title line and echoed in a control_response on
// stdout. An unset name means the titler produced nothing.
const answerTitleRequest = (sessionId: string, requestId: string): void => {
  const name = process.env.CLAUDE_MOCK_SESSION_NAME ?? "";
  const path = transcriptPath(sessionId);
  if (name !== "" && path !== undefined)
    appendFileSync(path, titleLine(sessionId, name) + "\n");
  console.log(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { title: name === "" ? null : name },
      },
    }),
  );
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

// Ephemeral-invocation helpers (the behind-the-scenes suggestions ask):
// every invocation appends its argv to the ephemeral log, and output
// lines come from the ephemeral fixture env. Real claude 2.1.289 writes
// no transcript for `--no-session-persistence`, so none is simulated.
const appendEphemeralLog = (args: string[]): void => {
  const path = process.env.CLAUDE_MOCK_EPHEMERAL_LOG;
  if (path === undefined || path === "") return;
  appendFileSync(path, JSON.stringify(args) + "\n");
};

const ephemeralLines = (): string[] => {
  const custom = process.env.CLAUDE_MOCK_EPHEMERAL_LINES ?? "";
  if (custom === "") return [DEFAULT_LINE];
  return custom.split("\n").filter((line) => line !== "");
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  // The ephemeral suggestions ask: log, stream the fixture lines, write
  // no transcript, exit.
  if (args.includes("--no-session-persistence")) {
    appendEphemeralLog(args);
    await captureStdinTo("CLAUDE_MOCK_CAPTURE_STDIN");
    await streamLines(ephemeralLines(), 0);
    process.exit(0);
  }

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

  // Captures record the decoded prompt, so suites shared with goose
  // compare the same text whichever framing the flavor uses.
  const frames = decodeStdin(
    (await readStdin()).toString("utf8"),
    argValue(args, "--input-format") === "stream-json",
  );
  capturePromptTo("CLAUDE_MOCK_CAPTURE_STDIN", Buffer.from(frames.prompt));
  captureTo("CLAUDE_MOCK_CAPTURE_CWD", process.cwd());
  captureTo("CLAUDE_MOCK_CAPTURE_ARGS", JSON.stringify(args));
  captureTo("CLAUDE_MOCK_CAPTURE_ENV", JSON.stringify(claudeCodeEnv()));

  if (
    frames.titleRequestId !== undefined &&
    sessionId !== undefined &&
    !neverCreate
  )
    answerTitleRequest(sessionId, frames.titleRequestId);

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
