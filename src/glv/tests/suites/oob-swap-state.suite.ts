import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The rename-from-header route answers with the title fragment plus an
// out-of-band sidebar re-render. htmx dispatches htmx:oobAfterSwap (not
// htmx:afterSwap) for the OOB target, so client-side #session-list state —
// collapsed groups — used to be wiped and never re-applied.
const runOobSwapStateSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-oobswap-");
    fx.seedSessions(env, [
      {
        id: "o-a",
        name: "OOB Alpha",
        workingDir: `${env.scratchDir}/o-a`,
      },
      {
        id: "o-b",
        name: "OOB Beta",
        workingDir: `${env.scratchDir}/o-b`,
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("out-of-band sidebar swaps preserve client state", () => {
    it("keeps a collapsed group collapsed after a header rename", async () => {
      const groupRes = await authedFetch(
        env,
        `/sessions/${fx.viewId("o-a")}/group-with`,
        {
          method: "POST",
          body: new URLSearchParams({ otherId: fx.viewId("o-b") }),
          headers: { "HX-Request": "true" },
        },
      );
      expect(groupRes.status).toBe(200);

      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const group = page.locator(".session-group");
        await expect(group).toBeVisible();

        await page.locator("[data-action='toggle-group']").first().click();
        await expect(group).toHaveClass(/collapsed/);

        // The collapsed set persists in localStorage; open the grouped
        // session by URL (collapse hides the member links) and rename it
        // from the transcript header — the response swaps the title and
        // re-renders the sidebar out-of-band.
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("o-a")}`);
        await expect(page.locator("#detail-pane")).toContainText("OOB Alpha");
        await expect(page.locator(".session-group")).toHaveClass(/collapsed/);
        await page.locator("#detail-pane [data-action='rename']").click();
        const input = page.locator("#detail-pane .rename-input");
        await input.fill("Renamed OOB");
        await input.press("Enter");

        await expect(page.locator("#detail-pane")).toContainText(
          "Renamed OOB",
          { timeout: 10000 },
        );
        // Give the OOB swap a beat, then the collapsed state must survive.
        await page.waitForTimeout(500);
        await expect(page.locator(".session-group")).toHaveClass(/collapsed/);
      });
    });
  });
};

export { runOobSwapStateSuite };
