import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  cronJobIn,
  fakeHomeEnv,
  flagValue,
  type IntegrationEnv,
  waitForArgs,
  withPage,
  writeCronConfig,
} from "../../glv/tests/harness.js";
import { gooseConfigPath } from "../models.js";
import { startIntegrationEnv } from "./integration-harness.js";

// Scheduled-run model selection: the schedule form's own picker, the
// config-file modelProvider/model pair, and the flags each fire actually
// passes to the agent. goose-only, like the New Session picker it shares
// the catalogue with (claude has no model surface).

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors the model-select suite's goose config: zai active with
// glm-5.3 configured, plus a static catalogue below offering more.
const CONFIG_YAML = `active_provider: zai
providers:
  zai:
    enabled: true
    model: glm-5.3
    configured: true
  anthropic:
    enabled: true
    model: claude-sonnet-4-5
    configured: true
`;

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

// goose resolves its config under APPDATA on Windows and ~/.config
// elsewhere; fakeHomeEnv spells the fake home the same way for both.
const writeGooseConfig = (home: string): void => {
  const configYaml = gooseConfigPath(fakeHomeEnv(home));
  mkdirSync(dirname(configYaml), { recursive: true });
  writeFileSync(configYaml, CONFIG_YAML);
};

describe("scheduled-run model picker (goose)", () => {
  let env: IntegrationEnv;
  let homeDir: string;
  let cfgPath: string;
  let argsPath: string;
  let workDir: string;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "glv-cronmodel-home-"));
    writeGooseConfig(homeDir);
    cfgPath = writeCronConfig(homeDir, "glv-goose", []);
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
      // The fast poll makes the edit test's config reload land quickly.
      { GLV_CONFIG: cfgPath, GLV_CONFIG_WATCH_POLL_MS: "250" },
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

  it("serves the schedule form with its own lazy picker", async () => {
    const res = await authedFetch(env, "/cron/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    // The picker is a lazy slot, exactly like the New Session form's —
    // the catalogue may spawn the agent binary, so the form renders
    // instantly and the select swaps in after.
    expect(html).toContain('class="form-field model-picker-slot"');
    expect(html).toContain('hx-get="/sessions/model-picker"');
    expect(html).toContain("Pick a model below");
    expect(html).not.toContain("default model");
  });

  it("saves a job with the picked model and shows it back", async () => {
    const { status, html } = await postJob({
      job_name: "Weekly build",
      schedule: "every weekday at 9:00",
      prompt: "Run the nightly build",
      working_dir: workDir,
      model_provider: "zai:glm-5.1",
    });
    expect(status).toBe(200);
    // The confirmation names the pin, and the card carries it too.
    expect(html).toContain("Scheduled run saved");
    expect(html).toContain("Model");
    expect(html).toContain("zai / glm-5.1");
    expect(html).toContain("cron-job-model");
    // The file stores the pair as its two halves.
    expect(cronJobIn(cfgPath, "Weekly build")).toMatchObject({
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
    const job = cronJobIn(cfgPath, "Default sweep");
    expect(job).toBeDefined();
    expect(job?.modelProvider).toBeUndefined();
    expect(job?.model).toBeUndefined();
  });

  it("rejects a provider that is no longer configured", async () => {
    const { status, html } = await postJob({
      job_name: "ghost-job",
      schedule: "every weekday at 9:00",
      prompt: "Ghost provider",
      working_dir: workDir,
      model_provider: "ghost:whatever",
    });
    expect(status).toBe(422);
    expect(html).toContain("no longer available in goose");
    // The re-rendered slot carries the submitted value so the picker
    // restores the selection instead of silently resetting it.
    expect(html).toContain(
      'hx-get="/sessions/model-picker?submitted=ghost%3Awhatever"',
    );
    expect(cronJobIn(cfgPath, "ghost-job")).toBeUndefined();
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
      model_provider: "zai:not-a-glm",
    });
    expect(status).toBe(422);
    expect(html).toContain("no longer available in goose");
    expect(cronJobIn(cfgPath, "bad-model")).toBeUndefined();
  });

  it("starts fired sessions with the pinned model flags", async () => {
    const { status } = await postJob({
      job_name: "pinned-sweep",
      schedule: "* * * * * *",
      prompt: "Pinned sweep",
      working_dir: workDir,
      model_provider: "zai:glm-5.3",
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
        model_provider: "",
      }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    expect(cronJobIn(cfgPath, "pinned-sweep")?.modelProvider).toBeUndefined();
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
      'hx-get="/sessions/model-picker?submitted=zai%3Aglm-5.1"',
    );

    const put = await authedFetch(env, "/cron/Weekly build", {
      method: "PUT",
      body: new URLSearchParams({
        job_name: "Weekly build",
        schedule: "every weekday at 9:00",
        prompt: "Run the nightly build",
        working_dir: workDir,
        model_provider: "anthropic:claude-opus-4-6",
      }),
      headers: { "HX-Request": "true" },
    });
    expect(put.status).toBe(200);
    const putHtml = await put.text();
    expect(putHtml).toContain("anthropic / claude-opus-4-6");
    expect(cronJobIn(cfgPath, "Weekly build")).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("schedules with a picked model from the browser", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/new`);
      await page.getByRole("button", { name: "🕒 Schedule…" }).click();
      await expect(page.locator("#cron-save-slot form")).toBeVisible();

      // The form's own picker swaps in lazily; pick a non-default model.
      const picker = page.locator(
        "#cron-save-slot select[name=model_provider]",
      );
      await expect(picker).toBeVisible({ timeout: 15_000 });
      await picker.selectOption("zai:glm-5.1");

      await page.locator("input[data-schedule-input]").fill("at 7:15");
      await page.locator('input[name="job_name"]').fill("Browser model job");
      await page.locator('textarea[name="prompt"]').fill("Browser sweep");
      await page
        .locator("#cron-save-slot button[data-schedule-submit]")
        .click();
      await expect(page.locator("#cron-save-slot")).toContainText(
        "Scheduled run saved",
        { timeout: 15_000 },
      );
      await expect(page.locator("#cron-save-slot")).toContainText(
        "zai / glm-5.1",
      );
      await expect(page.locator("#cron-job-grid")).toContainText(
        "Browser model job",
      );
      expect(cronJobIn(cfgPath, "Browser model job")).toMatchObject({
        modelProvider: "zai",
        model: "glm-5.1",
      });
    });
  });
});

describe("hand-edited model pin (goose)", () => {
  let env: IntegrationEnv;
  let homeDir: string;
  let argsPath: string;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "glv-cronmodel-hand-"));
    writeGooseConfig(homeDir);
    const argsDir = mkdtempSync(join(tmpdir(), "glv-cronmodel-hargs-"));
    argsPath = join(argsDir, "args.json");
    const cfgPath = writeCronConfig(homeDir, "glv-goose", [
      {
        name: "hand-pin",
        schedule: "* * * * * *",
        prompt: "Hand pinned sweep",
        workingDir: mkdtempSync(join(tmpdir(), "glv-cronmodel-hw-")),
        modelProvider: "zai",
        model: "glm-5.3",
      },
    ]);
    env = await startIntegrationEnv(
      "glv-cronmodel-hand-",
      {
        captureArgs: argsPath,
        sessionName: "Hand Pinned Session",
      },
      homeDir,
      { GLV_CONFIG: cfgPath },
    );
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("fires a hand-written pin with the model flags", async () => {
    // The config file is the source of truth: a pin written by hand (never
    // touched by the form) reaches the agent's argv on every fire.
    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--provider")).toBe("zai");
    expect(flagValue(args, "--model")).toBe("glm-5.3");
  });
});
