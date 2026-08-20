import { readdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
} from "../harness.js";

// Archiving a session used to sweep its temp working dir and uploads out
// from under a still-running agent. The archive route must stop the run
// first; this suite observes the runner status over the session's own SSE
// stream and checks the temp dir sweep afterwards.
const runArchiveStopsRunSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const subdirCount = (base: string): number =>
    readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
      .length;

  beforeAll(async () => {
    env = await fx.startEnv("glv-archstop-", {
      sleepMs: 120000,
      sessionName: "Archive Stop",
    });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("archive stops an active run", () => {
    it(`stops the ${fx.name} run before sweeping its temp working dir`, async () => {
      const tempBefore = subdirCount(env.tempDir);

      const form = new FormData();
      form.append("prompt", "long running work");
      form.append("session_mode", "temp");
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      const sessionId = /data-session-id="([^"]+)"/.exec(html)?.[1];
      expect(sessionId).toBeTruthy();
      expect(subdirCount(env.tempDir)).toBeGreaterThan(tempBefore);

      // Subscribe to the session stream, then archive mid-run: the run
      // must transition to "stopped" (not keep streaming into a deleted
      // working dir) and the temp dir must be swept.
      const streamPromise = collectSse(
        env,
        `/sessions/${sessionId}/events`,
        (seen) =>
          seen.some(
            (e) =>
              e.event === "status" && parseSseData(e.data).status === "stopped",
          ),
        15000,
      );

      const archiveRes = await authedFetch(
        env,
        `/sessions/${sessionId}/archive`,
        { method: "POST" },
      );
      expect(archiveRes.status).toBe(200);

      const stopped = await streamPromise;
      expect(
        stopped.some(
          (e) =>
            e.event === "status" && parseSseData(e.data).status === "stopped",
        ),
      ).toBe(true);

      const killDeadline = Date.now() + 8000;
      while (Date.now() < killDeadline && subdirCount(env.tempDir) > tempBefore)
        await new Promise((resolve) => setTimeout(resolve, 200));
      expect(subdirCount(env.tempDir)).toBe(tempBefore);
    }, 40000);
  });
};

export { runArchiveStopsRunSuite };
