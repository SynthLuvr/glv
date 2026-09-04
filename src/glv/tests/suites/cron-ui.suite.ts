import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { formatOneShotLocal } from "../../schedule.js";
import {
  authedFetch,
  type CronConfigFile,
  cronJobIn,
  type FlavorFixture,
  type IntegrationEnv,
  readCronConfig,
  withPage,
  writeCronConfig,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The scheduled-runs UI: creating from the New Session form, managing
// from the section, recognizing job-started sessions, and the one-shot
// lifecycle. The config file stays the source of truth throughout — every
// assertion about state reads the file the UI claims to write.

const runCronUiSuite = (fx: FlavorFixture): void => {
  const writeConfig = (homeDir: string, cronJobs: unknown[]): string =>
    writeCronConfig(homeDir, fx.binName, cronJobs);

  // Polls the file until it satisfies the predicate (the server's writes
  // trail the HTTP response by design — retirement happens after a fire).
  const waitForConfig = async (
    path: string,
    accept: (config: CronConfigFile) => boolean,
    timeoutMs = 15_000,
  ): Promise<CronConfigFile> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const config = readCronConfig(path);
      if (accept(config)) return config;
      if (Date.now() > deadline)
        throw new Error(
          `config at ${path} never matched: ${JSON.stringify(config)}`,
        );
      await sleep(250);
    }
  };

  describe("schedule mode in the New Session form", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let cfgPath: string;
    let workingDir: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cronui-form-"));
      cfgPath = writeConfig(homeDir, []);
      workingDir = mkdtempSync(join(tmpdir(), "glv-cronui-work-"));
      env = await fx.startEnv(
        "glv-cronui-form-",
        { sessionName: "Should Not Start" },
        homeDir,
        { GLV_CONFIG: cfgPath },
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("keeps one Start session and shows the section's empty state", async () => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      // The New Session form is untouched: one submit, no schedule fields.
      expect(html).toContain("Start session");
      expect(html).not.toContain("schedule-send-btn");
      expect(html).not.toContain("data-schedule-input");

      // The Scheduled runs section is always present (Saved prompts
      // pattern): header button, empty state, live-reload notice.
      expect(html).toContain('id="scheduled-runs"');
      expect(html).toContain("Schedule…");
      expect(html).toContain("No scheduled runs yet");
      expect(html).toContain("Changes apply live");
      expect(html).not.toContain("cron-job-card");
    });

    it("serves the inline schedule form for the section slot", async () => {
      const res = await authedFetch(env, "/cron/new");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('hx-post="/cron"');
      expect(html).toContain('name="job_name"');
      // A single-line textbox — no suggestion dropdown on it.
      expect(html).toContain("data-schedule-input");
      const scheduleInput =
        /<input[^>]*data-schedule-input[^>]*>/.exec(html)?.[0] ?? "";
      expect(scheduleInput).not.toContain("list=");
      // The form's own working directory field, with home-dir suggestions.
      expect(html).toContain('name="working_dir"');
      expect(html).toContain("data-schedule-dir");
      expect(html).toContain('list="schedule-recent-dirs"');
      expect(html).toContain("<datalist");
      expect(html).toContain("Schedule run");
    });

    it("previews upcoming runs and shows the English → cron conversion", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=every%20weekday%20at%209%3A00",
      );
      const html = await res.text();
      expect(html).toContain("every weekday at 9:00");
      expect(html).toContain("0 9 * * 1-5");
      expect(html).toContain("next-runs-list");
    });

    it("translates the other documented phrasings to cron", async () => {
      const check = async (schedule: string, cron: string): Promise<void> => {
        const res = await authedFetch(
          env,
          `/cron/preview?schedule=${encodeURIComponent(schedule)}`,
        );
        const html = await res.text();
        expect(html).toContain(cron);
      };
      await check("at 9:00", "0 9 * * *");
      await check("on sunday at 18:00", "0 18 * * 0");
      await check("every 30 minutes", "*/30 * * * *");
      await check("every 2 hours", "0 */2 * * *");
      await check("on the 1st day of the month at 9:00", "0 9 1 * *");
      await check("on the last day of the month at 18:00", "0 18 L * *");
    });

    it("rejects a time-less phrase with guidance", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=every%20weekday",
      );
      const html = await res.text();
      expect(html).toContain("Give the schedule a time");
    });

    it("previews a cron schedule humanized", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=0%209%20*%20*%20*",
      );
      const html = await res.text();
      expect(html).toContain("Every day at 09:00");
    });

    it("explains an unparseable schedule in plain language", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=banana%20sandwich",
      );
      const html = await res.text();
      expect(html).toContain("Couldn’t understand that schedule");
    });

    it("rejects a schedule that fires more often than once a minute", async () => {
      // "after 9:00am" parses but matches every second after 9am — an
      // agent storm the guard must refuse.
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=after%209%3A00am",
      );
      const html = await res.text();
      expect(html).toContain("more often than once a minute");
    });

    it("rejects a one-shot time in the past", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=2000-01-01T09%3A00",
      );
      const html = await res.text();
      expect(html).toContain("already in the past");
    });

    it("creates a job from the slot form, writes the config file, and starts nothing", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "Weekly build",
          schedule: "every weekday at 9:00",
          prompt: "Run the nightly build",
          working_dir: workingDir,
        }),
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      // Confirmation lands in the slot: name, schedule, live-reload notice.
      expect(html).toContain("Scheduled run saved");
      expect(html).toContain("Weekly build");
      // The English was converted — humanized form and the pattern itself.
      expect(html).toContain("Every Mon, Tue, Wed, Thu, Fri at 09:00");
      expect(html).toContain("0 9 * * 1-5");
      expect(html).toContain("Changes apply live");
      // The confirmation names the working directory the runs will use.
      expect(html).toContain("Working directory");
      expect(html).toContain(workingDir);
      // The grid and count refresh out of band with the new card.
      expect(html).toContain('id="cron-job-grid"');
      expect(html).toContain("cron-job-card");
      expect(html).toContain("Run the nightly build");

      // English is CONVERTED to a cron pattern — the file stores cron.
      const config = readCronConfig(cfgPath);
      expect(config.cronJobs).toEqual([
        {
          name: "Weekly build",
          schedule: "0 9 * * 1-5",
          prompt: "Run the nightly build",
          workingDir,
        },
      ]);

      // Scheduling never starts a session.
      const page = await authedFetch(env, "/");
      const sidebar = await page.text();
      expect(sidebar).not.toContain("Should Not Start");
    });

    it("re-renders the slot form without losing typed work on a bad schedule", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "broken-job",
          schedule: "definitely not a schedule",
          prompt: "Keep this exact text",
          working_dir: workingDir,
        }),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("Couldn’t understand that schedule");
      // The typed job name, schedule, and working directory survive the
      // rejection (the composed prompt lives in the untouched form above).
      expect(html).toContain('value="broken-job"');
      expect(html).toContain("definitely not a schedule");
      expect(html).toContain(`value="${workingDir}"`);
      expect(readCronConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects an empty prompt with a pointer back to the form", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "no-prompt",
          schedule: "every weekday at 9:00",
          prompt: "",
          working_dir: workingDir,
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("type one in the form above");
    });

    it("rejects a missing working directory with a pointer to the field", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "no-dir",
          schedule: "every weekday at 9:00",
          prompt: "Somewhere to run",
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("A working directory is required");
      expect(readCronConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects a working directory that does not exist", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "ghost-dir",
          schedule: "every weekday at 9:00",
          prompt: "Run nowhere",
          working_dir: "/definitely/not/a/real/dir",
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("does not exist");
      expect(readCronConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects a name collision with an existing job", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "Weekly build",
          schedule: "at 8:30",
          prompt: "Another sweep",
          working_dir: workingDir,
        }),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("already exists");
      expect(html).toContain("Weekly build");
      expect(readCronConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects a model the agent cannot resolve, with a pointer to the picker", async () => {
      const res = await authedFetch(env, "/cron", {
        method: "POST",
        body: new URLSearchParams({
          job_name: "modelpick",
          schedule: "every weekday at 9:00",
          prompt: "Model pick",
          working_dir: workingDir,
          model_provider: "ghost/nowhere",
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("no longer available");
      expect(readCronConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("validates the typed schedule live and schedules without losing the prompt", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/new`);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        // One submit in the form; the section below carries scheduling.
        await expect(page.locator("button.send-btn")).toHaveText(
          "Start session",
        );
        await expect(page.locator("button.schedule-send-btn")).toHaveCount(0);
        // Earlier tests in this env may have created jobs, so read the
        // count instead of assuming the empty state.
        const before = await page
          .locator("#scheduled-runs-count")
          .textContent();

        // "Schedule…" loads the inline form into the section's slot.
        await page.getByRole("button", { name: "🕒 Schedule…" }).click();
        await expect(page.locator("#cron-save-slot form")).toBeVisible();
        const scheduleBtn = page.locator(
          "#cron-save-slot button[data-schedule-submit]",
        );
        await expect(scheduleBtn).toBeDisabled();

        // Unparseable input shows the error before any click and keeps
        // the button disabled.
        await page.locator("input[data-schedule-input]").fill("banana");
        await expect(page.locator("[data-schedule-validation]")).toContainText(
          "Couldn’t understand",
        );
        await expect(scheduleBtn).toBeDisabled();

        // A valid schedule enables the button, shows the live verdict,
        // and the server preview lists upcoming runs.
        await page
          .locator("input[data-schedule-input]")
          .fill("every weekday at 9:00");
        await expect(page.locator("[data-schedule-validation]")).toContainText(
          "✓ every weekday at 9:00 → 0 9 * * 1-5",
        );
        await expect(scheduleBtn).toBeEnabled();
        await expect(page.locator(".next-runs-body")).toContainText(
          "0 9 * * 1-5",
          { timeout: 10_000 },
        );

        // Compose the prompt in the form above, then schedule from the
        // slot — the page never navigates and the form keeps its text.
        await page.locator('textarea[name="prompt"]').fill("Weekly sweep");
        await page.locator('input[name="job_name"]').fill("Browser job");
        await scheduleBtn.click();
        await expect(page.locator("#cron-save-slot")).toContainText(
          "Scheduled run saved",
          { timeout: 15_000 },
        );
        expect(page.url()).toBe(`${env.baseUrl}/sessions/new`);
        await expect(page.locator('textarea[name="prompt"]')).toHaveValue(
          "Weekly sweep",
        );
        await expect(page.locator("#cron-job-grid")).toContainText(
          "Browser job",
        );
        await expect(page.locator("#scheduled-runs-count")).toHaveText(
          String(Number(before) + 1),
        );
      });
    });

    it("sets the working directory on the schedule form itself", async () => {
      const otherDir = mkdtempSync(join(tmpdir(), "glv-cronui-od-"));
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/new`);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        const sessionDir = page.locator(
          'form.new-session-form input[name="working_dir"]',
        );
        await sessionDir.fill(workingDir);

        // "Schedule…" loads the inline form; its working directory field
        // is seeded with the form above's value.
        await page.getByRole("button", { name: "🕒 Schedule…" }).click();
        const dirField = page.locator(
          "#cron-save-slot input[data-schedule-dir]",
        );
        await expect(dirField).toHaveValue(workingDir);

        // Untouched, the field follows the form above…
        await sessionDir.fill(otherDir);
        await expect(dirField).toHaveValue(otherDir);
        // …but once edited here it stays put, whatever happens above.
        await dirField.fill(workingDir);
        await sessionDir.fill(otherDir);
        await expect(dirField).toHaveValue(workingDir);

        // Even a temporary directory in the form above leaves the run's
        // own directory alone.
        await page.locator('input[data-source-radio="temp"]').check();
        await expect(dirField).toHaveValue(workingDir);

        // Submitting schedules the run in the field's directory.
        await page.locator("input[data-schedule-input]").fill("at 5:05");
        await page.locator('input[name="job_name"]').fill("Dir pick job");
        await page.locator('textarea[name="prompt"]').fill("Dir sweep");
        await page
          .locator("#cron-save-slot button[data-schedule-submit]")
          .click();
        await expect(page.locator("#cron-save-slot")).toContainText(
          "Scheduled run saved",
          { timeout: 15_000 },
        );
        expect(cronJobIn(cfgPath, "Dir pick job")?.workingDir).toBe(workingDir);
      });
    });
  });

  describe("managing scheduled runs", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let cfgPath: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cronui-manage-"));
      const workA = mkdtempSync(join(tmpdir(), "glv-cronui-ma-"));
      const workB = mkdtempSync(join(tmpdir(), "glv-cronui-mb-"));
      cfgPath = writeConfig(homeDir, [
        {
          name: "nightly",
          schedule: "0 9 * * *",
          prompt: "Nightly sweep of the logs",
          workingDir: workA,
        },
        {
          name: "friday-tz",
          schedule: "30 8 * * 5",
          prompt: "Friday EU report",
          workingDir: workB,
          timezone: "Europe/Berlin",
          enabled: false,
        },
      ]);
      env = await fx.startEnv(
        "glv-cronui-manage-",
        { sessionName: "Unstarted" },
        homeDir,
        { GLV_CONFIG: cfgPath },
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    const jobByName = (name: string): Record<string, unknown> | undefined =>
      cronJobIn(cfgPath, name);

    it("lists every job with status, schedule, next run, and the notice", async () => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      expect(html).toContain("Scheduled runs");
      expect(html).toContain("Changes apply live");
      expect(html).toContain("nightly");
      expect(html).toContain("Every day at 09:00");
      expect(html).toContain("Enabled");
      expect(html).toContain("Nightly sweep of the logs");
      // friday-tz is paused and its schedule keeps the raw pattern shape
      // plus the timezone suffix from the file.
      expect(html).toContain("friday-tz");
      expect(html).toContain("Paused");
      expect(html).toContain("(Europe/Berlin)");
    });

    it("pauses and resumes a job through the config file", async () => {
      const pause = await authedFetch(env, "/cron/nightly/pause", {
        method: "POST",
      });
      const pausedHtml = await pause.text();
      expect(pause.status).toBe(200);
      expect(pausedHtml).toContain("Paused");
      expect(jobByName("nightly")?.enabled).toBe(false);

      const resume = await authedFetch(env, "/cron/nightly/resume", {
        method: "POST",
      });
      const resumedHtml = await resume.text();
      expect(resume.status).toBe(200);
      expect(resumedHtml).toContain("Enabled");
      expect(jobByName("nightly")?.enabled).toBe(true);
    });

    it("edits a job and preserves fields the form doesn't expose", async () => {
      // The edit form pre-fills the typed schedule from the job as stored.
      const edit = await authedFetch(env, "/cron/friday-tz/edit");
      const editHtml = await edit.text();
      expect(edit.status).toBe(200);
      expect(editHtml).toContain('value="30 8 * * 5"');
      expect(editHtml).toContain("Friday EU report");

      const put = await authedFetch(env, "/cron/friday-tz", {
        method: "PUT",
        body: new URLSearchParams({
          job_name: "friday-eu",
          schedule: "on sunday at 18:00",
          prompt: "Rewritten EU report",
          working_dir: jobByName("friday-tz")?.workingDir as string,
        }),
        headers: { "HX-Request": "true" },
      });
      expect(put.status).toBe(200);
      const putHtml = await put.text();
      expect(putHtml).toContain("friday-eu");
      // English input, converted and humanized on save.
      expect(putHtml).toContain("Every Sun at 18:00");

      const job = jobByName("friday-eu");
      expect(job).toBeDefined();
      // English input, converted on save.
      expect(job?.schedule).toBe("0 18 * * 0");
      expect(job?.prompt).toBe("Rewritten EU report");
      // The form never exposes timezone or enabled; both survive.
      expect(job?.timezone).toBe("Europe/Berlin");
      expect(job?.enabled).toBe(false);
      // The old name is gone.
      expect(jobByName("friday-tz")).toBeUndefined();
    });

    it("rejects an edit that collides with another job's name", async () => {
      const res = await authedFetch(env, "/cron/friday-eu", {
        method: "PUT",
        body: new URLSearchParams({
          job_name: "nightly",
          schedule: "on sunday at 18:00",
          prompt: "Rewritten EU report",
          working_dir: jobByName("friday-eu")?.workingDir as string,
        }),
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("already exists");
      expect(jobByName("friday-eu")).toBeDefined();
    });

    it("deletes jobs and hides the section when the last one goes", async () => {
      const first = await authedFetch(env, "/cron/nightly", {
        method: "DELETE",
        headers: { "HX-Request": "true" },
      });
      expect(first.status).toBe(200);
      expect(jobByName("nightly")).toBeUndefined();

      const second = await authedFetch(env, "/cron/friday-eu", {
        method: "DELETE",
        headers: { "HX-Request": "true" },
      });
      expect(second.status).toBe(200);
      const html = await second.text();
      // The section swaps back with its empty state — cards gone.
      expect(html).toContain('id="scheduled-runs"');
      expect(html).toContain("No scheduled runs yet");
      expect(html).not.toContain("cron-job-card");
      expect(readCronConfig(cfgPath).cronJobs).toEqual([]);
    });
  });

  describe("recognizing job-started sessions", () => {
    let env: IntegrationEnv;
    let homeDir: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cronui-badge-"));
      const workingDir = mkdtempSync(join(tmpdir(), "glv-cronui-bw-"));
      writeConfig(homeDir, [
        {
          name: "nightly-watch",
          schedule: "* * * * * *",
          prompt: "Watch the logs",
          workingDir,
        },
      ]);
      env = await fx.startEnv(
        "glv-cronui-badge-",
        { sessionName: "Watched Session" },
        homeDir,
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("badges the session in the sidebar and the transcript header", async () => {
      // Wait for the every-second job to start a session, then take its
      // id from the sidebar markup.
      const deadline = Date.now() + 30_000;
      let sessionId: string | undefined;
      while (Date.now() < deadline && sessionId === undefined) {
        const res = await authedFetch(env, "/");
        const html = await res.text();
        const match = /data-session-id="([^"]+)"/.exec(html);
        if (match !== null && html.includes("Watched Session"))
          sessionId = match[1];
        if (sessionId === undefined) await sleep(500);
      }
      expect(sessionId).toBeDefined();

      const meta = await authedFetch(env, "/sessions/sidebar-meta");
      const metaHtml = await meta.text();
      expect(metaHtml).toContain("cron-chip");
      expect(metaHtml).toContain("nightly-watch");

      const transcript = await authedFetch(env, `/sessions/${sessionId}`);
      const transcriptHtml = await transcript.text();
      expect(transcriptHtml).toContain("cron-chip");
      expect(transcriptHtml).toContain("nightly-watch");
    });
  });

  describe("schedule lifecycle", () => {
    it("fires once at the chosen time and retires itself from the config", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cronui-once-"));
      const cfgPath = writeConfig(homeDir, [
        {
          name: "one-shot",
          // One-shot schedules have minute precision, so aim at the first
          // minute boundary comfortably in the future — enough lead for
          // serve to boot without the scheduler rightly pruning the job
          // as already past.
          schedule: formatOneShotLocal(
            new Date(Math.ceil((Date.now() + 40_000) / 60_000) * 60_000),
          ),
          prompt: "One time only",
          workingDir: mkdtempSync(join(tmpdir(), "glv-cronui-ow-")),
        },
      ]);
      const env = await fx.startEnv(
        "glv-cronui-once-",
        { sessionName: "One Shot Session" },
        homeDir,
        { GLV_CONFIG: cfgPath },
      );
      try {
        // The session lands…
        const deadline = Date.now() + 100_000;
        let html = "";
        while (Date.now() < deadline) {
          const res = await authedFetch(env, "/");
          html = await res.text();
          if (html.includes("One Shot Session")) break;
          await sleep(500);
        }
        expect(html).toContain("One Shot Session");

        // …and the job retires itself from the config after firing.
        const config = await waitForConfig(
          cfgPath,
          (c) => (c.cronJobs ?? []).length === 0,
        );
        expect(config.cronJobs).toEqual([]);
      } finally {
        await env.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }, 150000);

    it("prunes an expired one-shot at boot without running it", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cronui-exp-"));
      const cfgPath = writeConfig(homeDir, [
        {
          name: "missed",
          schedule: formatOneShotLocal(new Date(Date.now() - 60_000)),
          prompt: "Should never run",
          workingDir: mkdtempSync(join(tmpdir(), "glv-cronui-ew-")),
        },
      ]);
      const env = await fx.startEnv(
        "glv-cronui-exp-",
        { sessionName: "Missed Session" },
        homeDir,
        { GLV_CONFIG: cfgPath },
      );
      try {
        // The prune happens during boot, before the first request.
        const config = await waitForConfig(
          cfgPath,
          (c) => (c.cronJobs ?? []).length === 0,
        );
        expect(config.cronJobs).toEqual([]);
        const res = await authedFetch(env, "/");
        const html = await res.text();
        expect(html).not.toContain("Missed Session");
        expect(html).not.toContain("cron-job-card");
      } finally {
        await env.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }, 60000);

    it("fires an English schedule, translated to cron at boot", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cronui-text-"));
      const cfgPath = writeConfig(homeDir, [
        {
          name: "text-sweep",
          schedule: "every 2 minutes",
          prompt: "Typed schedule sweep",
          workingDir: mkdtempSync(join(tmpdir(), "glv-cronui-tw-")),
        },
      ]);
      const env = await fx.startEnv(
        "glv-cronui-text-",
        { sessionName: "Typed Schedule Session" },
        homeDir,
        { GLV_CONFIG: cfgPath },
      );
      try {
        // "every 2 minutes" fires on even-minute boundaries, so the
        // first fire lands within ~2 minutes of boot — but a boot just
        // past a boundary waits a full cycle first, and a loaded CI
        // runner can lag a fire by tens of seconds more. Measure the
        // window from the first boundary, padded past the 60s session
        // timeout, so a slow fire — or a missed one plus its retry —
        // still lands inside the poll.
        const firstFire = 120_000 - (Date.now() % 120_000);
        const deadline = Date.now() + firstFire + 180_000;
        let html = "";
        while (Date.now() < deadline) {
          const res = await authedFetch(env, "/");
          html = await res.text();
          if (html.includes("Typed Schedule Session")) break;
          await sleep(1000);
        }
        expect(html).toContain("Typed Schedule Session");
        // A recurring job stays in the config (unlike a one-shot).
        const jobs = readCronConfig(cfgPath).cronJobs ?? [];
        expect(jobs).toHaveLength(1);
      } finally {
        await env.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }, 360_000);
  });
};

export { runCronUiSuite };
