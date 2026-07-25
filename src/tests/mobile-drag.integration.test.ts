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

const handleCenter = async (
  page: Page,
  sourceId: string,
): Promise<{ x: number; y: number }> => {
  const handle = page.locator(
    `.session-item[data-session-id="${sourceId}"] .session-drag-handle`,
  );
  const box = await handle.boundingBox();
  if (box === null) throw new Error("drag handle not found");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

// page.mouse fires the same pointer events a touch would, so a desktop run
// exercises the mobile drag path.
const dragHandleOnto = async (
  page: Page,
  sourceId: string,
  targetId: string,
): Promise<void> => {
  const { x, y } = await handleCenter(page, sourceId);
  const target = page.locator(`.session-item[data-session-id="${targetId}"]`);
  const drop = await target.boundingBox();
  if (drop === null) throw new Error("drop target not found");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
};

// A sub-threshold handle gesture still synthesizes a click that must not
// switch to the detail pane.
const dragHandleInPlace = async (
  page: Page,
  sourceId: string,
): Promise<void> => {
  const { x, y } = await handleCenter(page, sourceId);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3, y + 3, { steps: 4 });
  await page.mouse.up();
};

// Home opens on the detail pane (latest session selected); reach the list via
// the sidebar toggle, the way a mobile user does.
const openMobileList = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(env.baseUrl);
  await page.locator('.mobile-pane-btn[data-pane="sidebar"]').click();
  await expect(page.locator(".app")).toHaveAttribute(
    "data-mobile-pane",
    "sidebar",
  );
};

describe("drag does not navigate on mobile", () => {
  it("keeps the list pane after a handle gesture that barely moves", async () => {
    await withPage(env.context, async (page) => {
      await openMobileList(page);
      await dragHandleInPlace(page, "md-a");
      // Wait for any spurious navigation to settle.
      await page.waitForTimeout(300);
      await expect(page.locator(".app")).toHaveAttribute(
        "data-mobile-pane",
        "sidebar",
      );
    });
  }, 30000);

  it("keeps the list pane after a full drag that lands back on the list", async () => {
    await withPage(env.context, async (page) => {
      await openMobileList(page);
      await dragHandleOnto(page, "md-b", "md-c");
      // Wait for any spurious navigation to settle.
      await page.waitForTimeout(300);
      await expect(page.locator(".app")).toHaveAttribute(
        "data-mobile-pane",
        "sidebar",
      );
    });
  }, 30000);

  it("a normal session tap still navigates to the detail pane", async () => {
    await withPage(env.context, async (page) => {
      await openMobileList(page);
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

describe("drag ghost tracks the cursor", () => {
  it("keeps the pointer inside the ghost instead of floating above it", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      const handle = page.locator(
        '.session-item[data-session-id="md-a"] .session-drag-handle',
      );
      await expect(handle).toBeVisible();
      const box = await handle.boundingBox();
      if (box === null) throw new Error("drag handle not found");
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

      await page.mouse.move(startX, startY);
      await page.mouse.down();

      // Cross the threshold so the ghost is born at the grab point.
      const cur1 = { x: startX + 25, y: startY + 12 };
      await page.mouse.move(cur1.x, cur1.y, { steps: 6 });

      const ghost = page.locator(".session-item.drag-ghost");
      await expect(ghost).toBeVisible();
      const ghostBox1 = await ghost.boundingBox();
      if (ghostBox1 === null) throw new Error("drag ghost not found");
      // The cursor must sit *inside* the ghost at the grab point. The bug
      // floated the ghost up ~130% of its height, leaving the cursor below it.
      expect(cur1.x).toBeGreaterThanOrEqual(ghostBox1.x);
      expect(cur1.x).toBeLessThanOrEqual(ghostBox1.x + ghostBox1.width);
      expect(cur1.y).toBeGreaterThanOrEqual(ghostBox1.y);
      expect(cur1.y).toBeLessThanOrEqual(ghostBox1.y + ghostBox1.height);

      // The ghost follows the cursor and the cursor stays inside as it moves.
      const cur2 = { x: startX + 90, y: startY + 55 };
      await page.mouse.move(cur2.x, cur2.y, { steps: 6 });
      const ghostBox2 = await ghost.boundingBox();
      if (ghostBox2 === null) throw new Error("drag ghost not found");
      expect(cur2.x).toBeGreaterThanOrEqual(ghostBox2.x);
      expect(cur2.x).toBeLessThanOrEqual(ghostBox2.x + ghostBox2.width);
      expect(cur2.y).toBeGreaterThanOrEqual(ghostBox2.y);
      expect(cur2.y).toBeLessThanOrEqual(ghostBox2.y + ghostBox2.height);

      // Release over the detail pane (outside #session-list) so no grouping
      // side effect leaks into the shared DB for later tests.
      await page.mouse.move(1000, 100, { steps: 6 });
      await page.mouse.up();
    });
  }, 30000);
});
