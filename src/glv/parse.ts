import { ArkErrors, type Type, type } from "arktype";
import { Err, mayFail, Ok, type Result } from "ts-handling";

// Callers feed this text that may not be JSON at all — `gh`/`git` can exit
// 0 with an update notice or help text on stdout. Parse failures come back
// as an Err the caller can degrade on, instead of a throw; the schema then
// checks the parsed value, so an Err covers "not JSON" and "wrong shape".
const parseJson = (raw: string, schema: Type): Result<unknown, string> => {
  const data = mayFail(() => JSON.parse(raw));
  if (!data.ok) return Err(data.error);

  const parsed = schema(data.data);
  return parsed instanceof ArkErrors ? Err(parsed.summary) : Ok(parsed);
};

// Permissive schema for callers that accept any JSON value and narrow it
// themselves.
const AnyJson = type("unknown");

// "object" also admits arrays, so callers wanting a true record narrow
// afterwards with isRecord.
const JsonObject = type("object");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export { AnyJson, isRecord, JsonObject, parseJson };
