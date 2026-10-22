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
  bearerFetch,
  type IntegrationEnv,
  seedApiToken,
} from "../../glv/tests/harness.js";
import { startIntegrationEnv } from "./integration-harness.js";

// Regression (#338): submit-time model validation used to consult only
// the catalogue cache, so with a cold cache — a scripts/CI submit before
// any picker had rendered, or the 60s TTL simply lapsed — any model id
// validated. A typo'd `model` pin answered 201 and started a run that
// died at goose startup instead of answering 422. The submit itself must
// now pay the one-off catalogue fetch, so the verdict matches the
// picker's no matter how cold the cache is.
//
// Coldness is staged by delaying the mock's ACP answers past the boot
// warm-up: the server's own picker fetch is still in flight when the
// tests post, which is exactly the state an API caller hits. Well under
// the 10s initialize timeout so the conversation still completes.

const ACP_DELAY_MS = 4000;

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
      models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
    },
  ],
});

const startColdEnv = async (
  prefix: string,
): Promise<{ env: IntegrationEnv; home: string }> => {
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  writeGooseConfig(home, TWO_PROVIDER_CONFIG_YAML);
  const env = await startIntegrationEnv(
    prefix,
    { acpDelayMs: ACP_DELAY_MS, acpProviders: ACP_PROVIDERS },
    home,
  );
  return { env, home };
};

const UNAVAILABLE = {
  error:
    "That model is no longer available in goose. Pick another from the list.",
};

describe("session-start model validation against a cold catalogue (goose)", () => {
  let env: IntegrationEnv;
  let home: string;
  let token = "";

  beforeAll(async () => {
    ({ env, home } = await startColdEnv("glv-cold-sess-"));
    token = seedApiToken(env.dbs.authDb, "cold-sessions");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a typo'd model pin with 422 instead of a doomed run", async () => {
    // Posted while the boot-time fetch is still stalled — pre-fix this
    // answered 201 (the pin validated against nothing) and the run died
    // at goose startup.
    const res = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({
        prompt: "cold catalogue: typo pin",
        working_dir: env.scratchDir,
        model: "goose:zai:glm-5,3",
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(UNAVAILABLE);
  }, 30000);

  it("still starts a run pinned to a model the catalogue knows", async () => {
    // A non-configured but catalogued model (the configured one is
    // glm-5.3) must keep validating once the fetch has been paid for.
    const res = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({
        prompt: "cold catalogue: valid pin",
        working_dir: env.scratchDir,
        model: "goose:zai:glm-5.1",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("started");
  }, 30000);
});

describe("scheduled-run model validation against a cold catalogue (goose)", () => {
  let env: IntegrationEnv;
  let home: string;
  let token = "";

  beforeAll(async () => {
    ({ env, home } = await startColdEnv("glv-cold-cron-"));
    token = seedApiToken(env.dbs.authDb, "cold-cron");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a typo'd model pin when saving the job", async () => {
    // Pre-fix the job saved against the empty cache and every one of its
    // fires would start a doomed run.
    const res = await bearerFetch(env, "/api/cron", token, {
      method: "POST",
      body: new URLSearchParams({
        name: "cold-typo",
        schedule: "every weekday at 9:00",
        prompt: "Cold catalogue: typo pin",
        working_dir: env.scratchDir,
        model: "goose:zai:glm-5,3",
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(UNAVAILABLE);
  }, 30000);

  it("saves the job when the pin names a catalogued model", async () => {
    const res = await bearerFetch(env, "/api/cron", token, {
      method: "POST",
      body: new URLSearchParams({
        name: "cold-valid",
        schedule: "every weekday at 9:00",
        prompt: "Cold catalogue: valid pin",
        working_dir: env.scratchDir,
        model: "goose:zai:glm-5.1",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      model_provider?: string;
      model?: string;
    };
    expect(body).toMatchObject({ model_provider: "zai", model: "glm-5.1" });
  }, 30000);
});
