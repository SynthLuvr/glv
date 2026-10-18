import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The stop-early notice story: when the provider refuses service (a usage
// limit with its reset time, a network outage) the agent says so on its
// own stream, but that record never reaches the transcript the viewer
// renders — and goose 1.45.0 exits 0 after printing it, so the run reads
// as a clean finish. The suite drives the mock agent through each shape
// (refusal with exit 0, plain crash with exit 1, healthy reply) and
// asserts over HTTP what the user actually sees.

const runStopNoticeSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let envExit: IntegrationEnv;
  let envRefuseExit: IntegrationEnv;
  let linesDir: string;

  const linesFileFor = (name: string): string => join(linesDir, name);

  const writeLines = (name: string, lines: readonly string[]): string => {
    const path = linesFileFor(name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  };

  const startRun = (
    e: IntegrationEnv,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    authedFetch(e, `/sessions/${fx.viewId(id)}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
      headers: { "HX-Request": "true" },
    });

  const pageHtml = async (e: IntegrationEnv, id: string): Promise<string> => {
    const res = await authedFetch(e, `/sessions/${fx.viewId(id)}`);
    expect(res.status).toBe(200);
    return res.text();
  };

  // Polls the server-rendered session page until `needle` appears (or the
  // budget runs out) — the notice only exists once the run settled, and a
  // fixed delay races the agent process.
  const waitForPageText = async (
    e: IntegrationEnv,
    id: string,
    needle: string,
    timeoutMs = 15000,
  ): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let html = "";
    for (;;) {
      html = await pageHtml(e, id);
      if (html.includes(needle)) return html;
      if (Date.now() > deadline)
        throw new Error(
          `page for ${id} never contained ${JSON.stringify(needle)}; ` +
            `last seen: ${html.slice(0, 500)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  // The prompt bar returns to its idle shape once the run settles.
  const waitForIdleBar = async (
    e: IntegrationEnv,
    id: string,
  ): Promise<string> => waitForPageText(e, id, "send-btn");

  beforeAll(async () => {
    linesDir = mkdtempSync(join(tmpdir(), "glv-stop-lines-"));
    // The file is re-read per invocation, so one environment walks through
    // every scenario by rewriting it.
    writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
    env = await fx.startEnv("glv-stop-", {
      linesFile: linesFileFor("main.txt"),
    });
    envExit = await fx.startEnv("glv-stop-exit-", { exitCode: 1 });
    // claude's documented refusal shape: the failure record printed and
    // a non-zero exit. goose exits 0 after the same record, so both
    // verdicts get their own environment.
    writeLines("refuse-exit.txt", [
      fx.refusalRecord(
        "API Error: 429 usage limit reached — your plan resets at 09:00",
      ),
    ]);
    envRefuseExit = await fx.startEnv("glv-stop-rx-", {
      exitCode: 1,
      linesFile: linesFileFor("refuse-exit.txt"),
    });
    for (const e of [env, envExit, envRefuseExit]) {
      mkdirSync(join(e.scratchDir, "w"), { recursive: true });
      fx.seedSessions(e, [
        { id: "limit-1", name: "Limit", workingDir: join(e.scratchDir, "w") },
        { id: "net-1", name: "Net", workingDir: join(e.scratchDir, "w") },
        { id: "ok-1", name: "Ok", workingDir: join(e.scratchDir, "w") },
      ]);
      for (const id of ["limit-1", "net-1", "ok-1"])
        fx.seedMessages(e, id, [
          { role: "user", content: [{ type: "text", text: "seed" }] },
        ]);
    }
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
    await envExit?.cleanup();
    await envRefuseExit?.cleanup();
    rmSync(linesDir, { recursive: true, force: true });
  });

  describe("usage-limit refusal, exit 0", () => {
    it("streams an error status carrying the notice, not a completion", async () => {
      writeLines("main.txt", [
        fx.refusalRecord(
          "Rate limit exceeded: usage limit reached. Your quota resets at 17:01.",
        ),
      ]);
      const stream = collectSse(
        env,
        `/sessions/${fx.viewId("limit-1")}/events`,
        (evs) =>
          evs.some(
            (e) =>
              e.event === "status" && parseSseData(e.data).status === "error",
          ),
        15000,
      );
      await startRun(env, "limit-1", "hit the limit please");
      const events = await stream;
      const statuses = events
        .filter((e) => e.event === "status")
        .map((e) => parseSseData(e.data).status);
      expect(statuses).not.toContain("completed");
      const error = events
        .filter((e) => e.event === "status")
        .map((e) => parseSseData(e.data))
        .find((data) => data.status === "error");
      expect(error?.error).toContain("Session stopped early");
      expect(error?.error).toContain("usage limit reached");
      expect(error?.error).toContain("resets at 17:01");
      expect(error?.error).toContain("Send a message to continue");
    });

    it("shows the notice in the session view", async () => {
      const html = await waitForPageText(env, "limit-1", "Run stopped early");
      expect(html).toContain("usage limit reached");
      expect(html).toContain("resets at 17:01");
    });

    it("renders the structured notice card in the browser", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("limit-1")}`);
        const hint = page.locator("form.prompt-bar .status-hint.error");
        await expect(hint).toContainText("Run stopped early");
        await expect(hint).toContainText("usage limit reached");
        await expect(hint.locator(".stop-notice-icon")).toBeVisible();
        await expect(hint.locator(".stop-notice-title")).toContainText(
          "Run stopped early",
        );
        await expect(hint.locator(".stop-notice-classification")).toContainText(
          "Provider usage limit reached",
        );
        await expect(hint.locator(".stop-notice-reason")).toContainText(
          "resets at 17:01",
        );
        await expect(hint.locator(".stop-notice-action")).toContainText(
          "Send a message to continue",
        );
      });
    });

    it("keeps the notice across a server restart", async () => {
      await env.restart();
      const html = await pageHtml(env, "limit-1");
      expect(html).toContain("Run stopped early");
      expect(html).toContain("resets at 17:01");
    });

    it("clears the notice once the session continues and finishes", async () => {
      writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
      await startRun(env, "limit-1", "continue please");
      const html = await waitForIdleBar(env, "limit-1");
      expect(html).not.toContain("Run stopped early");
    });
  });

  describe("non-quota failures keep their own wording", () => {
    it("reports a network outage as a network error, not a usage limit", async () => {
      writeLines("main.txt", [
        fx.refusalRecord(
          "Network error — could not connect to api.anthropic.com:443",
        ),
      ]);
      await startRun(env, "net-1", "lose the network please");
      const html = await waitForPageText(env, "net-1", "Run stopped early");
      expect(html).toContain("Provider network error");
      expect(html).toContain("could not connect");
      expect(html).not.toContain("usage limit");
    });
  });

  describe("refusal with a non-zero exit", () => {
    it("still words the stop by the refusal, not the exit code", async () => {
      await startRun(envRefuseExit, "net-1", "refuse and fail loudly");
      const html = await waitForPageText(
        envRefuseExit,
        "net-1",
        "Run stopped early",
      );
      expect(html).toContain("usage limit");
      expect(html).toContain("resets at 09:00");
      expect(html).not.toContain("exited with code 1");
    });
  });

  describe("failures the agent never announced", () => {
    it("keeps the exit-code message and does not persist it", async () => {
      const stream = collectSse(
        envExit,
        `/sessions/${fx.viewId("net-1")}/events`,
        (evs) =>
          evs.some(
            (e) =>
              e.event === "status" && parseSseData(e.data).status === "error",
          ),
        15000,
      );
      await startRun(envExit, "net-1", "crash please");
      const events = await stream;
      const error = events
        .filter((e) => e.event === "status")
        .map((e) => parseSseData(e.data))
        .find((data) => data.status === "error");
      expect(error?.error).toContain("exited with code 1");
      expect(error?.error).not.toContain("Send a message to continue");

      // Live handle still explains the crash; a restart (handle gone)
      // keeps it exactly as transient as before — only refusals persist.
      const html = await waitForPageText(
        envExit,
        "net-1",
        "exited with code 1",
      );
      expect(html).toContain("exited with code 1");
      await envExit.restart();
      const after = await pageHtml(envExit, "net-1");
      expect(after).not.toContain("exited with code 1");
    });
  });

  describe("healthy runs", () => {
    it("finish with no notice, before and after a restart", async () => {
      writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
      await startRun(env, "ok-1", "all good please");
      const html = await waitForIdleBar(env, "ok-1");
      expect(html).not.toContain("Session stopped early");
      await env.restart();
      const after = await pageHtml(env, "ok-1");
      expect(after).not.toContain("Session stopped early");
      expect(after).not.toContain('class="status-hint error"');
    });
  });
};

export { runStopNoticeSuite };
