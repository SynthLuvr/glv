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

// A handle gesture is a drag affordance, so the click it synthesizes must
// never switch the mobile view to the detail pane — even when the pointer
// barely moves (under the drag threshold) and lifts back over its own card.
const dragHandleInPlace = async (
  page: Page,
  sourceId: string,
): Promise<void> => {
  const handle = page.locator(
    `.session-item[data-session-id="${sourceId}"] .session-drag-handle`,
  );
  const h = await handle.boundingBox();
  if (h === null) throw new Error("drag handle not found");
  const cx = h.x + h.width / 2;
  const cy = h.y + h.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 3, cy + 3, { steps: 4 });
  await page.mouse.up();
};

// The home route selects the latest session, so it opens on the detail pane;
// switch to the session list the way a mobile user does — via the toggle.
const showListPane = async (page: Page): Promise<void> => {
  await page.locator('.mobile-pane-btn[data-pane="sidebar"]').click();
  await expect(page.locator(".app")).toHaveAttribute(
    "data-mobile-pane",
    "sidebar",
  );
};

describe("drag does not navigate on mobile", () => {
  it("keeps the list pane after a handle gesture that barely moves", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.goto(env.baseUrl);
      await showListPane(page);

      await dragHandleInPlace(page, "md-a");
      // Let any stray click/navigation settle.
      await page.waitForTimeout(300);

      await expect(page.locator(".app")).toHaveAttribute(
        "data-mobile-pane",
        "sidebar",
      );
    });
  }, 30000);

  it("keeps the list pane after a full drag that lands back on the list", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.goto(env.baseUrl);
      await showListPane(page);

      await dragHandleOnto(page, "md-b", "md-c");
      await page.waitForTimeout(300);

      await expect(page.locator(".app")).toHaveAttribute(
        "data-mobile-pane",
        "sidebar",
      );
    });
  }, 30000);

  it("a normal session tap still navigates to the detail pane", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.goto(env.baseUrl);
      await showListPane(page);
      await page
        .locator('.session-item[data-session-id="md-a"] .session-name')
        .click();
      await expect(page).toHaveURL(`${env.baseUrl}/sessions/md-a`);
      await expect(page.locator(".app")).toHaveAttribute(
        "data-mobile-pane",
        "detail",
      );
    });
  }, 30000);
});

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
