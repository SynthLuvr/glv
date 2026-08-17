import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SessionRow } from "./sessions.js";

type EstablishOutcome =
  | { ok: true; sessionId: string; session: SessionRow }
  | { ok: false; status: ContentfulStatusCode; error: string };

// The new-session strategy, implemented per flavor. goose must discover the
// session id its agent chose (temp handle, poll, rekey); claude pre-assigns
// the id and waits for the transcript to appear. Routes drive this
// interface only, so the create-session flow is identical for both.
type SessionLauncher = {
  /** Enqueue the run and return an opaque handle for it. */
  readonly startNew: (workingDir: string, prompt: string) => string;
  /**
   * Resolve the run's real session id, or undefined when the agent did not
   * create one within the timeout.
   */
  readonly awaitNew: (
    handle: string,
    workingDir: string,
    timeoutMs: number,
  ) => Promise<string | undefined>;
  /**
   * Bind the handle to the real session id and confirm the session is
   * readable, stopping the run on failure. `conflictError` localises the
   * 409 copy ("directory" vs "repository"); strategies that cannot
   * conflict ignore it. Safe inside an existing withCreateLock task —
   * this never acquires the lock itself.
   */
  readonly establish: (
    handle: string,
    sessionId: string,
    conflictError: string,
  ) => EstablishOutcome;
};

// Serializes async tasks per key. The stored tail swallows rejections so one
// failure can't poison the chain.
const withCreateLock = <T>(
  locks: Map<string, Promise<void>>,
  key: string,
  task: () => T | Promise<T>,
): Promise<T> => {
  const tail = locks.get(key) ?? Promise.resolve();
  const run = tail.then(task, task);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

export type { EstablishOutcome, SessionLauncher };
export { withCreateLock };
