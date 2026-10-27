import { ArkErrors, type Type, type } from "arktype";
import type { FastifyRequest } from "fastify";
import type { CronJobRecord } from "../cron-jobs.js";
import { type ParsedMessage, parseMessage, toIso } from "../format/index.js";
import { decodeModelValue, encodeAgentModelValue } from "../models.js";
import type { SavedPrompt } from "../prompts/db.js";
import type { Runner } from "../runner/index.js";
import { getHandle } from "../runner/index.js";
import { parseSchedule } from "../schedule.js";
import type { MessageRow, SessionRow } from "../sessions.js";
import {
  type LastRunRecord,
  LastRunState,
  type RunHistoryRecord,
} from "../stop-notices.js";
import type { AgentRuntime } from "./context.js";
import { isRecord, queryValue } from "./http.js";

// The ArkType contracts at the JSON API's boundaries. Every shape the
// API sends or accepts is defined here once; the OpenAPI document below
// is generated from these schemas (toJsonSchema), so the published
// contract cannot drift from them.

// The error body every failure answers with (mirrors the pre-existing
// 401/404 shapes).
const ApiError = type({ error: "string" });

// The body POST /api/sessions and POST /api/sessions/:id/prompt return:
// where the submitted prompt sits — "queued" behind the session's active
// run or the concurrency pool, "started" once execution has begun.
const ApiRunAccepted = type({ id: "string", status: "'started' | 'queued'" });

// The body POST /api/sessions/:id/stop returns (idempotent).
const ApiStopAccepted = type({ id: "string", status: "'stopped'" });

// The body POST /api/sessions/:id/fork returns: "created" when the copy
// landed without a prompt, otherwise where the submitted prompt sits.
const ApiForkAccepted = type({
  id: "string",
  status: "'created' | 'started' | 'queued'",
});

// The listing window: 1–500 rows, skipping forward from the newest.
// The optional filters (#344) all narrow the listing server-side before
// that window, so pagination pages the filtered order exactly as it
// pages the unfiltered one: working_dir keeps only sessions under one
// directory (the row's working_dir equals the prefix or lies underneath
// it), agent keeps one served agent's sessions, and active=true keeps
// only sessions with a live run (queued or running). active also
// accepts an explicit false — it reads as absent, the natural spelling
// of "no restriction".
const MAX_LIST_LIMIT = 500;
const ListLimit = type(`1 <= number.integer <= ${MAX_LIST_LIMIT}`);
const ListOffset = type("number.integer >= 0");
const ApiListActive = type("'true' | 'false'");
const ApiListQuery = type({
  "limit?": ListLimit,
  "offset?": ListOffset,
  "working_dir?": "string",
  "agent?": "string",
  "active?": ApiListActive,
});

// The detail read's windows (#339, #383): fields=meta answers a poll
// with the session row alone — no transcript, but carrying
// message_count, its length — while the window parameters each select
// a server-side slice before serialization: after=<message-index>
// starts the transcript at that index (the count of messages the
// caller already holds), head=<n> keeps the first n, and last=<n> the
// final n. A poll costs the window's size, not the transcript's.
const ApiDetailFields = type("'meta'");
const ApiDetailWindow = type("number.integer >= 0");
const ApiDetailQuery = type({
  "fields?": ApiDetailFields,
  "after?": ApiDetailWindow,
  "head?": ApiDetailWindow,
  "last?": ApiDetailWindow,
});

// The wait endpoint's deadline (#341): how long GET /api/sessions/:id/wait
// may park before answering 202 with the still-active status. One hour
// (#382) spans a typical worker run in one park; past it a script
// re-dials, each re-park a fresh agent turn that re-sends its whole
// transcript. 0 answers with a single snapshot, no park; -1 drops the
// deadline entirely — park until the run settles or the caller hangs up.
const MAX_WAIT_MS = 3_600_000;
const UNBOUNDED_TIMEOUT = -1;
const DEFAULT_WAIT_MS = 30_000;
const ApiWaitTimeout = type(
  `${UNBOUNDED_TIMEOUT} | 0 <= number.integer <= ${MAX_WAIT_MS}`,
);
const ApiWaitQuery = type({ "timeout?": ApiWaitTimeout });

// How the last run ended, persisted in the stop-notices sidecar beyond
// the registry window: "finished" settled cleanly, "stopped" was stopped
// by the user or by the server's own teardown (reason says which — a
// shutdown stop carries e.g. "server shutdown", a user stop carries
// nothing), "stopped_early" was refused service by the provider (a
// usage limit with its reset time, a network outage) — reason carries
// the notice wording — and "failed" crashed (non-zero exit, signal
// death, startup-watchdog kill), reason carrying the verdict with its
// stderr tail. reason appears only where there is something to explain;
// ended_at is the settle instant (ISO 8601 UTC with an explicit
// designator — toApiTimestamp). The state union is the
// sidecar's own LastRunState schema, so the wire contract cannot drift
// from what the recorder writes.
const ApiLastRun = type({
  state: LastRunState,
  "reason?": "string",
  ended_at: "string",
});

type ApiLastRunData = typeof ApiLastRun.infer;

// The wire's one timestamp spelling (#346): storage is consistently UTC
// but not consistently marked — goose's agent-owned SQLite rows and the
// viewer-owned sidecars spell SQLite's datetime('now')/CURRENT_TIMESTAMP
// ("2026-10-21 18:22:36", no zone), while claude transcripts and the
// glv-owned recorders spell full ISO instants. Every timestamp the API
// serializes passes through here, so the wire never asks a reader to
// guess: each value is ISO 8601 with an explicit zone designator (Z).
// Idempotent — a value that already names its zone is honoured as
// written.
const toApiTimestamp = (timestamp: string): string => toIso(timestamp);

// The nullable companion: null means the event never happened — a
// session never archived, a prompt never run — and stays null on the
// wire; anything else re-spells zoned through toApiTimestamp.
const toApiTimestampOrNull = (timestamp: string | null): string | null =>
  timestamp === null ? null : toApiTimestamp(timestamp);

const toApiLastRun = (record: LastRunRecord): ApiLastRunData => ({
  state: record.state,
  ...(record.reason === undefined ? {} : { reason: record.reason }),
  ended_at: toApiTimestamp(record.endedAt),
});

// The optional last_run field, spelled once for every shape that
// carries the verdict (the session rows, the wait answers), so the
// wire can never present it two ways.
const lastRunField = (
  lastRun: LastRunRecord | undefined,
): { last_run?: ApiLastRunData } =>
  lastRun === undefined ? {} : { last_run: toApiLastRun(lastRun) };

// One settled run as the history endpoint returns it: the last-run
// verdict shape plus started_at, the instant the run's process spawned
// (omitted for a run stopped while still queued). Built by composing
// ApiLastRun, so the verdict fields cannot drift from the rows' and
// the wait answer's spelling.
const ApiRunHistoryEntry = ApiLastRun.and({ "started_at?": "string" });

type ApiRunHistoryEntryData = typeof ApiRunHistoryEntry.infer;

// Composed on toApiLastRun so the entry's verdict fields cannot drift
// from the last_run spelling; started_at joins only when known.
const toApiRunHistoryEntry = (
  record: RunHistoryRecord,
): ApiRunHistoryEntryData => ({
  ...toApiLastRun(record),
  ...(record.startedAt === undefined
    ? {}
    : { started_at: toApiTimestamp(record.startedAt) }),
});

// The run-state vocabulary every status field speaks: the live states
// from the runner's registry ("queued"/"running"), its terminal states
// ("completed"/"stopped"/"error", visible for the short window a
// settled run lingers in the registry), and "idle" once no handle
// remains. One definition, so the session rows and the wait endpoint's
// answers cannot drift apart.
const ApiRunStatus = type(
  "'queued'|'running'|'completed'|'stopped'|'error'|'idle'",
);
type ApiRunStatusData = typeof ApiRunStatus.infer;

// One session row as the listing and detail endpoints return it: the
// store's SessionRow plus `status`, the run state toApiSession projects
// from the runner's registry — the same vocabulary the session's SSE
// stream emits — and `last_run`, the persisted verdict of the most
// recent settled run (omitted until one has settled). The timestamp
// fields re-spell to the wire's zoned form (toApiTimestamp); everything
// else passes through as the store spelled it.
const ApiSession = type({
  id: "string",
  "agent?": "string",
  name: "string",
  user_set_name: "number | null",
  description: "string",
  session_type: "string",
  working_dir: "string",
  created_at: "string",
  updated_at: "string",
  total_tokens: "number | null",
  provider_name: "string | null",
  model: "string | null",
  archived_at: "string | null",
  status: ApiRunStatus,
  "last_run?": ApiLastRun,
});

type ApiSessionData = typeof ApiSession.infer;

// Decorates a store row with the run status both session read endpoints
// return: the runner's own status while a handle exists — "queued" or
// "running", or the terminal "completed"/"stopped"/"error" for the short
// window a settled run lingers in the registry so a polling client sees
// how it ended — and "idle" once no handle remains. The last-run
// verdict, when one is recorded, rides along so "how did the last run
// end?" stays answerable past that window and across a restart. Beside
// the schema, like toApiCronJob/toApiPrompt, so the wire shape cannot
// drift from it.
const toApiSession = (
  row: SessionRow,
  runner: Runner,
  lastRun?: LastRunRecord,
): ApiSessionData => ({
  ...row,
  created_at: toApiTimestamp(row.created_at),
  updated_at: toApiTimestamp(row.updated_at),
  archived_at: toApiTimestampOrNull(row.archived_at),
  status: getHandle(runner, row.id)?.status ?? "idle",
  ...lastRunField(lastRun),
});

// One transcript message as the detail endpoint spells it: parseMessage's
// parse with the row's timestamp re-spelled to the wire's zoned form —
// the only field where the store's spelling and the wire's differ.
const toApiMessage = (row: MessageRow): ParsedMessage => ({
  ...parseMessage(row),
  timestamp: toApiTimestamp(row.timestamp),
});

// The body GET /api/sessions/:id/wait answers with (#341): the run's
// status — a terminal state or idle when the wait resolved (200), the
// live queued/running state when the caller's deadline hit first (202) —
// plus last_run, the same persisted verdict the session rows carry, so
// one call says not just that the run ended but how (a clean finish vs a
// provider refusal vs a crash). The verdict rides resolved answers only:
// on a deadline hit the described run has not ended.
const ApiWaitResult = type({
  id: "string",
  status: ApiRunStatus,
  "last_run?": ApiLastRun,
});

type ApiWaitResultData = typeof ApiWaitResult.infer;

// Beside its schema, like toApiSession, so the wire shape cannot drift.
const toApiWaitResult = (
  id: string,
  status: ApiRunStatusData,
  lastRun?: LastRunRecord,
): ApiWaitResultData => ({
  id,
  status,
  ...lastRunField(lastRun),
});

// The multipart form fields POST /api/sessions accepts. The `uploads`
// file parts are documented beside these — toJsonSchema cannot express
// OpenAPI's binary format. `name`, when submitted non-blank, names the
// session at creation through the same viewer-managed rename the
// browser's rename action performs; absent or blank leaves naming to
// the agent's own mid-run retitling.
const ApiStartSessionForm = type({
  prompt: "string",
  "name?": "string",
  "working_dir?": "string",
  "session_mode?": "'temp'",
  "model?": "string",
  "location?": "string",
});

// The multipart form fields POST /api/sessions/:id/prompt accepts.
const ApiFollowUpForm = type({
  prompt: "string",
  "location?": "string",
});

// The multipart form fields POST /api/sessions/:id/fork accepts: the
// index of the last transcript message to keep (decimal, in transcript
// order; omitted for the whole history) and an optional first prompt
// that rides the follow-up path against the new session.
const ApiForkForm = type({
  "cutoff?": "string",
  "prompt?": "string",
});

// One scheduled-run row exactly as the cron endpoints return it (the
// store's CronJobRecord, snake_cased like ApiSession) plus next_runs:
// the next fire times an enabled schedule spells, soonest first (up to
// three, ISO instants). Omitted for paused rows and for schedules that
// no longer parse — no claim is made about a run that will not fire.
const ApiCronJob = type({
  name: "string",
  /** The canonical schedule spelling (human text is stored as its cron translation). */
  schedule: "string",
  /** The schedule exactly as last typed, when schedule holds a translation. */
  "schedule_input?": "string",
  prompt: "string",
  working_dir: "string",
  "timezone?": "string",
  enabled: "boolean",
  /** The agent the run fires through ("goose", "claude"). */
  agent: "string",
  /** The pinned model, both keys together or neither. */
  "model_provider?": "string",
  "model?": "string",
  /** Follow-on prompts, in run order. */
  "follow_ups?": "string[]",
  /** The most recent occurrence served (ISO 8601 UTC, zoned). */
  "last_fired_at?": "string",
  "next_runs?": "string[]",
});

type ApiCronJobData = typeof ApiCronJob.infer;

// The multipart form fields POST /api/cron accepts. follow_ups submits
// one part per follow-on prompt, in run order.
const ApiCronJobForm = type({
  name: "string",
  schedule: "string",
  prompt: "string",
  working_dir: "string",
  "timezone?": "string",
  "model?": "string",
  "follow_ups?": "string[]",
});

// The body DELETE /api/cron/:name returns.
const ApiCronDeleted = type({ name: "string", status: "'deleted'" });

// The body POST /api/cron/:name/run returns — "started" means the fire
// was accepted, not that it finished (runs proceed in the background).
const ApiCronRunAccepted = type({ name: "string", status: "'started'" });

// A stored row as the API spells it. defaultAgent is what a row
// without its own agent would read as (records from the store always
// carry one; the fallback keeps the projection total).
const toApiCronJob = (
  job: CronJobRecord,
  defaultAgent: string,
): ApiCronJobData => {
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  return {
    name: job.name,
    schedule: job.schedule,
    ...(job.scheduleInput === undefined
      ? {}
      : { schedule_input: job.scheduleInput }),
    prompt: job.prompt,
    working_dir: job.workingDir,
    ...(job.timezone === undefined ? {} : { timezone: job.timezone }),
    enabled: job.enabled,
    agent: job.agent ?? defaultAgent,
    ...(job.modelProvider === undefined || job.model === undefined
      ? {}
      : { model_provider: job.modelProvider, model: job.model }),
    ...(job.followUps !== undefined && job.followUps.length > 0
      ? { follow_ups: [...job.followUps] }
      : {}),
    ...(job.lastFiredAt === undefined
      ? {}
      : { last_fired_at: toApiTimestamp(job.lastFiredAt) }),
    ...(job.enabled && parsed.ok
      ? {
          next_runs: parsed.info.next
            .slice(0, 3)
            .map((run) => run.toISOString()),
        }
      : {}),
  };
};

// One saved prompt exactly as the prompt endpoints return it (the
// store's SavedPrompt, snake_cased like ApiSession). `body` rides
// along verbatim — placeholders like {{repo}} included, unsubstituted —
// exactly as submitted; `last_used_at` stays null until the prompt has
// been run. The timestamp fields re-spell to the wire's zoned form
// (toApiTimestamp).
const ApiPrompt = type({
  id: "string",
  title: "string",
  body: "string",
  category: "string | null",
  sort_order: "number",
  usage_count: "number",
  last_used_at: "string | null",
  created_at: "string",
  updated_at: "string",
});

type ApiPromptData = typeof ApiPrompt.infer;

const toApiPrompt = (prompt: SavedPrompt): ApiPromptData => ({
  id: prompt.id,
  title: prompt.title,
  body: prompt.body,
  category: prompt.category,
  sort_order: prompt.sortOrder,
  usage_count: prompt.usageCount,
  last_used_at: toApiTimestampOrNull(prompt.lastUsedAt),
  created_at: toApiTimestamp(prompt.createdAt),
  updated_at: toApiTimestamp(prompt.updatedAt),
});

// The form fields the prompt writes accept — the same title, body,
// and optional category the browser's save and edit forms submit.
const ApiPromptForm = type({
  title: "string",
  body: "string",
  "category?": "string",
});

// --- The model catalogue (#342) ---------------------------------------

// A model selection as the catalogue spells it: the provider/model pair
// an agent resolves — the same pair a scheduled-run row stores as its
// pin.
const ApiModelSelection = type({
  provider: "string",
  model: "string",
});

// One model an agent offers, as the combined picker renders it: the
// provider and model id a pin names, the picker label, and `pin` — the
// exact spelling the `model` field of POST /api/sessions (and the
// scheduled-run forms) accepts: "agent:provider:model".
const ApiModelEntry = type({
  provider: "string",
  model: "string",
  label: "string",
  pin: "string",
});

// One served agent's slice of GET /api/models: every model it offers in
// picker order (the agent's default provider first), plus its own
// default selection — omitted when the agent has none readable.
const ApiAgentModels = type({
  agent: "string",
  label: "string",
  "default?": ApiModelSelection,
  models: ApiModelEntry.array(),
});

type ApiAgentModelsData = typeof ApiAgentModels.infer;

// The body GET /api/models answers with: one slice per served agent, in
// picker order.
const ApiModels = type({ agents: ApiAgentModels.array() });

// Beside its schema, like toApiSession, so the wire shape cannot drift —
// and it takes the runtime whole, like toApiSession takes the runner, so
// a caller cannot transpose the slice's two string fields. The pin is
// derived here — the combined spelling of the choice's own form value —
// so the answer names, by construction, exactly what a submit of the
// same value would decode. A choice whose value does not decode to a
// provider/model pair (no flavour offers one today) has no spellable
// pin and is skipped. Resolving a catalogue may spawn the agent binary,
// so this is async; an agent with no model source contributes no
// default and an empty catalogue.
const toApiAgentModels = async (
  runtime: AgentRuntime,
): Promise<ApiAgentModelsData> => {
  const defaultSelection = runtime.models?.defaultSelection();
  const choices = (await runtime.models?.choices()) ?? [];
  return {
    agent: runtime.id,
    label: runtime.profile.agentName,
    ...(defaultSelection === undefined ? {} : { default: defaultSelection }),
    models: choices.flatMap((choice) => {
      const selection = decodeModelValue(choice.value);
      return selection === undefined
        ? []
        : [
            {
              provider: choice.provider,
              model: selection.model,
              label: choice.label,
              pin: encodeAgentModelValue(runtime.id, choice.value),
            },
          ];
    }),
  };
};

// A well-formed listing query, parsed: the window plus the filters
// that arrived — absent ones read as undefined / false. The route folds
// this into the store's SessionFilter.
type ParsedListQuery = {
  readonly ok: true;
  readonly limit: number;
  readonly offset: number;
  readonly agent: string | undefined;
  readonly workingDirPrefix: string | undefined;
  readonly active: boolean;
};

type ListQuery =
  | ParsedListQuery
  | { readonly ok: false; readonly error: string };

// The wording every rejected query parameter answers with: the name it
// arrived under and ArkType's own summary of what failed.
const invalidQueryParameter = (key: string, errors: ArkErrors): string =>
  `Invalid "${key}" query parameter: ${errors.summary}.`;

// Query strings arrive as strings; parse each to a number and let the
// ArkType bounds decide. Absent (or empty) parameters read as absent.
const parseNumberQuery = (
  request: FastifyRequest,
  key: string,
  bounds: Type<number>,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly error: string } => {
  const raw = queryValue(request, key);
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  const checked = bounds(Number(raw));
  if (checked instanceof ArkErrors)
    return { ok: false, error: invalidQueryParameter(key, checked) };
  return { ok: true, value: checked };
};

// A string parameter with no shape to check beyond presence; absent (or
// empty) reads as absent. The listing's string filters share it.
const parseStringQuery = (
  request: FastifyRequest,
  key: string,
): string | undefined => {
  const raw = queryValue(request, key);
  return raw === "" ? undefined : raw;
};

// A string parameter validated against a literal union — the string
// counterpart of parseNumberQuery: absent (or empty) reads as absent,
// anything outside the union is a client error naming the parameter.
const parseEnumQuery = (
  request: FastifyRequest,
  key: string,
  shape: Type<string>,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: string } => {
  const raw = parseStringQuery(request, key);
  if (raw === undefined) return { ok: true, value: undefined };
  const checked = shape(raw);
  if (checked instanceof ArkErrors)
    return { ok: false, error: invalidQueryParameter(key, checked) };
  return { ok: true, value: checked };
};

// The listing window and filters: the defaults keep the sidebar's
// VIEWER_FILTER window when no parameter arrives. The agent filter is
// validated against the agents this server serves, so a typo answers a
// client error naming the choices rather than a silently empty list.
const parseListQuery = (
  request: FastifyRequest,
  defaultLimit: number,
  servedAgents: readonly string[],
): ListQuery => {
  const limit = parseNumberQuery(request, "limit", ListLimit);
  if (!limit.ok) return limit;
  const offset = parseNumberQuery(request, "offset", ListOffset);
  if (!offset.ok) return offset;
  const active = parseEnumQuery(request, "active", ApiListActive);
  if (!active.ok) return active;
  const agent = parseStringQuery(request, "agent");
  if (agent !== undefined && !servedAgents.includes(agent))
    return {
      ok: false,
      error:
        `Invalid "agent" query parameter: must be one of the served ` +
        `agents (${servedAgents.join(", ")}).`,
    };
  // working_dir needs no validation — any non-empty string is a prefix —
  // but trailing separators are trimmed so "/repo/" filters exactly
  // like "/repo". A value of pure separators ("/", "\\") trims to the
  // empty prefix, which sits under every path.
  const rawWorkingDir = parseStringQuery(request, "working_dir");
  const workingDirPrefix =
    rawWorkingDir === undefined
      ? undefined
      : rawWorkingDir.replace(/[\\/]+$/, "");
  return {
    ok: true,
    limit: limit.value ?? defaultLimit,
    offset: offset.value ?? 0,
    agent,
    workingDirPrefix,
    active: active.value === "true",
  };
};

// The detail read's parsed windows. `after` is the transcript index to
// start from — the count of messages the caller already holds, the same
// count cursor the SSE feed's append ids and the store tail speak, so
// the answer carries everything from that index on and 0 reads the
// whole transcript. `head` and `last` keep the first or final n
// messages, clamped to the transcript's length (0 answers an empty
// window, a count past the end everything). At most one window may
// arrive, and never with fields=meta: meta omits the transcript, a
// window selects part of it, and either combination would silently
// answer a smaller question than the caller asked.
type DetailWindow = {
  readonly after: number | undefined;
  readonly head: number | undefined;
  readonly last: number | undefined;
};

type DetailQuery =
  | ({ readonly ok: true; readonly metaOnly: boolean } & DetailWindow)
  | { readonly ok: false; readonly error: string };

// fields=meta: present reads as meta-only, absent (or empty) as the
// default transcript read — anything but "meta" is a client error.
const parseDetailQuery = (request: FastifyRequest): DetailQuery => {
  const fields = parseEnumQuery(request, "fields", ApiDetailFields);
  if (!fields.ok) return fields;
  const after = parseNumberQuery(request, "after", ApiDetailWindow);
  if (!after.ok) return after;
  const head = parseNumberQuery(request, "head", ApiDetailWindow);
  if (!head.ok) return head;
  const last = parseNumberQuery(request, "last", ApiDetailWindow);
  if (!last.ok) return last;
  const windows = Object.entries({
    after: after.value,
    head: head.value,
    last: last.value,
  })
    .filter(([, count]) => count !== undefined)
    .map(([name]) => name);
  if (fields.value !== undefined && windows.length > 0)
    return {
      ok: false,
      error:
        '"fields=meta" omits messages while a window parameter selects ' +
        "them — pass one, not both.",
    };
  if (windows.length > 1)
    return {
      ok: false,
      error:
        `"${windows[0]}" and "${windows[1]}" are alternative transcript ` +
        "windows — pass at most one of after, head, or last.",
    };
  return {
    ok: true,
    metaOnly: fields.value !== undefined,
    after: after.value,
    head: head.value,
    last: last.value,
  };
};

// The wait endpoint's deadline: absent (or empty) reads as the default;
// -1 reads as Infinity, the deadline-free park (#382) the wait loop
// honours by never letting its deadline lapse.
type WaitQuery =
  | { readonly ok: true; readonly timeout: number }
  | { readonly ok: false; readonly error: string };

const parseWaitQuery = (request: FastifyRequest): WaitQuery => {
  const timeout = parseNumberQuery(request, "timeout", ApiWaitTimeout);
  if (!timeout.ok) return timeout;
  if (timeout.value === UNBOUNDED_TIMEOUT)
    return { ok: true, timeout: Number.POSITIVE_INFINITY };
  return { ok: true, timeout: timeout.value ?? DEFAULT_WAIT_MS };
};

// --- The OpenAPI document, generated from the schemas above -----------

// toJsonSchema decorates its output with a $schema keyword; components
// inside an OpenAPI document carry no such self-declaration, so it is
// dropped on the way in.
const component = (t: {
  readonly toJsonSchema: () => object;
}): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(t.toJsonSchema()))
    if (key !== "$schema") out[key] = value;
  return out;
};

// The `properties` object of a generated schema, narrowed without a cast
// (empty when the schema somehow has none).
const properties = (t: {
  readonly toJsonSchema: () => object;
}): Record<string, unknown> => {
  const props = component(t).properties;
  return isRecord(props) ? props : {};
};

// OpenAPI spells file parts as `{ type: "string", format: "binary" }` —
// outside JSON Schema's vocabulary, so it is merged in by hand.
const uploadsProperty = (): Record<string, unknown> => ({
  type: "array",
  items: { type: "string", format: "binary" },
  description: "Optional file attachments (50 MB each, 100 MB total).",
});

const ref = (name: string): Record<string, unknown> => ({
  $ref: `#/components/schemas/${name}`,
});

const jsonResponse = (
  description: string,
  schema?: Record<string, unknown>,
): Record<string, unknown> => ({
  description,
  ...(schema === undefined
    ? {}
    : {
        content: {
          "application/json": { schema },
        },
      }),
});

const multipartRequest = (schema: string): Record<string, unknown> => ({
  required: true,
  content: {
    "multipart/form-data": { schema: ref(schema) },
  },
});
// The token-bootstrap request body: one required field, spellable as a
// JSON object or a form field.
const nameBodySchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};

// The 201 every creator answers with: the created resource plus its
// Location header.
const createdResponse = (
  description: string,
  locationDescription: string,
  schema: string,
): Record<string, unknown> => ({
  description,
  headers: {
    Location: {
      description: locationDescription,
      schema: { type: "string" },
    },
  },
  content: {
    "application/json": { schema: ref(schema) },
  },
});

const bearerResponses = (): Record<string, unknown> => ({
  "401": jsonResponse(
    "Missing, invalid, or insufficient credential.",
    ref("Error"),
  ),
});

// A query parameter entry, documented by the schema property it
// mirrors (see properties()).
const queryParam = (
  name: string,
  schema: unknown,
  description: string,
): Record<string, unknown> => ({
  name,
  in: "query",
  schema,
  description,
});

const sessionParam = (): Record<string, unknown> => ({
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Session id, namespaced by agent (e.g. goose:<uuid>).",
});

const cronNameParam = (): Record<string, unknown> => ({
  name: "name",
  in: "path",
  required: true,
  schema: { type: "string" },
  description:
    "Scheduled-run name — letters, digits, spaces, dots, dashes, " +
    "underscores, max 64 characters (URL-encode spaces).",
});

const promptIdParam = (): Record<string, unknown> => ({
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Saved-prompt id, as the list endpoint spells it.",
});

const openApiDocument = (
  defaultListLimit: number,
  servedAgents: readonly string[],
): Record<string, unknown> => {
  const queryProps = properties(ApiListQuery);
  const detailQueryProps = properties(ApiDetailQuery);
  return {
    openapi: "3.1.0",
    info: {
      title: "glv API",
      version: "1.0.0",
      summary: "Drive and monitor glv sessions from scripts and CI.",
      description:
        "Auth is an API-token bearer on every path " +
        "(Authorization: Bearer glv_at_…); GET also accepts the browser " +
        "session cookie, POST accepts the bearer only. Live monitoring " +
        "rides the Server-Sent Events routes /sessions/{id}/events and " +
        "/events/status with the same bearer header, and sequencing — " +
        "waiting for a run to settle — rides the long-poll GET /api/" +
        "sessions/{id}/wait. Destructive " +
        "operations (archive, delete) and every management surface " +
        "(tokens, groups) stay in the browser; the saved-prompt library " +
        "is written and read over JSON at /api/prompts (deleting and " +
        "reordering prompts stay in the browser), and scheduled runs " +
        "are created, listed, run on demand, and deleted over JSON at " +
        "/api/cron. The " +
        "combined model catalogue behind the New Session picker is " +
        "readable at /api/models — each model's pin is the exact " +
        "spelling the model fields accept. The verdict history behind " +
        "last_run — every settled run, not just the latest — is " +
        "readable at /api/sessions/{id}/runs. Every timestamp on the " +
        "wire — created_at, updated_at, archived_at, message " +
        "timestamps, last_run.ended_at, the run-history instants, " +
        "last_fired_at — is ISO 8601 UTC with an " +
        "explicit zone designator (2026-10-21T18:22:36Z): storage is " +
        "UTC, and the wire says so. The one credential-less path is the " +
        "flag-gated, loopback-only token bootstrap POST /api/tokens " +
        "(see there).",
    },
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Error: component(ApiError),
        RunAccepted: component(ApiRunAccepted),
        StopAccepted: component(ApiStopAccepted),
        ForkAccepted: component(ApiForkAccepted),
        Session: component(ApiSession),
        LastRun: component(ApiLastRun),
        WaitResult: component(ApiWaitResult),
        RunHistoryEntry: component(ApiRunHistoryEntry),
        StartSessionForm: {
          ...component(ApiStartSessionForm),
          properties: {
            ...properties(ApiStartSessionForm),
            uploads: uploadsProperty(),
          },
        },
        FollowUpForm: {
          ...component(ApiFollowUpForm),
          properties: {
            ...properties(ApiFollowUpForm),
            uploads: uploadsProperty(),
          },
        },
        ForkForm: component(ApiForkForm),
        CronJob: component(ApiCronJob),
        CronJobForm: component(ApiCronJobForm),
        CronDeleted: component(ApiCronDeleted),
        CronRunAccepted: component(ApiCronRunAccepted),
        Prompt: component(ApiPrompt),
        PromptForm: component(ApiPromptForm),
        MintedToken: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description:
                "The raw glv_at_… credential — returned exactly once; " +
                "only its SHA-256 hash is stored.",
            },
            name: { type: "string", description: "The label passed in." },
          },
          required: ["token", "name"],
        },
        ModelSelection: component(ApiModelSelection),
        ModelEntry: component(ApiModelEntry),
        AgentModels: component(ApiAgentModels),
        Models: component(ApiModels),
      },
    },
    paths: {
      "/api/cron": {
        get: {
          summary: "List scheduled runs (creation order)",
          description:
            "One-shots that already fired are retired from the list by " +
            "the scheduler; paused rows carry enabled: false and no " +
            "next_runs.",
          responses: {
            "200": jsonResponse("The scheduled-run rows.", {
              type: "array",
              items: ref("CronJob"),
            }),
            ...bearerResponses(),
          },
        },
        post: {
          summary: "Schedule a run",
          description:
            "Multipart form. The schedule is one of: an ISO 8601 local " +
            "datetime (2026-09-03T09:00 — fires once, then retires " +
            "itself), a cron pattern (0 9 * * 1-5), or human text " +
            "(every weekday at 9:00 — translated to its cron pattern at " +
            "save time). An optional timezone (IANA name) relocates " +
            "either kind. Repeated follow_ups fields chain further " +
            "prompts, strictly in order, after the first. The row is " +
            "written and the scheduler picks it up immediately — no " +
            "restart needed.",
          requestBody: multipartRequest("CronJobForm"),
          responses: {
            "201": createdResponse(
              "The scheduled run was saved.",
              "The new run's detail URL.",
              "CronJob",
            ),
            "422": jsonResponse("Validation failure.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/cron/{name}": {
        get: {
          summary: "Read one scheduled run",
          parameters: [cronNameParam()],
          responses: {
            "200": jsonResponse("The scheduled-run row.", ref("CronJob")),
            "404": jsonResponse("Unknown scheduled-run name.", ref("Error")),
            ...bearerResponses(),
          },
        },
        delete: {
          summary: "Delete a scheduled run",
          description:
            "Cancels the schedule. An in-flight run keeps running; a " +
            "one-shot not yet fired simply never fires.",
          parameters: [cronNameParam()],
          responses: {
            "200": jsonResponse("The run was deleted.", ref("CronDeleted")),
            "404": jsonResponse("Unknown scheduled-run name.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/cron/{name}/run": {
        post: {
          summary: "Run a scheduled run now",
          description:
            "Fires the stored run immediately through the running " +
            "scheduler — the same path a scheduled tick takes, so the " +
            "prompt, working directory, model pin, and follow-on chain " +
            "all apply, and a still-running previous fire is refused " +
            "with 409 rather than stacked. The job's schedule is " +
            "unaffected: a recurring job keeps its times, and a " +
            "not-yet-due one-shot keeps its appointment (only a fire " +
            "served at or after its own moment retires it).",
          parameters: [cronNameParam()],
          responses: {
            "202": jsonResponse(
              "The fire was started; the session appears in the viewer " +
                "as the agent creates it.",
              ref("CronRunAccepted"),
            ),
            "404": jsonResponse("Unknown scheduled-run name.", ref("Error")),
            "409": jsonResponse(
              "The job's previous fire is still in flight.",
              ref("Error"),
            ),
            "422": jsonResponse(
              "The stored row would not fire — a missing working " +
                "directory, a disabled agent, or an unparsable schedule.",
              ref("Error"),
            ),
            ...bearerResponses(),
          },
        },
      },
      "/api/models": {
        get: {
          summary: "List the model catalogue (the picker's choices)",
          description:
            "The combined catalogue the New Session picker renders " +
            "from, exposed for scripts: one entry per served agent, in " +
            "picker order, carrying every model it offers (provider, " +
            "model id, label) and the agent's own default selection. " +
            "Each model also carries pin — the exact agent:provider:" +
            "model spelling the model field of POST /api/sessions and " +
            "the scheduled-run forms accepts — so a script can " +
            "discover and validate pins without reimplementing the " +
            "agent's own catalogue protocol. Resolving a catalogue may " +
            "spawn the agent binary, so a cold call can take seconds; " +
            "later calls ride the same short-lived cache the picker and " +
            "submit-time validation share.",
          responses: {
            "200": jsonResponse("The combined model catalogue.", ref("Models")),
            ...bearerResponses(),
          },
        },
      },
      "/api/prompts": {
        get: {
          summary: "List saved prompts (manual order)",
          description:
            "Every stored prompt with its body — the content to fill an " +
            "editor with or submit as a session prompt. Ordered the way " +
            "the library renders by default: manual order, last-used " +
            "recency breaking ties.",
          responses: {
            "200": jsonResponse("The saved prompts.", {
              type: "array",
              items: ref("Prompt"),
            }),
            ...bearerResponses(),
          },
        },
        post: {
          summary: "Save a prompt",
          description:
            "Multipart form, the same fields the browser's save form " +
            "accepts: title and body required (blank answers 422), " +
            "category optional — a blank category stores null. Answers " +
            "with the stored prompt and a Location naming its detail " +
            "URL. The write rides the same operation layer the browser " +
            "form does, so both surfaces run identical effects.",
          requestBody: multipartRequest("PromptForm"),
          responses: {
            "201": createdResponse(
              "The prompt was saved.",
              "The new prompt's detail URL.",
              "Prompt",
            ),
            "422": jsonResponse("Title or body blank.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/prompts/{id}": {
        get: {
          summary: "Read one saved prompt",
          parameters: [promptIdParam()],
          responses: {
            "200": jsonResponse("The saved prompt.", ref("Prompt")),
            "404": jsonResponse("Unknown prompt id.", ref("Error")),
            ...bearerResponses(),
          },
        },
        put: {
          summary: "Update a saved prompt",
          description:
            "Multipart form with the same fields the create accepts — " +
            "a full save, not a patch: every submit rewrites title, " +
            "body, and category together. The row keeps its id, sort " +
            "position, and usage stats. Blank title or body answers " +
            "422; an unknown id answers 404.",
          parameters: [promptIdParam()],
          requestBody: multipartRequest("PromptForm"),
          responses: {
            "200": jsonResponse("The updated prompt.", ref("Prompt")),
            "404": jsonResponse("Unknown prompt id.", ref("Error")),
            "422": jsonResponse("Title or body blank.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions": {
        get: {
          summary: "List sessions (newest first)",
          description:
            "Each row carries status — the same run-state projection the " +
            "detail endpoint returns — so a script can scan for live runs " +
            "without opening the SSE feed. Rows also carry last_run, the " +
            "persisted verdict of each session's most recent settled run " +
            "(finished/stopped/stopped_early/failed with a reason), so a " +
            "scan can flag runs that ended badly without opening each " +
            "session. Three filters narrow the list server-side — " +
            "working_dir, agent, active — and every one applies before " +
            "the limit/offset window, so pagination pages the filtered " +
            "order exactly as it pages the unfiltered one.",
          parameters: [
            queryParam(
              "limit",
              queryProps.limit,
              `Rows to return (1–${MAX_LIST_LIMIT}; default ${defaultListLimit}).`,
            ),
            queryParam(
              "offset",
              queryProps.offset,
              "Rows to skip, for pagination (default 0).",
            ),
            queryParam(
              "working_dir",
              queryProps.working_dir,
              "Restrict the list to sessions in this directory: a row's " +
                "working_dir equals it or lies underneath it. A trailing " +
                "separator is tolerated; a sibling directory that merely " +
                "shares a stem does not match.",
            ),
            queryParam(
              "agent",
              queryProps.agent,
              `Restrict the list to one served agent (${servedAgents.join(" or ")}); ` +
                "anything else answers 422.",
            ),
            queryParam(
              "active",
              queryProps.active,
              "Pass true to restrict the list to sessions with a live run " +
                "(queued or running) — the same set the /events/status " +
                "sync snapshot carries. false reads as absent.",
            ),
          ],
          responses: {
            "200": jsonResponse("The session list.", {
              type: "array",
              items: ref("Session"),
            }),
            "422": jsonResponse(
              "Invalid limit/offset or filter value.",
              ref("Error"),
            ),
            ...bearerResponses(),
          },
        },
        post: {
          summary: "Start a new session",
          description:
            "Multipart form. Either working_dir (an existing directory " +
            "on the server) or session_mode=temp (glv creates and owns a " +
            "scratch directory). An optional non-blank name field labels " +
            "the session at creation — the same viewer-managed rename the " +
            "browser's rename action performs — so a driven loop can tell " +
            "its runs apart before any agent-derived title arrives; " +
            "absent or blank keeps auto-derived naming. Returns once the " +
            "session exists — not when the run completes; park on GET " +
            "/api/sessions/{id}/wait (it resolves with the run's " +
            "verdict), poll GET /api/sessions/{id} (its session.status " +
            "names the run's state), or subscribe to the session's SSE " +
            "feed for progress.",
          requestBody: multipartRequest("StartSessionForm"),
          responses: {
            "201": createdResponse(
              "The run was accepted.",
              "The new session's detail URL.",
              "RunAccepted",
            ),
            "422": jsonResponse("Validation failure.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions/{id}": {
        get: {
          summary: "Read a session with its parsed transcript",
          description:
            "The session row carries status — the run's live state " +
            '(queued/running) or how it last settled ("completed", ' +
            '"stopped", "error" — visible for the short window a settled ' +
            'run lingers — then "idle"), so a polling client can tell a ' +
            "live run from a finished one without opening the SSE feed. " +
            "last_run names how the most recent settled run ended — " +
            "finished, stopped (by request, or by the server's own " +
            "shutdown teardown — reason says which), stopped_early (the " +
            "provider refused service: a usage limit with its reset " +
            "time, a network outage), or failed (a crash exit, signal " +
            "death, or the startup watchdog) with the reason wording and " +
            "the settle " +
            "instant — persisted beyond the registry window and across a " +
            "server restart, so a session that merely left the active " +
            "list can never be mistaken for a successful finish. " +
            "Long transcripts need not ride every poll: fields=meta " +
            "answers with the session row, no messages, and " +
            "message_count — the transcript's length, so a liveness " +
            "check compares integers instead of downloading messages " +
            "to count them; after=<message-index> answers with only " +
            "the messages from that transcript index on (advance the " +
            "cursor, the count of messages held, by the length of each " +
            "answer); head=<n> answers with the first n messages; " +
            "last=<n> with the final n — the tail read that pulls a " +
            "run's verdict out of a long transcript without paying for " +
            "the rest. The parameters cannot be combined (422).",
          parameters: [
            sessionParam(),
            queryParam(
              "fields",
              detailQueryProps.fields,
              'Pass "meta" to read the session row without the ' +
                "transcript — the cheap poll for done-yet checks; the " +
                "answer carries message_count.",
            ),
            queryParam(
              "after",
              detailQueryProps.after,
              "Transcript index to start from — the count of messages " +
                "already held; the answer carries everything from there " +
                "on (empty once caught up), so a poll downloads just " +
                "what landed since. 0 reads the whole transcript.",
            ),
            queryParam(
              "head",
              detailQueryProps.head,
              "Count of leading messages to keep — the first-prompt " +
                "window a fingerprint check needs; clamped to the " +
                "transcript's length.",
            ),
            queryParam(
              "last",
              detailQueryProps.last,
              "Count of trailing messages to keep — the tail window " +
                "that reads a run's final answer without downloading " +
                "the transcript behind it; clamped to the transcript's " +
                "length.",
            ),
          ],
          responses: {
            "200": jsonResponse("The session row and its parsed messages.", {
              type: "object",
              properties: {
                session: ref("Session"),
                message_count: {
                  type: "integer",
                  description:
                    "The transcript's message count. Carried by the " +
                    "fields=meta answer, so a liveness poll compares " +
                    "integers instead of downloading the transcript.",
                },
                messages: {
                  type: "array",
                  description:
                    "Parsed transcript messages, oldest first (each " +
                    "timestamp ISO 8601 UTC, zoned). Omitted " +
                    "under fields=meta; windowed by after, head, or " +
                    "last when one is given.",
                },
              },
              required: ["session"],
            }),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            "422": jsonResponse(
              "Invalid fields/after/head/last combination.",
              ref("Error"),
            ),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions/{id}/wait": {
        get: {
          summary: "Wait for the session's run to settle",
          description:
            "The long-poll that replaces a script's poll loop: the " +
            "answer parks while the session's run is queued or running " +
            "and resolves the moment it settles — or immediately when " +
            "no run is active. A resolved wait (200) carries the " +
            "terminal status — completed/stopped/error, or idle when no " +
            "run is registered — and the same last_run verdict the " +
            "session rows carry, so the answer says not just that the " +
            "run ended but how: a clean finish, a stop by request, a " +
            "provider refusal, or a crash. When the deadline passes " +
            "with the run still active the answer is 202 with the live " +
            "status — call again to keep waiting, which is how a script " +
            "covers runs longer than any single deadline. timeout is " +
            `milliseconds (0–${MAX_WAIT_MS}, default ${DEFAULT_WAIT_MS}): ` +
            "0 answers with a single snapshot, no park, and -1 parks " +
            "with no deadline at all — one call spans any run length, " +
            "and a caller that hangs up mid-park drops the answer.",
          parameters: [
            sessionParam(),
            queryParam(
              "timeout",
              properties(ApiWaitQuery).timeout,
              `Deadline in milliseconds (0–${MAX_WAIT_MS}; default ` +
                `${DEFAULT_WAIT_MS}). On expiry the answer is 202 with ` +
                "the live status; -1 parks with no deadline, until the " +
                "run settles or the caller hangs up.",
            ),
          ],
          responses: {
            "200": jsonResponse(
              "The wait resolved: the run settled, or none was active.",
              ref("WaitResult"),
            ),
            "202": jsonResponse(
              "The deadline passed with the run still active; the body " +
                "names the live status. Call again to keep waiting.",
              ref("WaitResult"),
            ),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            "422": jsonResponse("Invalid timeout.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions/{id}/runs": {
        get: {
          summary: "Read the session's settled-run history",
          description:
            "Every verdict the session has settled, not just the " +
            "latest: one row per settled run, oldest first, each " +
            "spelled like last_run (state, optional reason, ended_at — " +
            "the settle instant) plus started_at, the instant the run's " +
            "process spawned (omitted for a run stopped while still " +
            "queued). The history is append-only — a later run never " +
            "overwrites an earlier verdict — so a loop's stall " +
            "frequency, crash-then-retry chains, and repeated provider " +
            "refusals stay queryable after the fact, across the run " +
            "handle's registry window and server restarts. Capped at " +
            "the newest 20 runs per session; an empty runs array means " +
            "the session has never settled a run.",
          parameters: [sessionParam()],
          responses: {
            "200": jsonResponse(
              "The session's recent settled runs, oldest first.",
              {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "The session id, as spelled in the path.",
                  },
                  runs: {
                    type: "array",
                    items: ref("RunHistoryEntry"),
                    description:
                      "One entry per settled run, oldest first (each " +
                      "timestamp ISO 8601 UTC, zoned), newest 20 kept.",
                  },
                },
                required: ["id", "runs"],
              },
            ),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions/{id}/prompt": {
        post: {
          summary: "Queue a follow-up prompt",
          description:
            "Multipart form. Starts the follow-up immediately, or queues " +
            "it behind the session's active run (status: queued).",
          parameters: [sessionParam()],
          requestBody: multipartRequest("FollowUpForm"),
          responses: {
            "200": jsonResponse("The prompt was accepted.", ref("RunAccepted")),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            "422": jsonResponse("Validation failure.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions/{id}/stop": {
        post: {
          summary: "Stop the session's run",
          description: "Idempotent: 200 whether or not a run is active.",
          parameters: [sessionParam()],
          responses: {
            "200": jsonResponse("The session is stopped.", ref("StopAccepted")),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/sessions/{id}/fork": {
        post: {
          summary: "Fork the session",
          description:
            "Multipart form. Copies the session's persisted state under a " +
            'fresh id (name "<name> (fork)"), keeping only the messages ' +
            "up to the optional cutoff — the index of the last transcript " +
            "message to keep, in transcript order; omitted means the whole " +
            "history. A cutoff that would strand a tool call without its " +
            "result is rejected (422). The source is never modified. An " +
            "optional prompt field starts the fork through the same path " +
            'as a follow-up (status "started" or "queued"); without ' +
            'one the answer is status "created" and the fork sits idle.',
          parameters: [sessionParam()],
          requestBody: multipartRequest("ForkForm"),
          responses: {
            "201": createdResponse(
              "The fork was created.",
              "The fork's detail URL.",
              "ForkAccepted",
            ),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            "422": jsonResponse("Invalid cutoff.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
      "/api/tokens": {
        post: {
          summary: "Mint an API token (loopback bootstrap; flag-gated)",
          description:
            "Exists only while serve runs with --allow-token-bootstrap " +
            "(default off — without the flag this path answers exactly " +
            "like any unknown /api route). The bootstrap for clients with " +
            "network reach but no filesystem access to the data " +
            "directory (SSH port-forwards, sibling containers, CI " +
            "executors): no credential is required, because a credential " +
            "is what it mints — reachability is bounded by network " +
            "position instead. The decision is the TCP peer's socket " +
            "address (127.0.0.1 / ::1 only); x-forwarded-* headers are " +
            "never consulted, so do not put serve behind a reverse proxy " +
            "with this flag on — every proxied request arrives from the " +
            "proxy's own loopback hop. Minting reuses the exact operation " +
            "the browser's /auth/tokens page and `glv token create` use " +
            "(hash-only storage, fixed 30-day TTL, last_used_at audit " +
            "trail) and still requires an owner to exist. Bounded to 10 " +
            "mints per rolling minute.",
          security: [],
          requestBody: {
            required: true,
            description: "The token's label: 1–64 characters, trimmed.",
            content: {
              "application/json": { schema: nameBodySchema },
              "application/x-www-form-urlencoded": { schema: nameBodySchema },
              "multipart/form-data": { schema: nameBodySchema },
            },
          },
          responses: {
            "201": jsonResponse(
              "The minted token — the plaintext crosses the wire exactly " +
                "this once.",
              ref("MintedToken"),
            ),
            "403": jsonResponse("The TCP peer is not loopback.", ref("Error")),
            "409": jsonResponse(
              "No owner yet — a passkey must be registered once first.",
              ref("Error"),
            ),
            "422": jsonResponse(
              "Missing or blank name; nothing was minted.",
              ref("Error"),
            ),
            "429": jsonResponse(
              "Mint valve: more than 10 mints in the last minute.",
              ref("Error"),
            ),
          },
        },
      },
    },
  };
};

export {
  type DetailWindow,
  openApiDocument,
  type ParsedListQuery,
  parseDetailQuery,
  parseListQuery,
  parseWaitQuery,
  toApiAgentModels,
  toApiCronJob,
  toApiMessage,
  toApiPrompt,
  toApiRunHistoryEntry,
  toApiSession,
  toApiWaitResult,
};
