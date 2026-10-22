import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: the JSON reads for the saved-prompt
// library. Rows are seeded straight into the prompts database the way
// an external writer would, so the tests read content the API itself
// did not create; auth rides the same gate every /api path sits behind.

type PromptJson = {
  id: string;
  title: string;
  body: string;
  category: string | null;
  sort_order: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

const runApiPromptsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";

  // Explicit ids and sort_order, so list order and detail URLs are
  // known before any request.
  const seedPrompt = (row: {
    id: string;
    title: string;
    body: string;
    category?: string;
    sortOrder?: number;
  }): void => {
    const db = new DatabaseSync(env.dbs.promptsDb);
    db.prepare(
      "INSERT INTO saved_prompts (id, title, body, category, sort_order) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).run(
      row.id,
      row.title,
      row.body,
      row.category ?? null,
      row.sortOrder ?? 0,
    );
    db.close();
  };

  beforeAll(async () => {
    env = await fx.startEnv("glv-apiprompts-");
    token = seedApiToken(env.dbs.authDb, "api-prompts");
    seedPrompt({
      id: "ap-1",
      title: "Release notes",
      body: "Draft the release notes for {{repo}} on branch {{branch}}.",
      category: "Docs",
      sortOrder: 0,
    });
    seedPrompt({
      id: "ap-2",
      title: "Working-tree sweep",
      body: "Tidy up the working tree and summarize what changed.",
      sortOrder: 1,
    });
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("GET /api/prompts", () => {
    it("rejects an unauthenticated request with 401 JSON", async () => {
      const res = await fetch(`${env.baseUrl}/api/prompts`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("admits the session cookie — reads never need the bearer", async () => {
      const res = await authedFetch(env, "/api/prompts");
      expect(res.status).toBe(200);
    });

    it("lists every saved prompt with its content, in manual order", async () => {
      const res = await bearerFetch(env, "/api/prompts", token);
      expect(res.status).toBe(200);
      const prompts = (await res.json()) as PromptJson[];
      expect(prompts).toHaveLength(2);

      const release = prompts.find((prompt) => prompt.id === "ap-1");
      expect(release).toMatchObject({
        id: "ap-1",
        title: "Release notes",
        body: "Draft the release notes for {{repo}} on branch {{branch}}.",
        category: "Docs",
      });
      expect(release?.usage_count).toBe(0);
      expect(release?.last_used_at).toBeNull();
      expect(typeof release?.created_at).toBe("string");
      expect(typeof release?.updated_at).toBe("string");

      const sweep = prompts.find((prompt) => prompt.id === "ap-2");
      expect(sweep?.category).toBeNull();

      expect(prompts.findIndex((prompt) => prompt.id === "ap-1")).toBeLessThan(
        prompts.findIndex((prompt) => prompt.id === "ap-2"),
      );
    });
  });

  describe("GET /api/prompts/:id", () => {
    it("returns one saved prompt, body included", async () => {
      const res = await bearerFetch(env, "/api/prompts/ap-2", token);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "ap-2",
        title: "Working-tree sweep",
        body: "Tidy up the working tree and summarize what changed.",
        category: null,
      });
    });

    it("answers 404 JSON for an unknown id", async () => {
      const res = await bearerFetch(env, "/api/prompts/ap-nope", token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No saved prompt ap-nope." });
    });
  });
};

export { runApiPromptsSuite };
