import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
  withPage,
} from "../harness.js";

// A new session submitted while every runner slot is busy must queue and
// run when a slot frees, not fail: the launchers' discovery poll used to
// start its countdown at enqueue time, so a queued run — not yet spawned,
// unable to create session data — burned the whole timeout and the create
// route answered 502 and stopped it. The countdown now starts when the
// run leaves the queue.
//
// The fixture pins --max-concurrent 1 and a mock holding its slot for
// 12s — past the route's 10s poll timeout — so the second create cannot
// possibly finish inside the old countdown. Both flavor mocks write the
// session row/transcript the moment the process starts, so discovery
// succeeds as soon as the slot frees.

const runSessionQueueSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";

  const scratchDir = (name: string): string => {
    const dir = join(env.scratchDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

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
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("queues the second session and starts it when the slot frees", async () => {
    const holdDir = scratchDir("hold-slot");
    const queuedDir = scratchDir("queued-behind");

    // Fills the only slot; the mock holds it ~12s.
    const first = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({
        prompt: "first run — holds the slot",
        working_dir: holdDir,
      }),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    expect(created.id).toContain(":");

    // Submitted while the first still runs: must wait out the queue
    // (~12s — beyond the old 10s deadline) instead of failing the create.
    const t0 = Date.now();
    const second = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({
        prompt: "second run — must queue, not fail",
        working_dir: queuedDir,
      }),
    });
    const elapsed = Date.now() - t0;
    expect(second.status).toBe(201);
    const queued = (await second.json()) as { id: string; status: string };
    // Established after the run left the queue, so it reports started.
    expect(queued.status).toBe("started");
    // Not shorter than the mock holding the slot: the request really
    // waited rather than failing fast.
    expect(elapsed).toBeGreaterThanOrEqual(11000);

    // The second session's store row is written by the agent process
    // itself, so a 200 proves the queued run genuinely started and ran.
    for (const id of [created.id, queued.id]) {
      const detail = await bearerFetch(env, `/api/sessions/${id}`, token);
      expect(detail.status).toBe(200);
    }
  }, 60000);

  it("surfaces the queue wait on the form while the create waits for a slot", async () => {
    const fillerDir = scratchDir("form-filler");
    const formDir = scratchDir("form-subject");

    // Fill the only slot; the mock holds it ~12s.
    const filler = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({
        prompt: "queue-wait filler — holds the slot",
        working_dir: fillerDir,
      }),
    });
    expect(filler.status).toBe(201);

    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await page.locator("form.new-session-form").waitFor();
      await page.locator('input[name="working_dir"]').fill(formDir);
      await page
        .locator("textarea[name=prompt]")
        .fill("second session — the pool is full");
      await page.locator("form.new-session-form button[type=submit]").click();

      // The submit pends for as long as the pool stays full; the hint
      // names the wait instead of leaving a silently disabled button.
      await expect(
        page.locator("form.new-session-form button[type=submit]"),
      ).toBeDisabled();
      await expect(page.locator("[data-queue-wait]")).toHaveText(
        "Waiting for a free slot…",
        { timeout: 10000 },
      );

      // The slot frees, the queued run starts, and the create lands the
      // session; the swapped-in transcript view has no wait hint.
      await page.waitForURL("**/sessions/**", { timeout: 30000 });
      await expect(page.locator("[data-queue-wait]")).toHaveCount(0);
    });
  }, 90000);
};

export { runSessionQueueSuite };
