import { readdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

// When the agent never creates its session data, the create route times out
// and must clean up every directory it provisioned for the attempt: the
// per-batch upload dir and (in temp mode) the temp working dir. Both are
// untagged at that point, so the archive-time sweep would never collect
// them — they leak forever unless the failure path removes them itself.
const runCreateFailureCleanupSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const subdirCount = (base: string): number =>
    readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
      .length;

  beforeAll(async () => {
    env = await fx.startEnv("glv-createfail-", {
      sleepMs: 120000,
      neverCreateSession: true,
    });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("session-create failure cleanup", () => {
    it("removes the upload and temp dirs when no session is ever created", async () => {
      const uploadsBefore = subdirCount(env.uploadsDir);
      const tempBefore = subdirCount(env.tempDir);

      const form = new FormData();
      form.append("prompt", "never creates a session");
      form.append("session_mode", "temp");
      form.append(
        "uploads",
        new File(["attachment body"], "notes.txt", {
          type: "text/plain",
        }),
      );
      const res = await authedFetch(env, "/sessions", {
        method: "POST",
        body: form,
      });

      // The launch poll times out (pollTimeoutMs, 10s by default) and the
      // form is rejected; nothing may be left behind.
      expect(res.status).toBe(502);
      const html = await res.text();
      expect(html).toContain("No session");

      expect(subdirCount(env.uploadsDir)).toBe(uploadsBefore);
      expect(subdirCount(env.tempDir)).toBe(tempBefore);
    }, 40000);
  });
};

export { runCreateFailureCleanupSuite };
