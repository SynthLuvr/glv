import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

let env: IntegrationEnv;

const promptId = (title: string): string | undefined => {
  const db = new DatabaseSync(env.dbs.promptsDb, { readOnly: true });
  const row = db
    .prepare("SELECT id FROM saved_prompts WHERE title = ?")
    .get(title);
  db.close();
  return (row as { id: string } | undefined)?.id;
};

const post = (path: string, body: Record<string, string>): Promise<Response> =>
  authedFetch(env, path, {
    method: "POST",
    body: new URLSearchParams(body),
  });

beforeAll(async () => {
  env = await startIntegrationEnv("glv-prompts-");
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("saved prompts", () => {
  it("creates a prompt and lists it", async () => {
    const res = await post("/prompts", { title: "Deploy", body: "Ship it" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Deploy");

    const list = await authedFetch(env, "/prompts");
    expect(await list.text()).toContain("Deploy");
  });

  it("renders a card and an edit form for a prompt", async () => {
    const id = promptId("Deploy");
    expect(id).toBeDefined();
    const card = await authedFetch(env, "/prompts/" + id + "/card");
    expect(await card.text()).toContain("prompt-card");
    const edit = await authedFetch(env, "/prompts/" + id + "/edit");
    const editHtml = await edit.text();
    expect(editHtml).toContain('name="title"');
    expect(editHtml).toContain('name="body"');
  });

  it("updates a prompt via PUT", async () => {
    const id = promptId("Deploy");
    const res = await authedFetch(env, "/prompts/" + id, {
      method: "PUT",
      body: new URLSearchParams({ title: "Deploy v2", body: "Ship harder" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Deploy v2");
  });

  it("rejects an empty title and body with an error", async () => {
    const res = await post("/prompts", { title: "", body: "" });
    expect(await res.text()).toContain("required");
  });

  it("stores and surfaces a category", async () => {
    await post("/prompts", {
      title: "Ops task",
      body: "do it",
      category: "Ops",
    });
    const list = await authedFetch(env, "/prompts");
    expect(await list.text()).toContain("Ops");
  });

  it("deletes a prompt", async () => {
    const id = promptId("Ops task");
    const res = await authedFetch(env, "/prompts/" + id, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
  });

  it("persists a manual reorder", async () => {
    await post("/prompts", { title: "First", body: "a" });
    await post("/prompts", { title: "Second", body: "b" });
    const a = promptId("First");
    const b = promptId("Second");
    const res = await post("/prompts/reorder", { order: b + "," + a });
    expect(res.status).toBe(200);
  });

  it("renders the library with Use/Run/Edit controls on the new-session page", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator(".prompt-card")).toHaveCount(3);
      await expect(page.locator(".prompt-card-btn.use").first()).toBeVisible();
      await expect(page.locator(".prompt-card-btn.run").first()).toBeVisible();
    });
  });
});
