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

const runStreamDiscardSuite = (fx: FlavorFixture): void => {
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

  // A valid NDJSON message line in the flavor's stream dialect.
  const VALID_LINE = fx.streamLine("structured reply");
  // One line in the FOREIGN dialect: the viewer must drop it (envelope
  // strictness is deliberate — see the streamEnvelope profile field).
  const FOREIGN_LINE = fx.foreignLine;

  // Non-JSON banner text the agent may emit alongside structured output.
  const RAW_LINE = fx.rawBanner;

  let envValid: IntegrationEnv;
  let envRaw: IntegrationEnv;
  let envForeign: IntegrationEnv;

  beforeAll(async () => {
    // sleepMs keeps each run alive long enough for the SSE to attach before the
    // line streams, so the transient preview reliably surfaces.
    envValid = await fx.startEnv("glv-discard-valid-", {
      lines: [VALID_LINE],
      sleepMs: 4000,
    });
    envRaw = await fx.startEnv("glv-discard-raw-", {
      lines: [RAW_LINE],
      sleepMs: 4000,
    });
    envForeign = await fx.startEnv("glv-discard-foreign-", {
      lines: [FOREIGN_LINE],
      sleepMs: 4000,
    });
    const validDir = envValid.scratchDir + "/p";
    const rawDir = envRaw.scratchDir + "/p";
    const foreignDir = envForeign.scratchDir + "/p";
    mkdirSync(validDir, { recursive: true });
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(foreignDir, { recursive: true });
    fx.seedSessions(envValid, [
      { id: "discard-1", name: "Discard Valid", workingDir: validDir },
    ]);
    fx.seedMessages(envValid, "discard-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
    fx.seedSessions(envRaw, [
      { id: "raw-1", name: "Discard Raw", workingDir: rawDir },
    ]);
    fx.seedMessages(envRaw, "raw-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
    fx.seedSessions(envForeign, [
      { id: "foreign-1", name: "Discard Foreign", workingDir: foreignDir },
    ]);
    fx.seedMessages(envForeign, "foreign-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  }, 180000);

  afterAll(async () => {
    await envValid?.cleanup();
    await envRaw?.cleanup();
    await envForeign?.cleanup();
  });

  describe("invalid stream lines are discarded", () => {
    it("renders a valid NDJSON message line as a preview", async () => {
      const stream = collectSse(
        envValid,
        `/sessions/${fx.viewId("discard-1")}/events`,
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
        `/sessions/${fx.viewId("raw-1")}/events`,
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

    it("drops a foreign-dialect envelope with no preview", async () => {
      const collected: SseEvent[] = [];
      const collect = collectSse(
        envForeign,
        `/sessions/${fx.viewId("foreign-1")}/events`,
        // Never satisfy: collect every event until the timeout so a late
        // terminal-flush preview can't slip past an early resolve.
        () => false,
        8000,
        (e) => collected.push(e),
      );
      await startRun(envForeign, "foreign-1", "foreign test");
      try {
        await collect;
      } catch {
        // expected timeout
      }

      expect(hasStatus(collected, "completed")).toBe(true);
      expect(collected.filter((e) => e.event === "preview")).toHaveLength(0);
      expect(collected.some((e) => e.data.includes("foreign reply"))).toBe(
        false,
      );
    });
  });
};

export { runStreamDiscardSuite };
