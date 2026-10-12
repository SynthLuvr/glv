import { type } from "arktype";
import { execa } from "execa";
import { type ParsedMessage, parseMessage } from "../format/index.js";
import type { ModelSelection } from "../models.js";
import { isRecord } from "../parse.js";
import type { MessageRow, SessionRow } from "../sessions.js";
import { errorMessage, unrefTimer } from "../util.js";

// The behind-the-scenes ask: one short, session-free run of the same
// assistant the session uses. Each flavor provides the argv that keeps
// the run off the books plus any post-run cleanup its store needs;
// everything here is agent-agnostic. The prompt always travels over
// stdin, exactly like real runs, so it never hits argument-length
// limits.

// How one flavor performs an ephemeral ask.
type EphemeralAsk = {
  /** Agent name for diagnostics ("goose", "claude"). */
  readonly name: string;
  /** Resolved binary to launch. */
  readonly binary: string;
  /** argv for the ask; a pinned model rides along when one resolves. */
  readonly args: (model: ModelSelection | undefined) => string[];
  /** Extra environment variables for the agent process. */
  readonly env: () => Record<string, string>;
  /**
   * Store cleanup after the ask finishes (goose sweeps the hidden
   * session rows `--no-session` leaves behind). Best-effort by
   * contract: a throw is logged and must never affect the ask's result.
   */
  readonly cleanup?: () => void;
};

// A finished ask: the assistant text assembled from the stream, or
// undefined when the run failed, timed out, or said nothing.
type AskResult = { readonly text: string } | undefined;

// One NDJSON stream record → its assistant text. Both dialects are
// accepted (goose's top-level role/content records and claude's
// message-nested ones) so the parser stays stable across agent releases.
const lineText = (line: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "";
  }
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) return "";
  const nested = isRecord(record.message) ? record.message : undefined;
  const content: unknown =
    nested !== undefined && "content" in nested
      ? nested.content
      : record.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item): string[] => {
      if (!isRecord(item) || item.type !== "text") return [];
      return typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
};

// Best-effort by contract (see EphemeralAsk.cleanup): a throw is logged,
// never propagated.
const runCleanup = (ask: EphemeralAsk): void => {
  if (ask.cleanup === undefined) return;
  try {
    ask.cleanup();
  } catch (err) {
    console.error(
      `suggestions: cleanup after the ${ask.name} ask failed: ` +
        errorMessage(err),
    );
  }
};

// Runs the ask: spawns the binary outside the runner pool (it must never
// occupy a concurrency slot real prompts wait on), collects the
// assistant text off stdout, and always runs the flavor's cleanup.
const runEphemeralAsk = async (
  ask: EphemeralAsk,
  prompt: string,
  workingDir: string,
  timeoutMs: number,
  model: ModelSelection | undefined,
): Promise<AskResult> => {
  try {
    const proc = execa(ask.binary, ask.args(model), {
      input: prompt,
      cwd: workingDir,
      env: ask.env(),
      killDescendants: true,
    });
    const lines: string[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs);
    unrefTimer(timer);
    try {
      for await (const line of proc) lines.push(line);
      const result = await proc;
      if (result.exitCode !== 0) return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
    const text = lines.map(lineText).join("").trim();
    return text === "" ? undefined : { text };
  } catch {
    return undefined;
  } finally {
    runCleanup(ask);
  }
};

// ---- parsing the reply ----

// The reply is expected to be a JSON array of strings; anything the
// assistant wraps around it is tolerated by scanning for the outermost
// bracketed array. Validated at the boundary like any JSON payload.
const StringArray = type("string[]");

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_LENGTH = 120;

// Parses the assistant's reply into 1..MAX_SUGGESTIONS non-empty
// prompts. Returns undefined when nothing usable is in there — the
// caller stores the empty marker so the turn is never re-asked.
const parseSuggestionReply = (text: string): string[] | undefined => {
  // A fenced code block beats the raw text when present — a prose
  // preamble containing "[" would otherwise mislead the scan below.
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = fence === null ? [text] : [fence[1], text];
  for (const candidate of candidates) {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start < 0 || end <= start) continue;
    let value: unknown;
    try {
      value = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
    const items = StringArray(value);
    if (items instanceof type.errors) continue;
    const usable = items
      .map((item) => item.trim().replaceAll(/\s+/g, " "))
      .filter((item) => item !== "" && item.length <= MAX_SUGGESTION_LENGTH)
      .slice(0, MAX_SUGGESTIONS);
    if (usable.length > 0) return usable;
  }
  return undefined;
};

// ---- the ask prompt ----

// How much conversation feeds the ask — deliberately tiny, so the ask's
// cost stays small by design.
const TAIL_MESSAGES = 12;
const TAIL_MESSAGE_CHARS = 400;
const TAIL_TOTAL_CHARS = 4000;

const textOf = (message: ParsedMessage): string =>
  message.items
    .flatMap((item): string[] =>
      item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim();

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

// "user: …" / "assistant: …" lines for the tail of the conversation,
// oldest first, budgeted.
const conversationTail = (rows: readonly MessageRow[]): string => {
  const lines: string[] = [];
  let total = 0;
  for (const row of rows.slice(-TAIL_MESSAGES)) {
    const message = parseMessage(row);
    const text = clip(textOf(message), TAIL_MESSAGE_CHARS);
    if (text === "") continue;
    const line = clip(`${message.role}: ${text}`, TAIL_MESSAGE_CHARS + 32);
    if (total + line.length > TAIL_TOTAL_CHARS) break;
    total += line.length;
    lines.push(line);
  }
  return lines.join("\n");
};

// The ask's instruction: propose a few short follow-ups, reply with a
// JSON array and nothing else. Framed as a private helper question about
// an excerpt, never as a turn of the user's session.
const buildAskPrompt = (agentName: string, tail: string): string =>
  [
    "You are helping build a prompt suggestion feature. Below is the " +
      "tail of a conversation between a user and their coding agent " +
      `(${agentName}). Your job is to propose what the user might sensibly ` +
      "ask next.",
    "",
    "Rules:",
    "- Propose 3 short follow-up prompts the user could send next.",
    "- Each prompt: at most 12 words, concrete, grounded in what just " +
      "happened — not generic filler.",
    "- Do not repeat a prompt the user already sent.",
    "- Reply with ONLY a JSON array of 3 strings. No markdown, no " +
      "commentary, no tools.",
    "",
    "Conversation tail:",
    tail,
  ].join("\n");

// ---- turn identity ----

// Fingerprint of a finished turn: the session's last-write timestamp
// plus its committed message count. Messages only grow within a session,
// so a later turn can never produce the same pair, and a stable
// transcript yields a stable key — the pair identifies "this exact
// finished turn" across polls, refreshes, and restarts.
const turnKeyOf = (
  session: Pick<SessionRow, "id" | "updated_at">,
  messageCount: number,
): string => `${session.updated_at}:${messageCount}`;

export type { EphemeralAsk };
export {
  buildAskPrompt,
  conversationTail,
  parseSuggestionReply,
  runEphemeralAsk,
  turnKeyOf,
};
