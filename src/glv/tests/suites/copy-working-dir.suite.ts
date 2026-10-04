import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runCopyWorkingDirSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  // A deliberately long path so the displayed value is middle-truncated with an
  // ellipsis while the copy button still carries the whole working directory.
  const FULL_DIR = join(
    "a-very-long-temp-directory-uuid",
    "eae84395-25df-4d35-a95c-96062e8a6e9b",
  );

  const fullWorkingDir = (): string => join(env.scratchDir, FULL_DIR);

  // The only meta-chip that owns a copy button is the working-directory chip, so
  // filter on its presence to avoid colliding with the (also `.mono`) ID chip.
  const workingDirChip = (page: Page) =>
    page.locator(".meta-chip").filter({ has: page.locator(".copy-value-btn") });

  beforeAll(async () => {
    env = await fx.startEnv("glv-copy-working-dir-");
    fx.seedSessions(env, [
      {
        id: "t-copy-dir",
        name: "Copy Working Dir",
        workingDir: fullWorkingDir(),
      },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const open = async (run: (page: Page) => Promise<void>): Promise<void> =>
    withPage(env.context, async (page) => {
      await page.goto(env.baseUrl + "/sessions/" + fx.viewId("t-copy-dir"));
      await run(page);
    });

  describe("working directory copy", () => {
    it("renders a copy button carrying the whole working directory", async () => {
      await open(async (page) => {
        const expected = fullWorkingDir();
        const chip = workingDirChip(page);
        await expect(chip.locator(".copy-value-btn")).toHaveAttribute(
          "data-copy",
          expected,
        );
        const shown =
          (await chip.locator(".meta-value.mono").first().textContent()) ?? "";
        expect(shown).toContain("…");
        expect(shown.length).toBeLessThan(expected.length);
      });
    });

    it("copies the full path to the clipboard on click", async () => {
      await open(async (page) => {
        await page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"]);
        const expected = fullWorkingDir();
        const btn = workingDirChip(page).locator(".copy-value-btn");
        await btn.click();
        // writeText is async; poll until the clipboard reflects it.
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
            timeout: 5000,
          })
          .toBe(expected);
        await expect(btn).toHaveClass(/copied/);
      });
    });
  });
};

export { runCopyWorkingDirSuite };
