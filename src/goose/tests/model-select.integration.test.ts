import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { writeGooseConfig } from "../../glv/tests/goose-config.js";
import {
  authedFetch,
  flagValue,
  type IntegrationEnv,
  postFollowUp,
  postNewSession,
  waitForArgs,
  withPage,
} from "../../glv/tests/harness.js";
import { fetchModelPicker } from "../../glv/tests/model-picker.js";
import {
  gooseFixture,
  insertSessions,
  startIntegrationEnv,
} from "./integration-harness.js";

// The model picker is one combined select: every entry — including which
// agent runs — is spelled "<agent>:<model value>". On this single-agent
// fixture every value carries the "goose:" prefix; the combined fixture
// covers the cross-agent picks.

// goose's provider config, as `goose configure` writes it: one configured
// model per provider. Includes entries the picker must NOT offer (disabled
// provider, empty model) alongside usable ones. zai mirrors the real setup
// that motivated the catalogue work: one configured model out of the many
// the provider actually offers. grok is deliberately absent from the ACP
// catalogue below (a custom provider goose has no static list for).
const CONFIG_YAML = `active_provider: zai
providers:
  zai:
    enabled: true
    model: glm-5.3
    configured: true
  claude-acp:
    enabled: true
    model: current
    configured: true
  anthropic:
    enabled: true
    model: claude-sonnet-4-5
    configured: true
  grok:
    enabled: true
    model: grok-4
    configured: true
  disabled-prov:
    enabled: false
    model: hidden-model
    configured: true
  bare:
    enabled: true
    model: ""
    configured: true
`;

// What the mock reports for `_goose/unstable/providers/list`: static
// catalogue models for zai/anthropic, none for claude-acp (an ACP provider
// that only knows its models at runtime), nothing at all for grok.
const ACP_PROVIDERS = JSON.stringify({
  entries: [
    {
      providerId: "zai",
      providerName: "Z.AI",
      models: [
        { id: "glm-5.3", name: "GLM-5.3" },
        { id: "glm-5.3[1m]", name: "GLM-5.3 1M" },
        { id: "glm-5.1", name: "GLM-5.1" },
        { id: "glm-4.6", name: "GLM-4.6" },
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
    { providerId: "claude-acp", providerName: "Claude Code ACP", models: [] },
  ],
});

// What the mock reports for `_goose/unstable/providers/supported-models/list`
// when asked about claude-acp: the models the wrapped agent itself offers.
const ACP_SUPPORTED_MODELS = JSON.stringify({
  "claude-acp": ["default", "sonnet", "claude-fable-5[1m]", "opus", "haiku"],
});

describe("new-session model picker (goose)", () => {
  let env: IntegrationEnv;
  let bareEnv: IntegrationEnv;
  let legacyEnv: IntegrationEnv;
  let workDir: string;
  let followupDir: string;
  let argsDir: string;
  let argsPath: string;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "glv-model-home-"));
    writeGooseConfig(home, CONFIG_YAML);
    argsDir = mkdtempSync(join(tmpdir(), "glv-model-args-"));
    argsPath = join(argsDir, "args.json");

    env = await startIntegrationEnv(
      "glv-model-",
      {
        captureArgs: argsPath,
        acpProviders: ACP_PROVIDERS,
        acpSupportedModels: ACP_SUPPORTED_MODELS,
      },
      home,
    );

    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
    followupDir = join(env.scratchDir, "followup");
    mkdirSync(followupDir, { recursive: true });

    // A session to resume in the follow-up test.
    insertSessions(env.dbs.flavor.sessionsDb, [
      { id: "resume-target", name: "Resume Target", workingDir: followupDir },
    ]);

    // No goose config at all → the form shows no picker.
    const bareHome = mkdtempSync(join(tmpdir(), "glv-model-bare-"));
    bareEnv = await startIntegrationEnv("glv-model-bare-", {}, bareHome);

    // A goose too old for the ACP catalogue extensions: every _goose method
    // answers "method not found", so the picker must fall back to the one
    // configured model per provider.
    const legacyHome = mkdtempSync(join(tmpdir(), "glv-model-legacy-"));
    writeGooseConfig(legacyHome, CONFIG_YAML);
    legacyEnv = await startIntegrationEnv("glv-model-legacy-", {}, legacyHome);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    await bareEnv?.cleanup();
    await legacyEnv?.cleanup();
    rmSync(argsDir, { recursive: true, force: true });
  });

  it("renders the form instantly with a lazy picker slot", async () => {
    const res = await authedFetch(env, "/sessions/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    // The picker itself is not in the initial HTML: resolving the catalogue
    // can spawn the agent binary, and the form must never block on that.
    // The agent select is gone entirely — the pick names the agent.
    expect(html).not.toContain('name="agent"');
    expect(html).not.toContain('name="model"');
    expect(html).toContain('class="form-field model-picker-slot"');
    expect(html).toContain('hx-get="/sessions/model-picker"');
    expect(html).toContain('hx-trigger="load"');
  });

  // The lazy load must not gate the form either: htmx hands
  // hx-disabled-elt down to descendant requests, so the picker's load GET
  // kept Start session disabled until the catalogue resolved. Hold the
  // fragment back and start a session anyway.
  it("shows the loading spinner and never gates session start", async () => {
    await withPage(env.context, async (page) => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/sessions/model-picker*", async (route) => {
        await gate;
        await route.continue();
      });
      const startSession = async (): Promise<void> => {
        await page.goto(`${env.baseUrl}/sessions/new`);
        await expect(page.locator(".model-slot-loading")).toBeVisible();
        await page
          .locator('textarea[name="prompt"]')
          .fill("Start without waiting for models");
        await page.locator('input[name="working_dir"]').fill(workDir);
        await expect(page.locator("button.send-btn")).toBeEnabled();
        await page.locator("button.send-btn").click();
        // The session starts anyway: the detail pane swaps to its
        // transcript with a prompt bar.
        await expect(page.locator("form.prompt-bar")).toBeVisible({
          timeout: 20000,
        });
      };
      try {
        await startSession();
      } finally {
        release();
      }
    });
  }, 60000);

  it("lists every model each configured provider offers", async () => {
    const html = await fetchModelPicker(env);
    expect(html).toContain('name="model"');
    expect(html).toContain('<optgroup label="goose">');
    expect(html).toContain("goose default — zai / glm-5.3");
    expect(html).toContain('value="goose:" selected=""');
    // Static catalogue models, submitted as agent-prefixed provider/model
    // pairs. Several providers sit behind one agent, so labels carry the
    // provider the old per-provider optgroups named.
    expect(html).toContain("zai / GLM-5.1");
    expect(html).toContain('value="goose:zai:glm-5.1"');
    expect(html).toContain('value="goose:zai:glm-5.3[1m]"');
    expect(html).toContain("anthropic / Claude Opus 4.6");
    expect(html).toContain('value="goose:anthropic:claude-opus-4-6"');
    // claude-acp has no static catalogue: its models come from the live
    // supported-models query, with the configured model appended.
    expect(html).toContain("claude-acp / opus");
    expect(html).toContain('value="goose:claude-acp:opus"');
    expect(html).toContain('value="goose:claude-acp:current"');
    // A provider absent from the catalogue still shows its configured model.
    expect(html).toContain("grok / grok-4");
    expect(html).toContain('value="goose:grok:grok-4"');
    // Unusable entries never appear.
    expect(html).not.toContain("hidden-model");
    expect(html).not.toContain("disabled-prov");
    expect(html).not.toContain("bare");
  });

  it("starts the run with --provider/--model for a picked model", async () => {
    const res = await postNewSession(
      env,
      workDir,
      "inspect the project",
      "goose:zai:glm-5.1",
    );
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--provider")).toBe("zai");
    expect(flagValue(args, "--model")).toBe("glm-5.1");
  });

  it("passes a live-discovered model through to the run", async () => {
    // Drop the prior run's capture so waitForArgs waits for this run —
    // a leftover file resolves instantly with its stale flags.
    rmSync(argsPath, { force: true });
    const res = await postNewSession(
      env,
      workDir,
      "use the claude adapter",
      "goose:claude-acp:opus",
    );
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--provider")).toBe("claude-acp");
    expect(flagValue(args, "--model")).toBe("opus");
  });

  it("passes no model flags when a default entry is kept", async () => {
    rmSync(argsPath, { force: true });
    const res = await postNewSession(
      env,
      workDir,
      "run with the default",
      "goose:",
    );
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("passes no model flags when the field is absent entirely", async () => {
    rmSync(argsPath, { force: true });
    const res = await postNewSession(env, workDir, "plain submit");
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("rejects a pick naming an agent that is not served", async () => {
    const res = await postNewSession(
      env,
      workDir,
      "use a ghost agent",
      "ghost:whatever",
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("not enabled");
    expect(html).toContain("ghost");
    // The form re-renders rather than leaking a broken selection: the lazy
    // slot comes back carrying the submitted value so the picker restores it.
    expect(html).toContain('class="form-field model-picker-slot"');
    expect(html).toContain(
      'hx-get="/sessions/model-picker?submitted=ghost%3Awhatever"',
    );
  });

  it("rejects a model the provider does not offer", async () => {
    const res = await postNewSession(
      env,
      workDir,
      "use a ghost model",
      "goose:zai:not-a-glm",
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("no longer available in goose");
    expect(html).toContain(
      'hx-get="/sessions/model-picker?submitted=goose%3Azai%3Anot-a-glm"',
    );
  });

  it("keeps model flags off follow-up (resume) runs", async () => {
    // The follow-up bar has no model picker; a resumed run must keep the
    // session's model, not inherit goose's current default.
    rmSync(argsPath, { force: true });
    const res = await postFollowUp(
      env,
      gooseFixture.viewId("resume-target"),
      "and then summarize",
    );
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--session-id")).toBe("resume-target");
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("leaves the paste tip alone next to the picker hint", async () => {
    // Regression: the picker hint shipped reusing .paste-hint, which
    // uploads.ts rewrites (first match in the form) — producing a second
    // "Tip: paste images with Ctrl+V" and clobbering the picker hint.
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/new`);
      const pasteHints = page.locator("form.new-session-form .paste-hint");
      await expect(pasteHints).toHaveCount(1);
      // The uploads script rewrites it per platform once the page settles.
      await expect(pasteHints.first()).toHaveText(/^Tip: paste images with /);
      const modelHint = page.locator("form.new-session-form .model-hint");
      await expect(modelHint).toHaveCount(1);
      await expect(modelHint).toHaveText(/Each agent lists the models/);
    });
  });

  it("hides the picker when goose has no configured models", async () => {
    const form = await authedFetch(bareEnv, "/sessions/new");
    const formHtml = await form.text();
    expect(form.status).toBe(200);
    expect(formHtml).not.toContain("model-picker-slot");
    expect(formHtml).not.toContain('name="model"');
    // The fragment answers with a hidden placeholder: an empty body would
    // make htmx skip the swap and strand the loading slot forever.
    const fragHtml = await fetchModelPicker(bareEnv);
    expect(fragHtml).toContain("model-picker-empty");
    expect(fragHtml).not.toContain('name="model"');
  });

  it("falls back to configured models when the agent can't list them", async () => {
    const form = await authedFetch(legacyEnv, "/sessions/new");
    const formHtml = await form.text();
    expect(form.status).toBe(200);
    expect(formHtml).toContain('class="form-field model-picker-slot"');
    const html = await fetchModelPicker(legacyEnv);
    // One option per provider — the configured model — and no catalogue
    // entries, but still a working picker.
    expect(html).toContain('name="model"');
    expect(html).toContain('<optgroup label="goose">');
    expect(html).toContain('value="goose:zai:glm-5.3"');
    expect(html).not.toContain("glm-5.1");
    expect(html).toContain('value="goose:claude-acp:current"');
  });
});
