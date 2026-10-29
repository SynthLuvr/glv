import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectSse,
  type IntegrationEnv,
  parseSseData,
  postFollowUp,
} from "../../glv/tests/harness.js";
import { claudeFixture } from "./integration-harness.js";

// ADR 0010: claude runs hold stdin open (stream-json input) so pending
// background tasks survive the turn that armed them and their
// completion wakes the agent into a new turn. These scenarios drive the
// real server → runner → spawn path against the scripted mock claude
// and prove, from the pipe's own point of view, that glv held it open
// across the turn boundary and closed it exactly when the run had
// nothing left to wait for.

// One line of the mock's stdin-lifecycle log, oldest first.
type StdinPhase = {
  phase: string;
  stdinOpen: boolean;
  [key: string]: unknown;
};

const readPhases = (path: string): StdinPhase[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as StdinPhase)
    : [];

const phase = (phases: StdinPhase[], name: string): StdinPhase | undefined =>
  phases.find((p) => p.phase === name);

const hasStatus = (
  events: { event: string; data: string }[],
  status: string,
): boolean =>
  events.some(
    (e) => e.event === "status" && parseSseData(e.data).status === status,
  );

const SESSION = "stdin-1";

// Seeds the session the scenarios run against, creating the working dir
// the run spawns in.
const seedSession = (env: IntegrationEnv, name: string): void => {
  const workingDir = join(env.scratchDir, "w");
  mkdirSync(workingDir, { recursive: true });
  claudeFixture.seedSessions(env, [{ id: SESSION, name, workingDir }]);
  claudeFixture.seedMessages(env, SESSION, [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
};

describe("held-open stdin — background tasks outlive the turn (claude)", () => {
  describe("a completed task wakes the agent", () => {
    let env: IntegrationEnv;
    let logPath: string;
    let promptCapture: string;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "glv-stdin-wake-"));
      logPath = join(dir, "stdin.log");
      promptCapture = join(dir, "prompt.txt");
      env = await claudeFixture.startEnv(
        "glv-stdin-wake-",
        undefined,
        undefined,
        {
          CLAUDE_MOCK_BG_TASKS: "wake",
          CLAUDE_MOCK_STDIN_LOG: logPath,
          CLAUDE_MOCK_CAPTURE_STDIN: promptCapture,
        },
      );
      seedSession(env, "Stdin Wake");
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("holds stdin across the turn boundary, wakes, and settles completed", async () => {
      const stream = collectSse(
        env,
        `/sessions/${claudeFixture.viewId(SESSION)}/events`,
        (evs) =>
          // The completed status can land before the wake turn's preview
          // flushes, and vice versa — wait for both.
          hasStatus(evs, "completed") &&
          evs.some(
            (e) =>
              e.event === "preview" &&
              e.data.includes("reporting back as promised"),
          ),
        30_000,
      );
      const posted = await postFollowUp(
        env,
        claudeFixture.viewId(SESSION),
        "watch the pr and report back",
      );
      expect(posted.status).toBe(200);
      const events = await stream;

      // The run took the wake turn and finished cleanly — no error, and
      // the last preview is the wake turn's report, not turn 1's.
      expect(hasStatus(events, "running")).toBe(true);
      expect(hasStatus(events, "completed")).toBe(true);
      expect(hasStatus(events, "error")).toBe(false);
      const previews = events.filter((e) => e.event === "preview");
      expect(previews[previews.length - 1]?.data).toContain(
        "reporting back as promised",
      );

      // The pipe's own account of the run: the prompt arrived as one
      // stream-json user line; stdin was still open at turn 1's result
      // and through the parked silence while the task ran; the wake
      // turn ran and ended; only then did EOF arrive — glv closed the
      // pipe at the wake result, not before.
      const phases = readPhases(logPath);
      const promptLine = phase(phases, "prompt");
      expect(promptLine?.line).toContain('"type":"user"');
      expect(promptLine?.line).toContain("watch the pr and report back");
      expect(phase(phases, "turn1-result")?.stdinOpen).toBe(true);
      expect(phase(phases, "after-task-ran")?.stdinOpen).toBe(true);
      expect(phase(phases, "turn2-result")?.stdinOpen).toBe(true);
      expect(phase(phases, "eof")?.closedAfterWakeTurn).toBe(true);

      // The captured prompt is the decoded text — the same raw prompt
      // every other suite sees, despite the new wire format.
      expect(readFileSync(promptCapture, "utf8")).toBe(
        "watch the pr and report back",
      );
    }, 60_000);
  });

  describe("a completion that never wakes the agent", () => {
    let env: IntegrationEnv;
    let logPath: string;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "glv-stdin-nowake-"));
      logPath = join(dir, "stdin.log");
      env = await claudeFixture.startEnv(
        "glv-stdin-nowake-",
        undefined,
        undefined,
        {
          CLAUDE_MOCK_BG_TASKS: "nowake",
          CLAUDE_MOCK_STDIN_LOG: logPath,
          // The idle defense on a short leash: with no wake turn ever
          // coming, closing stdin is the only way this run can end.
          GLV_CLAUDE_STDIN_IDLE_MS: "700",
        },
      );
      seedSession(env, "Stdin NoWake");
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("still ends: the idle defense closes the pipe and the run settles", async () => {
      const stream = collectSse(
        env,
        `/sessions/${claudeFixture.viewId(SESSION)}/events`,
        (evs) => hasStatus(evs, "completed") || hasStatus(evs, "error"),
        30_000,
      );
      const posted = await postFollowUp(
        env,
        claudeFixture.viewId(SESSION),
        "watch silently please",
      );
      expect(posted.status).toBe(200);
      const events = await stream;
      expect(hasStatus(events, "completed")).toBe(true);

      // Held open through the turn boundary and the parked silence;
      // closed by the idle defense, not by anything the agent did.
      const phases = readPhases(logPath);
      expect(phase(phases, "turn1-result")?.stdinOpen).toBe(true);
      expect(phase(phases, "eof")?.closedByIdleDefense).toBe(true);
    }, 60_000);
  });
});
