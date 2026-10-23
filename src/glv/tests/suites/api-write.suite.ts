import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: the JSON write API — POST /api/sessions,
// POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop — plus the
// listing window (?limit/?offset) and the generated /api/openapi.json.
// Every write goes through a bearer token (the API's only accepted
// credential for unsafe methods), against the real serve process and the
// real mock agent, so the operation layer's effects are observed exactly
// as a script would observe them.

type IdRow = { id: string };

type RunAccepted = { id: string; status: string };

const runApiWriteSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";
  // The id of a session created through the API; its run stays alive
  // (the mock sleeps) for the queueing and stop tests.
  let createdId = "";
  const captureDir = mkdtempSync(join(tmpdir(), "glv-apiwr-"));
  const captureStdin = join(captureDir, "stdin.txt");

  beforeAll(async () => {
    env = await fx.startEnv("glv-apiwr-", {
      // Keeps created runs alive so queueing and stopping observe a
      // genuinely active run; cleanup reaps them with the server.
      sleepMs: 30000,
      captureStdin,
    });
    token = seedApiToken(env.dbs.authDb, "api-write");
    fx.seedSessions(env, [
      { id: "aw-1", name: "Api Write Session", workingDir: env.scratchDir },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(captureDir, { recursive: true, force: true });
  });

  // Each agent invocation overwrites the capture file, so poll until it
  // holds the run under assertion — an earlier run's text may still be
  // in place, and the first read can race the first agent spawn before
  // the file exists.
  const waitForStdin = async (marker: string): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const text = readFileSync(captureStdin, "utf-8");
        if (text.includes(marker)) return text;
      } catch {
        // the writer may not have started yet — keep polling
      }
      if (Date.now() > deadline)
        throw new Error(`stdin capture never contained "${marker}"`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  // A multipart create exactly as curl -F would send it; `files` become
  // "uploads" file parts.
  const postCreate = (
    fields: Record<string, string>,
    files: Record<string, string> = {},
  ): Promise<Response> => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    for (const [key, text] of Object.entries(files))
      form.append("uploads", new Blob([text]), `${key}.txt`);
    return bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: form,
    });
  };

  const postPrompt = (
    id: string,
    fields: Record<string, string>,
  ): Promise<Response> =>
    bearerFetch(env, `/api/sessions/${id}/prompt`, token, {
      method: "POST",
      body: new URLSearchParams(fields),
    });

  describe("write auth boundary", () => {
    it("rejects a cookie-authenticated POST with 401 JSON", async () => {
      const res = await authedFetch(env, "/api/sessions", {
        method: "POST",
        body: new URLSearchParams({
          prompt: "cookie write",
          working_dir: env.scratchDir,
        }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error:
          "Write requests under /api require an API-token bearer; " +
          "session cookies are not accepted.",
      });
    });

    it("rejects an unauthenticated POST with 401 JSON", async () => {
      const res = await fetch(`${env.baseUrl}/api/sessions`, {
        method: "POST",
        body: new URLSearchParams({ prompt: "anon" }),
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("rejects a garbage bearer POST with 401 JSON", async () => {
      const res = await bearerFetch(env, "/api/sessions", "wrong-token", {
        method: "POST",
        body: new URLSearchParams({ prompt: "x" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Missing or invalid bearer token.",
      });
    });

    it("leaves the browser's HTML endpoints on the cookie", async () => {
      // The bearer-only rule guards /api writes, never the form surface
      // the UI itself posts to.
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("aw-1")}/stop`,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/sessions", () => {
    it("starts a run and returns 201 with the session id", async () => {
      const res = await postCreate({
        prompt: "api write: create the widget",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as RunAccepted;
      expect(typeof body.id).toBe("string");
      expect(body.status).toBe("started");
      expect(res.headers.get("location")).toBe(`/api/sessions/${body.id}`);
      createdId = body.id;

      const detail = await bearerFetch(env, `/api/sessions/${body.id}`, token);
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as { session: IdRow };
      expect(detailBody.session.id).toBe(body.id);

      await waitForStdin("api write: create the widget");
    });

    it("appends uploaded files to the prompt", async () => {
      const res = await postCreate(
        {
          prompt: "api write: read the attachment",
          working_dir: env.scratchDir,
        },
        { notes: "attached payload" },
      );
      expect(res.status).toBe(201);
      const text = await waitForStdin("api write: read the attachment");
      expect(text).toContain("Attached files");
      expect(text).toContain("notes.txt");
    });

    it("creates a temp working directory on session_mode=temp", async () => {
      const res = await postCreate({
        prompt: "api write: temp session",
        session_mode: "temp",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as RunAccepted;
      expect(body.status).toBe("started");
    });

    it("rejects an empty prompt with 422", async () => {
      const res = await postCreate({ prompt: "", working_dir: env.scratchDir });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "A prompt is required to start a session.",
      });
    });

    it("rejects a missing working directory with 422", async () => {
      const res = await postCreate({
        prompt: "api write",
        working_dir: join(tmpdir(), "glv-apiwr-nonexistent"),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "That working directory does not exist.",
      });
    });

    it("rejects a model naming an unserved agent with 422", async () => {
      const res = await postCreate({
        prompt: "api write",
        working_dir: env.scratchDir,
        model: "nosuchagent:",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'Agent "nosuchagent" is not enabled.',
      });
    });

    it("rejects a model the agent no longer offers with 422", async () => {
      const agent = fx.viewId("aw-1").split(":")[0];
      const res = await postCreate({
        prompt: "api write",
        working_dir: env.scratchDir,
        model: `${agent}:definitely-not-a-model`,
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        // The copy names the profile's agentName spelling ("goose",
        // "claude"), not the display name.
        error: `That model is no longer available in ${fx.name}. Pick another from the list.`,
      });
    });

    it("rejects a malformed location share with 422", async () => {
      const res = await postCreate({
        prompt: "api write",
        working_dir: env.scratchDir,
        location: "not json",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error:
          "That location could not be read — remove the chip and share again.",
      });
    });
  });

  describe("POST /api/sessions/:id/prompt", () => {
    it("starts a follow-up on an idle session", async () => {
      const res = await postPrompt(fx.viewId("aw-1"), {
        prompt: "api write: follow up from the api",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: fx.viewId("aw-1"),
        status: "started",
      });
      await waitForStdin("api write: follow up from the api");
    });

    it("queues behind the session's active run", async () => {
      // createdId's run is still executing (the mock sleeps past this
      // suite), so the follow-up lands in its pending queue.
      const res = await postPrompt(createdId, {
        prompt: "api write: queued behind the run",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: createdId, status: "queued" });
    });

    it("answers 404 JSON for an unknown session", async () => {
      const res = await postPrompt("nope", { prompt: "api write" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });

    it("rejects an empty prompt with 422", async () => {
      const res = await postPrompt(fx.viewId("aw-1"), { prompt: "  " });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "A prompt is required." });
    });

    it("rejects a malformed location share with 422", async () => {
      const res = await postPrompt(fx.viewId("aw-1"), {
        prompt: "api write",
        location: "not json",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error:
          "That location could not be read — remove the chip and share again.",
      });
    });
  });

  describe("POST /api/sessions/:id/stop", () => {
    it("stops the active run and is idempotent", async () => {
      const res = await bearerFetch(
        env,
        `/api/sessions/${createdId}/stop`,
        token,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: createdId, status: "stopped" });

      const again = await bearerFetch(
        env,
        `/api/sessions/${createdId}/stop`,
        token,
        { method: "POST" },
      );
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ id: createdId, status: "stopped" });
    });

    it("answers 404 JSON for an unknown session", async () => {
      const res = await bearerFetch(env, "/api/sessions/nope/stop", token, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });
  });

  describe("GET /api/sessions windowing", () => {
    beforeAll(() => {
      fx.seedSessions(
        env,
        [1, 2, 3, 4, 5, 6].map((i) => ({
          id: `aw-page-${i}`,
          name: `API page ${i}`,
          workingDir: env.scratchDir,
        })),
      );
    });

    it("slices the newest-first list with limit and offset", async () => {
      const allRes = await bearerFetch(env, "/api/sessions", token);
      expect(allRes.status).toBe(200);
      const all = (await allRes.json()) as IdRow[];
      expect(all.length).toBeGreaterThanOrEqual(6);

      const page1 = (await (
        await bearerFetch(env, "/api/sessions?limit=3", token)
      ).json()) as IdRow[];
      expect(page1.map((row) => row.id)).toEqual(
        all.slice(0, 3).map((row) => row.id),
      );

      const page2 = (await (
        await bearerFetch(env, "/api/sessions?limit=3&offset=3", token)
      ).json()) as IdRow[];
      expect(page2.map((row) => row.id)).toEqual(
        all.slice(3, 6).map((row) => row.id),
      );

      const beyond = (await (
        await bearerFetch(
          env,
          `/api/sessions?limit=3&offset=${all.length + 10}`,
          token,
        )
      ).json()) as IdRow[];
      expect(beyond).toEqual([]);
    });

    it("rejects invalid windows with 422", async () => {
      for (const query of [
        "?limit=0",
        "?limit=abc",
        "?limit=501",
        "?offset=-1",
        "?offset=-x",
      ]) {
        const res = await bearerFetch(env, `/api/sessions${query}`, token);
        expect(res.status, query).toBe(422);
        const body = (await res.json()) as { error: string };
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      }
    });
  });

  describe("GET /api/openapi.json", () => {
    it("serves the generated contract to a bearer", async () => {
      const res = await bearerFetch(env, "/api/openapi.json", token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const doc = (await res.json()) as {
        openapi: string;
        paths: Record<string, unknown>;
        components: {
          schemas: Record<string, unknown>;
          securitySchemes: Record<string, unknown>;
        };
      };
      expect(doc.openapi).toBe("3.1.0");
      expect(Object.keys(doc.paths).sort()).toEqual([
        "/api/cron",
        "/api/cron/{name}",
        "/api/cron/{name}/run",
        "/api/prompts",
        "/api/prompts/{id}",
        "/api/sessions",
        "/api/sessions/{id}",
        "/api/sessions/{id}/fork",
        "/api/sessions/{id}/prompt",
        "/api/sessions/{id}/stop",
        "/api/sessions/{id}/wait",
      ]);
      expect(Object.keys(doc.components.securitySchemes)).toContain(
        "bearerAuth",
      );
      expect(Object.keys(doc.components.schemas).sort()).toEqual([
        "CronDeleted",
        "CronJob",
        "CronJobForm",
        "CronRunAccepted",
        "Error",
        "FollowUpForm",
        "ForkAccepted",
        "ForkForm",
        "LastRun",
        "Prompt",
        "RunAccepted",
        "Session",
        "StartSessionForm",
        "StopAccepted",
        "WaitResult",
      ]);
    });

    it("admits the session cookie — reads never need the bearer", async () => {
      const res = await authedFetch(env, "/api/openapi.json");
      expect(res.status).toBe(200);
    });

    it("answers 401 JSON without a credential", async () => {
      const res = await fetch(`${env.baseUrl}/api/openapi.json`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });
  });
};

export { runApiWriteSuite };
