import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  type MockConfig,
  seedApiToken,
} from "../harness.js";

// The wait primitive over real HTTP (#341): GET /api/sessions/:id/wait
// parks while the session's run is queued or running and answers the
// moment it settles — the single call that replaces the poll loop an
// orchestration script (fix run → refactor run → merge) used to hold.
// A resolved wait (200) carries the terminal status and the persisted
// last_run verdict; a deadline that hits first answers 202 with the
// live status, so re-calling covers runs longer than any single
// deadline. Three environments hold the mock behaviours (scripted
// lines file re-read per run, long-lived run, crash exit) because the
// mock's sleep and exit code are fixed per environment.

type LastRun = { state: string; reason?: string; ended_at: string };

type WaitResult = {
  id: string;
  status: string;
  last_run?: LastRun;
  error?: string;
};

type RunAccepted = { id: string; status: string };

// The live statuses a still-active answer (202) carries, whichever side
// of the spawn a snapshot catches.
const LIVE_STATUSES: readonly string[] = ["running", "queued"];

// One mock environment bound to the API token that speaks for it, so a
// helper can never pair one env's server with another env's token.
type WaitClient = { env: IntegrationEnv; token: string };

const runApiWaitSuite = (fx: FlavorFixture): void => {
  let main: WaitClient;
  let slow: WaitClient;
  let crash: WaitClient;
  let linesDir: string;

  const linesFileFor = (name: string): string => join(linesDir, name);

  const writeLines = (name: string, lines: readonly string[]): void => {
    const path = linesFileFor(name);
    writeFileSync(path, `${lines.join("\n")}\n`);
  };

  const startClient = async (
    prefix: string,
    mock: MockConfig = {},
  ): Promise<WaitClient> => {
    const env = await fx.startEnv(prefix, mock);
    return { env, token: seedApiToken(env.dbs.authDb, "api-wait") };
  };

  const fetchApi = (
    client: WaitClient,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => bearerFetch(client.env, path, client.token, init);

  // Follow-up runs spawn the agent in the session's working dir, so the
  // dir must exist or the spawn rejects and the run errors immediately.
  const seedSession = (client: WaitClient, id: string, name: string) => {
    const workingDir = join(client.env.scratchDir, "w");
    mkdirSync(workingDir, { recursive: true });
    fx.seedSessions(client.env, [{ id, name, workingDir }]);
    fx.seedMessages(client.env, id, [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  };

  // One wait call; `timeout` accepts raw strings so the 422 cases can
  // send values no number parser would mint.
  const waitOn = async (
    client: WaitClient,
    id: string,
    timeout?: number | string,
  ): Promise<{ status: number; body: WaitResult }> => {
    const path =
      timeout === undefined
        ? `/api/sessions/${id}/wait`
        : `/api/sessions/${id}/wait?timeout=${timeout}`;
    const res = await fetchApi(client, path);
    return { status: res.status, body: (await res.json()) as WaitResult };
  };

  const postPrompt = (
    client: WaitClient,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    fetchApi(client, `/api/sessions/${id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  const postCreate = (
    client: WaitClient,
    prompt: string,
  ): Promise<Response> => {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("working_dir", client.env.scratchDir);
    return fetchApi(client, "/api/sessions", { method: "POST", body: form });
  };

  beforeAll(async () => {
    linesDir = mkdtempSync(join(tmpdir(), "glv-apiwait-"));
    writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
    main = await startClient("glv-apiwait-", {
      linesFile: linesFileFor("main.txt"),
    });
    slow = await startClient("glv-apiwait-slow-", { sleepMs: 30000 });
    crash = await startClient("glv-apiwait-err-", { exitCode: 1 });
    seedSession(main, "aw-1", "Wait One");
    seedSession(main, "aw-fresh", "Never Ran");
    seedSession(crash, "aw-1", "Wait Crash");
  }, 240000);

  afterAll(async () => {
    await main?.env.cleanup();
    await slow?.env.cleanup();
    await crash?.env.cleanup();
    rmSync(linesDir, { recursive: true, force: true });
  });

  describe("GET /api/sessions/:id/wait", () => {
    it("answers idle immediately on a session that never ran", async () => {
      const id = fx.viewId("aw-fresh");
      const answer = await waitOn(main, id);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ id, status: "idle" });
    });

    it("resolves when a started run settles, carrying the verdict", async () => {
      // The headline orchestration shape: create, then one wait — no
      // poll loop between them.
      const res = await postCreate(main, "wait: run me to the end");
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as RunAccepted;
      const answer = await waitOn(main, id, 30000);
      expect(answer.status).toBe(200);
      expect(answer.body.id).toBe(id);
      expect(answer.body.status).toBe("completed");
      expect(answer.body.last_run?.state).toBe("finished");
      expect(
        Number.isNaN(Date.parse(answer.body.last_run?.ended_at ?? "")),
      ).toBe(false);
      // Still settled an instant later — the registry window answers a
      // re-wait the same way.
      const again = await waitOn(main, id);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe("completed");
    });

    it("resolves a follow-up run the same way", async () => {
      const id = fx.viewId("aw-1");
      const res = await postPrompt(main, id, "wait: follow up");
      expect(res.status).toBe(200);
      const answer = await waitOn(main, id, 30000);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ id, status: "completed" });
      expect(answer.body.last_run?.state).toBe("finished");
    });

    it("answers 202 with the live status when the deadline passes", async () => {
      const created = await postCreate(slow, "wait: outlive the deadline");
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as RunAccepted;
      const started = Date.now();
      const answer = await waitOn(slow, id, 300);
      const elapsed = Date.now() - started;
      expect(answer.status).toBe(202);
      // The mock sleeps 30 s, so the run cannot have settled: the answer
      // is the deadline, and it honoured the asked-for window.
      expect(LIVE_STATUSES).toContain(answer.body.status);
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(10000);

      // timeout=0 is the no-park snapshot of the same run.
      const snap = await waitOn(slow, id, 0);
      expect(snap.status).toBe(202);
      expect(LIVE_STATUSES).toContain(snap.body.status);
    });

    it("resolves a requested stop with the stopped verdict", async () => {
      const created = await postCreate(slow, "wait: stop me");
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as RunAccepted;
      expect((await waitOn(slow, id, 0)).status).toBe(202);
      const stop = await fetchApi(slow, `/api/sessions/${id}/stop`, {
        method: "POST",
      });
      expect(stop.status).toBe(200);
      const answer = await waitOn(slow, id, 30000);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ id, status: "stopped" });
      expect(answer.body.last_run?.state).toBe("stopped");
    });

    it("carries the crash verdict on a failed run", async () => {
      const id = fx.viewId("aw-1");
      const res = await postPrompt(crash, id, "wait: crash me");
      expect(res.status).toBe(200);
      const answer = await waitOn(crash, id, 30000);
      expect(answer.status).toBe(200);
      expect(answer.body.status).toBe("error");
      expect(answer.body.last_run?.state).toBe("failed");
      expect(answer.body.last_run?.reason).toContain("exited with code 1");
    });

    it("carries the stopped-early verdict on a provider refusal", async () => {
      writeLines("main.txt", [
        fx.refusalRecord(
          "Rate limit exceeded: usage limit reached. Your quota resets at 17:01.",
        ),
      ]);
      const id = fx.viewId("aw-1");
      const res = await postPrompt(main, id, "wait: hit the limit");
      expect(res.status).toBe(200);
      const answer = await waitOn(main, id, 30000);
      // The refusal printed and the process still exited 0: the wait's
      // status says the run errored, the verdict says why the provider
      // stopped it — the gap this endpoint was asked to close.
      expect(answer.status).toBe(200);
      expect(answer.body.status).toBe("error");
      expect(answer.body.last_run?.state).toBe("stopped_early");
      expect(answer.body.last_run?.reason).toContain("resets at 17:01");
    });

    it("answers 404 for an unknown session", async () => {
      const res = await fetchApi(main, "/api/sessions/nope/wait");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });

    it("rejects an unparsable or out-of-range timeout", async () => {
      const id = fx.viewId("aw-1");
      for (const timeout of ["abc", "-2", "1.5", "3600001"]) {
        const answer = await waitOn(main, id, timeout);
        expect(answer.status, `timeout=${timeout}`).toBe(422);
        expect(answer.body.error).toContain("timeout");
      }
    });

    it("accepts a deadline up to the one-hour cap (#382)", async () => {
      const id = fx.viewId("aw-fresh");
      const answer = await waitOn(main, id, 3_600_000);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ id, status: "idle" });
    });

    it("parks deadline-free on timeout=-1 until the run settles (#382)", async () => {
      const created = await postCreate(slow, "wait: park without a deadline");
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as RunAccepted;
      expect((await waitOn(slow, id, 0)).status).toBe(202);
      let resolved = false;
      const parked = waitOn(slow, id, -1).then((answer) => {
        resolved = true;
        return answer;
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(resolved).toBe(false);
      const stop = await fetchApi(slow, `/api/sessions/${id}/stop`, {
        method: "POST",
      });
      expect(stop.status).toBe(200);
      const answer = await parked;
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ id, status: "stopped" });
      expect(answer.body.last_run?.state).toBe("stopped");
    });

    it("requires a credential", async () => {
      const res = await fetch(`${main.env.baseUrl}/api/sessions/nope/wait`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("survives a caller that hangs up mid-wait", async () => {
      const created = await postCreate(slow, "wait: outlive a hang-up");
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as RunAccepted;
      const controller = new AbortController();
      const parked = fetchApi(slow, `/api/sessions/${id}/wait?timeout=30000`, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      await expect(parked).rejects.toThrow();
      // The aborted wait left nothing wedged: the same session answers a
      // fresh call at once.
      const answer = await waitOn(slow, id, 0);
      expect(answer.status).toBe(202);
      expect(LIVE_STATUSES).toContain(answer.body.status);
    });
  });

  describe("GET /api/openapi.json", () => {
    it("documents the wait path and its result schema", async () => {
      const res = await fetchApi(main, "/api/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<
          string,
          {
            get?: {
              parameters?: Array<{
                name?: string;
                schema?: {
                  anyOf?: Array<{ const?: number; maximum?: number }>;
                };
              }>;
              responses?: Record<string, unknown>;
            };
          }
        >;
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, { enum?: string[] }> }
          >;
        };
      };
      const wait = doc.paths["/api/sessions/{id}/wait"]?.get;
      expect(wait).toBeDefined();
      expect(wait?.responses?.["200"]).toBeDefined();
      expect(wait?.responses?.["202"]).toBeDefined();
      expect(wait?.responses?.["404"]).toBeDefined();
      expect(wait?.responses?.["422"]).toBeDefined();
      expect(wait?.parameters?.map((p) => p.name)).toContain("timeout");
      // The generated schema spells the timeout union as anyOf: the -1
      // sentinel beside the bounded integer range.
      const members =
        wait?.parameters?.find((p) => p.name === "timeout")?.schema?.anyOf ??
        [];
      expect(members.map((member) => member.const)).toContain(-1);
      expect(
        members.find((member) => member.maximum !== undefined)?.maximum,
      ).toBe(3_600_000);
      const result = doc.components.schemas.WaitResult?.properties;
      expect(result?.status?.enum).toEqual([
        "completed",
        "error",
        "idle",
        "queued",
        "running",
        "stopped",
      ]);
      expect(result?.last_run).toBeDefined();
    });
  });
};

export { runApiWaitSuite };
