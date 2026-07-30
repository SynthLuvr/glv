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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

// Envelope-format NDJSON matching real goose's stream-json output:
// {"type":"message","message":{"role":"assistant","content":[...]}}
const ENVELOPE_LINES = [
  JSON.stringify({
    type: "message",
    message: {
      id: "msg-envelope-1",
      role: "assistant",
      created: 1785432183,
      content: [{ type: "text", text: "envelope reply one" }],
    },
  }),
  JSON.stringify({
    type: "message",
    message: {
      id: "msg-envelope-2",
      role: "assistant",
      created: 1785432184,
      content: [{ type: "text", text: "envelope reply two" }],
    },
  }),
];

// A non-JSON line goose might emit alongside structured output.
const RAW_LINE = "goose is ready";

let envEnvelope: IntegrationEnv;
let envReconnect: IntegrationEnv;

beforeAll(async () => {
  envEnvelope = await startIntegrationEnv("glv-env-envelope-", {
    lines: [...ENVELOPE_LINES, RAW_LINE],
    sleepMs: 500,
    lineDelayMs: 200,
    writeDb: true,
  });
  envReconnect = await startIntegrationEnv("glv-env-reconnect-", {
    lines: [
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "reconnect reply" }],
      }),
      RAW_LINE,
    ],
    writeDb: true,
  });
  const envelopeDir = envEnvelope.scratchDir + "/p";
  const reconnectDir = envReconnect.scratchDir + "/p";
  mkdirSync(envelopeDir, { recursive: true });
  mkdirSync(reconnectDir, { recursive: true });
  insertSessions(envEnvelope.dbs.sessionsDb, [
    { id: "env-1", name: "Envelope", workingDir: envelopeDir },
  ]);
  insertMessages(envEnvelope.dbs.sessionsDb, "env-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
  insertSessions(envReconnect.dbs.sessionsDb, [
    { id: "rc-1", name: "Reconnect", workingDir: reconnectDir },
  ]);
  insertMessages(envReconnect.dbs.sessionsDb, "rc-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
}, 120000);

afterAll(async () => {
  await envEnvelope?.cleanup();
  await envReconnect?.cleanup();
});

describe("envelope-format NDJSON preview", () => {
  it("renders goose envelope lines as HTML preview, not raw JSON", async () => {
    const stream = collectSse(
      envEnvelope,
      "/sessions/env-1/events",
      (evs) =>
        hasStatus(evs, "completed") && evs.some((e) => e.event === "preview"),
      15000,
    );
    await startRun(envEnvelope, "env-1", "envelope test");
    const events = await stream;

    const previews = events.filter((e) => e.event === "preview");
    expect(previews.length).toBeGreaterThan(0);

    const envelopePreview = previews.find((p) =>
      p.data.includes("envelope reply"),
    );
    expect(envelopePreview).toBeDefined();
    // The envelope wrapper must not leak as raw text.
    expect(envelopePreview?.data).not.toContain('"type":"message"');

    // Non-JSON lines still render as stream-raw.
    const rawPreview = previews.find((p) => p.data.includes("goose is ready"));
    expect(rawPreview).toBeDefined();
    expect(rawPreview?.data).toContain("stream-raw");
  });
});

describe("terminal reconnect — no stale preview re-flush", () => {
  it("does not emit preview events when reconnecting to a finished run", async () => {
    await startRun(envReconnect, "rc-1", "reconnect test");
    await delay(2000);

    // Simulate an EventSource reconnect: the handle is still retained (30s
    // window), so its ring buffer still holds every buffered NDJSON line.
    const collected: SseEvent[] = [];
    try {
      await collectSse(
        envReconnect,
        "/sessions/rc-1/events",
        // Never satisfy — collect everything until the timeout fires.
        () => false,
        5000,
        (e) => collected.push(e),
      );
    } catch {
      // Expected: collectSse rejects on timeout.
    }

    const previews = collected.filter((e) => e.event === "preview");
    expect(previews).toHaveLength(0);

    // Catchup and status events should still arrive.
    expect(collected.some((e) => e.event === "messages")).toBe(true);
    expect(hasStatus(collected, "completed")).toBe(true);
  });
});
