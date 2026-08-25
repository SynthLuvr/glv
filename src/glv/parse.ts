import { type Type, type } from "arktype";
import { mayFail, type Result } from "ts-handling";

// Callers feed this text that may not be JSON at all — `gh`/`git` can exit
// 0 with an update notice or help text on stdout. Both parse and validation
// failures come back as an Err the caller can degrade on, instead of a
// throw.
const parseJson = <T>(raw: string, schema: Type<T>): Result<T, string> =>
  // The cast only settles arktype's generic output type — these schemas are
  // pure validators, so assert returns its input unchanged.
  mayFail(() => schema.assert(JSON.parse(raw)) as T);

// Permissive schema for callers that accept any JSON value and narrow it
// themselves.
const AnyJson = type("unknown");

// Any JSON object. Arrays pass too, mirroring `typeof`-based checks like
// isRecord.
const JsonObject = type({ "[string]": "unknown" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export { AnyJson, isRecord, JsonObject, parseJson };
