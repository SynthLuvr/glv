import { mayFail, type Result } from "ts-handling";

// Callers feed this text that may not be JSON at all — `gh`/`git` can exit
// 0 with an update notice or help text on stdout. Parse failures come back
// as an Err the caller can degrade on, instead of a throw.
const parseJson = <T = unknown>(raw: string): Result<T, string> =>
  mayFail(() => JSON.parse(raw) as T);

export { parseJson };
