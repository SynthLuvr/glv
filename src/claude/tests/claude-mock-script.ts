import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord, JsonObject, parseJson } from "../../glv/parse.js";
import {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
  stdinTranscriptPath,
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

// Session runs speak stream-json on stdin (ADR 0010): NDJSON frames,
// and the pipe stays open until the runner closes it — so a read-to-EOF
// would park the mock forever. Read the first `count` newline-terminated
// lines and stop, leaving the stream flowing so a later EOF is still
// observable.
const readStdinLines = (count: number): Promise<string[]> =>
  new Promise((resolve) => {
    const lines: string[] = [];
    let buffered = "";
    const onData = (chunk: string): void => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        lines.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (lines.length === count) {
          finish();
          return;
        }
      }
    };
    const finish = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      resolve(lines);
    };
    const onEnd = (): void => {
      // A pipe that closes mid-frame still hands over what it wrote.
      if (buffered !== "") lines.push(buffered);
      finish();
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });

// What one turn's stdin frames carry.
type StdinFrames = {
  /** The prompt text, unwrapped from its user frame. */
  prompt: string;
  /** Request id of the persisting title request, if one was sent. */
  titleRequestId: string | undefined;
};

// Narrows a stream-json user frame back to the prompt text it wraps —
// the same reading the real binary does. Anything else (a malformed
// line, an older dialect) is not a user frame.
const decodeUserFrame = (line: string): string | undefined => {
  const parsed = parseJson(line, JsonObject);
  if (!parsed.ok || parsed.data.type !== "user") return undefined;
  const message = parsed.data.message;
  if (!isRecord(message) || typeof message.content !== "string")
    return undefined;
  return message.content;
};

// The request id of a persisting generate_session_title control
// request, when the line is one. The id rides the frame itself, not
// the request payload.
const titleRequestIdOf = (line: string): string | undefined => {
  const parsed = parseJson(line, JsonObject);
  if (!parsed.ok || parsed.data.type !== "control_request") return undefined;
  const request = parsed.data.request;
  if (
    !isRecord(request) ||
    request.subtype !== "generate_session_title" ||
    request.persist !== true
  )
    return undefined;
  return typeof parsed.data.request_id === "string"
    ? parsed.data.request_id
    : undefined;
};

// Reads the frames the way claude now does, then captures the decoded
// prompt wherever the suite asked — the same files as before the
// stream-json switch, so prompt assertions keep working unchanged.
const captureStdin = (lines: string[]): StdinFrames => {
  const userLine = lines[0] ?? "";
  logStdinPhase("prompt", { line: userLine });
  const frames: StdinFrames = {
    prompt: decodeUserFrame(userLine) ?? userLine,
    titleRequestId: lines
      .slice(1)
      .map(titleRequestIdOf)
      .find((id) => id !== undefined),
  };
  const capturePath = process.env.CLAUDE_MOCK_CAPTURE_STDIN;
  if (capturePath !== undefined && capturePath !== "") {
    appendFileSync(capturePath, frames.prompt);
    appendFileSync(stdinTranscriptPath(capturePath), `${frames.prompt}\n`);
  }
  return frames;
};

// Appends one observed phase of a stdin-lifecycle scenario, with
// whether the pipe was still open at that instant — the fact the
// scenarios exist to prove.
const logStdinPhase = (
  phase: string,
  extra: Record<string, unknown> = {},
): void => {
  const path = process.env.CLAUDE_MOCK_STDIN_LOG;
  if (path === undefined || path === "") return;
  appendFileSync(
    path,
    `${JSON.stringify({
      phase,
      stdinOpen: !process.stdin.readableEnded,
      ...extra,
    })}\n`,
  );
};

// Resolves true if stdin reaches EOF within the window — the runner's
// close arriving — false if the pipe stayed open the whole time.
const waitForStdinClose = (timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (process.stdin.readableEnded) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      process.stdin.off("end", onEnd);
      resolve(false);
    }, timeoutMs);
    const onEnd = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    process.stdin.once("end", onEnd);
  });

const TASK_ID = "bgtask1";
const taskEvent = (subtype: string, fields: Record<string, unknown>) =>
  JSON.stringify({ type: "system", subtype, task_id: TASK_ID, ...fields });

const assistantLine = (text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

// The ADR 0010 scenarios: the run arms a background task and ends its
// turn — unlike the old text-stdin model, the process must stay alive
// until the task completes. "wake": the completion wakes the agent into
// a second turn, and the runner closes stdin at that turn's result.
// "nowake": the completion never wakes anyone, and the idle defense
// must close the pipe on its own.
const runBgTaskScenario = async (
  mode: string,
  sessionId: string | undefined,
): Promise<void> => {
  const say = (text: string): void => {
    console.log(assistantLine(text));
  };
  const result = (text: string): void => {
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
      }),
    );
  };
  // Real claude commits each assistant message to the session transcript
  // as it streams. The commit rides slightly behind the stream line so
  // the server's stream poll flushes the line as a live preview first —
  // the ordering the stdin-lifecycle suite asserts on.
  const sayAndCommit = async (text: string): Promise<void> => {
    say(text);
    await sleep(Number(process.env.CLAUDE_MOCK_BG_COMMIT_DELAY_MS ?? 2000));
    if (sessionId !== undefined)
      commitLine(sessionId, assistantLine(text), Date.now());
  };

  // Turn 1: arm the watcher, reply, end the turn.
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(
    taskEvent("background_tasks_changed", {
      tasks: [
        { task_id: TASK_ID, task_type: "local_bash", description: "watcher" },
      ],
    }),
  );
  console.log(
    taskEvent("task_started", {
      tool_use_id: "toolu_mock1",
      description: "watcher",
      is_backgrounded: true,
      task_type: "local_bash",
    }),
  );
  await sayAndCommit("Watcher armed; I'll report back when it finishes.");
  result("Watcher armed");
  logStdinPhase("turn1-result");

  // The task runs; the pipe must stay open across this silence.
  await sleep(Number(process.env.CLAUDE_MOCK_BG_WAKE_DELAY_MS ?? 800));
  logStdinPhase("after-task-ran");

  // Completion burst (the snapshot empties first — the policy's signal).
  console.log(taskEvent("background_tasks_changed", { tasks: [] }));
  console.log(
    taskEvent("task_updated", {
      patch: { status: "completed", end_time: Date.now() },
    }),
  );
  console.log(
    taskEvent("task_notification", {
      tool_use_id: "toolu_mock1",
      status: "completed",
      summary: "watcher completed",
    }),
  );

  if (mode === "wake") {
    // The wake turn runs unprompted and ends the session's work. The
    // commit is awaited before the EOF wait so the process never exits
    // with the transcript write still pending.
    console.log(JSON.stringify({ type: "system", subtype: "init" }));
    const wakeCommitted = sayAndCommit(
      "The watcher finished — reporting back as promised.",
    );
    result("Watcher finished");
    logStdinPhase("turn2-result");
    const closed = waitForStdinClose(10_000);
    await wakeCommitted;
    logStdinPhase("eof", { closedAfterWakeTurn: await closed });
  } else {
    // No wake ever comes; only the idle defense can end this run.
    const closed = await waitForStdinClose(30_000);
    logStdinPhase("eof", { closedByIdleDefense: closed });
  }
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

  // A new session's stdin carries two frames — the prompt and the title
  // request (see agent.ts); a follow-up carries the prompt alone.
  const frames = captureStdin(
    await readStdinLines(args.includes("--resume") ? 1 : 2),
  );
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

  // The stdin-lifecycle scenarios own the whole stream; everything else
  // streams the fixture's scripted lines as before.
  const bgMode = process.env.CLAUDE_MOCK_BG_TASKS;
  if (bgMode === "wake" || bgMode === "nowake") {
    await runBgTaskScenario(bgMode, sessionId);
    process.exit(0);
  }

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
