import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
  waitForAgentRun,
} from "../harness.js";

// The startup-failure story: an agent run that dies or stalls before its
// first output line used to leave a permanently empty session — stderr
// discarded, no diagnostic anywhere, the handle parked in "running"
// forever holding a concurrency slot. The runner now keeps a bounded
// stderr tail, kills silently-stalled starts through a startup watchdog,
// persists run-terminal errors like provider refusals, and logs every
// spawn/exit. Both failure shapes are driven through the scripted mock
// agent (a crashing run that prints to stderr, a silent one that never
// speaks) and asserted over HTTP.

const runStartupFailureSuite = (fx: FlavorFixture): void => {
  let envCrash: IntegrationEnv;
  let envStall: IntegrationEnv;

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

  const startRun = (
    e: IntegrationEnv,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    authedFetch(e, `/sessions/${fx.viewId(id)}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
      headers: { "HX-Request": "true" },
    });

  const seedSession = (e: IntegrationEnv, id: string, name: string): void => {
    const workingDir = join(e.scratchDir, "w");
    mkdirSync(workingDir, { recursive: true });
    fx.seedSessions(e, [{ id, name, workingDir }]);
    fx.seedMessages(e, id, [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  };

  const statusEvents = (events: { event: string; data: string }[]) =>
    events.filter((e) => e.event === "status").map((e) => parseSseData(e.data));

  const firstError = (
    events: { event: string; data: string }[],
  ): Record<string, unknown> | undefined =>
    statusEvents(events).find((data) => data.status === "error");

  // True once an error status followed a running status on this stream —
  // a freshly executed run failing, not the replayed baseline of an
  // earlier one.
  const sawRunFail = (events: { event: string; data: string }[]): boolean => {
    let running = false;
    for (const data of statusEvents(events))
      if (data.status === "running") running = true;
      else if (data.status === "error" && running) return true;

    return false;
  };

  const pageHtml = async (e: IntegrationEnv, id: string): Promise<string> => {
    const res = await authedFetch(e, `/sessions/${fx.viewId(id)}`);
    expect(res.status).toBe(200);
    return res.text();
  };

  // The error text only exists once the run settled; poll the rendered
  // page until the needle shows up (or the budget runs out).
  const waitForPageText = async (
    e: IntegrationEnv,
    id: string,
    needle: string,
    timeoutMs = 15000,
  ): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const html = await pageHtml(e, id);
      if (html.includes(needle)) return html;
      if (Date.now() > deadline)
        throw new Error(
          `page for ${id} never contained ${JSON.stringify(needle)}; ` +
            `last seen: ${html.slice(0, 500)}`,
        );
      await delay(250);
    }
  };

  beforeAll(async () => {
    // A run that prints its abort reason to stderr and dies — the shape
    // repro B substitutes for the agent binary.
    envCrash = await fx.startEnv("glv-fail-crash-", {
      behaviour: {
        stderr: ["fatal: memory allocation of 1342177280 bytes failed"],
        exitCode: 134,
      },
    });
    // A run that starts, says nothing, and lives on — the shape repro A
    // gets from a hung extension. The watchdog deadline is shrunk from
    // the 300s default so the suite observes the kill quickly; the mock
    // bounds its own lifetime (45s) as a safety net.
    envStall = await fx.startEnv(
      "glv-fail-stall-",
      { behaviour: { delayMs: 45_000 } },
      undefined,
      { GLV_STARTUP_TIMEOUT_MS: "2500" },
    );
    seedSession(envCrash, "crash-1", "Crash");
    seedSession(envStall, "stall-1", "Stall");
  }, 120000);

  afterAll(async () => {
    await envCrash?.cleanup();
    await envStall?.cleanup();
  });

  describe("agent dies at startup (terminating run)", () => {
    it("carries the exit verdict and the stderr tail on the status stream", async () => {
      const stream = collectSse(
        envCrash,
        `/sessions/${fx.viewId("crash-1")}/events`,
        (evs) => firstError(evs) !== undefined,
        15000,
      );
      const res = await startRun(envCrash, "crash-1", "die at startup please");
      expect(res.status).toBe(200);
      const error = firstError(await stream);
      expect(error?.error).toContain("exited with code 134");
      expect(error?.error).toContain("last stderr");
      expect(error?.error).toContain(
        "fatal: memory allocation of 1342177280 bytes failed",
      );
    });

    it("logs run spawn and exit to the server log", async () => {
      const out = envCrash.serverStdout();
      expect(out).toContain(
        `run: ${fx.name} session ${fx.viewId("crash-1")} started (pid `,
      );
      expect(out).toContain(
        `run: ${fx.name} session ${fx.viewId("crash-1")} ended (pid `,
      );
      expect(out).toContain("exit code 134");
    });

    it("explains the crash on the session page and after a restart", async () => {
      const html = await waitForPageText(
        envCrash,
        "crash-1",
        "exited with code 134",
      );
      expect(html).toContain("fatal: memory allocation");
      await envCrash.restart();
      const after = await pageHtml(envCrash, "crash-1");
      expect(after).toContain("exited with code 134");
      expect(after).toContain("fatal: memory allocation");
      expect(after).toContain("Run stopped early");
    });
  });

  describe("agent stalls silently at startup (watchdog)", () => {
    it("fails the run with a diagnostic and kills the agent process", async () => {
      const stream = collectSse(
        envStall,
        `/sessions/${fx.viewId("stall-1")}/events`,
        (evs) => firstError(evs) !== undefined,
        20000,
      );
      const res = await startRun(envStall, "stall-1", "hang silently please");
      expect(res.status).toBe(200);
      const call = await waitForAgentRun(envStall, fx.resumeFlag, 15000);
      const pid = call?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      const error = firstError(await stream);
      expect(error?.error).toContain(`${fx.name} run on session`);
      expect(error?.error).toContain("produced no output within 2.5s");
      expect(error?.error).toContain("was killed");

      // SIGTERM (SIGKILL after the grace window) reaps the stalled agent.
      const killDeadline = Date.now() + 10000;
      while (Date.now() < killDeadline && isAlive(pid)) await delay(200);
      expect(isAlive(pid)).toBe(false);
    }, 45000);

    it("releases the runner slot: the next prompt runs and fails again", async () => {
      const stream = collectSse(
        envStall,
        `/sessions/${fx.viewId("stall-1")}/events`,
        (evs) => sawRunFail(evs),
        20000,
      );
      const res = await startRun(envStall, "stall-1", "and again please");
      expect(res.status).toBe(200);
      await stream;
      const html = await waitForPageText(
        envStall,
        "stall-1",
        "produced no output",
      );
      expect(html).toContain("Run stopped early");
    }, 45000);

    it("keeps the watchdog diagnostic across a restart", async () => {
      await envStall.restart();
      const after = await pageHtml(envStall, "stall-1");
      expect(after).toContain("produced no output within 2.5s");
      expect(after).toContain("was killed");
    }, 30000);
  });
};

export { runStartupFailureSuite };
