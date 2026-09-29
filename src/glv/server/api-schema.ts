import { type Type, type } from "arktype";
import type { FastifyRequest } from "fastify";
import { isRecord, queryValue } from "./http.js";

// The ArkType contracts at the JSON API's boundaries. Every shape the
// API sends or accepts is defined here once; the OpenAPI document below
// is generated from these schemas (toJsonSchema), so the published
// contract cannot drift from the validation the routes actually run.

// The error body every failure answers with (mirrors the pre-existing
// 401/404 shapes).
const ApiError = type({ error: "string" });

// The body POST /api/sessions and POST /api/sessions/:id/prompt return:
// where the submitted prompt sits — "queued" behind the session's active
// run or the concurrency pool, "started" once execution has begun.
const ApiRunAccepted = type({ id: "string", status: "'started' | 'queued'" });

// The body POST /api/sessions/:id/stop returns (idempotent).
const ApiStopAccepted = type({ id: "string", status: "'stopped'" });

// The listing window: 1–500 rows, skipping forward from the newest.
const ListLimit = type("1 <= number.integer <= 500");
const ListOffset = type("number.integer >= 0");
const ApiListQuery = type({
  "limit?": "1 <= number.integer <= 500",
  "offset?": "number.integer >= 0",
});

// One session row exactly as the listing and detail endpoints return it
// (the store's SessionRow verbatim).
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

type ListQuery =
  | { readonly ok: true; readonly limit: number; readonly offset: number }
  | { readonly ok: false; readonly error: string };

// Query strings arrive as strings; parse each to a number and let the
// ArkType bounds decide. Absent (or empty) parameters keep the defaults
// the sidebar's VIEWER_FILTER window has always used.
const parseListQuery = (
  request: FastifyRequest,
  defaultLimit: number,
): ListQuery => {
  const parse = (
    key: string,
    bounds: Type<number>,
  ):
    | { readonly ok: true; readonly value: number | undefined }
    | { readonly ok: false; readonly error: string } => {
    const raw = queryValue(request, key);
    if (raw === undefined || raw === "") return { ok: true, value: undefined };
    const checked = bounds(Number(raw));
    if (checked instanceof type.errors)
      return {
        ok: false,
        error: `Invalid "${key}" query parameter: ${checked.summary}.`,
      };
    return { ok: true, value: checked };
  };

  const limit = parse("limit", ListLimit);
  if (!limit.ok) return limit;
  const offset = parse("offset", ListOffset);
  if (!offset.ok) return offset;
  return {
    ok: true,
    limit: limit.value ?? defaultLimit,
    offset: offset.value ?? 0,
  };
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

const sessionParam = (): Record<string, unknown> => ({
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Session id, namespaced by agent (e.g. goose:<uuid>).",
});

const openApiDocument = (
  defaultListLimit: number,
  maxListLimit: number,
): Record<string, unknown> => {
  const queryProps = properties(ApiListQuery);
  return {
    openapi: "3.1.0",
    info: {
      title: "glv API",
      version: "1.0.0",
      summary: "Drive and monitor glv sessions from scripts and CI.",
      description:
        "Authentication is an API-token bearer on every path " +
        "(Authorization: Bearer glv_at_…); GET also accepts the browser " +
        "session cookie, POST accepts the bearer only. Live monitoring " +
        "rides the Server-Sent Events routes /sessions/{id}/events and " +
        "/events/status with the same bearer header. Destructive " +
        "operations (archive, delete) and every management surface " +
        "(tokens, cron, prompts, groups) stay in the browser.",
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
        Session: component(ApiSession),
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
      },
    },
    paths: {
      "/api/sessions": {
        get: {
          summary: "List sessions (newest first)",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: queryProps.limit,
              description: `Rows to return (1–${maxListLimit}; default ${defaultListLimit}).`,
            },
            {
              name: "offset",
              in: "query",
              schema: queryProps.offset,
              description: "Rows to skip, for pagination (default 0).",
            },
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
            "when the run completes; poll GET /api/sessions/{id} or " +
            "subscribe to the session's SSE feed for progress.",
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
          parameters: [sessionParam()],
          responses: {
            "200": jsonResponse("The session row and its parsed messages.", {
              type: "object",
              properties: {
                session: ref("Session"),
                messages: {
                  type: "array",
                  description: "Parsed transcript messages, oldest first.",
                },
              },
              required: ["session", "messages"],
            }),
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
    },
  };
};

export { openApiDocument, parseListQuery };
