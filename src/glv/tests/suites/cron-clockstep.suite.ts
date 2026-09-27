import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { countSessions, pollUntil, sleep } from "../cron-helpers.js";
import {
  cronJobRow,
  type FlavorFixture,
  type IntegrationEnv,
  seedCronJobRow,
} from "../harness.js";

// The one-shot's distance from boot. Even a slow, contended boot still
// leaves the scheduler arming timers before the occurrence — and a boot
// slower than the harness's own 60s HTTP deadline fails the suite
// before any assertion runs. Short enough that the whole case fits
// vitest's 120s per-test ceiling.
const LEAD_MS = 65_000;

// The test stays silent this long past the scheduled instant before it
// observes anything: a request inside the final 31s window could pair
// its own clock reads close enough to land the simulated step on an
// unrelated read pair.
const QUIET_AFTER_TARGET_MS = 6_000;

const preloadPath = fileURLToPath(
  new URL("../cron-clockstep-preload.cjs", import.meta.url),
);

// Issue #272: croner 10.0.1 derived its timer delay and its trigger
// target from two separate clock reads, so a forward clock step (NTP
// correction, WSL2 host resync) crossing the scheduled instant between
// them made it re-arm for the next occurrence without ever firing —
// no log, no error. The preload injects exactly that step inside a
// real serve process, between croner's arming reads; this suite
// asserts the occurrence still fires on the production path.
const runCronClockStepSuite = (fx: FlavorFixture): void => {
  describe("a forward clock step across the scheduled instant", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workingDir: string;
    let stdinCapture: string;
    let targetMs = 0;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-clockstep-home-"));
      workingDir = mkdtempSync(join(tmpdir(), "glv-clockstep-work-"));
      stdinCapture = join(homeDir, "stdin-capture.txt");
      // A whole-second instant LEAD_MS out, spelled as an exact UTC
      // one-shot so the marker a fire records compares equal to it.
      targetMs = Math.ceil((Date.now() + LEAD_MS) / 1000) * 1000;
      const schedule = `${new Date(targetMs).toISOString().slice(0, 19)}Z`;
      env = await fx.startEnv(
        "glv-clockstep-",
        { sessionName: "Clockstep Run", captureStdin: stdinCapture },
        homeDir,
        {
          // The preload rides NODE_OPTIONS into serve — the same
          // channel as the harness's subprocess-coverage observer,
          // whose inherited value is preserved.
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${preloadPath}`]
            .filter(Boolean)
            .join(" "),
          GLV_CLOCKSTEP_TARGET_MS: String(targetMs),
        },
        ({ cronDb }) =>
          seedCronJobRow(cronDb, {
            name: "clockstep-once",
            schedule,
            prompt: "Clockstep probe prompt",
            workingDir,
            enabled: true,
            lastFiredAt: null,
          }),
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    });

    it("still fires the occurrence the arming race would skip", async () => {
      // Quiet until the instant has passed (see QUIET_AFTER_TARGET_MS).
      await sleep(targetMs + QUIET_AFTER_TARGET_MS - Date.now());

      // The fire stamps the row's marker before the run retires the
      // one-shot's row, so the marker is captured mid-poll; either a
      // stamped or a retired row proves the occurrence fired.
      let marker: string | undefined;
      const fired = await pollUntil(() => {
        const row = cronJobRow(env.dbs.cronDb, "clockstep-once");
        if (row === undefined) return true;
        marker = row.lastFiredAt ?? undefined;
        return marker !== undefined;
      }, 25_000);
      const injected = env.serverStderr().includes("[clockstep]");
      expect(
        fired,
        "the scheduled occurrence never fired — silently skipped by " +
          `the forward clock step (step injected: ${injected})`,
      ).toBe(true);

      // A live fire serving exactly the scheduled instant — not a
      // boot-time catch-up, the only way a buggy scheduler passes.
      expect(env.serverStdout()).not.toContain("firing missed run");
      if (marker !== undefined) expect(Date.parse(marker)).toBe(targetMs);

      // The fire ran the job for real: a session in the sidebar, the
      // job's prompt on the agent's stdin, the scheduler's event line.
      expect(
        await pollUntil(
          async () => (await countSessions(env, "Clockstep Run")) >= 1,
          10_000,
        ),
      ).toBe(true);
      const capturedStdin = (): string =>
        existsSync(stdinCapture) ? readFileSync(stdinCapture, "utf-8") : "";
      expect(
        await pollUntil(
          () => capturedStdin().includes("Clockstep probe prompt"),
          10_000,
        ),
      ).toBe(true);
      expect(env.serverStdout()).toContain(
        'cron job "clockstep-once" step 1/1 started session',
      );

      // The fired one-shot retires itself, as every fired one-shot does.
      expect(
        await pollUntil(
          () => cronJobRow(env.dbs.cronDb, "clockstep-once") === undefined,
          10_000,
        ),
      ).toBe(true);
    });
  });
};

export { runCronClockStepSuite };
