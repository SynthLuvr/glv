import { expect, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runMobileDragSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-mobile-drag-");
    const ids = ["md-a", "md-b", "md-c"];
    fx.seedSessions(
      env,
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
      `.session-item[data-session-id="${fx.viewId(sourceId)}"]` +
        " .session-drag-handle",
    );
    const box = await handle.boundingBox();
    if (box === null) throw new Error("drag handle not found");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  const expectCursorInsideGhost = async (
    cursor: { x: number; y: number },
    ghost: Locator,
  ): Promise<void> => {
    const box = await ghost.boundingBox();
    if (box === null) throw new Error("drag ghost not found");
    expect(cursor.x).toBeGreaterThanOrEqual(box.x);
    expect(cursor.x).toBeLessThanOrEqual(box.x + box.width);
    expect(cursor.y).toBeGreaterThanOrEqual(box.y);
    expect(cursor.y).toBeLessThanOrEqual(box.y + box.height);
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
          .locator(
            `.session-item[data-session-id="${fx.viewId("md-a")}"] .session-name`,
          )
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
            `.session-item[data-session-id="${fx.viewId("md-a")}"] .session-drag-handle`,
          ),
        ).toBeVisible();

        await dragHandleOnto(page, "md-a", "md-b");

        await expect(page.locator(".session-group")).toBeVisible();
        await expect(
          page.locator(".session-group .group-members"),
        ).toContainText("MD-A");
        await expect(
          page.locator(".session-group .group-members"),
        ).toContainText("MD-B");
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
        const { x, y } = await handleCenter(page, "md-a");

        await page.mouse.move(x, y);
        await page.mouse.down();

        // Cross the drag threshold so the ghost appears at the grab point.
        const cursor1 = { x: x + 25, y: y + 12 };
        await page.mouse.move(cursor1.x, cursor1.y, { steps: 6 });

        const ghost = page.locator(".session-item.drag-ghost");
        await expect(ghost).toBeVisible();
        await expectCursorInsideGhost(cursor1, ghost);

        const cursor2 = { x: x + 90, y: y + 55 };
        await page.mouse.move(cursor2.x, cursor2.y, { steps: 6 });
        await expectCursorInsideGhost(cursor2, ghost);

        // Release off the session list so no grouping leaks into the shared DB.
        await page.mouse.move(1000, 100, { steps: 6 });
        await page.mouse.up();
      });
    }, 30000);
  });
};

export { runMobileDragSuite };
