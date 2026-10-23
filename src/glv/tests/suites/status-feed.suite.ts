import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { FEED_JSON_EVENTS, parsePayload } from "../../sse-events.js";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
  type SseEvent,
} from "../harness.js";

const runStatusFeedSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const statusData = (events: SseEvent[]): Array<Record<string, unknown>> =>
    events.filter((e) => e.event === "status").map((e) => parseSseData(e.data));

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    env = await fx.startEnv("glv-status-", { sleepMs: 3000 });
    mkdirSync(env.scratchDir + "/s1", { recursive: true });
    fx.seedSessions(env, [
      { id: "sf-1", name: "Status One", workingDir: env.scratchDir + "/s1" },
      { id: "sf-2", name: "Status Two", workingDir: env.scratchDir + "/s2" },
    ]);
    fx.seedMessages(env, "sf-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("global status feed", () => {
    it("emits a names snapshot, not rename events, on connect", async () => {
      const events = await collectSse(
        env,
        "/events/status",
        (evs) => evs.some((e) => e.event === "names"),
        8000,
      );
      const sync = events.find((e) => e.event === "sync");
      expect(sync).toBeDefined();
      expect(JSON.parse(sync?.data ?? "[]")).toEqual([]);
      // Every sidebar session's current name arrives on one `names`
      // snapshot frame — "these are the names", not "each was renamed".
      const snapshots = events.filter((e) => e.event === "names");
      expect(snapshots.length).toBe(1);
      const names = parsePayload(
        FEED_JSON_EVENTS.names,
        snapshots[0]?.data ?? "",
      )?.map((entry) => entry.name);
      expect(names).toContain("Status One");
      expect(names).toContain("Status Two");
      // `rename` is reserved for actual deltas, and nothing has changed.
      expect(events.filter((e) => e.event === "rename")).toEqual([]);
    });

    it("reserves rename for an actual name change", async () => {
      let renamed = false;
      const events = await collectSse(
        env,
        "/events/status",
        (evs) => evs.some((e) => e.event === "rename"),
        15000,
        (e) => {
          // The rename must land after the stream has snapshotted the
          // baseline names, or the new name is the baseline and no delta
          // is ever emitted.
          if (e.event === "names" && !renamed) {
            renamed = true;
            fx.renameSession(env, "sf-1", "Renamed One");
          }
        },
      );
      const renames = events.filter((e) => e.event === "rename");
      expect(renames.length).toBe(1);
      expect(parseSseData(renames[0]?.data ?? "{}")).toEqual({
        sessionId: fx.viewId("sf-1"),
        name: "Renamed One",
      });
    });

    it("emits running then done deltas as a run starts and ends", async () => {
      const stream = collectSse(
        env,
        "/events/status",
        (evs) => statusData(evs).some((s) => s.status === "done"),
        15000,
      );
      await delay(400);
      await authedFetch(env, `/sessions/${fx.viewId("sf-1")}/prompt`, {
        method: "POST",
        body: new URLSearchParams({ prompt: "run it" }),
        headers: { "HX-Request": "true" },
      });
      const events = await stream;
      const statuses = statusData(events).map((s) => s.status);
      expect(statuses).toContain("running");
      expect(statuses).toContain("done");
    });
  });
};

export { runStatusFeedSuite };
