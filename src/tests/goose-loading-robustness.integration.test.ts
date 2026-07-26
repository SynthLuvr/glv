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

// Two independent servers: one where goose dies with a stderr load error, one
// where goose hangs at startup so the restart-on-hang path is exercised.
let envErr: IntegrationEnv;
let envHang: IntegrationEnv;

// The stderr line goose writes before failing, like a provider/MCP load error.
const LOAD_ERROR = "Error: failed to initialise MCP server (boom)";

const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

const startRun = (e: IntegrationEnv, id: string): Promise<Response> =>
  authedFetch(e, `/sessions/${id}/prompt`, {
    method: "POST",
    body: new URLSearchParams({ prompt: "do something" }),
    headers: { "HX-Request": "true" },
  });

// The terminal status event carrying the surfaced error string.
const errorEvent = (events: SseEvent[]): SseEvent | undefined =>
  events.find(
    (e) => e.event === "status" && parseSseData(e.data).status === "error",
  );

const hasStatus = (events: SseEvent[], value: string): boolean =>
  events.some(
    (e) => e.event === "status" && parseSseData(e.data).status === value,
  );

beforeAll(async () => {
  envErr = await startIntegrationEnv("glv-load-err-", {
    exitCode: 1,
    stderr: LOAD_ERROR,
  });
  // Short startup deadline + a single restart so the hang test resolves fast.
  envHang = await startIntegrationEnv(
    "glv-load-hang-",
    { sleepMs: 4000, stderr: "hang while loading providers" },
    { GLV_STARTUP_TIMEOUT_MS: "300", GLV_STARTUP_RETRIES: "1" },
  );
  ensureDir(envErr.scratchDir + "/e");
  ensureDir(envHang.scratchDir + "/h");
  // Seed a session + message so the events stream has a baseline. Each test
  // uses a fresh session so its stream can't resolve on a prior terminal run.
  insertSessions(envErr.dbs.sessionsDb, [
    { id: "se-1", name: "Err", workingDir: envErr.scratchDir + "/e" },
  ]);
  insertMessages(envErr.dbs.sessionsDb, "se-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
  insertSessions(envHang.dbs.sessionsDb, [
    { id: "ht-1", name: "Hang", workingDir: envHang.scratchDir + "/h" },
  ]);
  insertMessages(envHang.dbs.sessionsDb, "ht-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
}, 120000);

afterAll(async () => {
  await envErr?.cleanup();
  await envHang?.cleanup();
});

describe("goose load failures — diagnostics surface", () => {
  it("surfaces goose stderr in the error status and logs a warn trail", async () => {
    const stream = collectSse(
      envErr,
      "/sessions/se-1/events",
      (evs) => hasStatus(evs, "error"),
      15000,
    );
    await startRun(envErr, "se-1");
    const events = await stream;
    const err = parseSseData(errorEvent(events)?.data ?? "").error;
    // Before: "goose exited with code 1". Now the load error is included.
    expect(typeof err).toBe("string");
    expect(err).toContain("code 1");
    expect(err).toContain("failed to initialise MCP server");
    // The failure also leaves a [glv:runner] diagnostic. The warn fires
    // synchronously with the status change, so it is already in stderr by the
    // time the stream observes the terminal "error" status.
    expect(envErr.serverStderr()).toContain("[glv:runner]");
    expect(envErr.serverStderr()).toContain("failed to initialise MCP server");
  });
});

describe("goose load failures — startup timeout & restart", () => {
  it("restarts a hung goose, then errors with a no-output message", async () => {
    const stream = collectSse(
      envHang,
      "/sessions/ht-1/events",
      (evs) => hasStatus(evs, "error"),
      15000,
    );
    await startRun(envHang, "ht-1");
    const events = await stream;
    const err = parseSseData(errorEvent(events)?.data ?? "").error;
    expect(typeof err).toBe("string");
    expect(err).toContain("no output");
    // Salvaged stderr from the killed process is appended for context.
    expect(err).toContain("hang while loading providers");
    // The restart actually happened: a "restarting" warn was logged.
    expect(envHang.serverStderr()).toContain("restarting");
  });
});
