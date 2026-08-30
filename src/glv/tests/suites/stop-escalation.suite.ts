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

// A silent agent that traps SIGINT/SIGTERM used to park the runner's stdout
// drain forever: the escalation ladder only started after the drain, which a
// quiet process never ends. This suite pins the ladder to the whole run —
// stop() must eventually land SIGKILL even with no output flowing.
const runStopEscalationSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Signal 0 probes liveness without delivering a signal.
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    // An agent that ignores SIGINT/SIGTERM and never speaks; the behaviour
    // bounds its own lifetime, so a stop the ladder somehow misses cannot
    // outlive the suite.
    env = await fx.startEnv("glv-stop-esc-", {
      behaviour: { trapSignals: true },
    });
    const workingDir = join(env.scratchDir, "d");
    mkdirSync(workingDir, { recursive: true });
    fx.seedSessions(env, [{ id: "esc-1", name: "Escalation", workingDir }]);
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("stop escalation", () => {
    it(`kills ${fx.name} even when it ignores SIGINT/SIGTERM and goes silent`, async () => {
      const res = await authedFetch(env, "/sessions/esc-1/prompt", {
        method: "POST",
        body: new URLSearchParams({ prompt: "hang silently" }),
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);

      const pid = (await waitForAgentRun(env, fx.resumeFlag))?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(true);

      const stopRes = await authedFetch(env, "/sessions/esc-1/stop", {
        method: "POST",
        headers: { "HX-Request": "true" },
      });
      expect(stopRes.status).toBe(200);

      // stop() sends SIGINT (ignored by the trap); the ladder escalates to
      // SIGTERM at stopGraceMs (5s) and SIGKILL at 10s.
      const killDeadline = Date.now() + 20000;
      while (Date.now() < killDeadline && isAlive(pid)) await delay(200);
      expect(isAlive(pid)).toBe(false);
    }, 45000);
  });
};

export { runStopEscalationSuite };
