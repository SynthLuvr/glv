import { type } from "arktype";
import { truncate } from "./format/text.js";
import { JsonObject, parseJson } from "./parse.js";

// Why a run ended before its work was done: the provider refused service
// (a usage limit, a network outage, ...) and the agent said so on its own
// stream. Both agents stream NDJSON and *print* their failure record —
// goose `{"type":"error","error":"..."}` (crates/goose-cli session/mod.rs,
// StreamEvent::Error; verified against goose 1.45.0, which emits it and
// still exits 0), claude `{"type":"result","is_error":true,"result":..."}`
// (the headless failure "printed as the result on stdout" per its docs).
// Neither record lands in the session transcript the viewer renders, so
// without this classifier a refused run is indistinguishable from a clean
// finish — the agent's own announcement evaporates with the live preview.

// Kinds the UI words differently. The detail text always rides along so
// the provider's own phrasing (including any reset time) survives.
type StopReasonKind = "usage-limit" | "network" | "provider";

type StopReason = {
  readonly kind: StopReasonKind;
  /** Human-facing notice, ready to store and render as-is. */
  readonly notice: string;
};

// How many trailing stream lines to inspect. A refusal record is the
// agent's last word (or nearly so — goose follows it with a "complete"
// record), but a long run may still be finishing tool traffic around it,
// so scan a window rather than only the final line.
const SCAN_LINES = 20;

// The detail text is capped so a provider's embedded JSON error body
// cannot turn the prompt bar into a wall of text; the reset time the
// success criteria demand lives well inside the cap.
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

// The refusal text one stream line carries, when it is a failure record.
const refusalDetail = (line: string): string | undefined => {
  const parsed = parseJson(line, JsonObject);
  if (!parsed.ok) return undefined;
  const record = parsed.data;
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

// Classifies by the provider's own words rather than trusting one keyword:
// quota refusals and connection failures read differently in the UI, and
// everything else stays honest as a plain provider error.
const classify = (detail: string): StopReasonKind => {
  if (isUsageLimit(detail)) return "usage-limit";
  if (isNetworkFailure(detail)) return "network";
  return "provider";
};

const LEADS: Record<StopReasonKind, string> = {
  "usage-limit": "Session stopped early: provider usage limit reached.",
  network: "Session stopped early: provider network error.",
  provider: "Session stopped early: the run ended with an error.",
};

const noticeFor = (detail: string): string =>
  `${LEADS[classify(detail)]} ${truncate(detail, DETAIL_MAX)} Send a message to continue.`;

// Inspects a run's stream output (oldest first, as buffered) for a
// provider refusal the agent announced. Structured failure records only —
// an assistant *message about* a rate limit is conversation, not a
// refusal, and must not trip this. Both agents treat the failure record
// as terminal for the run (goose emits it, breaks its reply loop, then
// only prints its closing token-count record), so the newest match is
// the run's verdict.
const detectStopReason = (lines: readonly string[]): StopReason | undefined => {
  for (
    let i = lines.length - 1;
    i >= 0 && i >= lines.length - SCAN_LINES;
    i--
  ) {
    const detail = refusalDetail(lines[i] ?? "");
    if (detail !== undefined && detail.trim() !== "")
      return { kind: classify(detail), notice: noticeFor(detail) };
  }
  return undefined;
};

export type { StopReason, StopReasonKind };
export { detectStopReason };
