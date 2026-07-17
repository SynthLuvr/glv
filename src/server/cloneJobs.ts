import type { CloneJob } from "../gh.js";

// Upper bound on how long an unclaimed clone job is retained. Generous vs.
// ctx.pollTimeoutMs so legitimately slow clones survive, but finite so the
// map (and the orphaned goose run each entry pins) can't grow without limit
// when a user navigates away mid-clone.
const CLONE_JOB_TTL_MS = 5 * 60_000;

// Cadence of the background retention sweep started by createApp.
const CLONE_JOB_SWEEP_MS = 60_000;

// Reaps clone jobs older than maxAgeMs. A job whose goose run was enqueued but
// never claimed is stopped via onStop so the runner reaps the process and
// drops its registry entry instead of inheriting the leak. `now` is injected
// so the sweep is deterministic in tests without real timers.
const sweepCloneJobs = (
  cloneJobs: Map<string, CloneJob>,
  maxAgeMs: number,
  onStop: (tempKey: string) => void,
  now: number = Date.now(),
): void => {
  const expired = [...cloneJobs.values()].filter(
    (job) => now - job.createdAt >= maxAgeMs,
  );
  for (const job of expired) {
    if (job.tempKey !== undefined) onStop(job.tempKey);
    cloneJobs.delete(job.jobId);
  }
};

export { CLONE_JOB_SWEEP_MS, CLONE_JOB_TTL_MS, sweepCloneJobs };
