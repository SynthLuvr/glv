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

  const postPrompt = (fields: Record<string, string>): Promise<Response> =>
    bearerFetch(env, "/api/prompts", token, {
      method: "POST",
      body: new URLSearchParams(fields),
    });

  const putPrompt = (
    id: string,
    fields: Record<string, string>,
  ): Promise<Response> =>
    bearerFetch(env, `/api/prompts/${id}`, token, {
      method: "PUT",
      body: new URLSearchParams(fields),
    });

  describe("POST /api/prompts", () => {
    it("creates a prompt — 201, Location, and the stored row", async () => {
      const res = await postPrompt({
        title: "Seed checklist",
        body: "Verify {{repo}} boots on branch {{branch}}.",
        category: "Setup",
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as PromptJson;
      expect(res.headers.get("location")).toBe(`/api/prompts/${created.id}`);
      expect(created).toMatchObject({
        title: "Seed checklist",
        body: "Verify {{repo}} boots on branch {{branch}}.",
        category: "Setup",
        usage_count: 0,
        last_used_at: null,
      });
      expect(typeof created.id).toBe("string");

      // Read the row back through the detail endpoint — the round trip
      // a driving loop makes after seeding an entry.
      const read = await bearerFetch(env, `/api/prompts/${created.id}`, token);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(created);
    });

    it("stores a blank category as null", async () => {
      const res = await postPrompt({
        title: "No category",
        body: "A prompt saved without a category.",
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as PromptJson).category).toBeNull();
    });

    it("answers 422 JSON when the title or body is blank", async () => {
      const res = await postPrompt({ title: "   ", body: "Body is fine." });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "A title and prompt body are required.",
      });
    });

    it("rejects a cookie-authenticated write with 401 JSON", async () => {
      const res = await authedFetch(env, "/api/prompts", {
        method: "POST",
        body: new URLSearchParams({
          title: "Cookie write",
          body: "Must be refused.",
        }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error:
          "Write requests under /api require an API-token bearer; " +
          "session cookies are not accepted.",
      });
    });
  });

  describe("PUT /api/prompts/:id", () => {
    it("updates a prompt — answering with the row as stored", async () => {
      const res = await putPrompt("ap-2", {
        title: "Working-tree sweep (strict)",
        body: "Tidy the tree, summarize, and flag leftovers.",
        category: "Code care",
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as PromptJson;
      expect(updated).toMatchObject({
        id: "ap-2",
        title: "Working-tree sweep (strict)",
        body: "Tidy the tree, summarize, and flag leftovers.",
        category: "Code care",
      });

      // Verified through the read a script would rely on, not just the
      // write's own answer.
      const read = await bearerFetch(env, "/api/prompts/ap-2", token);
      expect(await read.json()).toMatchObject(updated);
    });

    it("clears the category on a blank submit", async () => {
      const res = await putPrompt("ap-2", {
        title: "Working-tree sweep (strict)",
        body: "Tidy the tree, summarize, and flag leftovers.",
        category: "",
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as PromptJson).category).toBeNull();
    });

    it("answers 404 JSON for an unknown id", async () => {
      const res = await putPrompt("ap-nope", {
        title: "Ghost",
        body: "No such row.",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No saved prompt ap-nope." });
    });

    it("answers 422 JSON when required fields are blank", async () => {
      const res = await putPrompt("ap-2", { title: "Titled", body: " " });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "A title and prompt body are required.",
      });
    });
  });

  describe("GET /api/openapi.json (prompt writes)", () => {
    it("documents POST /api/prompts and PUT /api/prompts/:id", async () => {
      const res = await bearerFetch(env, "/api/openapi.json", token);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      const methodsOf = (path: string): string[] =>
        Object.keys(doc.paths[path] ?? {}).sort();
      expect(methodsOf("/api/prompts")).toEqual(["get", "post"]);
      expect(methodsOf("/api/prompts/{id}")).toEqual(["get", "put"]);
    });
  });
};

export { runApiPromptsSuite };
