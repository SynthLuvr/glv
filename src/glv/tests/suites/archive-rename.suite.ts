import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runArchiveRenameSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const col = (id: string, name: string): unknown =>
    fx.readSessionField(env, name, id);

  const post = (
    path: string,
    body: Record<string, string>,
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: { "HX-Request": "true" },
    });

  beforeAll(async () => {
    env = await fx.startEnv("glv-archive-");
    fx.seedSessions(env, [
      {
        id: "ar-a",
        name: "Archive One",
        workingDir: join(env.scratchDir, "a"),
      },
      {
        id: "ar-b",
        name: "Archive Two",
        workingDir: join(env.scratchDir, "b"),
      },
      {
        id: "ar-c",
        name: "Archive Three",
        workingDir: join(env.scratchDir, "c"),
      },
      { id: "rn-a", name: "Rename Me", workingDir: join(env.scratchDir, "r1") },
      {
        id: "rn-b",
        name: "Sidebar Rename",
        workingDir: join(env.scratchDir, "r2"),
      },
      {
        id: "rn-c",
        name: "Blank Name",
        workingDir: join(env.scratchDir, "r3"),
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("archive", () => {
    it("archives a single session from the transcript button and hides it", async () => {
      const res = await post(`/sessions/${fx.viewId("ar-a")}/archive`, {});
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("new-session-form");
      expect(col("ar-a", "archived_at")).not.toBeNull();
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-list")).not.toContainText(
          "Archive One",
        );
      });
    });

    it("archives a bulk selection submitted as repeated id fields", async () => {
      const body = new URLSearchParams();
      body.append("id", fx.viewId("ar-b"));
      body.append("id", fx.viewId("ar-c"));
      const res = await authedFetch(env, "/sessions/archive", {
        method: "POST",
        body,
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id="session-list"');
      expect(col("ar-b", "archived_at")).not.toBeNull();
      expect(col("ar-c", "archived_at")).not.toBeNull();
    });
  });

  describe("rename", () => {
    it("renames from the header, persists it and refreshes the sidebar OOB", async () => {
      const res = await post(`/sessions/${fx.viewId("rn-a")}/rename`, {
        name: "Header Renamed",
        from: "header",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Header Renamed");
      expect(html).toContain('id="session-list"');
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl + "/sessions/" + fx.viewId("rn-a"));
        await expect(page.locator(".session-header")).toContainText(
          "Header Renamed",
        );
      });
      expect(col("rn-a", "user_set_name")).toBe(1);
    });

    it("trims whitespace and clears the custom name when blank", async () => {
      await post(`/sessions/${fx.viewId("rn-c")}/rename`, {
        name: "   ",
        from: "header",
      });
      expect(col("rn-c", "name")).toBe("");
      expect(col("rn-c", "user_set_name")).toBe(0);
    });

    it("re-renders the sidebar list when renamed from the sidebar", async () => {
      const res = await post(`/sessions/${fx.viewId("rn-b")}/rename`, {
        name: "Side X",
        from: "sidebar",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="session-list"');
      expect(html).not.toContain("session-header");
    });

    it("returns a not-found response for an unknown session rename", async () => {
      const res = await post("/sessions/nope/rename", { name: "x" });
      expect(await res.text()).toContain("Session not found");
    });

    it("renders inline rename and archive controls", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl + "/sessions/" + fx.viewId("rn-a"));
        await expect(page.locator(".archive-btn")).toBeVisible();
        await expect(
          page.locator(".session-item .rename-pencil").first(),
        ).toBeAttached();
      });
    });
  });
};

export { runArchiveRenameSuite };
