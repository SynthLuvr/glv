import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  jobNameFor,
  openCronSessionsDb,
  tagCronSession,
} from "../../cron-sessions.js";
import {
  addMember,
  createGroup,
  groupIdOf,
  openGroupsDb,
} from "../../groups/db.js";
import { tagDir } from "../../server/uploads.js";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// Archive hides a session; delete must destroy every record of it. Drives
// the real /sessions/:id/delete route end-to-end: the flavor's own store
// (assertSessionGone), glv's sidecars (group membership, cron job tag),
// tagged temp working dirs, the sidebar, and the three-tap UI.
const runSessionDeleteSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let homeDir: string;
  let cronDbPath: string;

  const post = (
    path: string,
    body: Record<string, string> = {},
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: { "HX-Request": "true" },
    });

  beforeAll(async () => {
    // An isolated HOME keeps the cron scheduler away from any real config,
    // and an explicit GLV_CRON_DB gives the suite a deterministic sidecar
    // path to seed and inspect.
    homeDir = mkdtempSync(join(tmpdir(), "glv-del-home-"));
    cronDbPath = join(homeDir, "cron.db");
    env = await fx.startEnv("glv-delete-", undefined, homeDir, {
      GLV_CRON_DB: cronDbPath,
    });
    fx.seedSessions(env, [
      {
        id: "dl-a",
        name: "Delete Me",
        workingDir: join(env.scratchDir, "a"),
      },
      { id: "dl-b", name: "Keep Me", workingDir: join(env.scratchDir, "b") },
      {
        id: "dl-ui",
        name: "UI Delete",
        workingDir: join(env.scratchDir, "ui"),
      },
      {
        id: "dl-keep",
        name: "UI Keep",
        workingDir: join(env.scratchDir, "ui2"),
      },
    ]);
    fx.seedMessages(env, "dl-a", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe("permanent delete", () => {
    it("destroys the session and every trace of it", async () => {
      // Rename first so the claude flavor has a meta sidecar row that the
      // delete must also erase; for goose it is just a row update.
      await post("/sessions/dl-a/rename", { name: "Doomed", from: "header" });

      // glv-owned traces: group membership, the cron job tag, and a
      // tagged temp working dir from a past run.
      const groups = openGroupsDb(env.dbs.groupsDb);
      const group = createGroup(groups, { name: "Doomed Group" });
      addMember(groups, group.id, "dl-a");
      groups.close();
      const cronDb = openCronSessionsDb(cronDbPath);
      tagCronSession(cronDb, "dl-a", "nightly-job");
      cronDb.close();
      const tempDir = join(env.tempDir, "tagged-run");
      mkdirSync(tempDir, { recursive: true });
      tagDir(tempDir, "dl-a");

      const res = await post("/sessions/dl-a/delete");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("new-session-form");

      fx.assertSessionGone(env, "dl-a");

      const groupsAfter = openGroupsDb(env.dbs.groupsDb);
      expect(groupIdOf(groupsAfter, "dl-a")).toBeUndefined();
      groupsAfter.close();
      const cronAfter = openCronSessionsDb(cronDbPath);
      expect(jobNameFor(cronAfter, "dl-a")).toBeUndefined();
      cronAfter.close();

      expect(existsSync(join(env.tempDir, "tagged-run"))).toBe(false);

      const gone = await authedFetch(env, "/sessions/dl-a");
      expect(gone.status).toBe(404);
      expect(await gone.text()).toContain("Session not found");
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-list")).not.toContainText("Doomed");
        await expect(page.locator("#session-list")).toContainText("Keep Me");
      });
    });

    it("404s when deleting an unknown session", async () => {
      const res = await post("/sessions/nope/delete");
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Session not found");
    });
  });

  describe("delete UI", () => {
    it("takes three taps: action sheet, Delete permanently, confirm OK", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/dl-ui`);
        await expect(page.locator(".archive-btn")).toBeVisible();
        await expect(page.locator(".archive-btn")).toHaveText("Archive");

        await page.click(".session-menu-toggle");
        const panel = page.locator(".session-menu-panel");
        await expect(panel).toBeVisible();
        await expect(panel).toContainText("Delete permanently");

        // Delete, then press OK in the confirmation dialog.
        const dialogs: string[] = [];
        page.on("dialog", (dialog) => {
          dialogs.push(dialog.message());
          void dialog.accept();
        });
        await page.click(".session-menu-delete");
        await expect(page.locator(".new-session-form")).toBeVisible();
        expect(dialogs[0]).toContain("Permanently delete");
      });
      fx.assertSessionGone(env, "dl-ui");
    });

    it("keeps the session when the confirmation dialog is cancelled", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/dl-keep`);
        page.on("dialog", (dialog) => {
          void dialog.dismiss();
        });
        await page.click(".session-menu-toggle");
        await page.click(".session-menu-delete");
        // No swap happened — the transcript is still on screen.
        await expect(page.locator(".session-header")).toContainText("UI Keep");
      });
      const kept = await authedFetch(env, "/sessions/dl-keep");
      expect(kept.status).toBe(200);
    });

    it("renders a bottom sheet on mobile and dismisses on Cancel / tap-outside", async () => {
      await withPage(env.context, async (page) => {
        await page.setViewportSize({ width: 400, height: 800 });
        await page.goto(`${env.baseUrl}/sessions/dl-keep`);
        const panel = page.locator(".session-menu-panel");
        await expect(panel).toBeHidden();

        await page.click(".session-menu-toggle");
        await expect(panel).toBeVisible();
        await expect(panel.locator(".session-menu-delete")).toBeVisible();
        await expect(panel.locator(".session-menu-cancel")).toBeVisible();
        // Docked to the viewport bottom — a sheet, not a dropdown. It slides
        // up (transform transition), so poll until it settles in place.
        const position = await panel.evaluate(
          (el) => getComputedStyle(el).position,
        );
        expect(position).toBe("fixed");
        const transition = await panel.evaluate(
          (el) => getComputedStyle(el).transitionProperty,
        );
        expect(transition).toContain("transform");
        await expect
          .poll(async () => {
            const box = await panel.boundingBox();
            return box === null ? -1 : box.y + box.height;
          })
          .toBeCloseTo(800, 0);

        // Cancel dismisses without deleting.
        await page.click(".session-menu-cancel");
        await expect(panel).toBeHidden();

        // Tap outside (the scrim) dismisses too.
        await page.click(".session-menu-toggle");
        await expect(panel).toBeVisible();
        await page.mouse.click(200, 100);
        await expect(panel).toBeHidden();

        await expect(page.locator(".session-header")).toContainText("UI Keep");
      });
    });

    it("renders a plain dropdown on desktop, closable with Escape", async () => {
      await withPage(env.context, async (page) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${env.baseUrl}/sessions/dl-keep`);
        await page.click(".session-menu-toggle");
        const panel = page.locator(".session-menu-panel");
        await expect(panel).toBeVisible();
        // Anchored to the header, not fixed to the viewport.
        const position = await panel.evaluate(
          (el) => getComputedStyle(el).position,
        );
        expect(position).toBe("absolute");
        // No Cancel row in a dropdown — outside click and Escape close it.
        await expect(panel.locator(".session-menu-cancel")).toBeHidden();
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
      });
    });
  });
};

export { runSessionDeleteSuite };
