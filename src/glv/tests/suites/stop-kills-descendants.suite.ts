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

const runStopKillsDescendantsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

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

  const startRun = (prompt: string): Promise<Response> =>
    authedFetch(env, `/sessions/${fx.viewId("tree-1")}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
      headers: { "HX-Request": "true" },
    });

  beforeAll(async () => {
    // A silent, long-lived agent that forks a descendant: the run stays
    // alive until the stop lands, and the behaviour records the child's
    // pid so the suite can watch the whole tree die.
    env = await fx.startEnv("glv-stop-tree-", {
      behaviour: { delayMs: 30000, spawnChild: true },
    });
    const workingDir = join(env.scratchDir, "d");
    mkdirSync(workingDir, { recursive: true });
    fx.seedSessions(env, [{ id: "tree-1", name: "Tree Kill", workingDir }]);
    fx.seedMessages(env, "tree-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  }, 120000);

  afterAll(async () => {
    // No reaping safety net: the descendant bounds its own lifetime (the
    // behaviour's default), and a kill-by-pid net could terminate an
    // unrelated process on Windows, where pids are recycled.
    await env?.cleanup();
  });

  describe("session stop reaps the whole process tree", () => {
    it(`kills a descendant spawned by ${fx.name} when the session is stopped`, async () => {
      await startRun("spawn a child please");

      const pid = (await waitForAgentRun(env, fx.resumeFlag))?.childPid ?? 0;
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(true);

      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("tree-1")}/stop`,
        {
          method: "POST",
          headers: { "HX-Request": "true" },
        },
      );
      expect(res.status).toBe(200);

      // killDescendants reaps the whole tree, so the orphaned descendant dies.
      const killDeadline = Date.now() + 8000;
      while (Date.now() < killDeadline && isAlive(pid)) await delay(100);
      expect(isAlive(pid)).toBe(false);
    }, 30000);
  });
};

export { runStopKillsDescendantsSuite };
