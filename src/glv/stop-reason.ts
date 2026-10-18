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

const refusalDetail = (line: string): string | undefined => {
  const parsed = parseJson(line, JsonObject);
  if (!parsed.ok) return undefined;
  const asError = ErrorRecord(parsed.data);
  if (!(asError instanceof type.errors)) return asError.error;
  const asResult = ResultRecord(parsed.data);
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
type StopKind = "usage-limit" | "network" | "provider";

// Sentence-case summaries used by the structured prompt-bar card.
const STOP_CLASSIFICATIONS: Record<StopKind, string> = {
  "usage-limit": "Provider usage limit reached",
  network: "Provider network error",
  provider: "The run ended with an error",
};

const leadFor = (kind: StopKind): string => {
  const text = STOP_CLASSIFICATIONS[kind];
  const lowered = `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  return `Session stopped early: ${lowered}.`;
};

const LEADS: Record<StopKind, string> = {
  "usage-limit": leadFor("usage-limit"),
  network: leadFor("network"),
  provider: leadFor("provider"),
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
  `${LEADS[classify(detail)]} ${truncate(detail, DETAIL_MAX)} ${ACTION_SENTENCE}`;

// Reverses noticeFor for the structured prompt-bar card: the lead and the
// trailing action sentence peel off into their own rows, leaving the
// provider's own words (reset time included) as the reason line. A
// live-run error that never went through noticeFor (an exit-code crash)
// passes through with no classification.
const splitStopNotice = (
  notice: string,
): { classification: string | undefined; detail: string } => {
  let classification: string | undefined;
  let rest = notice;
  for (const kind of ["usage-limit", "network", "provider"] as const) {
    const lead = LEADS[kind];
    if (rest.startsWith(lead)) {
      classification = STOP_CLASSIFICATIONS[kind];
      rest = rest.slice(lead.length);
      break;
    }
  }
  rest = rest.trim();
  if (rest.endsWith(ACTION_SENTENCE))
    rest = rest.slice(0, -ACTION_SENTENCE.length).trim();
  return { classification, detail: rest };
};

// Inspects a run's buffered stream lines (oldest first) for a provider
// refusal the agent announced, newest match first: both agents treat the
// failure record as terminal, so it is the run's verdict. Structured
// failure records only — an assistant *message about* a rate limit is
// conversation, not a refusal, and must not trip this.
const detectStopNotice = (lines: readonly string[]): string | undefined => {
  const newestFirst = lines.slice(-SCAN_LINES).reverse();
  for (const line of newestFirst) {
    const detail = refusalDetail(line);
    if (detail !== undefined && detail.trim() !== "") return noticeFor(detail);
  }
  return undefined;
};

export { detectStopNotice, splitStopNotice };
