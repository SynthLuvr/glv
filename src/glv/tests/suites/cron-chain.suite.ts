import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { formatOneShotLocal } from "../../schedule.js";
import {
  authedFetch,
  cronJobRow,
  type FlavorFixture,
  type IntegrationEnv,
  type MockConfig,
  readCronJobRows,
  seedCronJobRow,
  withPage,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls predicate every 250ms until it holds or the deadline passes;
// resolves to whether it ever held (a false outcome is the assertion in
// the "never happens" tests).
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

// Appends :ss to a minute-precision one-shot spelling so a test can aim
// a fixed distance out instead of waiting for a minute boundary (same
// helper as the cron-ui suite).
const withSeconds = (schedule: string, target: Date): string =>
  `${schedule}:${String(target.getSeconds()).padStart(2, "0")}`;

// Chained scheduled runs: follow-on prompts stacked on a job, each
// starting a new session after the previous step finishes. Persistence
// and the edit form first, then the chain driver's runtime rules —
// strict order, error-continues, stop/pause aborts, and the in-flight
// skip. Every assertion reads the running server over HTTP or the cron
// database rows it claims to write; prompts are observed through the
// mock agent's stdin capture (each invocation overwrites it, so a
// step's prompt is visible exactly while its session runs).

const runCronChainSuite = (fx: FlavorFixture): void => {
  // Counts a session-name's occurrences in the sidebar markup — the
  // sidebar renders each session's name exactly once (same technique as
  // the cron suite).
  const sessionCounter =
    (env: IntegrationEnv, sessionName: string) => async (): Promise<number> => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      return html.split(`class="session-name">${sessionName}<`).length - 1;
    };

  const putJob = async (
    env: IntegrationEnv,
    name: string,
    fields: Record<string, string | readonly string[]>,
  ): Promise<Response> => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields))
      if (typeof value === "string") body.set(key, value);
      else for (const entry of value) body.append(key, entry);

    return authedFetch(env, `/cron/${encodeURIComponent(name)}`, {
      method: "PUT",
      body,
      headers: { "HX-Request": "true" },
    });
  };

  describe("chained follow-on steps", () => {
    describe("persistence and the edit form", () => {
      let env: IntegrationEnv;
      let homeDir: string;
      let workDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-chain-persist-"));
        workDir = mkdtempSync(join(tmpdir(), "glv-chain-pw-"));
        env = await fx.startEnv(
          "glv-chain-persist-",
          { sessionName: "Never Fired" },
          homeDir,
        );
        // A daily 3am job: it never fires inside a test run.
        const res = await authedFetch(env, "/cron", {
          method: "POST",
          body: new URLSearchParams({
            job_name: "pipeline",
            schedule: "0 3 * * *",
            prompt: "Step one: sweep the logs",
            working_dir: workDir,
          }),
        });
        expect(res.status).toBe(200);
      }, 120000);

      afterAll(async () => {
        await env?.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      });

      it("stores follow-ons from the edit form and surfaces them everywhere", async () => {
        const res = await putJob(env, "pipeline", {
          job_name: "pipeline",
          schedule: "0 3 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
          follow_ups_present: "1",
          follow_up: [
            "Step two: summarize the results",
            "Step three: file the report",
          ],
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        // The card shows the pipeline at a glance: a steps chip plus
        // each follow-on's first line.
        expect(html).toContain("3 steps →");
        expect(html).toContain("2. Step two: summarize the results");
        expect(html).toContain("3. Step three: file the report");

        // The row stores the steps, in step order.
        expect(cronJobRow(env.dbs.cronDb, "pipeline")?.followUps).toEqual([
          "Step two: summarize the results",
          "Step three: file the report",
        ]);

        // Re-opening the edit form pre-fills every textarea: the first
        // prompt plus one per follow-on.
        const edit = await authedFetch(env, "/cron/pipeline/edit");
        const editHtml = await edit.text();
        expect(edit.status).toBe(200);
        expect(editHtml.match(/<textarea/g)?.length).toBe(3);
        expect(editHtml).toContain("Step one: sweep the logs");
        expect(editHtml).toContain("Step two: summarize the results");
        expect(editHtml).toContain("Step three: file the report");
        expect(editHtml).toContain("+ Add follow-on");
        expect(editHtml).toContain('name="follow_ups_present"');
      });

      it("rejects more than nine follow-ons with the cap copy, keeping the typed steps", async () => {
        const overCap = Array.from(
          { length: 10 },
          (_, index) => `Over-cap step ${index + 1}`,
        );
        const res = await putJob(env, "pipeline", {
          job_name: "pipeline",
          schedule: "0 3 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
          follow_ups_present: "1",
          follow_up: overCap,
        });
        // The edit route rejects inside a 200 swap (htmx only swaps
        // 2xx), carrying the error hint and the restored steps.
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("at most 9 follow-on steps");
        // The rejected submit's steps are restored — all ten of them —
        // so nothing typed is lost.
        for (const step of overCap) expect(html).toContain(step);
        // The stored row is untouched.
        expect(cronJobRow(env.dbs.cronDb, "pipeline")?.followUps).toHaveLength(
          2,
        );
      });

      it("saves nine follow-ons — the cap boundary", async () => {
        const nine = Array.from(
          { length: 9 },
          (_, index) => `Boundary step ${index + 1}`,
        );
        const res = await putJob(env, "pipeline", {
          job_name: "pipeline",
          schedule: "0 3 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
          follow_ups_present: "1",
          follow_up: nine,
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("10 steps →");
        expect(cronJobRow(env.dbs.cronDb, "pipeline")?.followUps).toEqual(nine);
      });

      it("drops blank follow-ons silently", async () => {
        const res = await putJob(env, "pipeline", {
          job_name: "pipeline",
          schedule: "0 3 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
          follow_ups_present: "1",
          follow_up: ["Keep this one", "   ", ""],
        });
        expect(res.status).toBe(200);
        expect(cronJobRow(env.dbs.cronDb, "pipeline")?.followUps).toEqual([
          "Keep this one",
        ]);
      });

      it("keeps stored follow-ons when the body carries no step fields", async () => {
        // A non-browser client (no marker, no step fields) edits other
        // fields only: the stored chain survives.
        const res = await putJob(env, "pipeline", {
          job_name: "pipeline",
          schedule: "0 4 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
        });
        expect(res.status).toBe(200);
        expect(cronJobRow(env.dbs.cronDb, "pipeline")?.followUps).toEqual([
          "Keep this one",
        ]);
      });

      it("clears stored follow-ons when every step block is removed", async () => {
        const res = await putJob(env, "pipeline", {
          job_name: "pipeline",
          schedule: "0 4 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
          follow_ups_present: "1",
        });
        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain("steps →");
        expect(cronJobRow(env.dbs.cronDb, "pipeline")?.followUps).toBe(
          undefined,
        );
      });

      it("re-keys the row on rename with follow-ons intact", async () => {
        const res = await putJob(env, "pipeline", {
          job_name: "renamed-pipeline",
          schedule: "0 4 * * *",
          prompt: "Step one: sweep the logs",
          working_dir: workDir,
          follow_ups_present: "1",
          follow_up: ["Renamed step two", "Renamed step three"],
        });
        expect(res.status).toBe(200);
        const rows = readCronJobRows(env.dbs.cronDb);
        expect(rows.find((job) => job.name === "pipeline")).toBeUndefined();
        expect(
          rows.find((job) => job.name === "renamed-pipeline")?.followUps,
        ).toEqual(["Renamed step two", "Renamed step three"]);
      });

      it("adds and removes step blocks client-side and saves them", async () => {
        await withPage(env.context, async (page) => {
          await page.goto(`${env.baseUrl}/sessions/new`);
          await expect(page.locator("form.new-session-form")).toBeVisible();

          // Open the edit form for the renamed job (htmx swap — the
          // first XHR can outlast the default wait on a loaded runner).
          await page
            .locator('[data-cron-job="renamed-pipeline"] button.edit')
            .click();
          const steps = page.locator("[data-cron-step]");
          await expect(steps.first()).toBeVisible({ timeout: 15_000 });
          await expect(steps).toHaveCount(2);

          // × removes a step block, purely client-side.
          await page
            .locator('[data-action="remove-cron-step"]')
            .first()
            .click();
          await expect(steps).toHaveCount(1);

          // The plus button stacks more; the new textareas carry the
          // follow_up name the server reads.
          await page.locator('[data-action="add-cron-step"]').click();
          await page.locator('[data-action="add-cron-step"]').click();
          await expect(steps).toHaveCount(3);
          const areas = page.locator('textarea[name="follow_up"]');
          await areas.nth(1).fill("Browser-added step");
          // A block left blank is a removal on save, not an error.
          await areas.nth(2).fill("   ");

          await page.locator("button[data-schedule-submit]").click();
          await expect(page.locator(".cron-job-card").first()).toContainText(
            "3 steps →",
            { timeout: 15_000 },
          );
          expect(
            cronJobRow(env.dbs.cronDb, "renamed-pipeline")?.followUps,
          ).toEqual(["Renamed step three", "Browser-added step"]);
        });
      });
    });

    describe("chain execution", () => {
      // Each scenario boots its own serve (the mock behaviour — sleep,
      // exit code — is fixed per environment); booting releases the
      // previous scenario's env so at most one is alive at a time.
      let alive:
        | {
            env: IntegrationEnv;
            homeDir: string;
            workDir: string;
          }
        | undefined;

      type Scenario = {
        env: IntegrationEnv;
        workDir: string;
        capture: () => string;
        countSessions: () => Promise<number>;
      };

      const bootChainEnv = async (
        prefix: string,
        mock: MockConfig,
      ): Promise<Scenario> => {
        if (alive !== undefined) {
          await alive.env.cleanup();
          rmSync(alive.homeDir, { recursive: true, force: true });
          rmSync(alive.workDir, { recursive: true, force: true });
        }
        const homeDir = mkdtempSync(join(tmpdir(), `${prefix}home-`));
        const workDir = mkdtempSync(join(tmpdir(), `${prefix}work-`));
        const captureStdin = join(homeDir, "stdin-capture.txt");
        // The store poll shrunk so a seeded row applies at test speed;
        // the chain poll shrunk so a chain walks its steps promptly.
        const env = await fx.startEnv(
          prefix,
          { ...mock, captureStdin },
          homeDir,
          { GLV_CRON_DB_POLL_MS: "250", GLV_CRON_CHAIN_POLL_MS: "100" },
        );
        alive = { env, homeDir, workDir };
        return {
          env,
          workDir,
          capture: () =>
            existsSync(captureStdin) ? readFileSync(captureStdin, "utf-8") : "",
          countSessions: sessionCounter(env, mock.sessionName ?? "Session"),
        };
      };

      afterAll(async () => {
        if (alive !== undefined) {
          await alive.env.cleanup();
          rmSync(alive.homeDir, { recursive: true, force: true });
          rmSync(alive.workDir, { recursive: true, force: true });
        }
      });

      // Aims a one-shot a fixed 20s out (seconds precision — no
      // minute-boundary wait) with the given follow-on chain.
      const seedOneShotChain = (
        env: IntegrationEnv,
        workDir: string,
        name: string,
        prompt: string,
        followUps: readonly string[],
      ): void => {
        const target = new Date(Date.now() + 20_000);
        seedCronJobRow(env.dbs.cronDb, {
          name,
          schedule: withSeconds(formatOneShotLocal(target), target),
          prompt,
          workingDir: workDir,
          enabled: true,
          followUps,
        });
      };

      // Polls the sidebar for the id of a session carrying the given
      // name (the only session in these scenarios).
      const pollForSessionId = async (
        env: IntegrationEnv,
        sessionName: string,
      ): Promise<string | undefined> => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const res = await authedFetch(env, "/");
          const html = await res.text();
          if (html.includes(sessionName)) {
            const match = /data-session-id="([^"]+)"/.exec(html);
            if (match !== null) return match[1];
          }
          await sleep(250);
        }
        return undefined;
      };

      it("runs each step as its own session, in order, every one tagged", async () => {
        const { env, workDir, capture, countSessions } = await bootChainEnv(
          "glv-chain-e2e-",
          { sessionName: "Chain Step", sleepMs: 1200 },
        );
        seedOneShotChain(
          env,
          workDir,
          "nightly-pipeline",
          "Chain step one prompt",
          ["Chain step two prompt", "Chain step three prompt"],
        );

        // Step 2's prompt reaching the agent proves step 1 finished
        // first (the chain gates on it); step 3's proves step 2 did.
        // The waits go in order — each mock invocation overwrites the
        // capture, so a step's prompt is visible exactly while its
        // session runs.
        expect(
          await pollUntil(
            () => capture().includes("Chain step two prompt"),
            90_000,
          ),
        ).toBe(true);
        expect(
          await pollUntil(
            () => capture().includes("Chain step three prompt"),
            30_000,
          ),
        ).toBe(true);

        // Three sessions, and every one of them badges the job name
        // (each chip carries the name in its label and title).
        expect(
          await pollUntil(async () => (await countSessions()) >= 3, 30_000),
        ).toBe(true);
        expect(
          await pollUntil(async () => {
            const meta = await authedFetch(env, "/sessions/sidebar-meta");
            const html = await meta.text();
            return html.split("nightly-pipeline").length - 1 >= 3;
          }, 30_000),
        ).toBe(true);

        // The one-shot retires only after the whole chain finishes.
        expect(
          await pollUntil(
            () => readCronJobRows(env.dbs.cronDb).length === 0,
            30_000,
          ),
        ).toBe(true);
      }, 200000);

      it("aborts the chain when a step's session is stopped", async () => {
        const { env, workDir, capture, countSessions } = await bootChainEnv(
          "glv-chain-stop-",
          { sessionName: "Stopped Chain", sleepMs: 60_000 },
        );
        seedOneShotChain(
          env,
          workDir,
          "stopped-pipeline",
          "Stop chain step one",
          ["Stop chain step two"],
        );

        // Wait for step 1's session, then stop it mid-run.
        const sessionId = await pollForSessionId(env, "Stopped Chain");
        expect(sessionId).toBeDefined();
        const stop = await authedFetch(env, `/sessions/${sessionId}/stop`, {
          method: "POST",
        });
        expect(stop.status).toBe(200);

        // The stop ends the pipeline: step 2's prompt never reaches the
        // agent, no second session appears, and the abort is logged.
        expect(
          await pollUntil(
            () => env.serverStderr().includes("was stopped — "),
            15_000,
          ),
        ).toBe(true);
        expect(capture().includes("Stop chain step two")).toBe(false);
        expect(await countSessions()).toBe(1);
      }, 200000);

      it("aborts the chain when the job is paused mid-run", async () => {
        const { env, workDir, capture, countSessions } = await bootChainEnv(
          "glv-chain-pause-",
          { sessionName: "Paused Chain", sleepMs: 4000 },
        );
        // Recurring (every second), so the pause lands while step 1 is
        // running and the liveness check is what stops step 2.
        seedCronJobRow(env.dbs.cronDb, {
          name: "pausable-pipeline",
          schedule: "* * * * * *",
          prompt: "Pause chain step one",
          workingDir: workDir,
          enabled: true,
          followUps: ["Pause chain step two"],
        });

        expect(
          await pollUntil(async () => (await countSessions()) >= 1, 30_000),
        ).toBe(true);
        const pause = await authedFetch(env, "/cron/pausable-pipeline/pause", {
          method: "POST",
        });
        expect(pause.status).toBe(200);

        // Step 1 finishes (~4s), the liveness check reads the pause, and
        // the remaining steps never run.
        expect(
          await pollUntil(
            () => env.serverStderr().includes("paused while its chain was"),
            30_000,
          ),
        ).toBe(true);
        expect(capture().includes("Pause chain step two")).toBe(false);
        expect(await countSessions()).toBe(1);
      }, 200000);

      it("continues the chain when a step errors", async () => {
        const { env, workDir, capture, countSessions } = await bootChainEnv(
          "glv-chain-err-",
          { sessionName: "Error Chain", exitCode: 1 },
        );
        seedOneShotChain(
          env,
          workDir,
          "error-pipeline",
          "Error chain step one",
          ["Error chain step two"],
        );

        expect(
          await pollUntil(
            () => capture().includes("Error chain step two"),
            90_000,
          ),
        ).toBe(true);
        expect(
          await pollUntil(async () => (await countSessions()) >= 2, 30_000),
        ).toBe(true);
        expect(env.serverStderr()).toContain("errored");
        expect(env.serverStderr()).toContain("continuing the chain");
      }, 200000);

      it("skips fires while a chain is still running instead of stacking pipelines", async () => {
        const { env, workDir, countSessions } = await bootChainEnv(
          "glv-chain-overlap-",
          { sessionName: "Overlap Chain", sleepMs: 8000 },
        );
        seedCronJobRow(env.dbs.cronDb, {
          name: "slow-pipeline",
          schedule: "* * * * * *",
          prompt: "Overlap step one",
          workingDir: workDir,
          enabled: true,
          followUps: ["Overlap step two"],
        });

        // The first fire starts step 1; the in-flight marker now spans
        // the whole chain, so every tick until it finishes must skip
        // rather than stack a second pipeline on the directory.
        expect(
          await pollUntil(async () => (await countSessions()) >= 1, 30_000),
        ).toBe(true);
        // Several fire windows pass deep inside step 1's 8s run: still
        // exactly one session.
        await sleep(3000);
        expect(await countSessions()).toBe(1);
        await sleep(3000);
        expect(await countSessions()).toBe(1);
      }, 200000);
    });
  });
};

export { runCronChainSuite };
