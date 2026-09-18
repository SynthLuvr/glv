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
  parseSseData,
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
      { id: "sse-resume-1", name: "Resume One", workingDir: workDir },
    ]);
    // A known four-message transcript so the reconnect cursor math is exact.
    fx.seedMessages(env, "sse-resume-1", [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
      { role: "assistant", content: [{ type: "text", text: "four" }] },
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

  // Reconnect resume: EventSource echoes the id of the last received event
  // as Last-Event-ID, and the stream must replay only what follows it. The
  // cursor plumbing is vendored from the hono fork this project dropped.
  describe("reconnect resume", () => {
    // Reads the first `messages` frame from a fresh connect, optionally with
    // the Last-Event-ID header an EventSource sends on reconnect.
    const firstMessagesEvent = async (
      path: string,
      lastEventId?: string,
    ): Promise<SseEvent | undefined> => {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
      };
      if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
      const res = await authedFetch(env, path, { headers });
      if (res.body === null) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            if (!/^event: messages$/m.test(frame)) continue;
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (data !== undefined)
              return { event: "messages", data, id: undefined };
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
      return undefined;
    };

    const entryIndexes = (msg: SseEvent | undefined): number[] => {
      const entries = parseSseData(msg?.data ?? "").entries;
      if (!Array.isArray(entries)) return [];
      return entries.map((entry) => (entry as { index: number }).index);
    };

    it("replays only entries after the Last-Event-ID cursor", async () => {
      const msg = await firstMessagesEvent(
        "/sessions/sse-resume-1/events",
        "2",
      );
      expect(msg).toBeDefined();
      expect(entryIndexes(msg)).toEqual([2, 3]);
      expect(parseSseData(msg?.data ?? "").cursor).toBe(4);
    });

    it("replays the full transcript on a first connect", async () => {
      const msg = await firstMessagesEvent("/sessions/sse-resume-1/events");
      expect(entryIndexes(msg)).toEqual([0, 1, 2, 3]);
      expect(parseSseData(msg?.data ?? "").cursor).toBe(4);
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
