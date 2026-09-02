import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { formatOneShotLocal } from "../../schedule.js";
import {
  authedFetch,
  defaultConfigFile,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type ConfigFile = { cronJobs?: unknown[] };

// The scheduled-runs UI: creating from the New Session form, managing
// from the section, recognizing job-started sessions, and the one-shot
// lifecycle. The config file stays the source of truth throughout — every
// assertion about state reads the file the UI claims to write.

const runCronUiSuite = (fx: FlavorFixture): void => {
  const writeConfig = (homeDir: string, cronJobs: unknown[]): string => {
    const path = defaultConfigFile(homeDir, fx.binName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ cronJobs }, null, 2));
    return path;
  };

  const readConfig = (path: string): ConfigFile =>
    (existsSync(path)
      ? JSON.parse(readFileSync(path, "utf-8"))
      : {}) as ConfigFile;

  // Polls the file until it satisfies the predicate (the server's writes
  // trail the HTTP response by design — retirement happens after a fire).
  const waitForConfig = async (
    path: string,
    accept: (config: ConfigFile) => boolean,
    timeoutMs = 15_000,
  ): Promise<ConfigFile> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const config = readConfig(path);
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

    it("shows the collapsed disclosure and hides the section when no jobs exist", async () => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      expect(html).toContain("Schedule…");
      expect(html).toContain("data-schedule-disclosure");
      // The section renders hidden — the page looks like today's.
      expect(html).toContain('id="scheduled-runs"');
      expect(html).not.toContain("cron-job-card");
    });

    it("previews upcoming runs for a daily schedule", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule_kind=daily&daily_time=09%3A00",
      );
      const html = await res.text();
      expect(html).toContain("Every day at 09:00");
      expect(html).toContain("next-runs-list");
    });

    it("explains an invalid cron pattern in plain language", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule_kind=cron&cron_pattern=not+a+pattern",
      );
      const html = await res.text();
      expect(html).toContain("doesn’t look like a cron pattern");
    });

    it("rejects a one-shot time in the past", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule_kind=once&once_date=2000-01-01&once_time=09%3A00",
      );
      const html = await res.text();
      expect(html).toContain("already in the past");
    });

    it("schedules from the form, writes the config file, and starts nothing", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Run the nightly build",
          working_dir: workingDir,
          submit_action: "schedule",
          schedule_kind: "weekly",
          weekly_day: "1",
          weekly_time: "09:00",
          job_name: "Weekly build",
        }),
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      // Confirmation state: name, humanized schedule, restart notice.
      expect(html).toContain("Scheduled run saved");
      expect(html).toContain("Weekly build");
      expect(html).toContain("Every Mon at 09:00");
      expect(html).toContain("Changes apply when glv serve restarts");
      // The management section now shows the card.
      expect(html).toContain("cron-job-card");
      expect(html).toContain("Run the nightly build");

      const config = readConfig(cfgPath);
      expect(config.cronJobs).toEqual([
        {
          name: "Weekly build",
          schedule: "0 9 * * 1",
          prompt: "Run the nightly build",
          workingDir,
        },
      ]);

      // Scheduling is an alternate submit — no session may have started.
      const page = await authedFetch(env, "/");
      const sidebar = await page.text();
      expect(sidebar).not.toContain("Should Not Start");
    });

    it("re-renders the form without losing typed work on a bad pattern", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Keep this exact text",
          working_dir: workingDir,
          submit_action: "schedule",
          schedule_kind: "cron",
          cron_pattern: "definitely not cron",
          job_name: "broken-job",
        }),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("doesn’t look like a cron pattern");
      // The prompt and the pattern survive the rejection.
      expect(html).toContain("Keep this exact text");
      expect(html).toContain("definitely not cron");
      expect(readConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects a name collision with an existing job", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Another sweep",
          working_dir: workingDir,
          submit_action: "schedule",
          schedule_kind: "daily",
          daily_time: "08:30",
          job_name: "Weekly build",
        }),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("already exists");
      expect(html).toContain("Weekly build");
      expect(readConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects attachments in schedule mode with a clear message", async () => {
      const body = new FormData();
      body.set("prompt", "Sweep with an attachment");
      body.set("working_dir", workingDir);
      body.set("submit_action", "schedule");
      body.set("schedule_kind", "daily");
      body.set("daily_time", "08:30");
      body.set("job_name", "attached");
      body.set(
        "uploads",
        new File(["hello"], "note.txt", { type: "text/plain" }),
      );
      const res = await authedFetch(env, "/sessions", { method: "POST", body });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("can’t include attachments");
    });

    it("rejects a non-default model in schedule mode", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Model pick",
          working_dir: workingDir,
          submit_action: "schedule",
          schedule_kind: "daily",
          daily_time: "08:30",
          job_name: "modelpick",
          model_provider: "anthropic/claude",
        }),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("default model");
    });

    it("still starts a session when schedule mode is not used", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Start me right now",
          working_dir: workingDir,
          submit_action: "run",
          schedule_kind: "daily",
          daily_time: "08:30",
        }),
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Start me right now");
      expect(html).not.toContain("Scheduled run saved");
    });

    it("schedules from the browser without navigating away", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/new`);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        // Collapsed by default: the run button is the visible one.
        await expect(page.locator("button.send-btn")).toBeVisible();
        await expect(page.locator("button.schedule-send-btn")).toBeHidden();

        // Opening the disclosure is schedule mode: relabel + dim.
        await page.locator(".schedule-summary").click();
        await expect(page.locator("button.schedule-send-btn")).toBeVisible();
        await expect(page.locator("button.send-btn")).toBeHidden();

        // The default (every day) preview loads live.
        await expect(page.locator(".next-runs-body")).toContainText(
          "Every day at 09:00",
          { timeout: 10_000 },
        );

        // Compose: prompt + weekly on Monday at 09:00.
        await page.locator('textarea[name="prompt"]').fill("Weekly sweep");
        await page.locator('input[name="job_name"]').fill("Browser job");
        await page.locator('[data-schedule-radio="weekly"]').check();
        await page
          .locator("select.schedule-weekday")
          .selectOption({ label: "Monday" });
        await page.locator('input[name="weekly_time"]').fill("09:00");
        await expect(page.locator(".next-runs-body")).toContainText(
          "Every Mon at 09:00",
        );

        // Submit schedules — the page never navigates.
        await page.locator("button.schedule-send-btn").click();
        await expect(page.locator(".schedule-confirmation")).toContainText(
          "Scheduled run saved",
          { timeout: 15_000 },
        );
        expect(page.url()).toBe(`${env.baseUrl}/sessions/new`);
        await expect(page.locator(".schedule-confirmation")).toContainText(
          "Every Mon at 09:00",
        );
        await expect(page.locator("#scheduled-runs")).toContainText(
          "Browser job",
        );
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

    const jobByName = (name: string): Record<string, unknown> | undefined => {
      const jobs = readConfig(cfgPath).cronJobs ?? [];
      return jobs.find((job) => (job as { name?: string }).name === name) as
        | Record<string, unknown>
        | undefined;
    };

    it("lists every job with status, schedule, next run, and the notice", async () => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      expect(html).toContain("Scheduled runs");
      expect(html).toContain("Changes apply when glv serve restarts");
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
      // The edit form pre-fills the controls from the stored schedule:
      // "30 8 * * 5" reads back as weekly Friday at 08:30.
      const edit = await authedFetch(env, "/cron/friday-tz/edit");
      const editHtml = await edit.text();
      expect(edit.status).toBe(200);
      expect(editHtml).toContain('value="5" selected');
      expect(editHtml).toContain("Friday EU report");

      const put = await authedFetch(env, "/cron/friday-tz", {
        method: "PUT",
        body: new URLSearchParams({
          job_name: "friday-eu",
          schedule_kind: "daily",
          daily_time: "07:15",
          prompt: "Rewritten EU report",
          working_dir: jobByName("friday-tz")?.workingDir as string,
        }),
        headers: { "HX-Request": "true" },
      });
      expect(put.status).toBe(200);
      const putHtml = await put.text();
      expect(putHtml).toContain("friday-eu");
      expect(putHtml).toContain("Every day at 07:15");

      const job = jobByName("friday-eu");
      expect(job).toBeDefined();
      expect(job?.schedule).toBe("15 7 * * *");
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
          schedule_kind: "daily",
          daily_time: "07:15",
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
      // The empty section swaps back in hidden.
      expect(html).toContain('id="scheduled-runs"');
      expect(html).toContain("hidden");
      expect(readConfig(cfgPath).cronJobs).toEqual([]);
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

  describe("one-shot lifecycle", () => {
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
  });
};

export { runCronUiSuite };
