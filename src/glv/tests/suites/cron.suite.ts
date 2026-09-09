import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type CronJobRow,
  defaultCronDb,
  expectServeRefusal,
  type FlavorFixture,
  fakeHomeEnv,
  type IntegrationEnv,
  readCronJobRows,
  removeCronJobRow,
  seedCronJobRow,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls predicate every 500ms until it holds or the deadline passes;
// resolves to whether it ever held.
const pollUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(500);
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

const runCronSuite = (fx: FlavorFixture): void => {
  // Asserts serve refuses to start for the given rows, naming every
  // expected stderr fragment. The rows are seeded into the flavor's
  // default cron database before boot, so the scheduler's boot read is
  // what refuses.
  const expectServeRefuses = async (
    jobs: CronJobRow[],
    ...stderrContains: string[]
  ): Promise<void> => {
    const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
    const cronDb = defaultCronDb(homeDir, fx.binName);
    for (const job of jobs) seedCronJobRow(cronDb, job);
    const stderr = await expectServeRefusal(
      fx.binPath,
      ["serve", ...fx.defaultServeArgs(homeDir)],
      fakeHomeEnv(homeDir),
    );
    for (const fragment of stderrContains) expect(stderr).toContain(fragment);
    rmSync(homeDir, { recursive: true, force: true });
  };

  describe("scheduled sessions from the cron database", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workingDir: string;
    let stdinCapture: string;
    let cwdCapture: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-home-"));
      workingDir = mkdtempSync(join(tmpdir(), "glv-cron-work-"));
      stdinCapture = join(homeDir, "stdin-capture.txt");
      cwdCapture = join(homeDir, "cwd-capture.txt");
      env = await fx.startEnv(
        "glv-cron-",
        {
          sessionName: "Cron Session",
          captureStdin: stdinCapture,
          captureCwd: cwdCapture,
        },
        homeDir,
      );
      // Seeded straight into the database the server serves from; the
      // watch poll picks it up and the schedule applies live.
      seedCronJobRow(env.dbs.cronDb, {
        name: "every-second",
        schedule: "* * * * * *",
        prompt: "Scheduled check-in from cron",
        workingDir,
        enabled: true,
      });
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("starts a new session per fire with the job's prompt and working dir", async () => {
      // The job fires every second; poll the sidebar until a session lands.
      const deadline = Date.now() + 30_000;
      let html = "";
      while (Date.now() < deadline) {
        const res = await authedFetch(env, "/");
        html = await res.text();
        if (html.includes("Cron Session")) break;
        await sleep(500);
      }
      expect(html).toContain("Cron Session");

      // The agent received the job's prompt on stdin and ran in the job's
      // working directory — both captured by the mock agent process.
      const stdin = await waitForContent(stdinCapture);
      expect(stdin).toContain("Scheduled check-in from cron");
      const cwd = await waitForContent(cwdCapture);
      expect(cwd.trim()).toBe(workingDir);
    });
  });

  describe("disabled cron jobs", () => {
    let env: IntegrationEnv;

    beforeAll(async () => {
      env = await fx.startEnv("glv-cron-off-", {
        sessionName: "Disabled Session",
      });
      seedCronJobRow(env.dbs.cronDb, {
        name: "paused",
        schedule: "* * * * * *",
        prompt: "Should never run",
        workingDir: mkdtempSync(join(tmpdir(), "glv-cron-offdir-")),
        enabled: false,
      });
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("never fires a disabled job", async () => {
      // The schedule fires every second; three fire windows pass with
      // no run ever appearing in the sidebar.
      await sleep(3000);
      const res = await authedFetch(env, "/");
      const html = await res.text();
      expect(html).not.toContain("Disabled Session");
    });
  });

  describe("establishment timeout", () => {
    let env: IntegrationEnv;

    beforeAll(async () => {
      env = await fx.startEnv(
        "glv-cron-timeout-",
        { neverCreateSession: true },
        undefined,
        { GLV_CRON_SESSION_TIMEOUT_MS: "2000" },
      );
      seedCronJobRow(env.dbs.cronDb, {
        name: "never",
        schedule: "* * * * * *",
        prompt: "No session will appear",
        workingDir: mkdtempSync(join(tmpdir(), "glv-cron-todir-")),
        enabled: true,
      });
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("stops the run and logs when the agent never creates a session", async () => {
      // First fire ~1s after boot, then a 2s establishment window before
      // the failure lands on stderr.
      const deadline = Date.now() + 30_000;
      let stderr = "";
      while (Date.now() < deadline) {
        stderr = env.serverStderr();
        if (stderr.includes('cron job "never"')) break;
        await sleep(500);
      }
      expect(stderr).toContain('cron job "never"');
      expect(stderr).toContain("no session was created");
    });
  });

  describe("live reload from the cron database", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workingDir: string;
    let stdinCapture: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-live-"));
      workingDir = mkdtempSync(join(tmpdir(), "glv-cron-livework-"));
      stdinCapture = join(homeDir, "stdin-live.txt");
      env = await fx.startEnv(
        "glv-cron-live-",
        { sessionName: "Live Session", captureStdin: stdinCapture },
        homeDir,
        // Shrinks the watch poll so every row write below is picked up
        // quickly.
        { GLV_CRON_DB_POLL_MS: "250" },
      );
      // Seeded straight into the database the server serves from — an
      // external writer, exactly the case the poll exists for.
      seedCronJobRow(env.dbs.cronDb, {
        name: "live",
        schedule: "* * * * * *",
        prompt: "Boot prompt",
        workingDir,
        enabled: true,
      });
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    });

    // The sidebar renders each session's name exactly once, so counting
    // marker occurrences counts that name's sessions.
    const countSessions = async (): Promise<number> => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      return html.split('class="session-name">Live Session<').length - 1;
    };

    const waitForSessions = async (atLeast: number): Promise<number> => {
      let count = 0;
      await pollUntil(async () => {
        count = await countSessions();
        return count >= atLeast;
      }, 30_000);
      return count;
    };

    // Each fire overwrites the mock agent's stdin capture, so poll it
    // until a run shows the given prompt.
    const waitForPrompt = async (prompt: string): Promise<void> => {
      const reached = await pollUntil(
        () =>
          existsSync(stdinCapture) &&
          readFileSync(stdinCapture, "utf-8").includes(prompt),
        30_000,
      );
      expect(reached, `prompt "${prompt}" never reached the agent`).toBe(true);
    };

    const waitForStderr = async (fragment: string): Promise<void> => {
      await pollUntil(() => env.serverStderr().includes(fragment), 20_000);
    };

    it("picks up a job seeded externally after boot", async () => {
      const count = await waitForSessions(1);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("keeps the running schedule when a written row is invalid", async () => {
      const before = await countSessions();

      // A structurally valid row with an invalid schedule, written
      // straight into the database: logged, schedule untouched.
      seedCronJobRow(env.dbs.cronDb, {
        name: "live",
        schedule: "not a cron expression",
        prompt: "Boot prompt",
        workingDir,
        enabled: true,
      });
      await waitForStderr("reload rejected");
      const stderr = env.serverStderr();
      expect(stderr).toContain("keeping the running schedule");
      expect(stderr).toContain('cron job "live"');
      expect(stderr).toContain("invalid schedule");

      // The every-second job kept firing through the broken window.
      const kept = await waitForSessions(before + 2);
      expect(kept).toBeGreaterThanOrEqual(before + 2);
    });

    it("applies an edited row to the running schedule", async () => {
      seedCronJobRow(env.dbs.cronDb, {
        name: "live",
        schedule: "* * * * * *",
        prompt: "Edited prompt",
        workingDir,
        enabled: true,
      });
      await waitForPrompt("Edited prompt");
    });

    it("stops firing once the row is removed", async () => {
      removeCronJobRow(env.dbs.cronDb, "live");
      // Let the reload land (the 250ms poll picks the delete up in well
      // under a second), then confirm the count stays flat across three
      // fire windows of the former every-second schedule.
      await sleep(3000);
      const first = await countSessions();
      await sleep(3000);
      const second = await countSessions();
      expect(second).toBe(first);
    });
  });

  describe("job validation at serve start", () => {
    let restoreAgent: (() => void) | undefined;

    beforeAll(async () => {
      // serve resolves the agent binary against PATH, which CI runners
      // lack; the mock is never invoked — validation exits serve first.
      restoreAgent = await fx.mockAgent();
    });

    afterAll(() => {
      restoreAgent?.();
    });

    // Each case boots its own serve process against its own seeded cron
    // database just to watch it exit non-zero and shares no state with
    // the others, so concurrency overlaps the three boots instead of
    // stacking tens of seconds of serial startups on a CI runner. The
    // scheduler's boot read validates the whole set and must fail fast
    // naming the offending job. (Duplicate names and half model pins
    // need no boot defense: the primary key and the paired model columns
    // make both structurally impossible to store.)
    it.concurrent("exits non-zero naming a job with an invalid schedule", () =>
      expectServeRefuses(
        [
          {
            name: "broken",
            schedule: "not a cron expression",
            prompt: "x",
            workingDir: tmpdir(),
            enabled: true,
          },
        ],
        "broken",
        "invalid schedule",
      ));

    it.concurrent("exits non-zero naming a job with an invalid timezone", () =>
      expectServeRefuses(
        [
          {
            name: "tz-broken",
            schedule: "0 3 * * *",
            prompt: "x",
            workingDir: tmpdir(),
            timezone: "Bogus/Zone",
            enabled: true,
          },
        ],
        "tz-broken",
        "invalid timezone",
      ));

    it.concurrent("leaves the database untouched when it refuses", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-keep-"));
      const cronDb = defaultCronDb(homeDir, fx.binName);
      const broken: CronJobRow = {
        name: "broken",
        schedule: "not a cron expression",
        prompt: "x",
        workingDir: tmpdir(),
        enabled: true,
      };
      seedCronJobRow(cronDb, broken);
      await expectServeRefusal(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(homeDir)],
        fakeHomeEnv(homeDir),
      );
      // The invalid row stays exactly as written — serve never rewrites
      // the store it refused to start from, so fixing it stays an
      // owner decision.
      expect(readCronJobRows(cronDb)).toEqual([broken]);
      rmSync(homeDir, { recursive: true, force: true });
    });
  });
};

export { runCronSuite };
