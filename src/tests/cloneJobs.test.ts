import { describe, expect, it, vi } from "vitest";
import type { CloneJob } from "../gh.js";
import { sweepCloneJobs } from "../server/cloneJobs.js";

const makeJob = (overrides: Partial<CloneJob> = {}): CloneJob => ({
  jobId: "clone_1",
  repo: "owner/repo",
  branch: "main",
  clonePath: "/tmp/glv/owner/repo",
  prompt: "hi",
  status: "done",
  error: undefined,
  tempKey: undefined,
  known: undefined,
  runStartedAt: undefined,
  createdAt: 1000,
  ...overrides,
});

describe("sweepCloneJobs", () => {
  it("removes jobs older than the TTL and keeps younger ones", () => {
    const old = makeJob({ jobId: "old", createdAt: 0 });
    const young = makeJob({ jobId: "young", createdAt: 4500 });
    const jobs = new Map<string, CloneJob>([
      ["old", old],
      ["young", young],
    ]);
    sweepCloneJobs(jobs, 1000, vi.fn(), 5000);
    expect(jobs.has("old")).toBe(false);
    expect(jobs.has("young")).toBe(true);
  });

  it("stops the orphaned goose run of an expired job", () => {
    const onStop = vi.fn();
    const job = makeJob({ jobId: "j", createdAt: 0, tempKey: "temp_abc" });
    const jobs = new Map<string, CloneJob>([["j", job]]);
    sweepCloneJobs(jobs, 1000, onStop, 5000);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("temp_abc");
    expect(jobs.has("j")).toBe(false);
  });

  it("does not call stop for a job whose run was never enqueued", () => {
    const onStop = vi.fn();
    const job = makeJob({ jobId: "j", createdAt: 0, tempKey: undefined });
    const jobs = new Map<string, CloneJob>([["j", job]]);
    sweepCloneJobs(jobs, 1000, onStop, 5000);
    expect(onStop).not.toHaveBeenCalled();
    expect(jobs.has("j")).toBe(false);
  });

  it("leaves non-expired jobs and their runs untouched", () => {
    const onStop = vi.fn();
    const job = makeJob({
      jobId: "j",
      createdAt: 4500,
      tempKey: "temp_xyz",
    });
    const jobs = new Map<string, CloneJob>([["j", job]]);
    sweepCloneJobs(jobs, 1000, onStop, 5000);
    expect(onStop).not.toHaveBeenCalled();
    expect(jobs.has("j")).toBe(true);
  });

  it("reaps multiple expired jobs in one pass", () => {
    const onStop = vi.fn();
    const jobs = new Map<string, CloneJob>([
      ["a", makeJob({ jobId: "a", createdAt: 0, tempKey: "ta" })],
      ["b", makeJob({ jobId: "b", createdAt: 10, tempKey: undefined })],
      ["c", makeJob({ jobId: "c", createdAt: 4500 })],
    ]);
    sweepCloneJobs(jobs, 1000, onStop, 5000);
    expect(jobs.has("a")).toBe(false);
    expect(jobs.has("b")).toBe(false);
    expect(jobs.has("c")).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("ta");
  });
});
