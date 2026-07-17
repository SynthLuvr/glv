import type { CloneJob } from "../gh.js";

// Clone jobs are only removed once their status poll reaches a terminal state,
// so a job abandoned mid-clone would otherwise live forever, each pinning an
// orphaned goose run. A sweep reaps stale entries to bound the leak.
const CLONE_JOB_TTL_MS = 5 * 60_000;
const CLONE_JOB_SWEEP_MS = 60_000;

// Drop jobs older than maxAgeMs. An enqueued-but-unclaimed run is stopped so
// the runner reaps its process. `now` is injected for deterministic tests.
const sweepCloneJobs = (
  cloneJobs: Map<string, CloneJob>,
  maxAgeMs: number,
  onStop: (tempKey: string) => void,
  now: number = Date.now(),
): void => {
  for (const job of cloneJobs.values()) {
    if (now - job.createdAt < maxAgeMs) continue;
    if (job.tempKey !== undefined) onStop(job.tempKey);
    cloneJobs.delete(job.jobId);
  }
};

export { CLONE_JOB_SWEEP_MS, CLONE_JOB_TTL_MS, sweepCloneJobs };
