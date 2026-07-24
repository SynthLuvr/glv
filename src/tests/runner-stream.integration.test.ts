import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
let envSlow: IntegrationEnv;
let envErr: IntegrationEnv;

const hasStatus = (events: SseEvent[], value: string): boolean =>
  events.some(
    (e) => e.event === "status" && parseSseData(e.data).status === value,
  );

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Follow-up runs spawn goose in the session's working dir, so the dir must
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
  env = await startIntegrationEnv("glv-stream-");
  envSlow = await startIntegrationEnv("glv-stream-slow-", { sleepMs: 4000 });
  envErr = await startIntegrationEnv("glv-stream-err-", { exitCode: 1 });
  ensureDir(envSlow.scratchDir + "/r");
  ensureDir(envSlow.scratchDir + "/s");
  ensureDir(envErr.scratchDir + "/e");
  insertSessions(env.dbs.sessionsDb, [
    { id: "idle-1", name: "Idle", workingDir: env.scratchDir + "/i" },
    { id: "db-1", name: "Tail Me", workingDir: env.scratchDir + "/d" },
  ]);
  insertMessages(env.dbs.sessionsDb, "idle-1", [
    { role: "user", content: [{ type: "text", text: "baseline prompt" }] },
  ]);
  insertMessages(env.dbs.sessionsDb, "db-1", [
    { role: "assistant", content: [{ type: "text", text: "first line" }] },
  ]);
  insertSessions(envSlow.dbs.sessionsDb, [
    { id: "rs-1", name: "Runner", workingDir: envSlow.scratchDir + "/r" },
    { id: "rs-2", name: "Stopper", workingDir: envSlow.scratchDir + "/s" },
  ]);
  insertMessages(envSlow.dbs.sessionsDb, "rs-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
  insertMessages(envSlow.dbs.sessionsDb, "rs-2", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
  insertSessions(envErr.dbs.sessionsDb, [
    { id: "er-1", name: "Error", workingDir: envErr.scratchDir + "/e" },
  ]);
  insertMessages(envErr.dbs.sessionsDb, "er-1", [
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
    expect(preview?.data).toContain("mock goose reply");
  });

  it("reports an error status when goose exits non-zero", async () => {
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

describe("events stream — database tail", () => {
  it("appends a newly written message", async () => {
    const stream = collectSse(
      env,
      "/sessions/db-1/events",
      (evs) => evs.some((e) => e.event === "append"),
      12000,
    );
    await delay(500);
    insertMessages(env.dbs.sessionsDb, "db-1", [
      {
        role: "assistant",
        content: [{ type: "text", text: "appended later" }],
      },
    ]);
    const events = await stream;
    const append = events.find((e) => e.event === "append");
    expect(append).toBeDefined();
    expect(append?.data).toContain("appended later");
  });

  it("emits a rename when the session name changes", async () => {
    const stream = collectSse(
      env,
      "/sessions/db-1/events",
      (evs) => evs.some((e) => e.event === "rename"),
      12000,
    );
    await delay(500);
    const db = new DatabaseSync(env.dbs.sessionsDb);
    db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(
      "Renamed Tail",
      "db-1",
    );
    db.close();
    const events = await stream;
    const rename = events.find((e) => e.event === "rename");
    expect(parseSseData(rename?.data ?? "").name).toBe("Renamed Tail");
  });

  it("emits a deleted status when the session is removed", async () => {
    insertSessions(env.dbs.sessionsDb, [
      { id: "del-1", name: "Delete Me", workingDir: env.scratchDir + "/x" },
    ]);
    const stream = collectSse(
      env,
      "/sessions/del-1/events",
      (evs) => hasStatus(evs, "deleted"),
      12000,
    );
    await delay(500);
    const db = new DatabaseSync(env.dbs.sessionsDb);
    db.prepare("DELETE FROM sessions WHERE id = ?").run("del-1");
    db.close();
    const events = await stream;
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
