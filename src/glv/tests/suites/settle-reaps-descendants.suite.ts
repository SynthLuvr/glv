import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  waitForAgentRun,
} from "../harness.js";

// #379: killDescendants only fires inside kill(), so a run whose agent
// died on its own — crash, SIGKILL, host memory pressure — leaked its
// descendants into glv's process group forever; a clean finish leaked
// them too, just less often. The runner now signals the agent's process
// group once after every settle, whatever the reason. This suite pins
// both halves: the unclean death (the incident's mechanism) and the
// clean finish.
//
// POSIX-only (see WINDOWS_EXCLUDED_SUITES in vitest.config.ts): execa
// no-ops a settled kill on Windows — no process groups.
const runSettleReapsDescendantsSuite = (fx: FlavorFixture): void => {
  let crash: IntegrationEnv;
  let finish: IntegrationEnv;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Signal 0 probes liveness without actually delivering a signal.
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const startRun = (env: IntegrationEnv, prompt: string): Promise<Response> =>
    authedFetch(env, `/sessions/${fx.viewId("tree-1")}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
      headers: { "HX-Request": "true" },
    });

  // Polls until the pid dies; false on timeout, so the assertion names
  // the survivor instead of the poll.
  const waitForDeath = async (pid: number, deadlineMs: number) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline && isAlive(pid)) await delay(100);
    return !isAlive(pid);
  };

  beforeAll(async () => {
    // A silent long-lived agent (for the unclean death) and a fast one
    // (for the clean finish); both descendants bound their own lifetime,
    // so a reap the code somehow misses cannot outlive the suite.
    crash = await fx.startEnv("glv-settle-crash-", {
      behaviour: { delayMs: 30000, spawnChild: true },
    });
    finish = await fx.startEnv("glv-settle-finish-", {
      behaviour: { spawnChild: true, stdout: [fx.streamLine(fx.mockReply)] },
    });
    for (const env of [crash, finish]) {
      const workingDir = join(env.scratchDir, "d");
      mkdirSync(workingDir, { recursive: true });
      fx.seedSessions(env, [{ id: "tree-1", name: "Settle Reap", workingDir }]);
      fx.seedMessages(env, "tree-1", [
        { role: "user", content: [{ type: "text", text: "seed" }] },
      ]);
    }
  }, 240000);

  afterAll(async () => {
    await crash?.cleanup();
    await finish?.cleanup();
  });

  describe("settle-time process-tree reaping", () => {
    it(`reaps the descendant of a ${fx.name} run killed uncleanly mid-flight`, async () => {
      const res = await startRun(crash, "spawn a child, then crash");
      expect(res.status).toBe(200);

      const call = await waitForAgentRun(crash, fx.resumeFlag);
      const pid = call?.pid ?? 0;
      const childPid = call?.childPid ?? 0;
      expect(pid).toBeGreaterThan(0);
      expect(childPid).toBeGreaterThan(0);
      expect(isAlive(childPid)).toBe(true);

      // The incident's mechanism: the agent dies on its own, with no
      // glv kill path involved. Nothing but the settle-time sweep can
      // take the descendant down.
      process.kill(pid, "SIGKILL");
      expect(await waitForDeath(pid, 10000)).toBe(true);

      // The group signal lands at settle; SIGKILL escalation would
      // follow within the reap grace (5 s) were the child to trap.
      expect(await waitForDeath(childPid, 10000)).toBe(true);
    }, 45000);

    it(`reaps the descendant when a ${fx.name} run finishes cleanly`, async () => {
      const res = await startRun(finish, "spawn a child, then finish");
      expect(res.status).toBe(200);

      const call = await waitForAgentRun(finish, fx.resumeFlag);
      const childPid = call?.childPid ?? 0;
      expect(childPid).toBeGreaterThan(0);

      // The run settles by exiting 0; the descendant would happily live
      // on (its own bounded lifetime is 120 s) without the sweep.
      expect(await waitForDeath(childPid, 10000)).toBe(true);
    }, 45000);
  });
};

export { runSettleReapsDescendantsSuite };
