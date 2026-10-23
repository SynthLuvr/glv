import { ArkErrors, type Type, type } from "arktype";
import type { FastifyRequest } from "fastify";
import type { CronJobRecord } from "../cron-jobs.js";
import type { SavedPrompt } from "../prompts/db.js";
import type { Runner } from "../runner/index.js";
import { getHandle } from "../runner/index.js";
import { parseSchedule } from "../schedule.js";
import type { SessionRow } from "../sessions.js";
import { type LastRunRecord, LastRunState } from "../stop-notices.js";
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
const MAX_LIST_LIMIT = 500;
const ListLimit = type(`1 <= number.integer <= ${MAX_LIST_LIMIT}`);
const ListOffset = type("number.integer >= 0");
const ApiListQuery = type({
  "limit?": ListLimit,
  "offset?": ListOffset,
});

// The detail read's windows (#339): fields=meta answers a poll with the
// session row alone — no transcript — and after=<message-index> starts
// the transcript at that index (the count of messages the caller
// already holds, so 0 reads everything). Either way a poll on a
// 300-message run costs what it costs on a fresh one, instead of
// re-downloading the whole history every time.
const ApiDetailFields = type("'meta'");
const ApiDetailAfter = type("number.integer >= 0");
const ApiDetailQuery = type({
  "fields?": ApiDetailFields,
  "after?": ApiDetailAfter,
});

// The wait endpoint's deadline (#341): how long GET /api/sessions/:id/wait
// may park before answering 202 with the still-active status. Bounded so
// no script pins a connection open indefinitely; 0 reads as "answer now"
// — a single snapshot, no park.
const MAX_WAIT_MS = 300_000;
const DEFAULT_WAIT_MS = 30_000;
const ApiWaitTimeout = type(`0 <= number.integer <= ${MAX_WAIT_MS}`);
const ApiWaitQuery = type({ "timeout?": ApiWaitTimeout });

// How the last run ended, persisted in the stop-notices sidecar beyond
// the registry window: "finished" settled cleanly, "stopped" was stopped
// by the user, "stopped_early" was refused service by the provider (a
// usage limit with its reset time, a network outage) — reason carries
// the notice wording — and "failed" crashed (non-zero exit, signal
// death, startup-watchdog kill), reason carrying the verdict with its
// stderr tail. reason appears only where there is something to explain;
// ended_at is the settle instant (ISO UTC). The state union is the
// sidecar's own LastRunState schema, so the wire contract cannot drift
// from what the recorder writes.
const ApiLastRun = type({
  state: LastRunState,
  "reason?": "string",
  ended_at: "string",
});

type ApiLastRunData = typeof ApiLastRun.infer;

const toApiLastRun = (record: LastRunRecord): ApiLastRunData => ({
  state: record.state,
  ...(record.reason === undefined ? {} : { reason: record.reason }),
  ended_at: record.endedAt,
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
// recent settled run (omitted until one has settled).
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
  status: getHandle(runner, row.id)?.status ?? "idle",
  ...(lastRun === undefined ? {} : { last_run: toApiLastRun(lastRun) }),
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
  ...(lastRun === undefined ? {} : { last_run: toApiLastRun(lastRun) }),
});

// The multipart form fields POST /api/sessions accepts. The `uploads`
// file parts are documented beside these — toJsonSchema cannot express
// OpenAPI's binary format.
const ApiStartSessionForm = type({
  prompt: "string",
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
  /** The most recent occurrence served, ISO UTC. */
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
      : { last_fired_at: job.lastFiredAt }),
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
// been run.
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
  last_used_at: prompt.lastUsedAt,
  created_at: prompt.createdAt,
  updated_at: prompt.updatedAt,
});

type ListQuery =
  | { readonly ok: true; readonly limit: number; readonly offset: number }
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

// The listing window: the defaults keep the sidebar's VIEWER_FILTER
// window when no parameter arrives.
const parseListQuery = (
  request: FastifyRequest,
  defaultLimit: number,
): ListQuery => {
  const limit = parseNumberQuery(request, "limit", ListLimit);
  if (!limit.ok) return limit;
  const offset = parseNumberQuery(request, "offset", ListOffset);
  if (!offset.ok) return offset;
  return {
    ok: true,
    limit: limit.value ?? defaultLimit,
    offset: offset.value ?? 0,
  };
};

// The detail read's windows. `after` is the transcript index to start
// from — the count of messages the caller already holds, so the answer
// carries everything from that index on (empty once caught up) and the
// cursor advances by the length of each answer; 0 reads the whole
// transcript. This is the cursor the SSE feed's append ids and the
// store tail already speak (a message count), never a -1 sentinel for
// "nothing held yet". fields=meta and after are mutually exclusive:
// one omits the transcript, the other windows it, and passing both
// would silently answer a smaller question than the caller asked, so
// it is refused.
type DetailQuery =
  | {
      readonly ok: true;
      readonly metaOnly: boolean;
      readonly after: number | undefined;
    }
  | { readonly ok: false; readonly error: string };

// fields=meta: present reads as meta-only, absent (or empty) as the
// default transcript read — anything but "meta" is a client error.
const parseFieldsQuery = (
  request: FastifyRequest,
):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly error: string } => {
  const raw = queryValue(request, "fields");
  if (raw === undefined || raw === "") return { ok: true, value: false };
  const checked = ApiDetailFields(raw);
  if (checked instanceof ArkErrors)
    return { ok: false, error: invalidQueryParameter("fields", checked) };
  return { ok: true, value: true };
};

const parseDetailQuery = (request: FastifyRequest): DetailQuery => {
  const fields = parseFieldsQuery(request);
  if (!fields.ok) return fields;
  const after = parseNumberQuery(request, "after", ApiDetailAfter);
  if (!after.ok) return after;
  if (fields.value && after.value !== undefined)
    return {
      ok: false,
      error:
        '"fields=meta" omits messages while "after" windows them — ' +
        "pass one, not both.",
    };
  return { ok: true, metaOnly: fields.value, after: after.value };
};

// The wait endpoint's deadline: absent (or empty) reads as the default,
// the park bound scripts re-dial to cover runs longer than one deadline.
type WaitQuery =
  | { readonly ok: true; readonly timeout: number }
  | { readonly ok: false; readonly error: string };

const parseWaitQuery = (request: FastifyRequest): WaitQuery => {
  const timeout = parseNumberQuery(request, "timeout", ApiWaitTimeout);
  if (!timeout.ok) return timeout;
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

const openApiDocument = (defaultListLimit: number): Record<string, unknown> => {
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
        "is readable over JSON at /api/prompts (creating and editing " +
        "prompts stays in the browser), and scheduled runs are created, " +
        "listed, run on demand, and deleted over JSON at /api/cron.",
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
            "201": {
              description: "The scheduled run was saved.",
              headers: {
                Location: {
                  description: "The new run's detail URL.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": { schema: ref("CronJob") },
              },
            },
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
            "session.",
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
          ],
          responses: {
            "200": jsonResponse("The session list.", {
              type: "array",
              items: ref("Session"),
            }),
            "422": jsonResponse("Invalid limit/offset.", ref("Error")),
            ...bearerResponses(),
          },
        },
        post: {
          summary: "Start a new session",
          description:
            "Multipart form. Either working_dir (an existing directory " +
            "on the server) or session_mode=temp (glv creates and owns a " +
            "scratch directory). Returns once the session exists — not " +
            "when the run completes; park on GET /api/sessions/{id}/wait " +
            "(it resolves with the run's verdict), poll GET /api/" +
            "sessions/{id} (its session.status names the run's state), " +
            "or subscribe to the session's SSE feed for progress.",
          requestBody: multipartRequest("StartSessionForm"),
          responses: {
            "201": {
              description: "The run was accepted.",
              headers: {
                Location: {
                  description: "The new session's detail URL.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": { schema: ref("RunAccepted") },
              },
            },
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
            "finished, stopped (by request), stopped_early (the provider " +
            "refused service: a usage limit with its reset time, a " +
            "network outage), or failed (a crash exit, signal death, or " +
            "the startup watchdog) with the reason wording and the settle " +
            "instant — persisted beyond the registry window and across a " +
            "server restart, so a session that merely left the active " +
            "list can never be mistaken for a successful finish. " +
            "Long transcripts need not ride every poll: fields=meta " +
            "answers with the session row and no messages, and " +
            "after=<message-index> answers with only the messages from " +
            "that transcript index on — advance the cursor (the count " +
            "of messages held) by the length of each answer. The two " +
            "cannot be combined (422).",
          parameters: [
            sessionParam(),
            queryParam(
              "fields",
              detailQueryProps.fields,
              'Pass "meta" to read the session row without the ' +
                "transcript — the cheap poll for done-yet checks.",
            ),
            queryParam(
              "after",
              detailQueryProps.after,
              "Transcript index to start from — the count of messages " +
                "already held; the answer carries everything from there " +
                "on (empty once caught up), so a poll downloads just " +
                "what landed since. 0 reads the whole transcript.",
            ),
          ],
          responses: {
            "200": jsonResponse("The session row and its parsed messages.", {
              type: "object",
              properties: {
                session: ref("Session"),
                messages: {
                  type: "array",
                  description:
                    "Parsed transcript messages, oldest first. Omitted " +
                    "under fields=meta; starting at the after index when " +
                    "given.",
                },
              },
              required: ["session"],
            }),
            "404": jsonResponse("Unknown session id.", ref("Error")),
            "422": jsonResponse(
              "Invalid fields/after combination.",
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
            `milliseconds (0–${MAX_WAIT_MS}, default ${DEFAULT_WAIT_MS}); ` +
            "0 answers with a single snapshot, no park.",
          parameters: [
            sessionParam(),
            queryParam(
              "timeout",
              properties(ApiWaitQuery).timeout,
              `Deadline in milliseconds (0–${MAX_WAIT_MS}; default ` +
                `${DEFAULT_WAIT_MS}). On expiry the answer is 202 with ` +
                "the live status.",
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
            "201": {
              description: "The fork was created.",
              headers: {
                Location: {
                  description: "The fork's detail URL.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": { schema: ref("ForkAccepted") },
              },
            },
            "404": jsonResponse("Unknown session id.", ref("Error")),
            "422": jsonResponse("Invalid cutoff.", ref("Error")),
            ...bearerResponses(),
          },
        },
      },
    },
  };
};

export {
  openApiDocument,
  parseDetailQuery,
  parseListQuery,
  parseWaitQuery,
  toApiCronJob,
  toApiPrompt,
  toApiSession,
  toApiWaitResult,
};
