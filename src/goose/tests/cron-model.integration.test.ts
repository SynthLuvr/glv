import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  TWO_PROVIDER_CONFIG_YAML,
  writeGooseConfig,
} from "../../glv/tests/goose-config.js";
import {
  authedFetch,
  cronJobRow,
  flagValue,
  type IntegrationEnv,
  waitForArgs,
  withPage,
} from "../../glv/tests/harness.js";
import { startIntegrationEnv } from "./integration-harness.js";

// Scheduled-run model selection: the New Session form's picker (which
// scheduled runs inherit — the schedule form renders no picker of its
// own), the cron database's modelProvider/model pair, and the flags
// each fire actually passes to the agent.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ACP_PROVIDERS = JSON.stringify({
  entries: [
    {
      providerId: "zai",
      providerName: "Z.AI",
      models: [
        { id: "glm-5.3", name: "GLM-5.3" },
        { id: "glm-5.1", name: "GLM-5.1" },
      ],
    },
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      models: [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      ],
    },
  ],
});

describe("scheduled-run model picker (goose)", () => {
  let env: IntegrationEnv;
  let homeDir: string;
  let argsPath: string;
  let workDir: string;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "glv-cronmodel-home-"));
    writeGooseConfig(homeDir, TWO_PROVIDER_CONFIG_YAML);
    const argsDir = mkdtempSync(join(tmpdir(), "glv-cronmodel-args-"));
    argsPath = join(argsDir, "args.json");
    workDir = mkdtempSync(join(tmpdir(), "glv-cronmodel-work-"));
    env = await startIntegrationEnv(
      "glv-cronmodel-",
      {
        captureArgs: argsPath,
        acpProviders: ACP_PROVIDERS,
        sessionName: "Pinned Session",
      },
      homeDir,
    );
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  const postJob = async (
    fields: Record<string, string>,
  ): Promise<{ status: number; html: string }> => {
    const res = await authedFetch(env, "/cron", {
      method: "POST",
      body: new URLSearchParams(fields),
    });
    return { status: res.status, html: await res.text() };
  };

  it("serves the schedule form without model fields of its own", async () => {
    const res = await authedFetch(env, "/cron/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    // No picker slot here: the New Session form above is the page's
    // single model picker, and the submit pulls its select the same way
    // it pulls the composed prompt (and the working directory).
    expect(html).not.toContain("model-picker-slot");
    expect(html).not.toContain('name="model"');
    expect(html).toContain(".new-session-form select[name=model]");
    expect(html).toContain(".new-session-form input[name=working_dir]");
    // The copy says the run inherits the form above's picks.
    expect(html).toContain("working directory and model");
  });

  it("saves a job with the picked model and shows it back", async () => {
    const { status, html } = await postJob({
      job_name: "Weekly build",
      schedule: "every weekday at 9:00",
      prompt: "Run the nightly build",
      working_dir: workDir,
      model: "goose:zai:glm-5.1",
    });
    expect(status).toBe(200);
    // The confirmation names the pin, and the card carries it too.
    expect(html).toContain("Scheduled run saved");
    expect(html).toContain("Model");
    expect(html).toContain("zai / glm-5.1");
    expect(html).toContain("cron-job-model");
    // The row stores the pair as its two halves.
    expect(cronJobRow(env.dbs.cronDb, "Weekly build")).toMatchObject({
      modelProvider: "zai",
      model: "glm-5.1",
    });
  });

  it("stores no model keys when the default is kept", async () => {
    const { status } = await postJob({
      job_name: "Default sweep",
      schedule: "at 8:30",
      prompt: "Default model sweep",
      working_dir: workDir,
    });
    expect(status).toBe(200);
    const job = cronJobRow(env.dbs.cronDb, "Default sweep");
    expect(job).toBeDefined();
    expect(job?.modelProvider).toBeUndefined();
    expect(job?.model).toBeUndefined();
  });

  it("rejects a pick naming an agent that is not served", async () => {
    const { status, html } = await postJob({
      job_name: "ghost-job",
      schedule: "every weekday at 9:00",
      prompt: "Ghost provider",
      working_dir: workDir,
      model: "ghost:whatever",
    });
    expect(status).toBe(422);
    expect(html).toContain("not enabled");
    expect(html).toContain("ghost");
    // The picker lives in the New Session form above, untouched by the
    // slot swap — the re-rendered form carries no picker to restore.
    expect(html).not.toContain("model-picker-slot");
    expect(cronJobRow(env.dbs.cronDb, "ghost-job")).toBeUndefined();
  });

  it("rejects a model the provider does not offer", async () => {
    // The catalogue must be warm before resolve() can reject an unknown
    // model for a configured provider — the picker fragment awaits it.
    const picker = await authedFetch(env, "/sessions/model-picker");
    expect(await picker.text()).toContain("GLM-5.1");
    const { status, html } = await postJob({
      job_name: "bad-model",
      schedule: "every weekday at 9:00",
      prompt: "Not a real model",
      working_dir: workDir,
      model: "goose:zai:not-a-glm",
    });
    expect(status).toBe(422);
    expect(html).toContain("no longer available in goose");
    expect(cronJobRow(env.dbs.cronDb, "bad-model")).toBeUndefined();
  });

  it("starts fired sessions with the pinned model flags", async () => {
    const { status } = await postJob({
      job_name: "pinned-sweep",
      schedule: "* * * * * *",
      prompt: "Pinned sweep",
      working_dir: workDir,
      model: "goose:zai:glm-5.3",
    });
    expect(status).toBe(200);
    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--provider")).toBe("zai");
    expect(flagValue(args, "--model")).toBe("glm-5.3");
  });

  it("drops the flags when the pin is edited back to default", async () => {
    const res = await authedFetch(env, "/cron/pinned-sweep", {
      method: "PUT",
      body: new URLSearchParams({
        job_name: "pinned-sweep",
        schedule: "* * * * * *",
        prompt: "Pinned sweep",
        working_dir: workDir,
        model: "",
      }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    expect(
      cronJobRow(env.dbs.cronDb, "pinned-sweep")?.modelProvider,
    ).toBeUndefined();
    // The reload lands, the next fire overwrites the capture file, and
    // its argv carries no model flags anymore.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const args = await waitForArgs(argsPath);
      if (!args.includes("--provider")) break;
      if (Date.now() > deadline) throw new Error("model flags never dropped");
      await sleep(250);
    }
  });

  it("preselects the stored model in the edit form and saves a change", async () => {
    const edit = await authedFetch(env, "/cron/Weekly build/edit");
    const editHtml = await edit.text();
    expect(edit.status).toBe(200);
    expect(editHtml).toContain(
      'hx-get="/sessions/model-picker?submitted=goose%3Azai%3Aglm-5.1"',
    );

    const put = await authedFetch(env, "/cron/Weekly build", {
      method: "PUT",
      body: new URLSearchParams({
        job_name: "Weekly build",
        schedule: "every weekday at 9:00",
        prompt: "Run the nightly build",
        working_dir: workDir,
        model: "goose:anthropic:claude-opus-4-6",
      }),
      headers: { "HX-Request": "true" },
    });
    expect(put.status).toBe(200);
    const putHtml = await put.text();
    expect(putHtml).toContain("anthropic / claude-opus-4-6");
    expect(cronJobRow(env.dbs.cronDb, "Weekly build")).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("schedules with a model picked in the form above", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/new`);

      // The New Session form's picker swaps in lazily; pick a
      // non-default model there.
      const picker = page.locator("form.new-session-form select[name=model]");
      await expect(picker).toBeVisible({ timeout: 15_000 });
      await picker.selectOption("goose:zai:glm-5.1");

      // The inline form renders no picker of its own.
      await page.getByRole("button", { name: "🕒 Schedule…" }).click();
      const slot = page.locator("#cron-save-slot");
      await expect(slot.locator("form")).toBeVisible();
      await expect(slot.locator("select[name=model]")).toHaveCount(0);

      // Compose in both forms, then submit from the slot: the model
      // comes from the picker above, the rest from this form.
      await slot.locator("input[data-schedule-input]").fill("at 7:15");
      await slot.locator('input[name="job_name"]').fill("Browser model job");
      await page
        .locator("form.new-session-form textarea[name=prompt]")
        .fill("Browser sweep");
      await slot.locator("button[data-schedule-submit]").click();
      await expect(slot).toContainText("Scheduled run saved", {
        timeout: 15_000,
      });
      await expect(slot).toContainText("zai / glm-5.1");
      await expect(page.locator("#cron-job-grid")).toContainText(
        "Browser model job",
      );
      expect(cronJobRow(env.dbs.cronDb, "Browser model job")).toMatchObject({
        modelProvider: "zai",
        model: "glm-5.1",
      });
    });
  });
});
