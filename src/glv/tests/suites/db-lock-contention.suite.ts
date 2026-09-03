import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// glv-owned SQLite files must wait out a transient lock instead of
// failing at once: node:sqlite's default busy timeout is 0, and CI has
// seen serve die with "database is locked" the instant another handle
// (a scanner eyeing a fresh file, a concurrent command) held the auth
// database. The held lock below reproduces that window: without the
// busy wait the request 500s while the lock is up; with it, the request
// parks on the lock, completes after the commit, and the session stays
// valid.

const runDbLockContentionSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-db-lock-");
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("serves an authenticated request through a lock on the auth database", async () => {
    const lock = new DatabaseSync(join(env.scratchDir, "auth.db"));
    try {
      lock.exec("PRAGMA busy_timeout=5000");
      lock.exec("BEGIN EXCLUSIVE");
      const pending = authedFetch(env, "/");
      await sleep(500);
      lock.exec("COMMIT");
      const res = await pending;
      expect(res.status).toBe(200);
    } finally {
      lock.close();
    }
  });
};

export { runDbLockContentionSuite };
