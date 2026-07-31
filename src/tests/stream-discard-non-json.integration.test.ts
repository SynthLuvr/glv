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

const hasStatus = (events: SseEvent[], value: string): boolean =>
  events.some(
    (e) => e.event === "status" && parseSseData(e.data).status === value,
  );

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

// A valid NDJSON message line matching goose's stdout and DB shape.
const VALID_LINE = JSON.stringify({
  role: "assistant",
  content: [{ type: "text", text: "structured reply" }],
});

// Non-JSON banner text goose may emit alongside structured output.
const RAW_LINE = "goose is ready";

let envValid: IntegrationEnv;
let envRaw: IntegrationEnv;

beforeAll(async () => {
  // sleepMs keeps each run alive long enough for the SSE to attach before the
  // line streams, so the transient preview reliably surfaces.
  envValid = await startIntegrationEnv("glv-discard-valid-", {
    lines: [VALID_LINE],
    sleepMs: 4000,
  });
  envRaw = await startIntegrationEnv("glv-discard-raw-", {
    lines: [RAW_LINE],
    sleepMs: 4000,
  });
  const validDir = envValid.scratchDir + "/p";
  const rawDir = envRaw.scratchDir + "/p";
  mkdirSync(validDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  insertSessions(envValid.dbs.sessionsDb, [
    { id: "discard-1", name: "Discard Valid", workingDir: validDir },
  ]);
  insertMessages(envValid.dbs.sessionsDb, "discard-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
  insertSessions(envRaw.dbs.sessionsDb, [
    { id: "raw-1", name: "Discard Raw", workingDir: rawDir },
  ]);
  insertMessages(envRaw.dbs.sessionsDb, "raw-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
}, 120000);

afterAll(async () => {
  await envValid?.cleanup();
  await envRaw?.cleanup();
});

describe("non-JSON stream lines are discarded", () => {
  it("renders a valid NDJSON message line as a preview", async () => {
    const stream = collectSse(
      envValid,
      "/sessions/discard-1/events",
      (evs) =>
        hasStatus(evs, "completed") && evs.some((e) => e.event === "preview"),
      15000,
    );
    await startRun(envValid, "discard-1", "valid test");
    const events = await stream;

    const preview = events.find((e) => e.event === "preview");
    expect(preview).toBeDefined();
    expect(preview?.data).toContain("structured reply");
    expect(preview?.data).toContain("stream-line");
  });

  it("drops a raw non-JSON line with no preview or stream-raw fallback", async () => {
    const collected: SseEvent[] = [];
    const collect = collectSse(
      envRaw,
      "/sessions/raw-1/events",
      // Never satisfy: collect every event until the timeout so a late
      // terminal-flush preview can't slip past an early resolve.
      () => false,
      8000,
      (e) => collected.push(e),
    );
    await startRun(envRaw, "raw-1", "raw test");
    try {
      await collect;
    } catch {
      // expected timeout
    }

    expect(hasStatus(collected, "completed")).toBe(true);
    expect(collected.filter((e) => e.event === "preview")).toHaveLength(0);
    expect(collected.some((e) => e.data.includes("stream-raw"))).toBe(false);
    expect(collected.some((e) => e.data.includes(RAW_LINE))).toBe(false);
  });
});
