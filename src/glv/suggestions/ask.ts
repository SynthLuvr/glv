import { type } from "arktype";
import { execa } from "execa";
import {
  messageKind,
  type ParsedMessage,
  parseMessage,
  toolCallInfo,
  toolResultInfo,
} from "../format/index.js";
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

// Two suggestions are near-duplicates when their normalized word sets
// overlap this much (Jaccard). Paraphrase pairs ("fix the failing test" /
// "fix the failing tests now") land well above the bar; genuinely
// different directions land well below it. Keeps one idea from crowding
// the strip's three slots.
const DUPLICATE_JACCARD = 0.6;

const wordsOf = (prompt: string): Set<string> =>
  new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== ""),
  );

const nearDuplicate = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared) >= DUPLICATE_JACCARD;
};

// Trims and normalizes the reply's items into up to MAX_SUGGESTIONS
// distinct prompts: one that near-duplicates an already-kept prompt is
// dropped (the first of a pair wins), freeing its slot for a later
// distinct prompt.
const distinctPrompts = (items: readonly string[]): string[] => {
  const prompts: string[] = [];
  const kept: Set<string>[] = [];
  for (const item of items) {
    const prompt = item.trim().replaceAll(/\s+/g, " ");
    if (prompt === "" || prompt.length > MAX_SUGGESTION_LENGTH) continue;
    const words = wordsOf(prompt);
    if (kept.some((seen) => nearDuplicate(words, seen))) continue;
    kept.push(words);
    prompts.push(prompt);
    if (prompts.length === MAX_SUGGESTIONS) break;
  }
  return prompts;
};

// Parses the assistant's reply into up to MAX_SUGGESTIONS distinct,
// non-empty prompts. Returns undefined when nothing usable is in there —
// the caller stores the empty marker so the turn is never re-asked.
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
    const usable = distinctPrompts(items);
    if (usable.length > 0) return usable;
  }
  return undefined;
};

// ---- the ask's context ----

// How much conversation feeds the ask — deliberately tiny, so the ask's
// cost stays small by design. The grounding sections around the tail
// (last reply, goal, actions, failure) are cheap relative to what they
// buy; the last reply gets the largest slice of the budget because the
// suggestions anchor on it.
const TAIL_MESSAGES = 12;
const TAIL_MESSAGE_CHARS = 480;
const TAIL_TOTAL_CHARS = 6000;
const GOAL_CHARS = 240;
const ACTION_LINES_MAX = 10;
const ACTIONS_CHARS = 640;
const ACTION_ARG_CHARS = 80;
const FAILURE_CHARS = 240;

const textOf = (message: ParsedMessage): string =>
  message.items
    .flatMap((item): string[] =>
      item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim();

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  // Cut at a word boundary when one is reasonably near the limit — a
  // mid-word cut can invert a sentence's meaning ("don't do X" → "do X")
  // and the ask then grounds suggestions in a corruption.
  const cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  const at = boundary > max * 0.6 ? boundary : max;
  return `${cut.slice(0, at).trimEnd()}…`;
};

// The generous budget for the assistant's last reply — the section the
// suggestions anchor on. Deliberately larger than a tail message: this
// is the one text worth spending the ask's tokens on.
const LAST_REPLY_CHARS = 1200;

// Ending-biased clip for the last reply. A closing assistant message
// front-loads the recap and ends with the actionable part — offers,
// questions, "say the word and I'll X or Y" — so a long reply is cut
// from its beginning, never its end.
const clipEnd = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  // Prefer starting just after a word break; a run with no break at all
  // (an unbroken 1200 chars) starts at the raw edge.
  const space = cut.indexOf(" ");
  const newline = cut.indexOf("\n");
  const boundary = Math.min(
    space === -1 ? max : space,
    newline === -1 ? max : newline,
  );
  const at = boundary < max ? boundary + 1 : 0;
  return `…${cut.slice(at).trimStart()}`;
};

const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

// The most telling argument of a tool call: its first non-empty string
// value. Command tools yield the command; editors yield the file path;
// anything else yields whatever text it carries.
const toolArgText = (args: unknown): string => {
  if (typeof args === "string") return oneLine(args);
  if (!isRecord(args)) return "";
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    const text = oneLine(value);
    if (text !== "") return text;
  }
  return "";
};

// The window's earliest prompt or compacted summary stands in for the
// session's goal — goose's injected turn-context rows and tool-result
// rows are neither — so suggestions stay aimed at what the session set
// out to do rather than the tail's local topic.
const goalSection = (parsed: readonly ParsedMessage[]): string | undefined => {
  const goal = parsed.find((message) => {
    const kind = messageKind(message.role, message.items);
    return kind === "prompt" || kind === "summary";
  });
  if (goal === undefined) return undefined;
  const text = clip(oneLine(textOf(goal)), GOAL_CHARS);
  return text === "" ? undefined : `[Session goal]\n${text}`;
};

// "→ shell(npm test)" — the call plus its most telling argument.
const actionLine = (name: string, args: unknown): string => {
  const arg = clip(toolArgText(args), ACTION_ARG_CHARS);
  return oneLine(arg === "" ? `→ ${name}` : `→ ${name}(${arg})`);
};

// The window's tool blocks — plain text extraction drops them — yield
// what the agent did and, when something failed, the last failure.
const toolSections = (parsed: readonly ParsedMessage[]): string[] => {
  const actions: string[] = [];
  let actionsChars = 0;
  let lastFailure: string | undefined;
  for (const { items } of parsed)
    for (const item of items) {
      const call = toolCallInfo(item);
      if (call !== undefined && actions.length < ACTION_LINES_MAX) {
        const line = actionLine(call.name, call.args);
        if (actionsChars + line.length <= ACTIONS_CHARS) {
          actionsChars += line.length;
          actions.push(line);
        }
      }
      const result = toolResultInfo(item);
      if (result?.isError === true) lastFailure = result.text;
    }

  const sections: string[] = [];
  if (actions.length > 0)
    sections.push(`[Recent actions]\n${actions.join("\n")}`);
  if (lastFailure !== undefined) {
    const failure = clip(oneLine(lastFailure), FAILURE_CHARS);
    if (failure !== "") sections.push(`[Last failure]\n${failure}`);
  }
  return sections;
};

// The window's last assistant output is "what the agent just told the
// user" — where its concrete offers, open questions, and asks for a
// decision live. This section anchors the ask: the suggestions exist to
// let the user act on this message with one tap. Returns the rendered
// section plus the message's index so the tail can leave it out.
const lastReplySection = (
  parsed: readonly ParsedMessage[],
): { readonly section: string; readonly index: number } | undefined => {
  for (let index = parsed.length - 1; index >= 0; index--) {
    const message = parsed[index];
    if (messageKind(message.role, message.items) !== "output") continue;
    const text = clipEnd(textOf(message), LAST_REPLY_CHARS);
    if (text === "") continue;
    return { section: `[Assistant's last reply]\n${text}`, index };
  }
  return undefined;
};

// "user: …" / "assistant: …" lines for the tail of the conversation,
// budgeted per message and in total. Selection walks newest-first so
// the section keeps what it is named for — the rows nearest the finished
// turn — no matter how the budgets are tuned; the previous oldest-first
// walk kept the window's head and dropped its tail when the budget ran
// short, the exact opposite of a conversation tail. Selected
// newest-first, emitted oldest-first for reading order.
const tailSection = (
  parsed: readonly ParsedMessage[],
  skipIndex: number | undefined,
): string | undefined => {
  const lines: string[] = [];
  let total = 0;
  for (let index = parsed.length - 1; index >= 0; index--) {
    if (index === skipIndex) continue;
    const message = parsed[index];
    const text = clip(textOf(message), TAIL_MESSAGE_CHARS);
    if (text === "") continue;
    const line = clip(`${message.role}: ${text}`, TAIL_MESSAGE_CHARS + 32);
    if (total + line.length > TAIL_TOTAL_CHARS) break;
    total += line.length;
    lines.unshift(line);
  }
  return lines.length === 0
    ? undefined
    : `[Conversation tail]\n${lines.join("\n")}`;
};

// "[Assistant's last reply] / [Session goal] / [Recent actions] / [Last
// failure] / [Conversation tail]" — the grounded context the ask
// reasons over, anchored on what the agent just told the user. Sections
// that would be empty are omitted.
const conversationContext = (rows: readonly MessageRow[]): string => {
  const parsed = rows.slice(-TAIL_MESSAGES).map(parseMessage);
  const lastReply = lastReplySection(parsed);
  const sections = [
    lastReply?.section,
    goalSection(parsed),
    ...toolSections(parsed),
    tailSection(parsed, lastReply?.index),
  ].flatMap((section) => (section === undefined ? [] : [section]));
  return sections.join("\n\n");
};

// The ask's instruction: propose a few short follow-ups grounded in the
// sections above, reply with a JSON array and nothing else. Framed as a
// private helper question about an excerpt, never as a turn of the
// user's session. The first rule ranks the sections: the last reply is
// the anchor; when it offers options, the chips must be those options.
const buildAskPrompt = (agentName: string, context: string): string =>
  [
    "You are the prompt-suggestion helper for a coding-agent viewer. " +
      "Below is grounded context about a session between a user and " +
      `their coding agent (${agentName}): what the agent just told the ` +
      "user, what the user set out to do, what the agent just did, and " +
      "the tail of the conversation. " +
      "Propose what the user should ask next.",
    "",
    "Rules:",
    "- Propose 3 short follow-up prompts, at most 12 words each.",
    "- [Assistant's last reply] is what the user just read and the " +
      "surest signal of what they want next — anchor on it before the " +
      "older sections.",
    "- When the last reply offers the user options or asks which way " +
      'to go ("I can do X or Y — say the word"), the first suggestions ' +
      "must be prompts that take those offered options, in the order " +
      "offered. Only a slot left over may point somewhere else.",
    "- Every suggestion must name the concrete thing it is about — a " +
      "file, command, error, or entity that appears in the context. A " +
      "suggestion that would fit any coding session is useless.",
    '- Never suggest generic chores ("add tests", "update the docs", ' +
      '"commit the changes") unless the conversation directly implies ' +
      "that exact next step.",
    "- The 3 suggestions must pull toward different next moves (for " +
      "example: take an offered option, continue the task, verify the " +
      "result, address an open risk) — never paraphrases of one another.",
    "- If the context shows a failure, one suggestion must deal with it.",
    "- Do not repeat a prompt the user already sent.",
    "- Reply with ONLY a JSON array of 3 strings. No markdown, no " +
      "commentary, no tools.",
    "",
    context,
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
  conversationContext,
  parseSuggestionReply,
  runEphemeralAsk,
  turnKeyOf,
};
