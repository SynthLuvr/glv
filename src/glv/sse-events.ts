import { type Type, type } from "arktype";

// The SSE wire contract, shared by the server (validated emit) and the
// browser bundle (validated parse) so the two ends cannot drift apart
// silently: the schemas that serialize an event on the server validate
// it in the client. Keep this module free of Node and hono imports —
// the client scripts bundle it for the browser.

// ---- session stream (/sessions/:id/events) ----

// One committed transcript row as pre-rendered HTML, keyed by its row
// index so the client can slot it into sequence.
const MessageEntry = type({ index: "number.integer", html: "string" });
type MessageEntry = typeof MessageEntry.infer;

// Cursor catch-up burst on (re)connect: every row after the resume
// cursor, plus the cursor to resume from next time.
const MessagesPayload = type({
  entries: MessageEntry.array(),
  cursor: "number.integer",
});

// The updated-at chip under the session title.
const MetaUpdate = type({ updated: "string", updatedTitle: "string" });
type MetaUpdate = typeof MetaUpdate.infer;

const SessionRenamePayload = type({ name: "string" });
type SessionRenamePayload = typeof SessionRenamePayload.infer;

// The tool call a running session is currently waiting on. Same shape as
// format/duration's ToolRun, with an absent timeout simply omitted —
// never an explicit null, which the client would have to launder back.
const ToolEventPayload = type({
  name: "string",
  count: "number.integer >= 1",
  startMs: "number",
  "timeoutSec?": "number",
});
type ToolEventPayload = typeof ToolEventPayload.infer;

// Run bookkeeping. The bare statuses — "idle" before any run registers,
// "deleted" once the session's rows are gone — travel without the
// optional fields; a full emission always includes them.
const SessionStatusPayload = type({
  status: "'queued'|'running'|'completed'|'stopped'|'error'|'idle'|'deleted'",
  "queuePosition?": "number.integer",
  "pendingCount?": "number.integer",
  "startedCount?": "number.integer",
  "error?": "string | null",
  "tool?": ToolEventPayload.or("null"),
});
type SessionStatusPayload = typeof SessionStatusPayload.infer;

// Next-prompt suggestions for the session's current finished turn: the
// prompts to render above the input box, or an empty array to clear
// whatever is rendered. Emitted whenever the visible set changes — the
// ask lands asynchronously, typically seconds after the turn completes.
const SuggestionsPayload = type({ prompts: type.string.array() });
type SuggestionsPayload = typeof SuggestionsPayload.infer;

// ---- status feed (/events/status) ----

// A plain list of session ids — the active-set snapshot on reconnect,
// and also the shape the sidebar stores its unread set under in
// localStorage, so both parses share one schema.
const StringListPayload = type.string.array();

// "done" is synthetic: it means the session left the active set.
const FeedStatusPayload = type({
  sessionId: "string",
  status: "'queued'|'running'|'completed'|'stopped'|'error'|'done'",
});
type FeedStatusPayload = typeof FeedStatusPayload.infer;

const FeedRenamePayload = type({ sessionId: "string", name: "string" });
type FeedRenamePayload = typeof FeedRenamePayload.infer;

// ---- event registries ----

// JSON-validated events by name; the registry drives both the typed emit
// helpers (server) and the typed listeners (client).
const SESSION_JSON_EVENTS = {
  messages: MessagesPayload,
  append: MessageEntry,
  replace: MessageEntry,
  rename: SessionRenamePayload,
  meta: MetaUpdate,
  status: SessionStatusPayload,
  suggestions: SuggestionsPayload,
} as const;

// Server-rendered fragments that travel as raw HTML text, not JSON.
const SESSION_TEXT_EVENTS = ["preview", "prompt", "preview-clear"] as const;

const FEED_JSON_EVENTS = {
  sync: StringListPayload,
  status: FeedStatusPayload,
  rename: FeedRenamePayload,
} as const;

// The feed's completion signal; its payload is the literal "closed".
const FEED_TEXT_EVENTS = ["done"] as const;

type SessionEventName =
  | keyof typeof SESSION_JSON_EVENTS
  | (typeof SESSION_TEXT_EVENTS)[number];
type FeedEventName =
  | keyof typeof FEED_JSON_EVENTS
  | (typeof FEED_TEXT_EVENTS)[number];

// The payload one event name carries: the schema's inference for JSON
// events, the raw text for fragment events.
type SessionEventPayload<E extends SessionEventName> =
  E extends keyof typeof SESSION_JSON_EVENTS
    ? (typeof SESSION_JSON_EVENTS)[E]["infer"]
    : string;

type FeedEventPayload<E extends FeedEventName> =
  E extends keyof typeof FEED_JSON_EVENTS
    ? (typeof FEED_JSON_EVENTS)[E]["infer"]
    : string;

// ---- parse (client / tests) ----

// Parses one SSE data field against a schema; undefined when the payload
// is malformed, so a drifted or truncated frame is dropped rather than
// trusted.
const parsePayload = <S extends Type<unknown>>(
  schema: S,
  raw: string,
): S["infer"] | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const out = schema(data);
  return out instanceof type.errors ? undefined : out;
};

// Subscribes one JSON event off a registry: the frame is parsed and
// validated against the event's schema — a frame that fails the schema
// never reaches the handler.
const onRegistryEvent = <
  R extends Record<string, Type<unknown>>,
  E extends keyof R & string,
>(
  source: EventSource,
  registry: R,
  event: E,
  handler: (payload: R[E]["infer"]) => void,
): void => {
  source.addEventListener(event, (e) => {
    if (!(e instanceof MessageEvent)) return;
    const payload = parsePayload(registry[event], e.data);
    if (payload !== undefined) handler(payload);
  });
};

// Fragment events travel as raw HTML text; a frame that is not a string
// is dropped rather than handed to the handler.
const onTextEvent = (
  source: EventSource,
  event: string,
  handler: (payload: string) => void,
): void => {
  source.addEventListener(event, (e) => {
    if (!(e instanceof MessageEvent)) return;
    const text = type.string(e.data);
    if (!(text instanceof type.errors)) handler(text);
  });
};

// Widened views of the text-event tuples so includes() accepts any event
// name without a cast.
const SESSION_TEXT_EVENT_NAMES: readonly string[] = SESSION_TEXT_EVENTS;
const FEED_TEXT_EVENT_NAMES: readonly string[] = FEED_TEXT_EVENTS;

const isSessionTextEvent = (
  event: SessionEventName,
): event is (typeof SESSION_TEXT_EVENTS)[number] =>
  SESSION_TEXT_EVENT_NAMES.includes(event);

const isFeedTextEvent = (
  event: FeedEventName,
): event is (typeof FEED_TEXT_EVENTS)[number] =>
  FEED_TEXT_EVENT_NAMES.includes(event);

// Subscribes one event off the registries: JSON events resolve their
// schema by name — the same table the server emits through — while
// fragment events arrive as validated text.
function onSessionEvent<E extends SessionEventName>(
  source: EventSource,
  event: E,
  handler: (payload: SessionEventPayload<E>) => void,
): void;
function onSessionEvent(
  source: EventSource,
  event: SessionEventName,
  handler: (payload: SessionEventPayload<SessionEventName>) => void,
): void {
  if (isSessionTextEvent(event)) onTextEvent(source, event, handler);
  else onRegistryEvent(source, SESSION_JSON_EVENTS, event, handler);
}

function onFeedEvent<E extends FeedEventName>(
  source: EventSource,
  event: E,
  handler: (payload: FeedEventPayload<E>) => void,
): void;
function onFeedEvent(
  source: EventSource,
  event: FeedEventName,
  handler: (payload: FeedEventPayload<FeedEventName>) => void,
): void {
  if (isFeedTextEvent(event)) onTextEvent(source, event, handler);
  else onRegistryEvent(source, FEED_JSON_EVENTS, event, handler);
}

// ---- serialize (server) ----

// Drops keys whose value is undefined before validation — JSON.stringify
// ignores them on the wire, but arktype treats an explicit undefined as
// a violation of an optional key. Arrays must pass through untouched, or
// Object.entries would crush them into an object. A non-object payload
// is a programming error and throws.
const jsonSafe = (payload: unknown): object => {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null)
    throw new Error("SSE payload must be an object");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload))
    if (value !== undefined) out[key] = value;
  return out;
};

// Serializes one outbound payload through its schema. A payload that
// misses the contract is a programming error, so it throws instead of
// putting a frame on the wire the client would have to drop.
const serializeJsonEvent = (
  schema: Type<unknown>,
  event: string,
  payload: unknown,
): string => {
  const out = schema(jsonSafe(payload));
  if (out instanceof type.errors)
    throw new Error(
      `SSE ${event} payload violates the contract: ${out.summary}`,
    );
  return JSON.stringify(out);
};

// Typed per-event emit: the payload is pinned to the event's inferred
// type at compile time and re-validated on the way out, mirroring what
// onSessionEvent/onFeedEvent do on the way in.
const registryEventData = <
  R extends Record<string, Type<unknown>>,
  E extends keyof R & string,
>(
  registry: R,
  event: E,
  payload: R[E]["infer"],
): string => serializeJsonEvent(registry[event], event, payload);

const sessionEventData = <E extends keyof typeof SESSION_JSON_EVENTS>(
  event: E,
  payload: (typeof SESSION_JSON_EVENTS)[E]["infer"],
): string => registryEventData(SESSION_JSON_EVENTS, event, payload);

const feedEventData = <E extends keyof typeof FEED_JSON_EVENTS>(
  event: E,
  payload: (typeof FEED_JSON_EVENTS)[E]["infer"],
): string => registryEventData(FEED_JSON_EVENTS, event, payload);

export type {
  FeedEventName,
  FeedRenamePayload,
  FeedStatusPayload,
  MessageEntry,
  MetaUpdate,
  SessionEventName,
  SessionRenamePayload,
  SessionStatusPayload,
  SuggestionsPayload,
  ToolEventPayload,
};
export {
  FEED_JSON_EVENTS,
  feedEventData,
  onFeedEvent,
  onSessionEvent,
  parsePayload,
  SESSION_JSON_EVENTS,
  StringListPayload,
  sessionEventData,
};
