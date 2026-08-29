import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  postFollowUp,
} from "../harness.js";

// Reaches the session-detail endpoints the happy-path suites skip: the
// prompt-bar fragment, all three rename renderings (sidebar list, full page,
// htmx fragment), bulk archive, 404 rendering, queueing a follow-up behind a
// running agent and cancelling it, and the usage bump when a run starts from
// a saved prompt.

const runSessionsRoutesSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const postForm = (
    path: string,
    body: Record<string, string | string[]>,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body))
      if (Array.isArray(value)) for (const v of value) params.append(key, v);
      else params.append(key, value);

    return authedFetch(env, path, {
      method: "POST",
      body: params,
      headers,
    });
  };

  const usageCount = (title: string): number => {
    const db = new DatabaseSync(env.dbs.promptsDb, { readOnly: true });
    const row = db
      .prepare("SELECT usage_count AS n FROM saved_prompts WHERE title = ?")
      .get(title) as { n: number } | undefined;
    db.close();
    return row?.n ?? -1;
  };

  beforeAll(async () => {
    // A long sleep keeps the first run busy so a follow-up queues behind it.
    env = await fx.startEnv("glv-sessrt-", { sleepMs: 15000 });
    fx.seedSessions(env, [
      { id: "sr-a", name: "Alpha", workingDir: env.scratchDir },
      { id: "sr-b", name: "Beta", workingDir: env.scratchDir },
      { id: "sr-c", name: "Gamma", workingDir: env.scratchDir },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("session detail routes", () => {
    it("renders the prompt bar as a standalone fragment", async () => {
      const res = await authedFetch(env, "/sessions/sr-a/prompt-bar");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("prompt-bar");
      expect(html).toContain('name="prompt"');
    });

    it("404s the fragment and page for unknown sessions", async () => {
      expect((await authedFetch(env, "/sessions/nope/prompt-bar")).status).toBe(
        404,
      );
      const page = await authedFetch(env, "/sessions/nope");
      expect(page.status).toBe(404);
      expect(await page.text()).toContain("nope");
    });

    it("pre-fills /sessions/new with a working directory", async () => {
      const res = await authedFetch(
        env,
        `/sessions/new?working_dir=${encodeURIComponent(env.scratchDir)}`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("New Session");
    });

    it("returns the sidebar list when renaming from the sidebar", async () => {
      const res = await postForm("/sessions/sr-a/rename", {
        name: "Renamed Alpha",
        from: "sidebar",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="session-list"');
      expect(html).toContain("Renamed Alpha");
    });

    it("returns a full page when renaming without htmx", async () => {
      const res = await postForm("/sessions/sr-b/rename", {
        name: "Renamed Beta",
        from: "header",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<html");
      expect(html).toContain("Renamed Beta");
    });

    it("returns title plus out-of-band list when renaming via htmx", async () => {
      const res = await postForm(
        "/sessions/sr-c/rename",
        { name: "Renamed Gamma", from: "header" },
        { "HX-Request": "true" },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("<html");
      expect(html).toContain("session-title");
      expect(html).toContain("hx-swap-oob");
    });

    it("404s a rename of an unknown session", async () => {
      const res = await postForm("/sessions/nope/rename", { name: "x" });
      expect(res.status).toBe(404);
    });

    it("archives a multi-select in bulk", async () => {
      const res = await postForm("/sessions/archive", {
        id: ["sr-b", "sr-c"],
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="session-list"');
      expect(html).not.toContain("Renamed Beta");

      const page = await authedFetch(env, "/");
      expect(await page.text()).not.toContain("Renamed Gamma");
    });
  });

  describe("follow-up queueing", () => {
    let sessionId = "";

    it("starts a run and queues a follow-up behind it", async () => {
      const start = await postForm("/sessions", {
        prompt: "kick off",
        working_dir: env.scratchDir,
      });
      expect(start.status).toBe(200);
      const startHtml = await start.text();
      const match = /detail-inner" data-session-id="([^"]+)"/.exec(startHtml);
      expect(match).not.toBeNull();
      sessionId = match?.[1] ?? "";
      expect(startHtml).toContain('data-run-status="running"');

      const queued = await postFollowUp(env, sessionId, "second prompt");
      expect(queued.status).toBe(200);
      const html = await queued.text();
      expect(html).toContain("queued-prompt");
      expect(html).toContain("second prompt");
    }, 60000);

    it("cancels the queued prompts", async () => {
      const res = await postForm(`/sessions/${sessionId}/queue/cancel`, {});
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("queued-prompt");
    });

    it("stops the running session", async () => {
      const res = await postForm(`/sessions/${sessionId}/stop`, {});
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("data-run-status");
    });

    it("404s queue/cancel for an unknown session", async () => {
      const res = await postForm("/sessions/nope/queue/cancel", {});
      expect(res.status).toBe(404);
    });
  });

  describe("saved prompt run", () => {
    it("bumps usage when a run starts from a saved prompt", async () => {
      const created = await authedFetch(env, "/prompts", {
        method: "POST",
        body: new URLSearchParams({ title: "Runner", body: "run me" }),
      });
      expect(created.status).toBe(200);
      expect(usageCount("Runner")).toBe(0);

      const res = await postForm("/sessions", {
        prompt: "kick off from a saved prompt",
        prompt_id: promptIdOf(env, "Runner"),
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(200);
      expect(usageCount("Runner")).toBeGreaterThan(0);

      // Stop the spawned agent; the test only needed the establishment.
      const html = await res.text();
      const match = /detail-inner" data-session-id="([^"]+)"/.exec(html);
      expect(match).not.toBeNull();
      await postForm(`/sessions/${match?.[1] ?? ""}/stop`, {});
    }, 60000);
  });
};

const promptIdOf = (env: IntegrationEnv, title: string): string => {
  const db = new DatabaseSync(env.dbs.promptsDb, { readOnly: true });
  const row = db
    .prepare("SELECT id FROM saved_prompts WHERE title = ?")
    .get(title) as { id: string } | undefined;
  db.close();
  if (row === undefined) throw new Error(`prompt ${title} not found`);
  return row.id;
};

export { runSessionsRoutesSuite };
