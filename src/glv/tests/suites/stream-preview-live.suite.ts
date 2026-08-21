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

// Regression suite for the runner's stdout drain. The drain once assumed
// execa's async iteration yields raw chunks and buffered/split on "\n" — but
// execa (v9+) yields one newline-stripped line per iteration, so chunks never
// contain a newline: nothing reached the ring buffer while the process was
// alive, and the whole run's output surfaced only at exit, concatenated into
// a single unparseable line that renderStreamLine discarded. The preview pane
// looked frozen for the entire run. This suite pins the real contract: every
// streamed line becomes a preview SSE event *while the run is still active*,
// strictly before the completed status.
const runStreamPreviewLiveSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const hasStatus = (events: SseEvent[], value: string): boolean =>
    events.some(
      (e) => e.event === "status" && parseSseData(e.data).status === value,
    );

  const statusIndex = (events: SseEvent[], value: string): number =>
    events.findIndex(
      (e) => e.event === "status" && parseSseData(e.data).status === value,
    );

  beforeAll(async () => {
    env = await fx.startEnv("glv-preview-live-", {
      // Hold the run open before the first line so the event stream can
      // attach and observe the running status with an empty preview first.
      sleepMs: 800,
      // Two lines with a pause between them: the first must preview while
      // the process is still alive mid-run, not batched up at the end.
      lines: [
        fx.streamLine("first live chunk"),
        fx.streamLine("second live chunk"),
      ],
      lineDelayMs: 600,
    });
    // Follow-up runs spawn the agent in the session's working dir, so the
    // dir must exist or execa rejects and the run errors out immediately.
    mkdirSync(env.scratchDir + "/p", { recursive: true });
    fx.seedSessions(env, [
      { id: "pl-1", name: "Preview Live", workingDir: env.scratchDir + "/p" },
    ]);
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("live preview delivery", () => {
    it("previews each streamed line while the run is active, before completion", async () => {
      // Resolve only once a preview has arrived AND the run has completed,
      // so the ordering assertion below compares settled facts. On the old
      // drain no preview ever arrives mid-run, this predicate never
      // satisfies, and collectSse rejects on its timeout — the failure mode
      // this suite exists to catch.
      const until = (evs: SseEvent[]): boolean =>
        evs.some((e) => e.event === "preview") && hasStatus(evs, "completed");

      const stream = collectSse(env, "/sessions/pl-1/events", until, 15000);
      const res = await authedFetch(env, "/sessions/pl-1/prompt", {
        method: "POST",
        body: new URLSearchParams({ prompt: "stream a reply" }),
        headers: { "HX-Request": "true" },
      });
      expect(res.ok).toBe(true);
      const events = await stream;

      expect(hasStatus(events, "running")).toBe(true);

      const previews = events.filter((e) => e.event === "preview");
      const firstPreview = events.findIndex((e) => e.event === "preview");
      const completedAt = statusIndex(events, "completed");

      // Sanity: the ordering comparison needs both endpoints observed.
      expect(completedAt).toBeGreaterThanOrEqual(0);
      expect(firstPreview).toBeGreaterThanOrEqual(0);

      // The core regression: previews stream live, strictly before the run
      // completes — never batched into (or after) the terminal transition.
      expect(firstPreview).toBeLessThan(completedAt);

      // Every streamed line previewed exactly once, in order — none
      // swallowed, none duplicated, none synthesized.
      expect(previews.length).toBe(2);
      expect(previews[0]?.data).toContain("first live chunk");
      expect(previews[1]?.data).toContain("second live chunk");
    });
  });
};

export { runStreamPreviewLiveSuite };
