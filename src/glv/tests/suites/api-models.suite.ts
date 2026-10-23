import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  type MockConfig,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: GET /api/models (#342) — the catalogue the
// combined New Session picker renders from, exposed for scripts. One
// entry per served agent: every model it offers (provider, model id,
// label) plus the agent's own default, each model carrying `pin` — the
// exact spelling the `model` field of POST /api/sessions accepts. Every
// flavour binds this suite with the catalogue its agent offers; the
// discovered pins are then round-tripped through POST /api/sessions to
// prove they validate, and a pin the catalogue does not offer is proved
// to still reject.

type ExpectedModel = {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
};

type ExpectedAgent = {
  readonly agent: string;
  readonly label: string;
  readonly default?: { readonly provider: string; readonly model: string };
  readonly models: readonly ExpectedModel[];
};

// The wire body the catalogue assertion compares against: each model's
// pin is the combined spelling of its triple.
const expectedBody = (agents: readonly ExpectedAgent[]): unknown => ({
  agents: agents.map((entry) => ({
    agent: entry.agent,
    label: entry.label,
    ...(entry.default === undefined ? {} : { default: entry.default }),
    models: entry.models.map((model) => ({
      provider: model.provider,
      model: model.model,
      label: model.label,
      pin: `${entry.agent}:${model.provider}:${model.model}`,
    })),
  })),
});

type ModelsSuiteOptions = {
  /** Mock config for the booted env (goose binds its ACP fixture). */
  readonly mock?: MockConfig;
  /** Prepares the flavour's config under the fake home before boot. */
  readonly prepareHome?: (home: string) => void;
  /** The catalogue the endpoint must answer with, in picker order. */
  readonly expected: readonly ExpectedAgent[];
};

// One agent slice off the wire, narrowed for the assertions below.
type CatalogueAgent = {
  readonly agent: string;
  readonly label: string;
  readonly models: readonly {
    readonly provider: string;
    readonly pin: string;
  }[];
};

const runApiModelsSuite = (
  fx: FlavorFixture,
  { mock, prepareHome, expected }: ModelsSuiteOptions,
): void => {
  let env: IntegrationEnv;
  let home: string;
  let token = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "glv-apimodels-home-"));
    prepareHome?.(home);
    env = await fx.startEnv("glv-apimodels-", mock, home, {
      // The catalogue's defaults must not depend on the host's shell:
      // empty strings fall through every override branch the model
      // sources read (GOOSE_PROVIDER/GOOSE_MODEL and ANTHROPIC_MODEL
      // for the default; GOOSE_PATH_ROOT for the config location), so
      // the expected catalogue comes from the prepared home alone.
      GOOSE_PROVIDER: "",
      GOOSE_MODEL: "",
      GOOSE_PATH_ROOT: "",
      ANTHROPIC_MODEL: "",
    });
    token = seedApiToken(env.dbs.authDb, "api-models");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  // The bearer catalogue read the submit round-trips start from.
  const catalogue = async (): Promise<readonly CatalogueAgent[]> => {
    const res = await bearerFetch(env, "/api/models", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: CatalogueAgent[] };
    return body.agents;
  };

  // The first agent slice, guaranteed to offer at least one model —
  // what both submit round-trips below pin from.
  const firstOfferingAgent = async (): Promise<CatalogueAgent> => {
    const first = (await catalogue())[0];
    if (first === undefined || first.models.length === 0)
      throw new Error("the catalogue offered no model to pin");
    return first;
  };

  describe("GET /api/models", () => {
    it("rejects an unauthenticated request with 401 JSON", async () => {
      const res = await fetch(`${env.baseUrl}/api/models`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("admits the session cookie — reads never need the bearer", async () => {
      const res = await authedFetch(env, "/api/models");
      expect(res.status).toBe(200);
    });

    it("answers the combined catalogue with submit-ready pins", async () => {
      const res = await bearerFetch(env, "/api/models", token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expectedBody(expected));
    });

    it("accepts a pin discovered from the catalogue at submit time", async () => {
      const first = await firstOfferingAgent();
      const res = await bearerFetch(env, "/api/sessions", token, {
        method: "POST",
        body: new URLSearchParams({
          prompt: "api models: submit a pin discovered from the catalogue",
          working_dir: env.scratchDir,
          model: first.models[0].pin,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { status: string };
      expect(["started", "queued"]).toContain(body.status);
    });

    it("still rejects a pin the catalogue does not offer", async () => {
      const first = await firstOfferingAgent();
      const res = await bearerFetch(env, "/api/sessions", token, {
        method: "POST",
        body: new URLSearchParams({
          prompt: "api models: a pin the catalogue does not offer",
          working_dir: env.scratchDir,
          model: `${first.agent}:${first.models[0].provider}:no-such-model`,
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error:
          `That model is no longer available in ${first.label}. ` +
          "Pick another from the list.",
      });
    });
  });
};

export { runApiModelsSuite };
