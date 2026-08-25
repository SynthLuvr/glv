import { ArkErrors, type distill, type Type, type } from "arktype";
import { Err, mayFail, Ok, type Result } from "ts-handling";

// The input is often not JSON at all — `gh`/`git` can exit 0 with an update
// notice or help text on stdout — so parse and validation failures come
// back as an Err the caller can degrade on, instead of a throw.
const parseJson = <T>(
  raw: string,
  schema: Type<T>,
): Result<distill.Out<T>, string> => {
  const data = mayFail(() => JSON.parse(raw));
  if (!data.ok) return Err(data.error);

  const parsed = schema(data.data);
  return parsed instanceof ArkErrors ? Err(parsed.summary) : Ok(parsed);
};

// Permissive schema for callers that accept any JSON value and narrow it
// themselves.
const AnyJson = type("unknown");

// Matches typeof-style record guards: any non-null object passes, arrays
// included.
const JsonObject = type({ "[string]": "unknown" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export { AnyJson, isRecord, JsonObject, parseJson };
