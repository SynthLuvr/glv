import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  collectSse,
  hasStatusEvent,
  hasStatusWhere,
  type IntegrationEnv,
  parseSseData,
  postSessionPrompt,
  postStop,
  type SseEvent,
  sleep,
  waitForArgs,
  withPage,
} from "../../glv/tests/harness.js";
import { insertSessions, startIntegrationEnv } from "./integration-harness.js";

// Session steering: a follow-up submitted while a claude run is in flight
// can be injected into the live process (--input-format stream-json)
// instead of queueing behind it. These tests run against the real serve
// process and the mock claude, which holds turns open (TURN_DELAY), logs
// every stdin line (STDIN_LOG), and can delay its exit (EXIT_DELAY) to
// open the steer-vs-exit race window.

const waitForText = async (
  path: string,
  needle: string,
  timeoutMs = 15000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
    if (text.includes(needle)) return text;
    if (Date.now() > deadline)
      throw new Error(
        `"${needle}" not in ${path} within ${timeoutMs}ms` +
          (existsSync(path) ? `:\n${readFileSync(path, "utf-8")}` : ""),
      );
    await sleep(50);
  }
};

const completedAt = (events: SseEvent[]): number =>
  events.findIndex(
    (e) => e.event === "status" && parseSseData(e.data).status === "completed",
  );

// The exact NDJSON line glv writes for a steered prompt.
const encodedMessage = (prompt: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: prompt } });

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("session steering (claude)", () => {
  let capDir: string;
  let holdArgs: string;
  let holdLog: string;
  let raceArgs: string;
  let raceLog: string;
  let slotLog: string;
  let offArgs: string;
  let offStdin: string;
  let envHold: IntegrationEnv;
  let envRace: IntegrationEnv;
  let envSlot: IntegrationEnv;
  let envUi: IntegrationEnv;
  let envOff: IntegrationEnv;
  // Seeds resumable sessions with real working dirs under the env scratch.
  const seedSessions = (env: IntegrationEnv, ids: readonly string[]): void => {
    mkdirSync(join(env.scratchDir, "dirs"), { recursive: true });
    insertSessions(
      env.dbs.flavor.projectsDir,
      ids.map((id) => ({
        id,
        name: `Steer ${id}`,
        workingDir: join(env.scratchDir, "dirs", id),
      })),
    );
    for (const id of ids)
      mkdirSync(join(env.scratchDir, "dirs", id), { recursive: true });
  };

  beforeAll(async () => {
    capDir = mkdtempSync(join(tmpdir(), "glv-steer-cap-"));

    // Holds each turn open so steers land mid-turn; writes committed rows
    // so the DB-poll path for steered messages is exercised too.
    holdArgs = join(capDir, "args-hold.json");
    holdLog = join(capDir, "stdin-hold.log");
    envHold = await startIntegrationEnv("glv-steer-hold-", {
      turnDelayMs: 2500,
      captureArgs: holdArgs,
      stdinLog: holdLog,
      writeDb: true,
    });
    seedSessions(envHold, ["st-1", "st-2", "st-3", "st-4", "st-8"]);

    // Short turns, then a long exit delay: a steer that lands after stdin
    // closed but before the process dies must not be lost — the
    // missed-window race fallback.
    raceArgs = join(capDir, "args-race.json");
    raceLog = join(capDir, "stdin-race.log");
    envRace = await startIntegrationEnv("glv-steer-race-", {
      turnDelayMs: 300,
      exitDelayMs: 6000,
      captureArgs: raceArgs,
      stdinLog: raceLog,
    });
    seedSessions(envRace, ["rc-1"]);

    // One concurrency slot: a second session's run stays queued (no
    // process yet), so a steer there must sit in pendingPrompts and be
    // written to stdin the moment the process spawns.
    slotLog = join(capDir, "stdin-slot.log");
    envSlot = await startIntegrationEnv("glv-steer-slot-", {
      turnDelayMs: 3000,
      stdinLog: slotLog,
      extraServeArgs: ["--max-concurrent", "1"],
    });
    seedSessions(envSlot, ["slot-a", "slot-b"]);

    // The UI test drives real button clicks through htmx, so its turn
    // window is wide enough to survive browser-pipeline latency under a
    // loaded suite (an 8 s held turn).
    envUi = await startIntegrationEnv("glv-steer-ui-", { turnDelayMs: 8000 });
    seedSessions(envUi, ["ui-1"]);

    // The rollback lever: steering disabled restores the pre-steering
    // contract wholesale — queue-only semantics AND raw write-and-close
    // stdin (no --input-format stream-json argv).
    offArgs = join(capDir, "args-off.json");
    offStdin = join(capDir, "stdin-off.txt");
    envOff = await startIntegrationEnv("glv-steer-off-", {
      sleepMs: 20000,
      serverEnv: { GLV_DISABLE_STEERING: "1" },
      captureArgs: offArgs,
      captureStdin: offStdin,
    });
    seedSessions(envOff, ["off-1"]);
  }, 240000);
  afterAll(async () => {
    await envHold?.cleanup();
    await envRace?.cleanup();
    await envSlot?.cleanup();
    await envUi?.cleanup();
    await envOff?.cleanup();
    rmSync(capDir, { recursive: true, force: true });
  });

  it("steers a mid-run prompt into the live process (one process, no resume)", async () => {
    // Attach the stream first so the whole run is observed from idle.
    const stream = collectSse(
      envHold,
      "/sessions/st-1/events",
      (evs) => hasStatusEvent(evs, "completed"),
      30000,
    );
    await postSessionPrompt(envHold, "st-1", "first slow task");
    await waitForArgs(holdArgs);

    // No mode on a busy steerable session → steer (the flavor default).
    const res = await postSessionPrompt(envHold, "st-1", "redirect now");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The steered prompt renders immediately, exactly like a prompt that
    // starts a run, and the status hint reports it as steered.
    expect(html).toContain("redirect now");
    expect(html).toContain("1 steered");
    expect(html).toContain('data-run-status="running"');

    // The message was injected into the live process's stdin, alongside
    // the run's own first prompt.
    await waitForText(holdLog, encodedMessage("redirect now"));

    const events = await stream;
    // The steered card streamed as a prompt event strictly before
    // completion, the committed user row arrived from the transcript, and
    // the single process exited 0 at stdin EOF (no error).
    const promptCard = events.find(
      (e) => e.event === "prompt" && e.data.includes("redirect now"),
    );
    expect(promptCard).toBeDefined();
    expect(events.indexOf(promptCard as SseEvent)).toBeLessThan(
      completedAt(events),
    );
    expect(
      events.some(
        (e) => e.event === "append" && e.data.includes("redirect now"),
      ),
    ).toBe(true);
    expect(hasStatusEvent(events, "error")).toBe(false);
    // Completed means every spawn already happened. No chained resume ran:
    // each message reached the agent exactly once (a chained resume would
    // have re-sent its prompt as the new process's first stdin line).
    const finalLog = readFileSync(holdLog, "utf-8");
    expect(occurrences(finalLog, encodedMessage("first slow task"))).toBe(1);
    expect(occurrences(finalLog, encodedMessage("redirect now"))).toBe(1);
  }, 45000);

  it("keeps steering while a turn is held open and completes via stdin EOF", async () => {
    const stream = collectSse(
      envHold,
      "/sessions/st-8/events",
      (evs) => hasStatusEvent(evs, "completed"),
      30000,
    );
    await postSessionPrompt(envHold, "st-8", "held turn");
    await waitForArgs(holdArgs);
    // The steer lands while turn one is still open (2500 ms turn delay).
    await postSessionPrompt(envHold, "st-8", "steer into the held turn");
    const events = await stream;
    expect(hasStatusEvent(events, "completed")).toBe(true);
    expect(hasStatusEvent(events, "error")).toBe(false);
    expect(hasStatusWhere(events, (d) => d.steeredCount === 1)).toBe(true);
    expect(hasStatusWhere(events, (d) => d.steerable === true)).toBe(true);
  }, 45000);

  it("starts a resume invocation for an idle submit (unchanged)", async () => {
    rmSync(holdArgs, { force: true });
    const res = await postSessionPrompt(envHold, "st-3", "fresh follow-up");
    expect(res.status).toBe(200);
    const args = await waitForArgs(holdArgs);
    expect(args).toContain("--resume");
    // The streaming-input flags ride along on resume runs too.
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
  }, 30000);

  it("falls back to a chained resume when the steer misses the closing stdin window", async () => {
    const stream = collectSse(
      envRace,
      "/sessions/rc-1/events",
      (evs) => hasStatusEvent(evs, "completed"),
      40000,
    );
    await postSessionPrompt(envRace, "rc-1", "quick task");
    // The mock logs the received message at once, then holds the turn for
    // TURN_DELAY (300 ms) before its result record. Waiting well past that
    // guarantees the runner has already closed stdin, while EXIT_DELAY
    // (6 s) keeps the process alive — the race window.
    await waitForText(raceLog, encodedMessage("quick task"));
    await sleep(1000);

    const res = await postSessionPrompt(envRace, "rc-1", "late steer");
    expect(res.status).toBe(200);

    // The prompt is never lost: it bypassed the dead stdin and ran as the
    // next chained process's first message.
    const events = await stream;
    expect(hasStatusEvent(events, "completed")).toBe(true);
    expect(hasStatusEvent(events, "error")).toBe(false);
    const args = readFileSync(raceArgs, "utf-8");
    expect(args).toContain("--resume");
    await waitForText(raceLog, encodedMessage("late steer"));
  }, 45000);

  it("holds pre-spawn steers in the pending queue and writes them at spawn", async () => {
    // slot-a occupies the single concurrency slot with a slow run.
    await postSessionPrompt(envSlot, "slot-a", "occupy the slot");
    // slot-b's run is queued (no process exists yet).
    await postSessionPrompt(envSlot, "slot-b", "waiting prompt");

    // A steer-mode submit on a queued run must become a steer-tagged
    // pending prompt, visible as a queued follow-up in the status feed.
    const stream = collectSse(
      envSlot,
      "/sessions/slot-b/events",
      (evs) => hasStatusWhere(evs, (d) => d.pendingCount === 1),
      15000,
    );
    const res = await postSessionPrompt(
      envSlot,
      "slot-b",
      "pre-spawn steer",
      "steer",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("queued-prompt");
    expect(html).toContain("pre-spawn steer");
    await stream;

    // Free the slot; both of slot-b's messages must reach the new
    // process's stdin together, in order.
    await postStop(envSlot, "slot-a");
    const log = await waitForText(slotLog, encodedMessage("waiting prompt"));
    await waitForText(slotLog, encodedMessage("pre-spawn steer"));
    expect(log.indexOf(encodedMessage("waiting prompt"))).toBeLessThan(
      log.indexOf(encodedMessage("pre-spawn steer")),
    );
  }, 45000);

  it("stops a steered run through the existing stop path", async () => {
    rmSync(holdArgs, { force: true });
    await postSessionPrompt(envHold, "st-4", "run to be stopped");
    await waitForArgs(holdArgs);
    await postSessionPrompt(envHold, "st-4", "steer before the stop");

    const res = await postStop(envHold, "st-4");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("send-btn");
    expect(html).not.toContain("status-hint running");
    const events = await collectSse(
      envHold,
      "/sessions/st-4/events",
      (evs) => hasStatusEvent(evs, "stopped"),
      15000,
    );
    expect(hasStatusEvent(events, "stopped")).toBe(true);
  }, 45000);

  it("queues an explicit queue-mode follow-up as a chained resume, never on stdin", async () => {
    rmSync(holdArgs, { force: true });
    await postSessionPrompt(envHold, "st-2", "first queue-mode task");
    await waitForArgs(holdArgs);

    const res = await postSessionPrompt(
      envHold,
      "st-2",
      "queued follow-up",
      "queue",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("queued-prompt");
    expect(html).toContain("queued follow-up");
    expect(html).toContain("Clear all queued");

    // While the first process lives, the queued prompt must not be
    // injected (queue semantics are unchanged for steerable flavors).
    await sleep(500);
    expect(readFileSync(holdLog, "utf-8")).not.toContain(
      encodedMessage("queued follow-up"),
    );

    // After the first run finishes it executes as a chained resume.
    const args = await waitForArgs(holdArgs);
    expect(args).toContain("--resume");
    await waitForText(holdLog, encodedMessage("queued follow-up"));
  }, 45000);

  it("offers Steer and Queue submit buttons and updates the hint live", async () => {
    await withPage(envUi.context, async (page: Page) => {
      await page.goto(`${envUi.baseUrl}/sessions/ui-1`);
      const bar = page.locator("form.prompt-bar");
      await expect(bar.locator(".send-btn")).toBeVisible();

      // Start a held-open run from the page itself (idle submit).
      await bar.locator("textarea.prompt-input").fill("ui busy run");
      await bar.locator(".send-btn").click();
      // Busy bar on a steerable flavor: Steer (primary) + Queue + Stop.
      await expect(bar.locator(".steer-btn")).toBeVisible();
      await expect(bar.locator(".queue-btn")).toBeVisible();
      await expect(bar.locator("textarea.prompt-input")).toHaveAttribute(
        "placeholder",
        "Steer or queue a follow-up…",
      );

      // Clicking Steer submits the form with mode=steer (the button's
      // name/value pair rides along with the htmx post); the swapped
      // response renders the steered suffix server-side.
      await bar.locator("textarea.prompt-input").fill("ui steer");
      await bar.locator(".steer-btn").click();
      await expect(page.locator(".status-hint.running")).toContainText(
        "(1 steered)",
      );

      // A second steer from outside the page proves the client-side SSE
      // path: the already-rendered hint must update to "(2 steered)"
      // without any pane swap.
      const res = await postSessionPrompt(envUi, "ui-1", "outside steer");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("2 steered");
      await expect(page.locator(".status-hint.running")).toContainText(
        "(2 steered)",
      );

      await bar.locator(".stop-btn").click();
      await expect(page.locator("form.prompt-bar .send-btn")).toBeVisible();
    });
  }, 45000);

  it("GLV_DISABLE_STEERING restores pure queue semantics", async () => {
    await postSessionPrompt(envOff, "off-1", "first hatch task");
    const args = await waitForArgs(offArgs);
    // No streaming-input mode: the pre-steering argv.
    expect(args).not.toContain("--input-format");

    // A default-mode submit on the busy session queues instead of steering.
    const res = await postSessionPrompt(envOff, "off-1", "should queue");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("queued-prompt");
    expect(html).toContain("should queue");
    expect(html).not.toContain("steer-btn");

    // The prompt traveled as raw stdin (write-and-close), not NDJSON.
    await waitForText(offStdin, "first hatch task");
    expect(readFileSync(offStdin, "utf-8")).not.toContain('"type":"user"');

    await postStop(envOff, "off-1");
  }, 45000);
});
