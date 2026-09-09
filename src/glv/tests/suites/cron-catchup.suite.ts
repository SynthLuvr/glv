import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { formatOneShotLocal } from "../../schedule.js";
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

// The log fragment every catch-up fire names — one line per missed
// run. The scheduler emits it with console.log, which consola's
// wrapper (serve's logger) sends to stdout — not the stderr trail.
const CATCHUP_LINE = "firing missed run scheduled for";

// Counts a session-name's occurrences in the sidebar markup (the
// sidebar renders each session's name exactly once — same technique as
// the cron suite).
const countSessions = async (
  env: IntegrationEnv,
  sessionName: string,
): Promise<number> => {
  const res = await authedFetch(env, "/");
  const html = await res.text();
  return html.split(`class="session-name">${sessionName}<`).length - 1;
};

// The job row's missed-run marker as epoch ms; undefined when the row
// (or its marker) is gone or unparseable.
const markerTime = (env: IntegrationEnv, name: string): number | undefined => {
  const marker = cronJobRow(env.dbs.cronDb, name)?.lastFiredAt;
  if (marker === undefined || marker === null) return undefined;
  const ms = Date.parse(marker);
  return Number.isNaN(ms) ? undefined : ms;
};

// Missed-run catch-up: an occurrence whose moment passed while no
// scheduler was watching (serve down, or the job paused) fires once,
// when the scheduler next adopts the job set — the latest missed
// occurrence, never a burst. Rows are seeded with controlled markers
// while serve is stopped, so nothing here races the wall clock except
// where a real fire is the point.

const runCronCatchUpSuite = (fx: FlavorFixture): void => {
  describe("missed-run catch-up", () => {
    describe("a missed one-shot fires on the next start", () => {
      let env: IntegrationEnv;
      let homeDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-once-"));
        env = await fx.startEnv(
          "glv-catchup-once-",
          { sessionName: "One-Shot Catch-Up" },
          homeDir,
          {},
          // A one-shot whose moment passed a minute before boot, with no
          // marker: the still-present row could only exist unfired.
          ({ cronDb }) =>
            seedCronJobRow(cronDb, {
              name: "sweep-once",
              schedule: formatOneShotLocal(new Date(Date.now() - 60_000)),
              prompt: "Missed one-shot prompt",
              workingDir: mkdtempSync(join(tmpdir(), "glv-catchup-odir-")),
              enabled: true,
              lastFiredAt: null,
            }),
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      });

      it("fires it at boot, then retires the row", async () => {
        const logged = await pollUntil(
          () =>
            env
              .serverStdout()
              .includes(`cron job "sweep-once": ${CATCHUP_LINE}`),
          20_000,
        );
        expect(logged).toBe(true);

        const sessions = await pollUntil(
          async () => (await countSessions(env, "One-Shot Catch-Up")) >= 1,
          30_000,
        );
        expect(sessions).toBe(true);

        // The fire retires the one-shot once its run is done.
        const retired = await pollUntil(
          () => cronJobRow(env.dbs.cronDb, "sweep-once") === undefined,
          30_000,
        );
        expect(retired).toBe(true);
      });
    });

    describe("a missed recurring run fires once on the next start", () => {
      let env: IntegrationEnv;
      let homeDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-rec-"));
        env = await fx.startEnv(
          "glv-catchup-rec-",
          { sessionName: "Recurring Catch-Up" },
          homeDir,
          {},
          // An every-second job whose marker says it last served an hour
          // ago — an outage-sized backlog of missed occurrences.
          ({ cronDb }) =>
            seedCronJobRow(cronDb, {
              name: "stale",
              schedule: "* * * * * *",
              prompt: "Recurring catch-up prompt",
              workingDir: mkdtempSync(join(tmpdir(), "glv-catchup-rdir-")),
              enabled: true,
              lastFiredAt: new Date(Date.now() - 3_600_000).toISOString(),
            }),
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      });

      it("fires the latest missed occurrence at boot", async () => {
        const logged = await pollUntil(
          () =>
            env.serverStdout().includes(`cron job "stale": ${CATCHUP_LINE}`),
          20_000,
        );
        expect(logged).toBe(true);

        const sessions = await pollUntil(
          async () => (await countSessions(env, "Recurring Catch-Up")) >= 1,
          30_000,
        );
        expect(sessions).toBe(true);

        // The catch-up fire stamped a fresh marker: the served
        // occurrence, written at fire start.
        const fresh = await pollUntil(() => {
          const ms = markerTime(env, "stale");
          return ms !== undefined && Date.now() - ms < 120_000;
        }, 15_000);
        expect(fresh).toBe(true);
      });

      it("catches up exactly once, never a burst", async () => {
        // Several ordinary fire windows pass; the backlog however deep,
        // the catch-up line appears exactly once.
        const ticking = await pollUntil(
          async () => (await countSessions(env, "Recurring Catch-Up")) >= 2,
          30_000,
        );
        expect(ticking).toBe(true);
        const catchUps = env.serverStdout().split(CATCHUP_LINE).length - 1;
        expect(catchUps).toBe(1);
      });
    });

    describe("restart right after a fire", () => {
      let env: IntegrationEnv;
      let homeDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-restart-"));
        // Fires once a minute at second 7: the next occurrence is a
        // full minute out, so a restart fits comfortably between fires.
        env = await fx.startEnv(
          "glv-catchup-restart-",
          { sessionName: "Restart Session" },
          homeDir,
          {},
          ({ cronDb }) =>
            seedCronJobRow(cronDb, {
              name: "minute-mark",
              schedule: "7 * * * * *",
              prompt: "Restart job prompt",
              workingDir: mkdtempSync(join(tmpdir(), "glv-catchup-mdir-")),
              enabled: true,
            }),
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      });

      it("records the served occurrence when a job fires", async () => {
        const sessions = await pollUntil(
          async () => (await countSessions(env, "Restart Session")) >= 1,
          75_000,
        );
        expect(sessions).toBe(true);
        const ms = markerTime(env, "minute-mark");
        expect(ms).toBeDefined();
        // The marker is the occurrence, not a wall-clock artifact: it
        // lands on the schedule's own second, within the last minute.
        expect(new Date(ms ?? 0).getSeconds()).toBe(7);
        expect(Date.now() - (ms ?? 0)).toBeLessThan(65_000);
      });

      it("does not re-fire the served occurrence on restart", async () => {
        // Restart with a full margin before the next occurrence: wait
        // until the most recent fire is < 25s old (≥ 35s of runway).
        const fresh = await pollUntil(() => {
          const ms = markerTime(env, "minute-mark");
          return ms !== undefined && Date.now() - ms < 25_000;
        }, 75_000);
        expect(fresh).toBe(true);

        await env.restart();
        // A boot catch-up would have logged before the port bound; give
        // the stderr pipe a moment to flush, then hold the line.
        await sleep(3_000);
        expect(env.serverStdout()).not.toContain(CATCHUP_LINE);
        const res = await authedFetch(env, "/");
        expect(res.status).toBe(200);
      });
    });

    describe("disabled jobs never catch up", () => {
      let env: IntegrationEnv;
      let homeDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-off-"));
        env = await fx.startEnv(
          "glv-catchup-off-",
          { sessionName: "Dead One-Shot" },
          homeDir,
          {},
          ({ cronDb }) =>
            seedCronJobRow(cronDb, {
              name: "dead-one-shot",
              schedule: formatOneShotLocal(new Date(Date.now() - 60_000)),
              prompt: "Should stay dead",
              workingDir: mkdtempSync(join(tmpdir(), "glv-catchup-ddir-")),
              enabled: false,
              lastFiredAt: null,
            }),
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      });

      it("retires a past disabled one-shot without running it", async () => {
        const retired = await pollUntil(
          () => cronJobRow(env.dbs.cronDb, "dead-one-shot") === undefined,
          10_000,
        );
        expect(retired).toBe(true);
        await sleep(3_000);
        expect(env.serverStdout()).not.toContain(CATCHUP_LINE);
        expect(await countSessions(env, "Dead One-Shot")).toBe(0);
      });
    });

    describe("pause across an occurrence catches up on resume", () => {
      let env: IntegrationEnv;
      let homeDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-pause-"));
        env = await fx.startEnv(
          "glv-catchup-pause-",
          { sessionName: "Resume Session" },
          homeDir,
          {},
          ({ cronDb }) =>
            seedCronJobRow(cronDb, {
              name: "snooze",
              schedule: "7 * * * * *",
              prompt: "Snoozed job prompt",
              workingDir: mkdtempSync(join(tmpdir(), "glv-catchup-pdir-")),
              enabled: false,
              lastFiredAt: new Date(Date.now() - 3_600_000).toISOString(),
            }),
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      });

      it("fires the missed occurrence when resumed", async () => {
        // While paused (and its moment long past), nothing fires.
        await sleep(3_000);
        expect(env.serverStdout()).not.toContain(CATCHUP_LINE);
        expect(await countSessions(env, "Resume Session")).toBe(0);

        const res = await authedFetch(env, "/cron/snooze/resume", {
          method: "POST",
        });
        expect(res.status).toBe(200);

        // Resuming adopts the job set — and with it the missed moment.
        const logged = await pollUntil(
          () =>
            env.serverStdout().includes(`cron job "snooze": ${CATCHUP_LINE}`),
          20_000,
        );
        expect(logged).toBe(true);
        const sessions = await pollUntil(
          async () => (await countSessions(env, "Resume Session")) >= 1,
          30_000,
        );
        expect(sessions).toBe(true);
      });
    });

    describe("an edit never re-fires or resets the marker", () => {
      let env: IntegrationEnv;
      let homeDir: string;
      let workDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-edit-"));
        workDir = mkdtempSync(join(tmpdir(), "glv-catchup-edir-"));
        env = await fx.startEnv(
          "glv-catchup-edit-",
          { sessionName: "Edit Session" },
          homeDir,
          {},
          // An hourly job with a fresh marker: nothing missed, nothing
          // due — any fire in this window would be fabricated.
          ({ cronDb }) =>
            seedCronJobRow(cronDb, {
              name: "steady",
              schedule: "7 0 * * *",
              prompt: "Steady job prompt",
              workingDir: workDir,
              enabled: true,
              lastFiredAt: new Date().toISOString(),
            }),
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      });

      it("renames the row and preserves last_fired_at byte for byte", async () => {
        await sleep(1_500);
        expect(env.serverStdout()).not.toContain(CATCHUP_LINE);
        const marker = cronJobRow(env.dbs.cronDb, "steady")?.lastFiredAt;
        expect(marker).toBeDefined();

        const res = await authedFetch(env, "/cron/steady", {
          method: "PUT",
          body: new URLSearchParams({
            job_name: "steady-renamed",
            schedule: "7 0 * * *",
            prompt: "Steady job prompt",
            working_dir: workDir,
          }),
        });
        expect(res.status).toBe(200);

        expect(cronJobRow(env.dbs.cronDb, "steady")).toBeUndefined();
        expect(cronJobRow(env.dbs.cronDb, "steady-renamed")?.lastFiredAt).toBe(
          marker,
        );
        // The edit adopted a new job set; nothing was missed, so nothing
        // fired.
        await sleep(3_000);
        expect(env.serverStdout()).not.toContain(CATCHUP_LINE);
        expect(await countSessions(env, "Edit Session")).toBe(0);
      });
    });

    describe("the marker column migrates", () => {
      let env: IntegrationEnv;
      let homeDir: string;

      // The pre-catch-up schema: everything but last_fired_at.
      const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  name           TEXT PRIMARY KEY,
  schedule       TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  working_dir    TEXT NOT NULL,
  timezone       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  model_provider TEXT,
  model          TEXT,
  follow_ups     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-catchup-mig-"));
        env = await fx.startEnv(
          "glv-catchup-mig-",
          { sessionName: "Migration Session" },
          homeDir,
          {},
          // Raw, deliberately un-migrated store: the table predates the
          // column, so boot has to add and seed it.
          ({ cronDb }) => {
            const db = new DatabaseSync(cronDb);
            db.exec(OLD_SCHEMA);
            db.prepare(
              "INSERT INTO cron_jobs (name, schedule, prompt, working_dir, enabled) " +
                "VALUES (?, ?, ?, ?, 1)",
            ).run(
              "legacy",
              "7 0 * * *",
              "Legacy job prompt",
              mkdtempSync(join(tmpdir(), "glv-catchup-ldir-")),
            );
            db.close();
          },
        );
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      });

      it("adds the column, seeds it to boot time, and fires nothing", async () => {
        // The read itself proves the column exists and holds a marker.
        const marker = cronJobRow(env.dbs.cronDb, "legacy")?.lastFiredAt;
        expect(marker).toBeDefined();
        const ms = Date.parse(marker ?? "");
        expect(Number.isNaN(ms)).toBe(false);
        // Seeded to the migration moment, i.e. this boot.
        expect(Date.now() - ms).toBeLessThan(120_000);

        await sleep(3_000);
        expect(env.serverStdout()).not.toContain(CATCHUP_LINE);
        expect(await countSessions(env, "Migration Session")).toBe(0);
      });
    });
  });
};

export { runCronCatchUpSuite };
