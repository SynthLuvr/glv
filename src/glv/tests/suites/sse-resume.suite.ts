import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
  type SseEvent,
} from "../harness.js";

// Cursor-based resume for the per-session event stream. EventSource re-sends
// the id of the last received event in the Last-Event-ID header on reconnect,
// so the server must replay only the messages after that cursor — the same
// delta-only contract the ?cursor= query serves on the initial connect.
const runSseResumeSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const catchup = (
    events: SseEvent[],
  ): { indexes: number[]; cursor: number } => {
    const messages = events.find((e) => e.event === "messages");
    const data = parseSseData(messages?.data ?? "");
    const entries = (data.entries ?? []) as Array<{ index: number }>;
    return {
      indexes: entries.map((entry) => entry.index),
      cursor: Number(data.cursor ?? 0),
    };
  };

  beforeAll(async () => {
    env = await fx.startEnv("glv-sse-resume-");
    fx.seedSessions(env, [
      { id: "resume-1", name: "Resume Me", workingDir: env.scratchDir + "/r" },
    ]);
    fx.seedMessages(env, "resume-1", [
      { role: "user", content: [{ type: "text", text: "first prompt" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "first reply" }],
      },
      { role: "user", content: [{ type: "text", text: "second prompt" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "second reply" }],
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("events stream — cursor resume", () => {
    it("replays every message when no cursor is supplied", async () => {
      const events = await collectSse(
        env,
        "/sessions/resume-1/events",
        (evs) => evs.some((e) => e.event === "messages"),
        8000,
      );
      const { indexes, cursor } = catchup(events);
      expect(indexes).toEqual([0, 1, 2, 3]);
      expect(cursor).toBe(4);
    });

    it("replays only messages after the Last-Event-ID header cursor", async () => {
      const events = await collectSse(
        env,
        "/sessions/resume-1/events",
        (evs) => evs.some((e) => e.event === "messages"),
        8000,
        undefined,
        { "Last-Event-ID": "2" },
      );
      const { indexes } = catchup(events);
      expect(indexes).toEqual([2, 3]);
    });

    it("replays only messages after the ?cursor= query cursor", async () => {
      const events = await collectSse(
        env,
        "/sessions/resume-1/events?cursor=3",
        (evs) => evs.some((e) => e.event === "messages"),
        8000,
      );
      const { indexes } = catchup(events);
      expect(indexes).toEqual([3]);
    });

    it("keeps serving after a client drops mid-stream", async () => {
      // An abrupt disconnect leaves the old handler writing into a dead
      // stream; those writes are no-ops, so the handler finishes cleanly
      // instead of crashing the connection loop.
      const dropped = collectSse(env, "/events/status", () => false, 500);
      await expect(dropped).rejects.toThrow(/timed out/);
      const events = await collectSse(
        env,
        "/sessions/resume-1/events",
        (evs) => evs.some((e) => e.event === "messages"),
        8000,
      );
      expect(catchup(events).indexes).toEqual([0, 1, 2, 3]);
    });
  });
};

export { runSseResumeSuite };
