import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

// Reaches the prompt-library endpoints the browser suites miss: 404s for
// unknown ids, validation on PUT, no-op reorders, the save form, and the
// grouped / sort=usage renderings (with usage seeded straight in the DB).

const runPromptsRoutesSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const post = (
    path: string,
    body: Record<string, string>,
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
    });

  const promptId = (title: string): string => {
    const db = new DatabaseSync(env.dbs.promptsDb, { readOnly: true });
    const row = db
      .prepare("SELECT id FROM saved_prompts WHERE title = ?")
      .get(title) as { id: string } | undefined;
    db.close();
    if (row === undefined) throw new Error(`prompt ${title} not found`);
    return row.id;
  };

  const setUsage = (title: string, count: number): void => {
    const db = new DatabaseSync(env.dbs.promptsDb);
    db.prepare("UPDATE saved_prompts SET usage_count = ? WHERE title = ?").run(
      count,
      title,
    );
    db.close();
  };

  beforeAll(async () => {
    env = await fx.startEnv("glv-promptsrt-");
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("prompt routes", () => {
    it("serves the inline save form", async () => {
      const res = await authedFetch(env, "/prompts/new");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('name="title"');
      expect(html).toContain('name="body"');
    });

    it("404s card, edit, and update for an unknown prompt", async () => {
      expect((await authedFetch(env, "/prompts/nope/card")).status).toBe(404);
      expect((await authedFetch(env, "/prompts/nope/edit")).status).toBe(404);
      const put = await authedFetch(env, "/prompts/nope", {
        method: "PUT",
        body: new URLSearchParams({ title: "x", body: "y" }),
      });
      expect(put.status).toBe(404);
    });

    it("re-renders the edit form (not the card) on invalid input", async () => {
      const created = await post("/prompts", {
        title: "Releasable",
        body: "cut a release",
      });
      expect(created.status).toBe(200);
      const id = promptId("Releasable");

      const res = await authedFetch(env, `/prompts/${id}`, {
        method: "PUT",
        body: new URLSearchParams({ title: "  ", body: "" }),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("required");
      expect(html).toContain('name="title"');

      // The original prompt survives the rejected edit.
      const list = await authedFetch(env, "/prompts");
      expect(await list.text()).toContain("Releasable");
    });

    it("treats an empty reorder as a no-op success", async () => {
      const res = await post("/prompts/reorder", { order: " , , " });
      expect(res.status).toBe(200);
    });

    it("orders by usage when sort=usage", async () => {
      await post("/prompts", { title: "Rare", body: "rare body" });
      await post("/prompts", { title: "Frequent", body: "frequent body" });
      setUsage("Frequent", 7);
      setUsage("Rare", 1);

      const byUsage = await authedFetch(env, "/prompts?sort=usage");
      const html = await byUsage.text();
      expect(html.indexOf("Frequent")).toBeGreaterThan(-1);
      expect(html.indexOf("Frequent")).toBeLessThan(html.indexOf("Rare"));
    });

    it("renders labelled category sections when grouped=1", async () => {
      await post("/prompts", {
        title: "Chore",
        body: "tidy up",
        category: "Ops",
      });
      const res = await authedFetch(env, "/prompts?grouped=1");
      const html = await res.text();
      expect(html).toContain("prompt-group");
      expect(html).toContain("Ops");
    });

    it("round-trips a category through create, edit, and card", async () => {
      await post("/prompts", {
        title: "Categorized",
        body: "hello",
        category: "Writing",
      });
      const id = promptId("Categorized");
      const card = await authedFetch(env, `/prompts/${id}/card`);
      expect(await card.text()).toContain("Writing");

      const put = await authedFetch(env, `/prompts/${id}`, {
        method: "PUT",
        body: new URLSearchParams({
          title: "Categorized",
          body: "hello again",
          category: "Editing",
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.text()).toContain("Editing");
    });

    it("surfaces known categories in the library datalist", async () => {
      const res = await authedFetch(env, "/prompts");
      const html = await res.text();
      expect(html).toContain('id="prompt-categories"');
      expect(html).toContain("Ops");
    });
  });
};

export { runPromptsRoutesSuite };
