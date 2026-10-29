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

  // Runs a prompt and resolves once the stream settles on an error
  // status, carrying every streamed status and the error's text.
  const runUntilError = async (
    e: IntegrationEnv,
    id: string,
    prompt: string,
  ): Promise<{ statuses: unknown[]; error: unknown }> => {
    const stream = collectSse(
      e,
      `/sessions/${fx.viewId(id)}/events`,
      (evs) =>
        evs.some(
          (ev) =>
            ev.event === "status" && parseSseData(ev.data).status === "error",
        ),
      15000,
    );
    await startRun(e, id, prompt);
    const data = (await stream)
      .filter((ev) => ev.event === "status")
      .map((ev) => parseSseData(ev.data));
    return {
      statuses: data.map((d) => d.status),
      error: data.find((d) => d.status === "error")?.error,
    };
  };

  // The structured prompt-bar card every stop kind renders.
  const expectNoticeCard = (
    e: IntegrationEnv,
    id: string,
    classification: string,
    reasons: readonly string[],
  ): Promise<void> =>
    withPage(e.context, async (page) => {
      await page.goto(`${e.baseUrl}/sessions/${fx.viewId(id)}`);
      const hint = page.locator("form.prompt-bar .status-hint.error");
      await expect(hint).toContainText("Run stopped early");
      await expect(hint.locator(".stop-notice-icon")).toBeVisible();
      await expect(hint.locator(".stop-notice-title")).toContainText(
        "Run stopped early",
      );
      await expect(hint.locator(".stop-notice-classification")).toContainText(
        classification,
      );
      const reason = hint.locator(".stop-notice-reason");
      for (const text of reasons) await expect(reason).toContainText(text);
      await expect(hint.locator(".stop-notice-action")).toContainText(
        "Send a message to continue",
      );
    });

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
        { id: "bg-1", name: "Bg", workingDir: join(e.scratchDir, "w") },
      ]);
      for (const id of ["limit-1", "net-1", "ok-1", "bg-1"])
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
      const { statuses, error } = await runUntilError(
        env,
        "limit-1",
        "hit the limit please",
      );
      expect(statuses).not.toContain("completed");
      expect(error).toContain("Session stopped early");
      expect(error).toContain("usage limit reached");
      expect(error).toContain("resets at 17:01");
      expect(error).toContain("Send a message to continue");
    });

    it("shows the notice in the session view", async () => {
      const html = await waitForPageText(env, "limit-1", "Run stopped early");
      expect(html).toContain("usage limit reached");
      expect(html).toContain("resets at 17:01");
    });

    it("renders the structured notice card in the browser", async () => {
      await expectNoticeCard(env, "limit-1", "Provider usage limit reached", [
        "usage limit reached",
        "resets at 17:01",
      ]);
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
    it("persists the exit-code message beyond the handle's eviction", async () => {
      const { error } = await runUntilError(envExit, "net-1", "crash please");
      expect(error).toContain("exited with code 1");
      expect(error).not.toContain("Send a message to continue");

      // The live handle explains the crash in the prompt bar, and — since
      // run-terminal errors are persisted too — a restart (handle gone)
      // keeps explaining it instead of leaving an unexplained transcript.
      await waitForPageText(envExit, "net-1", "exited with code 1");
      await envExit.restart();
      const after = await pageHtml(envExit, "net-1");
      expect(after).toContain("exited with code 1");
      expect(after).toContain("Run stopped early");
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

  // The kill-at-exit epilogue is claude's stream dialect, so the scenario
  // binds only to flavors that can produce it. With held-open stdin
  // (ADR 0010) glv-driven runs no longer produce it — the classifier is
  // a tripwire for claude drift: if a release re-introduces an exit-time
  // kill, the run must still surface it instead of settling clean.
  const killedTaskRecords = fx.killedTaskRecords;
  const cleanResultRecord = fx.cleanResultRecord;

  if (killedTaskRecords !== undefined && cleanResultRecord !== undefined)
    describe("background tasks killed at exit", () => {
      const WATCHER = "CI watcher: sleep 30; until gh pr checks 394";

      it("turns the silent kill into a stop notice on an exit-0 run", async () => {
        writeLines("main.txt", [
          fx.streamLine("Pushed the fix — CI is running. I'll report back."),
          cleanResultRecord,
          ...killedTaskRecords(WATCHER),
        ]);
        const { statuses, error } = await runUntilError(
          env,
          "bg-1",
          "watch the pr and report back please",
        );
        expect(statuses).not.toContain("completed");
        expect(error).toContain("Session stopped early");
        expect(error).toContain("background tasks were killed");
        expect(error).toContain(WATCHER);
        expect(error).toContain("Send a message to continue");
      });

      it("renders the kill card in the browser", async () => {
        const html = await waitForPageText(
          env,
          "bg-1",
          "Background tasks killed at exit",
        );
        expect(html).toContain(WATCHER);
        await expectNoticeCard(env, "bg-1", "Background tasks killed at exit", [
          WATCHER,
        ]);
      });

      it("keeps the notice across a server restart", async () => {
        await env.restart();
        const html = await pageHtml(env, "bg-1");
        expect(html).toContain("Background tasks killed at exit");
        expect(html).toContain(WATCHER);
      });

      it("does not flag a mid-run TaskStop followed by a clean finish", async () => {
        writeLines("main.txt", [
          ...killedTaskRecords("old watcher"),
          fx.streamLine("Watcher handed off; continuing."),
          cleanResultRecord,
        ]);
        await startRun(env, "bg-1", "hand off cleanly please");
        const html = await waitForIdleBar(env, "bg-1");
        expect(html).not.toContain("Session stopped early");
      });
    });
};

export { runStopNoticeSuite };
