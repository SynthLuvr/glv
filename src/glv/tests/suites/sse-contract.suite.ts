import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { type Type } from "arktype";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  FEED_JSON_EVENTS,
  parsePayload,
  SESSION_JSON_EVENTS,
} from "../../sse-events.js";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  type SseEvent,
} from "../harness.js";

// The SSE wire contract, exercised end to end: the server emits real
// events over HTTP/SSE and every JSON frame must satisfy the exact
// schema the browser bundle parses it with. The schemas are product
// code's, so a field that drifts on the emit side fails here the moment
// it leaves the server — before any client has to defend against it.

type JsonEventSchemas = Record<string, Type<unknown>>;

// Every JSON event on the wire, run through the same parser the browser
// bundle uses; returns one entry per frame the client would drop (empty
// when the whole stream is contract-conformant).
const contractViolations = (
  events: SseEvent[],
  schemas: JsonEventSchemas,
): string[] => {
  const violations: string[] = [];
  for (const ev of events) {
    const schema = schemas[ev.event];
    if (schema === undefined) continue;
    if (parsePayload(schema, ev.data) === undefined)
      violations.push(`${ev.event}: ${ev.data}`);
  }
  return violations;
};

const runSseContractSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let workDir: string;

  const prompt = (sessionId: string, text: string): Promise<Response> =>
    authedFetch(env, `/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt: text }),
      headers: { "HX-Request": "true" },
    });

  beforeAll(async () => {
    env = await fx.startEnv("glv-sse-contract-", {
      sessionName: "Contract Session",
      lines: [
        fx.streamLine("contract line one"),
        fx.streamLine("contract line two"),
      ],
      writeDb: true,
      lineDelayMs: 300,
      // Keep the run "running" briefly so intermediate statuses land.
      sleepMs: 500,
    });
    workDir = env.scratchDir + "/proj";
    mkdirSync(workDir, { recursive: true });
    fx.seedSessions(env, [
      { id: "sse-contract-1", name: "Contract One", workingDir: workDir },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("session stream contract", () => {
    it("emits only contract-conformant JSON payloads", async () => {
      const stream = collectSse(
        env,
        "/sessions/sse-contract-1/events",
        (evs) =>
          evs.some(
            (e) => e.event === "status" && e.data.includes('"completed"'),
          ),
        20000,
      );
      await prompt("sse-contract-1", "run for the contract");
      const events = await stream;

      expect(contractViolations(events, SESSION_JSON_EVENTS)).toEqual([]);
      // The run actually exercised the JSON-carrying events, so the
      // assertion above is not vacuously true.
      for (const name of ["messages", "status", "append"])
        expect(events.some((e) => e.event === name)).toBe(true);
    });
  });

  describe("status feed contract", () => {
    it("emits only contract-conformant feed payloads", async () => {
      const stream = collectSse(
        env,
        "/events/status",
        (evs) =>
          evs.some((e) => e.event === "status" && e.data.includes('"done"')),
        20000,
      );
      await prompt("sse-contract-1", "run for the feed contract");
      const events = await stream;

      expect(contractViolations(events, FEED_JSON_EVENTS)).toEqual([]);
      // The feed always opens with the active-set snapshot and every
      // sidebar session's name.
      expect(events.some((e) => e.event === "sync")).toBe(true);
      expect(events.some((e) => e.event === "rename")).toBe(true);
    });
  });

  describe("contract discrimination", () => {
    it("drops payloads that drift from the schema", () => {
      // The parse side must reject, never trust, malformed frames.
      expect(
        parsePayload(SESSION_JSON_EVENTS.status, '{"status":"bogus"}'),
      ).toBeUndefined();
      expect(
        parsePayload(
          SESSION_JSON_EVENTS.append,
          '{"index":"0","html":"<p>x</p>"}',
        ),
      ).toBeUndefined();
      expect(
        parsePayload(SESSION_JSON_EVENTS.meta, '{"updated":12}'),
      ).toBeUndefined();
      expect(parsePayload(FEED_JSON_EVENTS.sync, '["a",1]')).toBeUndefined();
      expect(
        parsePayload(SESSION_JSON_EVENTS.status, "not json"),
      ).toBeUndefined();
      // And it accepts the bare statuses the server really emits.
      expect(
        parsePayload(SESSION_JSON_EVENTS.status, '{"status":"deleted"}'),
      ).toEqual({ status: "deleted" });
    });
  });
};

export { runSseContractSuite };
