import { type distill, type Type, type } from "arktype";

// The SSE wire contract, shared by the server (validated emit) and the
// browser bundle (validated parse) so the two ends cannot drift apart
// silently: the same arktype schemas that serialize an event on the
// server validate it in the client. Keep this module free of Node and
// hono imports — the client scripts bundle it for the browser.

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
type MessagesPayload = typeof MessagesPayload.infer;

// The agent derived a new session title mid-run.
const SessionRenamePayload = type({ name: "string" });
type SessionRenamePayload = typeof SessionRenamePayload.infer;

// The updated-at chip under the session title.
const MetaPayload = type({ updated: "string", updatedTitle: "string" });
type MetaUpdate = typeof MetaPayload.infer;

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

// ---- status feed (/events/status) ----

// A plain list of session ids (the active-set snapshot on reconnect).
// Also the shape the sidebar stores its unread set under in
// localStorage, so both parses share one schema.
const StringListPayload = type.string.array();
type StringList = typeof StringListPayload.infer;

// One session's run state moved; "done" means it left the active set.
const FeedStatusPayload = type({
  sessionId: "string",
  status: "'queued'|'running'|'completed'|'stopped'|'error'|'done'",
});
type FeedStatusPayload = typeof FeedStatusPayload.infer;

// A session's derived name changed.
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
  meta: MetaPayload,
  status: SessionStatusPayload,
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

// The payload type one event name carries: the schema's inference for
// JSON events, the raw text for fragment events.
type SessionEventPayload<E extends SessionEventName> =
  E extends keyof typeof SESSION_JSON_EVENTS
    ? (typeof SESSION_JSON_EVENTS)[E]["infer"]
    : string;

type FeedEventPayload<E extends FeedEventName> =
  E extends keyof typeof FEED_JSON_EVENTS
    ? (typeof FEED_JSON_EVENTS)[E]["infer"]
    : string;

// Registry lookup with an honest unknown widening at the boundary; the
// payload typing above is what call sites compile against.
const schemaFor = (
  registry: object,
  event: string,
): Type<unknown> | undefined =>
  (registry as Record<string, Type<unknown>>)[event];

// ---- parse (client / tests) ----

// Parses one SSE data field against a schema; undefined when the payload
// is malformed, so a drifted or truncated frame is dropped rather than
// trusted with a cast.
const parsePayload = <t>(
  schema: Type<t>,
  raw: string,
): distill.Out<t> | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const out = schema(data);
  return out instanceof type.errors ? undefined : (out as distill.Out<t>);
};

// Subscribes one session-stream event with the payload parsed and
// validated against the contract. JSON events whose payload fails the
// schema never reach the handler; text events arrive as-is.
const onSessionEvent = <E extends SessionEventName>(
  source: EventSource,
  event: E,
  handler: (payload: SessionEventPayload<E>) => void,
): void => {
  source.addEventListener(event, (e) => {
    if (!(e instanceof MessageEvent)) return;
    const schema = schemaFor(SESSION_JSON_EVENTS, event);
    if (schema === undefined) {
      handler(e.data as SessionEventPayload<E>);
      return;
    }
    const parsed = parsePayload(schema, e.data);
    if (parsed !== undefined) handler(parsed as SessionEventPayload<E>);
  });
};

// The status-feed twin of onSessionEvent.
const onFeedEvent = <E extends FeedEventName>(
  source: EventSource,
  event: E,
  handler: (payload: FeedEventPayload<E>) => void,
): void => {
  source.addEventListener(event, (e) => {
    if (!(e instanceof MessageEvent)) return;
    const schema = schemaFor(FEED_JSON_EVENTS, event);
    if (schema === undefined) {
      handler(e.data as FeedEventPayload<E>);
      return;
    }
    const parsed = parsePayload(schema, e.data);
    if (parsed !== undefined) handler(parsed as FeedEventPayload<E>);
  });
};

// ---- serialize (server) ----

// Drops keys whose value is undefined before validation — the same
// normalization JSON.stringify applies when writing the wire — because
// arktype (unlike JSON) treats an explicit undefined as a violation of
// an optional key. Arrays pass through untouched.
const jsonSafe = (payload: object): object => {
  if (Array.isArray(payload)) return payload;
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
  payload: object,
): string => {
  const out = schema(jsonSafe(payload));
  if (out instanceof type.errors)
    throw new Error(
      `SSE ${event} payload violates the contract: ${out.summary}`,
    );
  return JSON.stringify(out);
};

// Typed per-event wrappers: the payload is checked against the event's
// inferred type at compile time and re-checked at runtime on the way
// out, mirroring what onSessionEvent does on the way in. The internal
// widenings are safe because the wrapper's signature already pinned the
// payload type, and every registry entry is an object schema.
const sessionEventData = <E extends keyof typeof SESSION_JSON_EVENTS>(
  event: E,
  payload: (typeof SESSION_JSON_EVENTS)[E]["infer"],
): string =>
  serializeJsonEvent(
    SESSION_JSON_EVENTS[event] as Type<unknown>,
    event,
    payload as object,
  );

const feedEventData = <E extends keyof typeof FEED_JSON_EVENTS>(
  event: E,
  payload: (typeof FEED_JSON_EVENTS)[E]["infer"],
): string =>
  serializeJsonEvent(
    FEED_JSON_EVENTS[event] as Type<unknown>,
    event,
    payload as object,
  );

export type {
  FeedEventName,
  FeedEventPayload,
  FeedRenamePayload,
  FeedStatusPayload,
  MessageEntry,
  MessagesPayload,
  MetaUpdate,
  SessionEventName,
  SessionEventPayload,
  SessionRenamePayload,
  SessionStatusPayload,
  StringList,
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
