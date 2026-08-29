import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  flagValue,
  type IntegrationEnv,
  postFollowUp,
  postNewSession,
  waitForArgs,
} from "../../glv/tests/harness.js";
import { insertSessions, startIntegrationEnv } from "./integration-harness.js";

// goose's provider config, as `goose configure` writes it: one model per
// provider. Includes entries the picker must NOT offer (disabled provider,
// empty model) alongside two usable ones.
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
  disabled-prov:
    enabled: false
    model: hidden-model
    configured: true
  bare:
    enabled: true
    model: ""
    configured: true
`;

describe("new-session model picker (goose)", () => {
  let env: IntegrationEnv;
  let bareEnv: IntegrationEnv;
  let workDir: string;
  let followupDir: string;
  let argsDir: string;
  let argsPath: string;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "glv-model-home-"));
    mkdirSync(join(home, ".config", "goose"), { recursive: true });
    writeFileSync(join(home, ".config", "goose", "config.yaml"), CONFIG_YAML);

    argsDir = mkdtempSync(join(tmpdir(), "glv-model-args-"));
    argsPath = join(argsDir, "args.json");

    env = await startIntegrationEnv(
      "glv-model-",
      { captureArgs: argsPath },
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
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
    await bareEnv?.cleanup();
    rmSync(argsDir, { recursive: true, force: true });
  });

  it("lists only models configured in goose, default preselected", async () => {
    const res = await authedFetch(env, "/sessions/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('name="model_provider"');
    expect(html).toContain("goose default — zai / glm-5.3");
    expect(html).toContain("zai — glm-5.3");
    expect(html).toContain("anthropic — claude-sonnet-4-5");
    // Unusable entries never appear.
    expect(html).not.toContain("hidden-model");
    expect(html).not.toContain("disabled-prov");
    expect(html).not.toContain("bare");
  });

  it("starts the run with --provider/--model for a picked model", async () => {
    const res = await authedFetch(env, "/sessions", {
      method: "POST",
      body: new URLSearchParams({
        prompt: "inspect the project",
        working_dir: workDir,
        model_provider: "anthropic",
      }),
    });
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--provider")).toBe("anthropic");
    expect(flagValue(args, "--model")).toBe("claude-sonnet-4-5");
  });

  it("passes no model flags when the default is kept", async () => {
    rmSync(argsPath, { force: true });
    const res = await postNewSession(env, workDir, "run with the default");
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("rejects a model that is no longer configured", async () => {
    const res = await authedFetch(env, "/sessions", {
      method: "POST",
      body: new URLSearchParams({
        prompt: "use a ghost model",
        working_dir: workDir,
        model_provider: "ghost",
      }),
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("no longer configured in goose");
    // The form re-renders rather than leaking a broken selection.
    expect(html).toContain('name="model_provider"');
  });

  it("keeps model flags off follow-up (resume) runs", async () => {
    // The follow-up bar has no model picker; a resumed run must keep the
    // session's model, not inherit goose's current default.
    rmSync(argsPath, { force: true });
    const res = await postFollowUp(env, "resume-target", "and then summarize");
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--session-id")).toBe("resume-target");
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("hides the picker when goose has no configured models", async () => {
    const res = await authedFetch(bareEnv, "/sessions/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('name="model_provider"');
  });
});
