import type { Runner, RunStatus } from "../runner/index.js";
import { isTerminalStatus } from "../runner/index.js";

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

const statusDeltas = (
  last: Map<string, RunStatus>,
  now: Map<string, RunStatus>,
): Array<[string, string]> => {
  const result: Array<[string, string]> = [];
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

export { activeSessionIds, activeStatuses, nameDeltas, statusDeltas };
