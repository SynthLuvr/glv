import { ArkErrors, type distill, type Type, type } from "arktype";
import { Err, mayFail, Ok, type Result } from "ts-handling";

// Any JSON value — the default for callers that narrow the result
// themselves.
const AnyJson = type("unknown");

// Matches typeof-style record guards: any non-null object passes, arrays
// included.
const JsonObject = type({ "[string]": "unknown" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The input is often not JSON at all — `gh`/`git` can exit 0 with an update
// notice or help text on stdout — so parse and validation failures come
// back as an Err the caller can degrade on, instead of a throw.
function parseJson(raw: string): Result<unknown, string>;
function parseJson<T>(
  raw: string,
  schema: Type<T>,
): Result<distill.Out<T>, string>;
function parseJson(
  raw: string,
  schema: Type<unknown> = AnyJson,
): Result<unknown, string> {
  const data = mayFail(() => JSON.parse(raw));
  if (!data.ok) return Err(data.error);

  const parsed = schema(data.data);
  return parsed instanceof ArkErrors ? Err(parsed.summary) : Ok(parsed);
}

export { isRecord, JsonObject, parseJson };
