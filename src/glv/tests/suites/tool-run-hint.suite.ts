import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
  withPage,
} from "../harness.js";

// A run whose newest persisted row is an unanswered tool request must say
// what it is waiting on — "bash running for 3m (timeout 30m)" — in the
// status hint, server-rendered, carried on status events, and ticking live
// in the browser, instead of an unexplained spinner. When the toolResponse
// row lands, the hint reverts to the plain Running… state.
const runToolRunHintSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let workDir: string;

  // A bash call that asked for a 30-minute timeout, still unanswered.
  const pendingRequest = (): unknown =>
    fx.toolRequest("bash", { command: "cargo test", timeout_secs: 1800 });

  // Follow-up runs spawn the agent in the session's working dir, so the
  // dir must exist or the run errors out immediately.
  const seed = (id: string, name: string): void => {
    fx.seedSessions(env, [{ id, name, workingDir: workDir }]);
    fx.seedMessages(env, id, [
      { role: "user", content: [{ type: "text", text: "run the suite" }] },
      { role: "assistant", content: [pendingRequest()] },
    ]);
  };

  const startRun = (id: string): Promise<Response> =>
    authedFetch(env, `/sessions/${id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt: "keep going" }),
      headers: { "HX-Request": "true" },
    });

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    env = await fx.startEnv("glv-tool-hint-", { sleepMs: 30000 });
    workDir = `${env.scratchDir}/w`;
    mkdirSync(workDir, { recursive: true });
    seed("th-http", "Hint HTTP");
    seed("th-sse", "Hint SSE");
    seed("th-live", "Hint Live");
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("tool run hint — server render", () => {
    it("names the in-flight tool and its timeout in the running hint", async () => {
      await startRun("th-http");
      // The handle starts as "queued" and flips to "running" once the
      // (sleeping) agent process spawns; poll the page until the running
      // hint carries the pending tool.
      const deadline = Date.now() + 15000;
      let html = "";
      while (Date.now() < deadline) {
        const res = await authedFetch(env, "/sessions/th-http");
        html = await res.text();
        if (html.includes("data-tool-running")) break;
        await sleep(200);
      }
      expect(html).toContain("data-tool-running");
      expect(html).toContain("bash running for");
      expect(html).toContain("(timeout 30m)");
    });
  });

  describe("tool run hint — status events", () => {
    it("carries the pending tool and clears it when the response lands", async () => {
      let sawTool: Record<string, unknown> | undefined;
      let sawCleared = false;
      let answered = false;
      const stream = collectSse(
        env,
        "/sessions/th-sse/events",
        (evs) => evs.length > 0 && sawTool !== undefined && sawCleared,
        20000,
        (e) => {
          if (e.event !== "status") return;
          const data = parseSseData(e.data);
          if (data.status !== "running") return;
          const tool = data.tool as Record<string, unknown> | null;
          if (tool !== null && tool.name === "bash") {
            sawTool = tool;
            // Answer the call mid-run: the newest row stops being an
            // unanswered request, so the hint must drop the tool.
            if (!answered) {
              answered = true;
              fx.seedMessages(env, "th-sse", [
                {
                  role: "user",
                  content: [fx.toolResponse("done", false)],
                },
              ]);
            }
          } else if (sawTool !== undefined) sawCleared = true;
        },
      );
      await startRun("th-sse");
      await stream;
      expect(sawTool).toBeDefined();
      expect(sawTool?.timeoutSec).toBe(1800);
      expect(sawTool?.count).toBe(1);
      expect(sawCleared).toBe(true);
    });
  });

  describe("tool run hint — live page", () => {
    it("ticks the elapsed time and reverts when the tool answers", async () => {
      await startRun("th-live");
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/th-live`);
        const hint = page.locator(".status-hint.running[data-tool-running]");
        await expect(hint).toBeVisible({ timeout: 15000 });
        await expect(hint).toContainText("bash running for");
        await expect(hint).toContainText("(timeout 30m)");
        // The elapsed leg is a live clock — it must advance on its own.
        const before = (await hint.textContent()) ?? "";
        await page.waitForFunction(
          (prev: string) => {
            const el = document.querySelector(
              ".status-hint[data-tool-running]",
            );
            return el !== null && el.textContent !== prev;
          },
          before,
          { timeout: 10000 },
        );
        // The tool answers: the hint drops the tool and goes back to the
        // plain running state.
        fx.seedMessages(env, "th-live", [
          { role: "user", content: [fx.toolResponse("done", false)] },
        ]);
        await expect(page.locator(".status-hint.running")).toHaveText(
          "Running…",
          { timeout: 10000 },
        );
      });
    });
  });
};

export { runToolRunHintSuite };
