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

    it("previews upcoming runs for a typed human schedule", async () => {
      const res = await authedFetch(
        env,
        "/cron/preview?schedule=every%20weekday%20at%209%3A00",
      );
      const html = await res.text();
      expect(html).toContain("every weekday at 9:00");
      expect(html).toContain("next-runs-list");
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

    it("schedules from the form, writes the config file, and starts nothing", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Run the nightly build",
          working_dir: workingDir,
          submit_action: "schedule",
          schedule: "every weekday at 9:00",
          job_name: "Weekly build",
        }),
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      // Confirmation state: name, humanized schedule, restart notice.
      expect(html).toContain("Scheduled run saved");
      expect(html).toContain("Weekly build");
      expect(html).toContain("every weekday at 9:00");
      expect(html).toContain("Changes apply when glv serve restarts");
      // The management section now shows the card.
      expect(html).toContain("cron-job-card");
      expect(html).toContain("Run the nightly build");

      // The typed schedule is stored verbatim — the file stays readable.
      const config = readConfig(cfgPath);
      expect(config.cronJobs).toEqual([
        {
          name: "Weekly build",
          schedule: "every weekday at 9:00",
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
          schedule: "definitely not a schedule",
          job_name: "broken-job",
        }),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("Couldn’t understand that schedule");
      // The prompt and the typed schedule survive the rejection.
      expect(html).toContain("Keep this exact text");
      expect(html).toContain("definitely not a schedule");
      expect(readConfig(cfgPath).cronJobs).toHaveLength(1);
    });

    it("rejects a name collision with an existing job", async () => {
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "Another sweep",
          working_dir: workingDir,
          submit_action: "schedule",
          schedule: "at 8:30",
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
      body.set("schedule", "every weekday at 9:00");
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
          schedule: "every weekday at 9:00",
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
          schedule: "every weekday at 9:00",
        }),
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Start me right now");
      expect(html).not.toContain("Scheduled run saved");
    });

    it("validates the typed schedule live and schedules without navigating", async () => {
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

        // No schedule typed: the schedule button is disabled.
        const scheduleBtn = page.locator("button.schedule-send-btn");
        await expect(scheduleBtn).toBeDisabled();

        // Typing something unparseable shows the error before any click
        // and keeps the button disabled.
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
          "✓ every weekday at 9:00",
        );
        await expect(scheduleBtn).toBeEnabled();
        await expect(page.locator(".next-runs-body")).toContainText(
          "every weekday at 9:00",
          { timeout: 10_000 },
        );

        // Compose and submit — the page never navigates.
        await page.locator('textarea[name="prompt"]').fill("Weekly sweep");
        await page.locator('input[name="job_name"]').fill("Browser job");
        await scheduleBtn.click();
        await expect(page.locator(".schedule-confirmation")).toContainText(
          "Scheduled run saved",
          { timeout: 15_000 },
        );
        expect(page.url()).toBe(`${env.baseUrl}/sessions/new`);
        await expect(page.locator(".schedule-confirmation")).toContainText(
          "every weekday at 9:00",
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
      expect(putHtml).toContain("on sunday at 18:00");

      const job = jobByName("friday-eu");
      expect(job).toBeDefined();
      expect(job?.schedule).toBe("on sunday at 18:00");
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

    it("fires a typed human schedule through later", async () => {
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
        // "every 2 minutes" fires at the next even-minute boundary, so
        // the first session lands within ~2 minutes of boot.
        const deadline = Date.now() + 150_000;
        let html = "";
        while (Date.now() < deadline) {
          const res = await authedFetch(env, "/");
          html = await res.text();
          if (html.includes("Typed Schedule Session")) break;
          await sleep(1000);
        }
        expect(html).toContain("Typed Schedule Session");
        // A recurring job stays in the config (unlike a one-shot).
        const jobs = readConfig(cfgPath).cronJobs ?? [];
        expect(jobs).toHaveLength(1);
      } finally {
        await env.cleanup();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }, 180000);
  });
};

export { runCronUiSuite };
