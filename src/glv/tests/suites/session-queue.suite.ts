import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// The concurrency-queue story: a new session submitted while every
// runner slot is busy must wait in the queue and start the moment a slot
// frees — not fail. The launchers' session-discovery poll used to start
// its countdown at enqueue time, so a run parked in the queue (which has
// not spawned, and therefore cannot create session data) always burned
// the whole poll timeout and the create route answered 502 "did not
// create a session in time" and stopped the queued run. The countdown
// now starts only once the run leaves the queue.
//
// The fixture pins --max-concurrent 1 and makes the mock agent hold its
// slot for 12s — longer than the create route's 10s poll timeout — so a
// queued second session cannot possibly start inside the old countdown.
// Both flavor mocks write the session row/transcript the moment the
// process starts, so discovery succeeds as soon as the slot frees.

const runSessionQueueSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";
  let dirA: string;
  let dirB: string;

  beforeAll(async () => {
    env = await fx.startEnv(
      "glv-sessionqueue-",
      // Holds the single slot past the 10s discovery deadline.
      { sleepMs: 12000 },
      undefined,
      undefined,
      undefined,
      // One slot: the second new session must queue.
      ["--max-concurrent", "1"],
    );
    token = seedApiToken(env.dbs.authDb, "session-queue");
    dirA = join(env.scratchDir, "queue-a");
    dirB = join(env.scratchDir, "queue-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("new session while every slot is busy", () => {
    it("queues the second session and starts it when the slot frees", async () => {
      // Fills the only slot; the run stays busy ~12s.
      const first = await bearerFetch(env, "/api/sessions", token, {
        method: "POST",
        body: new URLSearchParams({
          prompt: "first run — holds the slot",
          working_dir: dirA,
        }),
      });
      expect(first.status).toBe(201);
      const created = (await first.json()) as { id: string };
      expect(created.id).toContain(":");

      // Submitted while the first still runs: with the fix this waits
      // out the queue (~12s — beyond the old 10s deadline) and answers
      // 201 once the queued run has started and created its session.
      const t0 = Date.now();
      const second = await bearerFetch(env, "/api/sessions", token, {
        method: "POST",
        body: new URLSearchParams({
          prompt: "second run — must queue, not fail",
          working_dir: dirB,
        }),
      });
      const elapsed = Date.now() - t0;
      expect(second.status).toBe(201);
      const queued = (await second.json()) as { id: string; status: string };
      // Establishment happens after the run left the queue, so the
      // created run reports started, not queued.
      expect(queued.status).toBe("started");
      // The queue wait cannot be shorter than the mock run holding the
      // slot — proof the request really waited rather than failing fast.
      expect(elapsed).toBeGreaterThanOrEqual(11000);

      // Both sessions are readable over HTTP; the second's store row was
      // written by the agent process itself, so a 200 proves the queued
      // run genuinely started and ran.
      for (const id of [created.id, queued.id]) {
        const detail = await bearerFetch(env, `/api/sessions/${id}`, token);
        expect(detail.status).toBe(200);
      }
    }, 60000);
  });
};

export { runSessionQueueSuite };
