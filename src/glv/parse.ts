import { ArkErrors, type distill, type Type, type } from "arktype";
import { Err, mayFail, Ok, type Result } from "ts-handling";

// Callers feed this text that may not be JSON at all — `gh`/`git` can exit
// 0 with an update notice or help text on stdout. Both parse and validation
// failures come back as an Err the caller can degrade on, instead of a
// throw. The Ok data is the schema's own inferred output — nothing is cast:
// distill.Out is arktype's type for what a Type<T> returns once morphs run.
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

// Any JSON object. Arrays pass too, mirroring `typeof`-based checks like
// isRecord.
const JsonObject = type({ "[string]": "unknown" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export { AnyJson, isRecord, JsonObject, parseJson };
