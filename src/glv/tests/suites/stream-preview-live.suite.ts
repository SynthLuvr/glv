import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

// Pins the runner's stdout drain against the bug this suite was written
// for: execa's async iteration yields newline-stripped lines, so the old
// raw-chunk buffer/split never matched — every line surfaced only at exit,
// concatenated into one unparseable line, and the preview pane froze for
// the whole run. The contract: every streamed line becomes a preview SSE
// event *while the run is still active*, strictly before completion.
const runStreamPreviewLiveSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const statusIndex = (events: SseEvent[], value: string): number =>
    events.findIndex(
      (e) => e.event === "status" && parseSseData(e.data).status === value,
    );

  const hasStatus = (events: SseEvent[], value: string): boolean =>
    statusIndex(events, value) >= 0;

  beforeAll(async () => {
    env = await fx.startEnv("glv-preview-live-", {
      // Hold the run open before the first line so the SSE stream can
      // attach and observe the running status while the preview is empty.
      sleepMs: 800,
      // Two lines with a pause between them: the first must preview
      // mid-run, not batched up at exit.
      lines: [
        fx.streamLine("first live chunk"),
        fx.streamLine("second live chunk"),
      ],
      lineDelayMs: 600,
    });
    // Follow-up runs spawn the agent in the session's working dir, which
    // must exist or execa rejects and the run errors out immediately.
    const workDir = join(env.scratchDir, "p");
    mkdirSync(workDir, { recursive: true });
    fx.seedSessions(env, [
      { id: "pl-1", name: "Preview Live", workingDir: workDir },
    ]);
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("live preview delivery", () => {
    it("previews each streamed line while the run is active, before completion", async () => {
      // Resolve only once a preview has arrived AND the run completed, so
      // the ordering assertion compares settled facts. With the old drain
      // no preview ever arrives mid-run, so this never satisfies and
      // collectSse rejects on its timeout.
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

      // The core regression: previews stream live, strictly before the run
      // completes — never batched into (or after) the terminal transition.
      expect(firstPreview).toBeLessThan(completedAt);

      // Every streamed line previewed exactly once, in order.
      expect(previews.length).toBe(2);
      expect(previews[0]?.data).toContain("first live chunk");
      expect(previews[1]?.data).toContain("second live chunk");
    });
  });
};

export { runStreamPreviewLiveSuite };
