import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  collectSse,
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  parseSseData,
  type SseEvent,
  startIntegrationEnv,
} from "./integration-harness";

let env: IntegrationEnv;

const statusData = (events: SseEvent[]): Array<Record<string, unknown>> =>
  events.filter((e) => e.event === "status").map((e) => parseSseData(e.data));

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startIntegrationEnv("glv-status-", { sleepMs: 3000 });
  mkdirSync(env.scratchDir + "/s1", { recursive: true });
  insertSessions(env.dbs.sessionsDb, [
    { id: "sf-1", name: "Status One", workingDir: env.scratchDir + "/s1" },
    { id: "sf-2", name: "Status Two", workingDir: env.scratchDir + "/s2" },
  ]);
  insertMessages(env.dbs.sessionsDb, "sf-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("global status feed", () => {
  it("emits an empty sync and per-session names on connect", async () => {
    const events = await collectSse(
      env,
      "/events/status",
      (evs) =>
        evs.some((e) => e.event === "sync") &&
        evs.filter((e) => e.event === "rename").length >= 2,
      8000,
    );
    const sync = events.find((e) => e.event === "sync");
    expect(sync).toBeDefined();
    expect(JSON.parse(sync?.data ?? "[]")).toEqual([]);
    const names = events
      .filter((e) => e.event === "rename")
      .map((e) => parseSseData(e.data).name);
    expect(names).toContain("Status One");
    expect(names).toContain("Status Two");
  });

  it("emits running then done deltas as a run starts and ends", async () => {
    const stream = collectSse(
      env,
      "/events/status",
      (evs) => statusData(evs).some((s) => s.status === "done"),
      15000,
    );
    await delay(400);
    await authedFetch(env, "/sessions/sf-1/prompt", {
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
