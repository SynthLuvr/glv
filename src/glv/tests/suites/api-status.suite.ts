import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  type MockConfig,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: the run status the REST read paths project
// onto session rows — GET /api/sessions/:id's session object and every
// GET /api/sessions listing row carry `status`, so a polling script can
// tell queued/running from settled (completed/stopped/error) and idle
// without opening the SSE feed. Three environments hold the three mock
// behaviours (quick happy run, long-lived run, failing run) because the
// mock's sleep and exit code are fixed per environment.

// Every value a session row's `status` can hold.
const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "stopped",
  "error",
  "idle",
] as const;

type StatusRow = { id: string; status: string };

type RunAccepted = { id: string; status: string };

// One mock environment bound to the API token that speaks for it, so a
// helper can never pair one env's server with another env's token.
type StatusClient = { env: IntegrationEnv; token: string };

const runApiStatusSuite = (fx: FlavorFixture): void => {
  let quick: StatusClient;
  let slow: StatusClient;
  let failing: StatusClient;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const startClient = async (
    prefix: string,
    mock: MockConfig = {},
  ): Promise<StatusClient> => {
    const env = await fx.startEnv(prefix, mock);
    return { env, token: seedApiToken(env.dbs.authDb, "api-status") };
  };

  // Any request against a client's env, authenticated with its token.
  const fetchApi = (
    client: StatusClient,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => bearerFetch(client.env, path, client.token, init);

  // Follow-up runs spawn the agent in the session's working dir, so the
  // dir must exist or the spawn rejects and the run errors immediately.
  const ensureDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  };

  const statusOf = async (
    client: StatusClient,
    id: string,
  ): Promise<string> => {
    const res = await fetchApi(client, `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: StatusRow };
    return body.session.status;
  };

  // Polls the detail endpoint until status lands in `want`; a settled
  // run lingers in the registry for ~30s, so any reasonable poll cadence
  // observes the terminal status before it drops to "idle".
  const waitForStatus = async (
    client: StatusClient,
    id: string,
    want: readonly string[],
  ): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const status = await statusOf(client, id);
      if (want.includes(status)) return status;
      if (Date.now() > deadline)
        throw new Error(
          `status of ${id} stayed "${status}"; wanted one of ` + want.join("/"),
        );
      await delay(200);
    }
  };

  const postPrompt = (
    client: StatusClient,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    fetchApi(client, `/api/sessions/${id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  const postCreate = (
    client: StatusClient,
    prompt: string,
  ): Promise<Response> => {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("working_dir", client.env.scratchDir);
    return fetchApi(client, "/api/sessions", { method: "POST", body: form });
  };

  beforeAll(async () => {
    quick = await startClient("glv-apist-");
    slow = await startClient("glv-apist-slow-", { sleepMs: 30000 });
    failing = await startClient("glv-apist-err-", { exitCode: 1 });
    ensureDir(quick.env.scratchDir + "/q");
    ensureDir(failing.env.scratchDir + "/e");
    fx.seedSessions(quick.env, [
      {
        id: "as-1",
        name: "Status Idle",
        workingDir: quick.env.scratchDir + "/q",
      },
    ]);
    fx.seedSessions(slow.env, [
      { id: "as-2", name: "Status Slow", workingDir: slow.env.scratchDir },
    ]);
    fx.seedSessions(failing.env, [
      {
        id: "as-3",
        name: "Status Error",
        workingDir: failing.env.scratchDir + "/e",
      },
    ]);
  }, 240000);

  afterAll(async () => {
    await quick?.env.cleanup();
    await slow?.env.cleanup();
    await failing?.env.cleanup();
  });

  describe("GET /api/sessions/:id status", () => {
    it("reads idle on a session that never ran", async () => {
      expect(await statusOf(quick, fx.viewId("as-1"))).toBe("idle");
    });

    it("transitions running to completed around a quick run", async () => {
      const id = fx.viewId("as-1");
      const res = await postPrompt(quick, id, "status: run me");
      expect(res.status).toBe(200);
      expect(((await res.json()) as RunAccepted).status).toBe("started");
      // A fast mock may have settled by the first read, so accept either
      // end state — but it must be one of them, never idle-with-no-signal.
      const settled = await waitForStatus(quick, id, ["running", "completed"]);
      if (settled === "running")
        expect(await waitForStatus(quick, id, ["completed"])).toBe("completed");
    });

    it("reads running while the agent is alive, then stopped after a stop", async () => {
      const res = await postCreate(slow, "status: long run");
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as RunAccepted;

      expect(await waitForStatus(slow, id, ["running"])).toBe("running");

      const stop = await fetchApi(slow, `/api/sessions/${id}/stop`, {
        method: "POST",
      });
      expect(stop.status).toBe(200);
      expect(await waitForStatus(slow, id, ["stopped"])).toBe("stopped");
    });

    it("reads error after a failing run", async () => {
      const id = fx.viewId("as-3");
      const res = await postPrompt(failing, id, "status: fail me");
      expect(res.status).toBe(200);
      expect(await waitForStatus(failing, id, ["error"])).toBe("error");
    });

    it("answers 404 for an unknown session", async () => {
      const res = await fetchApi(quick, "/api/sessions/nope");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });
  });

  describe("GET /api/sessions status", () => {
    it("decorates every listing row, live and idle alike", async () => {
      const res = await fetchApi(slow, "/api/sessions");
      expect(res.status).toBe(200);
      const rows = (await res.json()) as StatusRow[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(RUN_STATUSES, `row ${row.id}`).toContain(row.status);

      const seeded = rows.find((row) => row.id === fx.viewId("as-2"));
      expect(seeded?.status).toBe("idle");
    });
  });

  describe("GET /api/openapi.json", () => {
    it("documents the status field on the Session schema", async () => {
      const res = await fetchApi(quick, "/api/openapi.json");
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
