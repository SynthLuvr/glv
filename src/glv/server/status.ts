import type { Runner, RunStatus } from "../runner/index.js";
import { getHandle, isTerminalStatus } from "../runner/index.js";

// Terminal handles linger in the registry; this filters them out so the
// sidebar only shows sessions that are queued or running.
const activeStatuses = (runner: Runner): Map<string, RunStatus> =>
  new Map(
    [...runner.registry.entries()]
      .filter(([, h]) => !isTerminalStatus(h.status))
      .map(([id, h]) => [id, h.status]),
  );

const activeSessionIds = (runner: Runner): Set<string> =>
  new Set(activeStatuses(runner).keys());

// The run status the REST read paths project onto a session row: the
// runner's own status while a handle exists — "queued" or "running",
// or the terminal status that lingers terminalRetentionMs after a run
// settles so a polling client sees how it ended — and "idle" once no
// handle remains. The same vocabulary the session's SSE stream emits,
// so both surfaces answer with one set of strings.
const sessionRunStatus = (runner: Runner, id: string): RunStatus | "idle" =>
  getHandle(runner, id)?.status ?? "idle";

// The whole registry's statuses (terminal ones included, unlike
// activeStatuses), so a listing can decorate every row with one snapshot.
const sessionRunStatuses = (runner: Runner): Map<string, RunStatus> =>
  new Map([...runner.registry].map(([id, h]) => [id, h.status]));

// The statuses the status feed emits: a live run state, or "done" for a
// session that just left the active set.
type FeedStatus = RunStatus | "done";

const statusDeltas = (
  last: Map<string, RunStatus>,
  now: Map<string, RunStatus>,
): Array<[string, FeedStatus]> => {
  const result: Array<[string, FeedStatus]> = [];
  for (const [id, status] of now)
    if (last.get(id) !== status) result.push([id, status]);
  for (const [id] of last) if (!now.has(id)) result.push([id, "done"]);
  return result;
};

const nameDeltas = (
  last: Map<string, string>,
  now: Map<string, string>,
): Array<[string, string]> => {
  const result: Array<[string, string]> = [];
  for (const [id, name] of now)
    if (last.get(id) !== name) result.push([id, name]);
  return result;
};

export {
  activeSessionIds,
  activeStatuses,
  nameDeltas,
  sessionRunStatus,
  sessionRunStatuses,
  statusDeltas,
};
