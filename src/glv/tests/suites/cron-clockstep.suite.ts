import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  cronJobRow,
  type FlavorFixture,
  type IntegrationEnv,
  seedCronJobRow,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls predicate every 250ms until it holds or the deadline passes;
// resolves to whether it ever held.
const pollUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(250);
  }
  return false;
};

// The mock agent writes its capture files asynchronously, trailing the
// fire that caused them; poll until one exists with content.
const waitForContent = async (
  path: string,
  timeoutMs = 10_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      if (content !== "") return content;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for content in ${path}`);
};

// Counts a session-name's occurrences in the sidebar markup (each
// rendered session spells its name exactly once — same technique as the
// other cron suites).
const countSessions = async (
  env: IntegrationEnv,
  sessionName: string,
): Promise<number> => {
  const res = await authedFetch(env, "/");
  const html = await res.text();
  return html.split(`class="session-name">${sessionName}<`).length - 1;
};

// How far ahead of boot the one-shot's moment sits. Long enough that
// even a slow, contended boot still leaves the scheduler arming timers
// before the occurrence (a boot slower than the harness's own 60s HTTP
// deadline fails before this suite's assertions run); short enough that
// the whole case fits inside vitest's 120s per-test ceiling.
const LEAD_MS = 65_000;

// The test stays silent this long past the scheduled instant before it
// starts observing: any request made inside the final ~31s window would
// interleave the server's own clock reads with the scheduler's arming
// reads, and the simulated step could land on an unrelated read pair.
const QUIET_AFTER_TARGET_MS = 6_000;

const preloadPath = fileURLToPath(
  new URL("../cron-clockstep-preload.cjs", import.meta.url),
);

// A forward clock step across a scheduled instant (WSL2 host resyncs,
// NTP corrections — issue #272) must not lose the occurrence: croner
// 10.0.1 derived its timer delay and its trigger target from two
// separate clock reads, so a step crossing the instant between them
// made it re-arm for the next occurrence without ever firing — no log,
// no error, the run gone until the next restart's catch-up. The preload
// injects exactly that step inside the real serve process, between
// croner's arming reads, and this suite asserts the one-shot still
// fires: session started, prompt delivered, marker recorded, row
// retired. Everything but the wall clock is the production path — real
// serve, real scheduler, real agent spawn, real stores.
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
      // A whole-second instant 65s out, spelled as an exact UTC one-shot
      // so the marker a fire records compares equal to the target.
      targetMs = Math.ceil((Date.now() + LEAD_MS) / 1000) * 1000;
      const schedule = `${new Date(targetMs).toISOString().slice(0, 19)}Z`;
      env = await fx.startEnv(
        "glv-clockstep-",
        { sessionName: "Clockstep Run", captureStdin: stdinCapture },
        homeDir,
        {
          // The clock-step preload rides NODE_OPTIONS into the serve
          // process — the same channel the harness already uses for its
          // subprocess-coverage observer, whose inherited value is
          // preserved here.
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

    it("still fires the occurrence croner's arming race would skip", async () => {
      // Quiet until the instant has passed (see QUIET_AFTER_TARGET_MS).
      await sleep(Math.max(targetMs - Date.now() + QUIET_AFTER_TARGET_MS, 0));

      // The fire records its missed-run marker before anything is
      // awaited, and the one-shot's row is retired once its run is
      // established — either observation proves the occurrence fired.
      let marker: string | undefined;
      const fired = await pollUntil(() => {
        const row = cronJobRow(env.dbs.cronDb, "clockstep-once");
        if (row === undefined) return true;
        if (row.lastFiredAt !== undefined && row.lastFiredAt !== null) {
          marker = row.lastFiredAt;
          return true;
        }
        return false;
      }, 25_000);
      const injected = env.serverStderr().includes("[clockstep]");
      expect(
        fired,
        "the scheduled occurrence never fired — silently skipped by " +
          `the forward clock step (step injected: ${injected})`,
      ).toBe(true);

      // It was a live fire serving exactly the scheduled instant — not a
      // boot-time catch-up (which would log "firing missed run" and, on
      // the buggy scheduler, is the only way this suite could pass).
      expect(env.serverStdout()).not.toContain("firing missed run");
      if (marker !== undefined) expect(Date.parse(marker)).toBe(targetMs);

      // The fire ran the job for real: a session in the sidebar, the
      // job's prompt on the agent's stdin, and the scheduler's own
      // event line on stdout.
      expect(
        await pollUntil(
          async () => (await countSessions(env, "Clockstep Run")) > 0,
          10_000,
        ),
        "no session was created for the fired run",
      ).toBe(true);
      expect(await waitForContent(stdinCapture)).toContain(
        "Clockstep probe prompt",
      );
      expect(env.serverStdout()).toContain(
        'cron job "clockstep-once" step 1/1 started session',
      );

      // And the one-shot retired itself, as every fired one-shot does.
      expect(
        await pollUntil(
          () => cronJobRow(env.dbs.cronDb, "clockstep-once") === undefined,
          10_000,
        ),
        "the fired one-shot was not retired",
      ).toBe(true);
    });
  });
};

export { runCronClockStepSuite };
