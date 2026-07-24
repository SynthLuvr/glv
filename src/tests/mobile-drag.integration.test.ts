import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

let env: IntegrationEnv;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-mobile-drag-");
  const ids = ["md-a", "md-b", "md-c"];
  insertSessions(
    env.dbs.sessionsDb,
    ids.map((id) => ({
      id,
      name: id.toUpperCase(),
      workingDir: `${env.scratchDir}/${id}`,
    })),
  );
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

// page.mouse fires the same pointer events a touch would, so a desktop run
// exercises the mobile drag path.
const dragHandleOnto = async (
  page: Page,
  sourceId: string,
  targetId: string,
): Promise<void> => {
  const handle = page.locator(
    `.session-item[data-session-id="${sourceId}"] .session-drag-handle`,
  );
  const target = page.locator(`.session-item[data-session-id="${targetId}"]`);
  const h = await handle.boundingBox();
  const t = await target.boundingBox();
  if (h === null || t === null) throw new Error("drag elements not found");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
};

describe("pointer drag to group", () => {
  it("groups two sessions by dragging a handle onto another card", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(
        page.locator(
          '.session-item[data-session-id="md-a"] .session-drag-handle',
        ),
      ).toBeVisible();

      await dragHandleOnto(page, "md-a", "md-b");

      await expect(page.locator(".session-group")).toBeVisible();
      await expect(page.locator(".session-group .group-members")).toContainText(
        "MD-A",
      );
      await expect(page.locator(".session-group .group-members")).toContainText(
        "MD-B",
      );
    });
  }, 30000);

  it("joins a third session into the existing group", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await dragHandleOnto(page, "md-c", "md-a");
      await expect(
        page.locator(".session-group .group-members .session-item"),
      ).toHaveCount(3);
    });
  }, 30000);
});
