import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
  type SseEvent,
} from "../harness.js";

const runRunnerStreamSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let envSlow: IntegrationEnv;
  let envErr: IntegrationEnv;

  const hasStatus = (events: SseEvent[], value: string): boolean =>
    events.some(
      (e) => e.event === "status" && parseSseData(e.data).status === value,
    );

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Follow-up runs spawn the agent in the session's working dir, so the dir must
  // exist or execa rejects and the run errors out immediately.
  const ensureDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  };

  const startRun = (
    e: IntegrationEnv,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    authedFetch(e, "/sessions/" + id + "/prompt", {
      method: "POST",
      body: new URLSearchParams({ prompt }),
      headers: { "HX-Request": "true" },
    });

  beforeAll(async () => {
    env = await fx.startEnv("glv-stream-");
    envSlow = await fx.startEnv("glv-stream-slow-", { sleepMs: 4000 });
    envErr = await fx.startEnv("glv-stream-err-", { exitCode: 1 });
    ensureDir(envSlow.scratchDir + "/r");
    ensureDir(envSlow.scratchDir + "/s");
    ensureDir(envErr.scratchDir + "/e");
    fx.seedSessions(env, [
      { id: "idle-1", name: "Idle", workingDir: env.scratchDir + "/i" },
      { id: "db-1", name: "Tail Me", workingDir: env.scratchDir + "/d" },
    ]);
    fx.seedMessages(env, "idle-1", [
      { role: "user", content: [{ type: "text", text: "baseline prompt" }] },
    ]);
    fx.seedMessages(env, "db-1", [
      { role: "assistant", content: [{ type: "text", text: "first line" }] },
    ]);
    fx.seedSessions(envSlow, [
      { id: "rs-1", name: "Runner", workingDir: envSlow.scratchDir + "/r" },
      { id: "rs-2", name: "Stopper", workingDir: envSlow.scratchDir + "/s" },
    ]);
    fx.seedMessages(envSlow, "rs-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
    fx.seedMessages(envSlow, "rs-2", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
    fx.seedSessions(envErr, [
      { id: "er-1", name: "Error", workingDir: envErr.scratchDir + "/e" },
    ]);
    fx.seedMessages(envErr, "er-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
    await envSlow?.cleanup();
    await envErr?.cleanup();
  });

  describe("events stream — baseline and idle", () => {
    it("emits a messages baseline and an idle status on connect", async () => {
      const events = await collectSse(
        env,
        "/sessions/idle-1/events",
        (evs) =>
          evs.some((e) => e.event === "messages") &&
          evs.some((e) => e.event === "status"),
        8000,
      );
      const messages = events.find((e) => e.event === "messages");
      expect(messages).toBeDefined();
      expect(parseSseData(messages?.data ?? "").cursor).toBe(1);
      expect(hasStatus(events, "idle")).toBe(true);
    });
  });

  describe("events stream — running run", () => {
    it("streams running then completed with a rendered preview line", async () => {
      const stream = collectSse(
        envSlow,
        "/sessions/rs-1/events",
        (evs) =>
          hasStatus(evs, "completed") && evs.some((e) => e.event === "preview"),
        15000,
      );
      await startRun(envSlow, "rs-1", "do the thing");
      const events = await stream;
      expect(hasStatus(events, "running")).toBe(true);
      expect(hasStatus(events, "completed")).toBe(true);
      const preview = events.find((e) => e.event === "preview");
      expect(preview?.data).toContain(fx.mockReply);
    });

    it(`reports an error status when ${fx.name} exits non-zero`, async () => {
      const stream = collectSse(
        envErr,
        "/sessions/er-1/events",
        (evs) => hasStatus(evs, "error"),
        15000,
      );
      await startRun(envErr, "er-1", "fail please");
      const events = await stream;
      expect(hasStatus(events, "error")).toBe(true);
    });
  });

  describe("events stream — store tail", () => {
    it("appends a newly written message", async () => {
      // Seed only after the stream has attached (its first event), so the
      // new row can never land inside the baseline snapshot — the same
      // attach-then-mutate rule the rename test below follows. A fixed
      // delay races on loaded CI shards.
      let seeded = false;
      const stream = collectSse(
        env,
        "/sessions/db-1/events",
        (evs) => evs.some((e) => e.event === "append"),
        12000,
        (e) => {
          if (e.event === "status" && !seeded) {
            seeded = true;
            fx.seedMessages(env, "db-1", [
              {
                role: "assistant",
                content: [{ type: "text", text: "appended later" }],
              },
            ]);
          }
        },
      );
      const events = await stream;
      const append = events.find((e) => e.event === "append");
      expect(append).toBeDefined();
      expect(append?.data).toContain("appended later");
    });

    it("emits a rename when the session name changes", async () => {
      const renameTo = (name: string): void =>
        fx.renameSession(env, "db-1", name);
      // The rename must land after the stream snapshots its baseline name, or
      // the new name is the baseline and no rename delta is ever emitted.
      const events = await collectSse(
        env,
        "/sessions/db-1/events",
        (evs) => evs.some((e) => e.event === "rename"),
        12000,
        (e) => {
          if (e.event === "status") renameTo("Renamed Tail");
        },
      );
      const rename = events.find((e) => e.event === "rename");
      expect(parseSseData(rename?.data ?? "").name).toBe("Renamed Tail");
    });

    it("emits a deleted status when the session is removed", async () => {
      fx.seedSessions(env, [
        { id: "del-1", name: "Delete Me", workingDir: env.scratchDir + "/x" },
      ]);
      // The deletion must land after the stream has observed the session
      // (its first status event): if the session is gone before the
      // handler's first poll, no deleted delta is ever emitted — the
      // same attach-then-mutate rule the rename test above follows.
      let removed = false;
      const events = await collectSse(
        env,
        "/sessions/del-1/events",
        (evs) => hasStatus(evs, "deleted"),
        12000,
        (e) => {
          if (!removed && e.event === "status") {
            removed = true;
            fx.deleteSession(env, "del-1");
          }
        },
      );
      expect(hasStatus(events, "deleted")).toBe(true);
    });
  });

  describe("follow-up prompt queuing and stop", () => {
    it("queues a second prompt while the first runs", async () => {
      await startRun(envSlow, "rs-1", "first slow prompt");
      const res = await startRun(envSlow, "rs-1", "second queued prompt");
      const html = await res.text();
      expect(html).toContain("queued-prompt");
      expect(html).toContain("second queued prompt");
    });

    it("stops a running session and returns to an idle prompt bar", async () => {
      await startRun(envSlow, "rs-2", "long running");
      const res = await authedFetch(envSlow, "/sessions/rs-2/stop", {
        method: "POST",
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("send-btn");
      expect(html).not.toContain("status-hint running");
    });
  });
};

export { runRunnerStreamSuite };
