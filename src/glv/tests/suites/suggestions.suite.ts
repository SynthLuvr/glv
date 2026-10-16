import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { SseEvent } from "../harness.js";
import {
  authedFetch,
  collectSse,
  type FlavorFixture,
  type IntegrationEnv,
  parseSseData,
  postFollowUp,
  postNewSession,
  rmScratch,
  withPage,
} from "../harness.js";

// Suggested next prompts, end to end: the watcher fires after a finished
// turn, the behind-the-scenes ask runs the agent with the same sign-in
// and setup, the reply parses into chips above the input box, and the
// helper run leaves no session behind — the go/no-go premise of the
// feature, proven against the flavor's real store.

// The reply the mock agent's ephemeral invocations are scripted to give:
// one NDJSON stream record whose text is a JSON array of three prompts,
// exactly what the ask asks for. The message-nested envelope parses for
// both flavors (the ask accepts either dialect).
const SUGGESTIONS = [
  "Run the test suite",
  "Commit these changes",
  "Explain what you did",
];

const ephemeralReplyLine = (prompts: string[]): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(prompts) }],
    },
  });

const SUGGESTION_EVENT_TIMEOUT_MS = 15000;
// Generous against the watcher's 100 ms test poll: several full cycles
// settle any "must not ask" assertion without a wall-clock marathon.
const SETTLE_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// One JSON argv per ephemeral invocation, as the mock agent logged it.
const ephemeralInvocations = (log: string): string[][] => {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string[]);
};

// Polls the invocation log until exactly n ephemeral asks have started.
const waitForInvocations = async (
  log: string,
  n: number,
  timeoutMs = 10000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ephemeralInvocations(log).length === n) return;
    await sleep(100);
  }
  throw new Error(
    `expected ${n} ephemeral invocations, saw ${ephemeralInvocations(log).length}`,
  );
};

// The prompts a suggestions event carried, when it carried any.
const eventPrompts = (event: SseEvent | undefined): string[] | undefined => {
  if (event === undefined) return undefined;
  const prompts = parseSseData(event.data).prompts;
  return Array.isArray(prompts) &&
    prompts.every((p): p is string => typeof p === "string")
    ? prompts
    : undefined;
};

// Polls the prompt-bar fragment until the predicate passes (default:
// the idle bar — a Send button, no Queue/Stop — i.e. the run settled).
const waitForBar = async (
  env: IntegrationEnv,
  sessionId: string,
  until: (html: string) => boolean = (html) => html.includes("send-btn"),
  timeoutMs = 10000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let html = "";
  while (Date.now() < deadline) {
    const res = await authedFetch(
      env,
      `/sessions/${sessionId}/prompt-bar?status=idle`,
    );
    html = await res.text();
    if (until(html)) return html;
    await sleep(100);
  }
  throw new Error(`prompt bar never reached the awaited state: ${html}`);
};

// The session id a create/follow-up response's transcript carries —
// anchored to the detail pane, not the sidebar items that also carry it.
const sessionIdOf = (html: string): string => {
  const id = /class="detail-inner" data-session-id="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeDefined();
  return id ?? "";
};

// Starts a session and resolves once its first turn has fully settled.
const runTurn = async (
  env: IntegrationEnv,
  prompt: string,
): Promise<string> => {
  const res = await postNewSession(env, env.scratchDir, prompt);
  expect(res.status).toBe(200);
  const sessionId = sessionIdOf(await res.text());
  await waitForBar(env, sessionId);
  return sessionId;
};

// Boots an environment with the ephemeral ask scripted, the feature's
// test poll interval, and a fresh invocation log. `homeDir` optionally
// fakes the home the server (and its model source) reads.
const startSuggestionEnv = async (
  fx: FlavorFixture,
  prefix: string,
  ephemeralLines: string[],
  extra: Record<string, string | number> = {},
  homeDir?: string,
): Promise<{ env: IntegrationEnv; log: string; logDir: string }> => {
  const logDir = mkdtempSync(join(tmpdir(), `${prefix}log-`));
  const log = join(logDir, "ephemeral.log");
  const env = await fx.startEnv(
    prefix,
    { writeDb: true, ephemeralLines, ephemeralLog: log, ...extra },
    homeDir,
    { GLV_SUGGESTIONS_POLL_MS: "100" },
  );
  return { env, log, logDir };
};

// Flips the feature on over HTTP.
const enableSuggestions = async (env: IntegrationEnv): Promise<void> => {
  const res = await authedFetch(env, "/suggestions/toggle", {
    method: "POST",
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('aria-pressed="true"');
};

const runSuggestionsSuite = (fx: FlavorFixture): void => {
  describe("suggested next prompts", () => {
    describe("feature flow", () => {
      let env: IntegrationEnv;
      let log: string;
      let logDir: string;
      // The session whose turn produced suggestions, shared with the
      // accept/dismiss browser test below.
      let suggestedSessionId: string;

      beforeAll(async () => {
        const started = await startSuggestionEnv(fx, "glv-suggestions-", [
          ephemeralReplyLine(SUGGESTIONS),
        ]);
        env = started.env;
        log = started.log;
        logDir = started.logDir;
      }, 180000);

      afterAll(async () => {
        await env?.cleanup();
        rmScratch(logDir);
      });

      it("renders the toggle in the sidebar, off by default", async () => {
        const page = await authedFetch(env, "/");
        const html = await page.text();
        expect(html).toContain("suggestions-toggle");
        expect(html).toContain('aria-pressed="false"');
      });

      it("toggles the feature on", async () => {
        await enableSuggestions(env);
      });

      it("asks once after a finished turn, streams the suggestions, and leaves no session behind", async () => {
        suggestedSessionId = await runTurn(env, "a session, feature on");

        // The event may land mid-stream (the ask finishes while the
        // client watches) or at connect (it finished earlier) — both
        // paths must deliver it.
        const events = await collectSse(
          env,
          `/sessions/${suggestedSessionId}/events`,
          (seen) =>
            seen.some(
              (e) =>
                e.event === "suggestions" && (eventPrompts(e) ?? []).length > 0,
            ),
          SUGGESTION_EVENT_TIMEOUT_MS,
        );
        const prompts = events
          .filter((e) => e.event === "suggestions")
          .map((e) => eventPrompts(e))
          .find((p) => p !== undefined && p.length > 0);
        expect(prompts).toEqual(SUGGESTIONS);

        // Server-rendered path: a fresh prompt-bar fragment carries the
        // chips for this finished turn.
        const bar = await waitForBar(env, suggestedSessionId);
        expect(bar).toContain("suggestion-strip");
        expect(bar).toContain(SUGGESTIONS[0]);

        // The premise: the helper run leaves nothing in the agent's own
        // store — no sidebar session, no hidden leftover — and the argv
        // the agent received is the session-free spelling.
        const invocations = ephemeralInvocations(log);
        expect(invocations).toHaveLength(1);
        const args = invocations[0];
        expect(
          args.includes("--no-session") ||
            args.includes("--no-session-persistence"),
        ).toBe(true);
        // No pin configured: the ask runs on the agent's own default,
        // which means no model flag reaches the binary.
        expect(args).not.toContain("--model");
        if (fx.ephemeralTraceCount !== undefined)
          expect(fx.ephemeralTraceCount(env)).toBe(0);

        const detail = await authedFetch(
          env,
          `/sessions/${suggestedSessionId}`,
        );
        const html = await detail.text();
        expect(html.match(/class="session-item/g)?.length).toBe(1);
        expect(html).not.toContain("CLI Session");

        // Once per turn: refreshes and re-reads never re-ask.
        await sleep(SETTLE_MS);
        expect(ephemeralInvocations(log)).toHaveLength(1);
        await authedFetch(
          env,
          `/sessions/${suggestedSessionId}/prompt-bar?status=idle`,
        );
        await sleep(SETTLE_MS);
        expect(ephemeralInvocations(log)).toHaveLength(1);
      });

      it("accepts a suggestion into the input, and typing stands them down", async () => {
        expect(suggestedSessionId).toBeDefined();

        await withPage(env.context, async (page) => {
          await page.goto(`${env.baseUrl}/sessions/${suggestedSessionId}`);

          // The strip arrives via the stream's connect reconciliation
          // (the row already exists for this turn).
          const chip = page.locator("[data-suggestion]").first();
          await expect(chip).toBeVisible({
            timeout: SUGGESTION_EVENT_TIMEOUT_MS,
          });
          await chip.click();
          await expect(page.locator(".prompt-input")).toHaveValue(
            SUGGESTIONS[0],
          );
          // Accepting consumed the strip.
          await expect(page.locator("[data-suggestions]")).toHaveCount(0);

          // A reload brings the strip back (still this turn's set);
          // typing makes it politely stand down.
          await page.reload();
          const chipAgain = page.locator("[data-suggestion]").first();
          await expect(chipAgain).toBeVisible({
            timeout: SUGGESTION_EVENT_TIMEOUT_MS,
          });
          await page.locator(".prompt-input").fill("my own prompt");
          await expect(page.locator("[data-suggestions]")).toHaveCount(0);
        });
      });

      it("suppresses suggestions for scheduled-job sessions", async () => {
        const before = ephemeralInvocations(log).length;
        fx.seedSessions(env, [
          {
            id: "cron-tagged",
            name: "Cron Tagged",
            workingDir: env.scratchDir,
          },
        ]);
        const db = new DatabaseSync(env.dbs.cronDb);
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare(
          "INSERT INTO cron_sessions (session_id, job_name) VALUES (?, ?)",
        ).run(fx.viewId("cron-tagged"), "nightly-check");
        db.close();

        const res = await postFollowUp(
          env,
          fx.viewId("cron-tagged"),
          "a scheduled session's turn",
        );
        expect(res.status).toBe(200);
        await waitForBar(env, fx.viewId("cron-tagged"));
        await sleep(SETTLE_MS);

        expect(ephemeralInvocations(log)).toHaveLength(before);
        const bar = await waitForBar(env, fx.viewId("cron-tagged"));
        expect(bar).not.toContain("suggestion-strip");
      });
    });

    // The ask's usefulness: what goes into the prompt it receives and
    // what survives parsing on the way out. The ask is grounded in the
    // session's goal, the agent's tool activity, and the turn's failure
    // state — none of which plain text extraction sees — and its reply
    // keeps one idea from crowding the strip with near-duplicates.
    describe("grounded ask", () => {
      const GOAL = "Migrate the auth module from passwords to passkeys";
      const FAILURE_TEXT = "FAIL src/auth.test.ts — passkey challenge missing";
      // One near-duplicate pair plus a fourth distinct prompt: the pair
      // must collapse and the fourth must take the freed slot.
      const DUPLICATED = [
        "Fix the failing login test",
        "Fix the failing login test now",
        "Run the auth test suite",
        "also add tests",
      ];
      const DEDUPED = [
        "Fix the failing login test",
        "Run the auth test suite",
        "also add tests",
      ];

      let env: IntegrationEnv;
      let log: string;
      let logDir: string;
      let captureDir: string;
      let capturePath: string;

      // waitForFile returns stable content, so a marker-poll is used
      // when the capture file may still hold the session run's prompt.
      const waitForCaptureMarker = async (marker: string): Promise<string> => {
        const deadline = Date.now() + 30000;
        for (;;) {
          try {
            const content = readFileSync(capturePath, "utf-8");
            if (content.includes(marker)) return content;
          } catch {
            // the mock has not written the capture yet — keep polling
          }
          if (Date.now() > deadline)
            throw new Error(`captured ask never contained "${marker}"`);
          await sleep(100);
        }
      };

      beforeAll(async () => {
        captureDir = mkdtempSync(join(tmpdir(), "glv-sugg-ground-cap-"));
        capturePath = join(captureDir, "ask-stdin.txt");
        const started = await startSuggestionEnv(
          fx,
          "glv-suggestions-ground-",
          [ephemeralReplyLine(DUPLICATED)],
          { captureStdin: capturePath },
        );
        env = started.env;
        log = started.log;
        logDir = started.logDir;
      }, 180000);

      afterAll(async () => {
        await env?.cleanup();
        rmScratch(logDir);
        rmScratch(captureDir);
      });

      it("grounds the ask in the goal, the tool activity, and the failure", async () => {
        await enableSuggestions(env);

        // The seeded transcript carries what text extraction alone
        // loses: an opening goal, a tool call, a failing result, and
        // the follow-up prompt (the mock commits streamed lines only,
        // never the prompt). Timestamps sit strictly in the past so
        // both stores order them before the run's committed reply.
        fx.seedSessions(env, [
          { id: "grounded", name: "Grounded", workingDir: env.scratchDir },
        ]);
        const base = Date.now();
        fx.seedMessages(env, "grounded", [
          {
            role: "user",
            content: [{ type: "text", text: GOAL }],
            createdTimestamp: base - 5000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Migrating the login route." }],
            createdTimestamp: base - 4000,
          },
          {
            role: "assistant",
            content: [fx.toolRequest("shell", { command: "npm test" })],
            createdTimestamp: base - 3000,
          },
          {
            role: "user",
            content: [fx.toolResponse(FAILURE_TEXT, true)],
            createdTimestamp: base - 2000,
          },
          {
            role: "user",
            content: [{ type: "text", text: "Why did the tests fail?" }],
            createdTimestamp: base - 1000,
          },
        ]);

        const res = await postFollowUp(
          env,
          fx.viewId("grounded"),
          "Why did the tests fail?",
        );
        expect(res.status).toBe(200);
        await waitForBar(env, fx.viewId("grounded"));

        await waitForInvocations(log, 1);
        const ask = await waitForCaptureMarker(
          "You are the prompt-suggestion helper",
        );
        expect(ask).toContain("[Session goal]");
        expect(ask).toContain(GOAL);
        expect(ask).toContain("[Recent actions]");
        expect(ask).toContain("npm test");
        expect(ask).toContain("[Last failure]");
        expect(ask).toContain("passkey challenge missing");
        expect(ask).toContain("[Conversation tail]");
        expect(ask).toContain("Why did the tests fail?");
        // The sharpened instruction travels with the context.
        expect(ask).toContain("generic chores");
        expect(ask).toContain("JSON array");
      });

      it("collapses near-duplicates and promotes the next distinct prompt", async () => {
        const res = await postFollowUp(
          env,
          fx.viewId("grounded"),
          "a second turn on the grounded session",
        );
        expect(res.status).toBe(200);
        await waitForBar(env, fx.viewId("grounded"));

        // The event may land mid-stream or at connect — both paths must
        // deliver the same deduped set.
        const events = await collectSse(
          env,
          `/sessions/${fx.viewId("grounded")}/events`,
          (seen) =>
            seen.some(
              (e) =>
                e.event === "suggestions" && (eventPrompts(e) ?? []).length > 0,
            ),
          SUGGESTION_EVENT_TIMEOUT_MS,
        );
        const prompts = events
          .filter((e) => e.event === "suggestions")
          .map((e) => eventPrompts(e))
          .find((p) => p !== undefined && p.length > 0);
        expect(prompts).toEqual(DEDUPED);

        // The server-rendered bar carries the same deduped set — the
        // near-duplicate never reaches a chip.
        const bar = await waitForBar(env, fx.viewId("grounded"));
        expect(bar).toContain(DEDUPED[0]);
        expect(bar).toContain(DEDUPED[2]);
        expect(bar).not.toContain("Fix the failing login test now");
      });
    });

    describe("model pin", () => {
      const pin = fx.suggestionModelPin;
      // Skipped wholesale when the flavor offers no resolvable pin.
      if (pin === undefined) return;

      let env: IntegrationEnv;
      let log: string;
      let logDir: string;
      let homeDir: string;

      beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "glv-sugg-model-home-"));
        pin.prepareHome?.(homeDir);
        const started = await startSuggestionEnv(
          fx,
          "glv-suggestions-model-",
          [ephemeralReplyLine(SUGGESTIONS)],
          {},
          homeDir,
        );
        env = started.env;
        log = started.log;
        logDir = started.logDir;
        // The pin, stored the way the settings row documents it —
        // the same SQLite contract an operator or future UI writes.
        const db = new DatabaseSync(env.dbs.suggestionsDb);
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('model', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(pin.value);
        db.close();
      }, 180000);

      afterAll(async () => {
        await env?.cleanup();
        rmScratch(logDir);
        rmScratch(homeDir);
      });

      it("asks on the pinned model, read from the settings row", async () => {
        await enableSuggestions(env);
        await runTurn(env, "a turn with a pinned suggestion model");
        await waitForInvocations(log, 1);

        const args = ephemeralInvocations(log)[0];
        for (const flag of pin.flags) expect(args).toContain(flag);
      });
    });

    describe("off by default", () => {
      let env: IntegrationEnv;
      let log: string;
      let logDir: string;

      beforeAll(async () => {
        const started = await startSuggestionEnv(fx, "glv-suggestions-off-", [
          ephemeralReplyLine(SUGGESTIONS),
        ]);
        env = started.env;
        log = started.log;
        logDir = started.logDir;
      }, 180000);

      afterAll(async () => {
        await env?.cleanup();
        rmScratch(logDir);
      });

      it("does none of this work while the setting is off", async () => {
        await runTurn(env, "a turn while the feature is off");
        await sleep(SETTLE_MS);
        expect(ephemeralInvocations(log)).toHaveLength(0);
      });

      it("toggles on with one tap", async () => {
        await enableSuggestions(env);
      });
    });

    describe("unusable reply", () => {
      let env: IntegrationEnv;
      let log: string;
      let logDir: string;

      beforeAll(async () => {
        const started = await startSuggestionEnv(fx, "glv-suggestions-bad-", [
          "no json array here",
        ]);
        env = started.env;
        log = started.log;
        logDir = started.logDir;
      }, 180000);

      afterAll(async () => {
        await env?.cleanup();
        rmScratch(logDir);
      });

      it("fails silently and never re-asks the served turn", async () => {
        await enableSuggestions(env);

        const sessionId = await runTurn(env, "turn whose ask answers garbage");
        // The ask happened exactly once...
        await waitForInvocations(log, 1);
        await sleep(SETTLE_MS);

        // ...got nothing usable, and surfaced nothing.
        expect(ephemeralInvocations(log)).toHaveLength(1);
        const bar = await waitForBar(env, sessionId);
        expect(bar).not.toContain("suggestion-strip");
        expect(env.serverStderr()).not.toContain("suggestions");

        // The turn stays served — no re-ask on re-read.
        await authedFetch(env, `/sessions/${sessionId}/prompt-bar?status=idle`);
        await sleep(SETTLE_MS);
        expect(ephemeralInvocations(log)).toHaveLength(1);
      });
    });

    describe("stopped run", () => {
      let env: IntegrationEnv;
      let log: string;
      let logDir: string;

      beforeAll(async () => {
        const started = await startSuggestionEnv(
          fx,
          "glv-suggestions-stop-",
          [ephemeralReplyLine(SUGGESTIONS)],
          { sleepMs: 8000 },
        );
        env = started.env;
        log = started.log;
        logDir = started.logDir;
      }, 180000);

      afterAll(async () => {
        await env?.cleanup();
        rmScratch(logDir);
      });

      it("asks nothing for a run the user stopped", async () => {
        await enableSuggestions(env);

        const res = await postNewSession(env, env.scratchDir, "stop me");
        expect(res.status).toBe(200);
        const sessionId = sessionIdOf(await res.text());

        // The run is live (the mock sleeps); stop it and settle.
        await waitForBar(env, sessionId, (h) => h.includes("stop-btn"));
        const stop = await authedFetch(env, `/sessions/${sessionId}/stop`, {
          method: "POST",
        });
        expect(stop.status).toBe(200);
        await waitForBar(env, sessionId);
        await sleep(SETTLE_MS);

        expect(ephemeralInvocations(log)).toHaveLength(0);
        const bar = await waitForBar(env, sessionId);
        expect(bar).not.toContain("suggestion-strip");
      });
    });
  });
};

export { runSuggestionsSuite };
