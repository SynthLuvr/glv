import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runGroupsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const post = (
    path: string,
    body: Record<string, string>,
  ): Promise<Response> =>
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
    env = await fx.startEnv("glv-groups-");
    const ids = ["g-a", "g-b", "g-c", "g-d", "g-e", "g-f"];
    fx.seedSessions(
      env,
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
      const res = await post(`/sessions/${fx.viewId("g-a")}/group-with`, {
        otherId: fx.viewId("g-b"),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id="session-list"');

      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".session-group")).toBeVisible();
        await expect(
          page.locator(".session-group .group-members"),
        ).toContainText("G-A");
        await expect(
          page.locator(".session-group .group-members"),
        ).toContainText("G-B");
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
      await post(`/sessions/${fx.viewId("g-c")}/group-with`, {
        otherId: fx.viewId("g-d"),
      });
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".session-group")).toHaveCount(1);
      });
      await post(`/sessions/${fx.viewId("g-c")}/ungroup`, {});
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".session-group")).toHaveCount(0);
      });
    });

    it("releasing a drag on the source card itself keeps the group", async () => {
      await post(`/sessions/${fx.viewId("g-e")}/group-with`, {
        otherId: fx.viewId("g-f"),
      });
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".session-group")).toContainText("G-E");

        // A short drag past the threshold, released while the pointer is
        // still over the dragged card: a no-op, never an ungroup.
        let ungroupRequested = false;
        page.on("request", (req) => {
          if (req.url().includes("/ungroup")) ungroupRequested = true;
        });
        const handle = page.locator(
          `[data-session-id='${fx.viewId("g-e")}'] .session-drag-handle`,
        );
        const box = await handle.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + 4, box!.y + 4);
        await page.mouse.down();
        await page.mouse.move(box!.x + 18, box!.y + 10, { steps: 4 });
        await page.mouse.up();

        await page.waitForTimeout(700);
        expect(ungroupRequested).toBe(false);
        await expect(
          page.locator(".session-group .group-members"),
        ).toContainText("G-E");
      });
    });
  });
};

export { runGroupsSuite };
