import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

// A payload that would execute if ever injected as a live HTML tag instead of
// escaped text. A user prompt renders as plain (non-markdown) text, so this
// exercises the JSX child-escaping path directly — not the DOMPurify path that
// already sanitises markdown.
const PAYLOAD = "<script>alert(1)</script>";

let env: IntegrationEnv;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-escape-");
  insertSessions(env.dbs.sessionsDb, [
    {
      id: "x-escape",
      name: "Escape Check",
      workingDir: join(env.scratchDir, "escape"),
    },
  ]);
  insertMessages(env.dbs.sessionsDb, "x-escape", [
    { role: "user", content: [{ type: "text", text: PAYLOAD }] },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("HTML escaping of user content", () => {
  it("escapes a user prompt so it renders as text, never as a live tag", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/x-escape`);
      // The prompt surfaces as literal display text (the escaped entities decode
      // back to the angle-bracket characters)…
      await expect(page.locator(".message-text").first()).toContainText(
        PAYLOAD,
      );
      // …while the underlying HTML carries escaped entities, not a raw tag.
      expect(await page.locator(".message-text").first().innerHTML()).toContain(
        "&lt;script&gt;",
      );
      // The payload never becomes an executable <script> element.
      await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(
        0,
      );
    });
  });
});
