import { mayFail, type Result } from "ts-handling";

// `gh`/`git` may exit 0 with non-JSON stdout (an update notice or help
// text). A Result keeps that failure explicit and carries the parse error
// to the caller instead of collapsing every failure to `null`, so callers
// can log or surface why a payload was rejected.
const parseJson = <T = unknown>(raw: string): Result<T, string> =>
  mayFail(() => JSON.parse(raw) as T);

export { parseJson };
