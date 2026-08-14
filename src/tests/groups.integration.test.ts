import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

let env: IntegrationEnv;

const post = (path: string, body: Record<string, string>): Promise<Response> =>
  authedFetch(env, path, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "HX-Request": "true" },
  });

const firstGroupId = (): string | undefined => {
  const db = new DatabaseSync(env.dbs.groupsDb, { readOnly: true });
  const row = db
    .prepare("SELECT id FROM session_groups ORDER BY created_at LIMIT 1")
    .get();
  db.close();
  return (row as { id: string } | undefined)?.id;
};

beforeAll(async () => {
  env = await startIntegrationEnv("glv-groups-");
  const ids = ["g-a", "g-b", "g-c", "g-d", "g-e", "g-f"];
  insertSessions(
    env.dbs.projectsDir,
    ids.map((id) => ({
      id,
      name: id.toUpperCase(),
      workingDir: env.scratchDir + "/" + id,
    })),
  );
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("session groups", () => {
  it("groups two sessions and renders a collapsible group in the sidebar", async () => {
    const res = await post("/sessions/g-a/group-with", { otherId: "g-b" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="session-list"');

    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator(".session-group")).toBeVisible();
      await expect(page.locator(".session-group .group-members")).toContainText(
        "G-A",
      );
      await expect(page.locator(".session-group .group-members")).toContainText(
        "G-B",
      );
    });
  });

  it("renames a group", async () => {
    const id = firstGroupId();
    expect(id).toBeDefined();
    const res = await post("/groups/" + id + "/rename", { name: "Pair" });
    expect(res.status).toBe(200);
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator(".session-group")).toContainText("Pair");
    });
  });

  it("archives every session in a group", async () => {
    const id = firstGroupId();
    const res = await post("/groups/" + id + "/archive", {});
    expect(res.status).toBe(200);
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("#session-list")).not.toContainText("G-A");
      await expect(page.locator("#session-list")).not.toContainText("G-B");
    });
  });

  it("dissolves a group when a member is removed below the threshold", async () => {
    await post("/sessions/g-c/group-with", { otherId: "g-d" });
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator(".session-group")).toHaveCount(1);
    });
    await post("/sessions/g-c/ungroup", {});
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator(".session-group")).toHaveCount(0);
    });
  });
});
