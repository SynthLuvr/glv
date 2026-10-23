import {
  createServeRunDir,
  killRegisteredServes,
  RUN_DIR_ENV,
  sweepOrphanedServes,
  sweepStaleServes,
} from "./serve-registry.js";

// Vitest global setup for the serve registry (issue #360): reap what
// previous runs leaked — the registry sweep covers runs that recorded
// their serves, the orphan sweep the fleets leaked before the registry
// existed — then mint this run's registry directory and hand it to the
// forked workers through the environment. The returned teardown kills
// every serve this run left alive — the worker deaths that skip
// per-test cleanup are exactly the ones whose detached process groups
// would otherwise outlive the run.
const setup = async (): Promise<() => Promise<void>> => {
  await sweepStaleServes();
  await sweepOrphanedServes();
  const runDir = createServeRunDir();
  process.env[RUN_DIR_ENV] = runDir;
  return async () => {
    await killRegisteredServes(runDir);
  };
};

export { setup as default };
