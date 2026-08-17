import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runReadonlySessionsSuite = (fx: FlavorFixture): void => {
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

  beforeAll(async () => {
    env = await fx.startEnv("glv-readonly-");
    fx.seedSessions(env, [
      {
        id: "ro-browse",
        name: "Browse Live",
        workingDir: join(env.scratchDir, "browse"),
      },
      {
        id: "ro-mutate",
        name: "Mutate Me",
        workingDir: join(env.scratchDir, "mutate"),
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("read-only store browsing", () => {
    it("browses the store read-only yet still sees live agent writes", async () => {
      // An externally written session (the agent itself) must show up on
      // the next browse — the store is re-read on every request.
      fx.seedSessions(env, [
        {
          id: "ro-live",
          name: `Live From ${fx.displayName}`,
          workingDir: join(env.scratchDir, "live"),
        },
      ]);
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-list")).toContainText(
          "Browse Live",
        );
        await expect(page.locator("#session-list")).toContainText(
          `Live From ${fx.displayName}`,
        );
      });
    });

    it("routes archive/rename through the viewer-owned writable store", async () => {
      // These mutate, so they succeed only via the writable store, then
      // persist and show up on the next read-only browse.
      const renameRes = await post("/sessions/ro-mutate/rename", {
        name: "Renamed Safe",
        from: "header",
      });
      expect(renameRes.status).toBe(200);
      expect(fx.readSessionField(env, "name", "ro-mutate")).toBe(
        "Renamed Safe",
      );
      expect(fx.readSessionField(env, "user_set_name", "ro-mutate")).toBe(1);

      const archiveRes = await post("/sessions/ro-mutate/archive", {});
      expect(archiveRes.status).toBe(200);
      expect(
        fx.readSessionField(env, "archived_at", "ro-mutate"),
      ).not.toBeNull();

      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-list")).not.toContainText(
          "Renamed Safe",
        );
      });
    });
  });
};

export { runReadonlySessionsSuite };
