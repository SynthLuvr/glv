import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: the run status the REST read paths project
// onto session rows — GET /api/sessions/:id's session object and every
// GET /api/sessions listing row carry `status`, so a polling script can
// tell queued/running from settled (completed/stopped/error) and idle
// without opening the SSE feed. Three environments hold the three mock
// behaviours (quick happy run, long-lived run, failing run) because the
// mock's sleep and exit code are fixed per environment.

type StatusRow = { id: string; status: string };

type RunAccepted = { id: string; status: string };

const runApiStatusSuite = (fx: FlavorFixture): void => {
  let envQuick: IntegrationEnv;
  let envSlow: IntegrationEnv;
  let envErr: IntegrationEnv;
  let tokenQuick = "";
  let tokenSlow = "";
  let tokenErr = "";

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Follow-up runs spawn the agent in the session's working dir, so the
  // dir must exist or the spawn rejects and the run errors immediately.
  const ensureDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  };

  const statusOf = async (
    env: IntegrationEnv,
    token: string,
    id: string,
  ): Promise<string> => {
    const res = await bearerFetch(env, `/api/sessions/${id}`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: StatusRow };
    return body.session.status;
  };

  // Polls the detail endpoint until status lands in `want`; a settled
  // run lingers in the registry for ~30s, so any reasonable poll cadence
  // observes the terminal status before it drops to "idle".
  const waitForStatus = async (
    env: IntegrationEnv,
    token: string,
    id: string,
    want: readonly string[],
  ): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const status = await statusOf(env, token, id);
      if (want.includes(status)) return status;
      if (Date.now() > deadline)
        throw new Error(
          `status of ${id} stayed "${status}"; wanted one of ` + want.join("/"),
        );
      await delay(200);
    }
  };

  const postPrompt = (
    env: IntegrationEnv,
    token: string,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    bearerFetch(env, `/api/sessions/${id}/prompt`, token, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  const postCreate = (
    env: IntegrationEnv,
    token: string,
    prompt: string,
  ): Promise<Response> => {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("working_dir", env.scratchDir);
    return bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: form,
    });
  };

  beforeAll(async () => {
    envQuick = await fx.startEnv("glv-apist-");
    envSlow = await fx.startEnv("glv-apist-slow-", { sleepMs: 30000 });
    envErr = await fx.startEnv("glv-apist-err-", { exitCode: 1 });
    tokenQuick = seedApiToken(envQuick.dbs.authDb, "api-status");
    tokenSlow = seedApiToken(envSlow.dbs.authDb, "api-status");
    tokenErr = seedApiToken(envErr.dbs.authDb, "api-status");
    ensureDir(envQuick.scratchDir + "/q");
    ensureDir(envErr.scratchDir + "/e");
    fx.seedSessions(envQuick, [
      {
        id: "as-1",
        name: "Status Idle",
        workingDir: envQuick.scratchDir + "/q",
      },
    ]);
    fx.seedSessions(envSlow, [
      { id: "as-2", name: "Status Slow", workingDir: envSlow.scratchDir },
    ]);
    fx.seedSessions(envErr, [
      {
        id: "as-3",
        name: "Status Error",
        workingDir: envErr.scratchDir + "/e",
      },
    ]);
  }, 240000);

  afterAll(async () => {
    await envQuick?.cleanup();
    await envSlow?.cleanup();
    await envErr?.cleanup();
  });

  describe("GET /api/sessions/:id status", () => {
    it("reads idle on a session that never ran", async () => {
      expect(await statusOf(envQuick, tokenQuick, fx.viewId("as-1"))).toBe(
        "idle",
      );
    });

    it("transitions running to completed around a quick run", async () => {
      const id = fx.viewId("as-1");
      const res = await postPrompt(envQuick, tokenQuick, id, "status: run me");
      expect(res.status).toBe(200);
      expect(((await res.json()) as RunAccepted).status).toBe("started");
      // A fast mock may have settled by the first read, so accept either
      // end state — but it must be one of them, never idle-with-no-signal.
      const settled = await waitForStatus(envQuick, tokenQuick, id, [
        "running",
        "completed",
      ]);
      if (settled === "running")
        expect(
          await waitForStatus(envQuick, tokenQuick, id, ["completed"]),
        ).toBe("completed");
    });

    it("reads running while the agent is alive, then stopped after a stop", async () => {
      const res = await postCreate(envSlow, tokenSlow, "status: long run");
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as RunAccepted;

      expect(await waitForStatus(envSlow, tokenSlow, id, ["running"])).toBe(
        "running",
      );

      const stop = await bearerFetch(
        envSlow,
        `/api/sessions/${id}/stop`,
        tokenSlow,
        { method: "POST" },
      );
      expect(stop.status).toBe(200);
      expect(await waitForStatus(envSlow, tokenSlow, id, ["stopped"])).toBe(
        "stopped",
      );
    });

    it("reads error after a failing run", async () => {
      const id = fx.viewId("as-3");
      const res = await postPrompt(envErr, tokenErr, id, "status: fail me");
      expect(res.status).toBe(200);
      expect(await waitForStatus(envErr, tokenErr, id, ["error"])).toBe(
        "error",
      );
    });

    it("answers 404 for an unknown session", async () => {
      const res = await bearerFetch(envQuick, "/api/sessions/nope", tokenQuick);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });
  });

  describe("GET /api/sessions status", () => {
    it("decorates every listing row, live and idle alike", async () => {
      const res = await bearerFetch(envSlow, "/api/sessions", tokenSlow);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as StatusRow[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(
          ["queued", "running", "completed", "stopped", "error", "idle"],
          `row ${row.id}`,
        ).toContain(row.status);

      const seeded = rows.find((row) => row.id === fx.viewId("as-2"));
      expect(seeded?.status).toBe("idle");
    });
  });

  describe("GET /api/openapi.json", () => {
    it("documents the status field on the Session schema", async () => {
      const res = await bearerFetch(envQuick, "/api/openapi.json", tokenQuick);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, { enum?: string[] }> }
          >;
        };
      };
      const session = doc.components.schemas.Session?.properties;
      expect(session?.id).toBeDefined();
      expect(session?.status?.enum).toEqual([
        "completed",
        "error",
        "idle",
        "queued",
        "running",
        "stopped",
      ]);
    });
  });
};

export { runApiStatusSuite };
