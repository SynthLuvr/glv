import { type } from "arktype";
import { truncate } from "./format/text.js";
import { JsonObject, parseJson } from "./parse.js";

// Why a run ended before its work was done: the provider refused service
// (a usage limit, a network outage, ...) and the agent said so on its own
// stream. Both agents stream NDJSON and *print* their failure record —
// goose `{"type":"error","error":"..."}` (crates/goose-cli session/mod.rs,
// StreamEvent::Error; verified against goose 1.45.0, which emits it and
// still exits 0), claude `{"type":"result","is_error":true,"result":...}`
// (the headless failure "printed as the result on stdout" per its docs).
// Neither record lands in the session transcript the viewer renders, so
// without this classifier a refused run is indistinguishable from a clean
// finish — the agent's own announcement evaporates with the live preview.
//
// A second silent-stop shape needs no provider: headless claude kills the
// plain background tasks its turn outlived right after printing its
// terminal result, then exits 0 — the kill rides the stream as a system
// task_notification with status "stopped", classified below into its own
// notice kind.

// How many trailing stream lines to inspect. A refusal record is the
// agent's last word (or nearly so — goose follows it with a "complete"
// record), but a long run may still be finishing tool traffic around it,
// so scan a window rather than only the final line.
const SCAN_LINES = 20;

// The detail text is capped so a provider's embedded JSON error body
// cannot turn the prompt bar into a wall of text; a reset time lives
// well inside the cap.
const DETAIL_MAX = 280;

// goose names the record's field "error" in both spellings it has shipped
// (PascalCase tags pre-1.x, snake_case since); claude's result record
// carries the text under "result".
const ErrorRecord = type({ type: "'error'|'Error'", error: "string" });
const ResultRecord = type({
  type: "'result'",
  is_error: "true",
  result: "string",
});

// claude's kill epilogue. It only streams when no Monitor task is
// pending — a pending monitor would park the process instead of killing
// (verified against a controlled 2.1.289 --print run).
const KilledTaskRecord = type({
  type: "'system'",
  subtype: "'task_notification'",
  status: "'stopped'",
  "summary?": "string",
});

const KILLED_TASK_DETAIL =
  "the agent left background work pending; a headless run cannot " +
  "outlive its turn, so the process killed it on exit and the agent " +
  "will not report back on its own";

const parseRecord = (line: string) => {
  const parsed = parseJson(line, JsonObject);
  return parsed.ok ? parsed.data : undefined;
};

const refusalDetail = (line: string): string | undefined => {
  const record = parseRecord(line);
  if (record === undefined) return undefined;
  const asError = ErrorRecord(record);
  if (!(asError instanceof type.errors)) return asError.error;
  const asResult = ResultRecord(record);
  if (!(asResult instanceof type.errors)) return asResult.result;
  return undefined;
};

const isUsageLimit = (detail: string): boolean =>
  /usage limit|rate limit|credits exhausted|credit balance|quota|429/i.test(
    detail,
  );

const isNetworkFailure = (detail: string): boolean =>
  /network error|could not connect|connection (error|reset|refused)|timed? out|fetch failed|socket/i.test(
    detail,
  );

// Kinds the notice words differently; the provider's own phrasing rides
// along so a reset time survives verbatim.
type StopKind = "usage-limit" | "network" | "provider" | "background-tasks";

const STOP_KINDS: readonly StopKind[] = [
  "usage-limit",
  "network",
  "provider",
  "background-tasks",
];

// Each kind carries both sentence forms: the lead that opens the flat
// notice, and the title-case summary the structured prompt-bar card shows.
const STOP_TEXT: Record<StopKind, { lead: string; summary: string }> = {
  "usage-limit": {
    lead: "Session stopped early: provider usage limit reached.",
    summary: "Provider usage limit reached",
  },
  network: {
    lead: "Session stopped early: provider network error.",
    summary: "Provider network error",
  },
  provider: {
    lead: "Session stopped early: the run ended with an error.",
    summary: "The run ended with an error",
  },
  "background-tasks": {
    lead:
      "Session stopped early: pending background tasks were killed when " +
      "the run ended.",
    summary: "Background tasks killed at exit",
  },
};

const ACTION_SENTENCE = "Send a message to continue.";

// Classifies by the provider's own words; anything unrecognized stays an
// honest plain provider error.
const classify = (detail: string): StopKind => {
  if (isUsageLimit(detail)) return "usage-limit";
  if (isNetworkFailure(detail)) return "network";
  return "provider";
};

const noticeFor = (detail: string): string =>
  `${STOP_TEXT[classify(detail)].lead} ${truncate(detail, DETAIL_MAX)} ${ACTION_SENTENCE}`;

// The killed-task notice quotes the work that died when the stream says
// what it was; there is no provider detail to classify here.
const noticeForKilledTask = (summary: string): string => {
  const named = summary === "" ? "" : `"${truncate(summary, DETAIL_MAX)}" — `;
  return (
    `${STOP_TEXT["background-tasks"].lead} ` +
    `${named}${KILLED_TASK_DETAIL} ${ACTION_SENTENCE}`
  );
};

// Reverses noticeFor for the structured card: the lead and the trailing
// action sentence peel off, leaving the provider's own words (reset time
// included) as the reason line. A live-run error that never went through
// noticeFor (an exit-code crash) passes through with no classification.
const splitStopNotice = (
  notice: string,
): { classification: string | undefined; detail: string } => {
  let classification: string | undefined;
  let rest = notice;
  for (const kind of STOP_KINDS) {
    const { lead, summary } = STOP_TEXT[kind];
    if (rest.startsWith(lead)) {
      classification = summary;
      rest = rest.slice(lead.length);
      break;
    }
  }
  rest = rest.trim();
  if (rest.endsWith(ACTION_SENTENCE))
    rest = rest.slice(0, -ACTION_SENTENCE.length).trim();
  return { classification, detail: rest };
};

// A stream line's killed-task summary when it carries one; undefined
// when it does not ("" is a real summary on a record that names no
// task).
const killedTaskSummary = (line: string): string | undefined => {
  const record = parseRecord(line);
  if (record === undefined) return undefined;
  const killed = KilledTaskRecord(record);
  return killed instanceof type.errors ? undefined : (killed.summary ?? "");
};

// Finds a kill epilogue newer than the run's own last word, newest
// match first. claude prints its terminal result first and kills
// afterwards, so a killed-task record older than the newest result
// belongs to a mid-run TaskStop — an ordinary handoff the run already
// handled. Without any result record the whole window is eligible: a
// run that died right after the kill still deserves the notice.
const killedTaskNotice = (window: readonly string[]): string | undefined => {
  const lastResult = window.findLastIndex(
    (line) => parseRecord(line)?.type === "result",
  );
  const epilogue = window.slice(lastResult + 1).toReversed();
  for (const line of epilogue) {
    const summary = killedTaskSummary(line);
    if (summary !== undefined) return noticeForKilledTask(summary);
  }
  return undefined;
};

// Inspects a run's buffered stream lines (oldest first) for a provider
// refusal the agent announced, newest match first: both agents treat the
// failure record as terminal, so it is the run's verdict. Structured
// failure records only — an assistant *message about* a rate limit is
// conversation, not a refusal, and must not trip this. A refusal outranks
// the kill epilogue: a run that announced its own failure ended on
// purpose, whatever background work it also killed.
const detectStopNotice = (lines: readonly string[]): string | undefined => {
  const window = lines.slice(-SCAN_LINES);
  for (const line of window.toReversed()) {
    const detail = refusalDetail(line);
    if (detail !== undefined && detail.trim() !== "") return noticeFor(detail);
  }
  return killedTaskNotice(window);
};

export { ACTION_SENTENCE, detectStopNotice, splitStopNotice };
