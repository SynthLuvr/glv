import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  defaultConfigFile,
  type FlavorFixture,
  fakeHomeEnv,
  type IntegrationEnv,
  waitForServeExit,
  writeCronConfig,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls predicate every 500ms until it holds or the deadline passes;
// resolves to whether it ever held.
const pollUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(500);
  }
  return false;
};

// The mock agent writes its capture files asynchronously, trailing the
// fire that caused them; poll until one exists with content.
const waitForContent = async (
  path: string,
  timeoutMs = 10_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      if (content !== "") return content;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for content in ${path}`);
};

const runCronSuite = (fx: FlavorFixture): void => {
  const writeConfig = (homeDir: string, cronJobs: unknown): string =>
    writeCronConfig(homeDir, fx.binName, cronJobs);

  // Asserts serve refuses to start for the given cronJobs value, naming
  // every expected stderr fragment.
  const expectServeRefuses = async (
    cronJobs: unknown,
    ...stderrContains: string[]
  ): Promise<void> => {
    const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
    const { status, stderr } = await waitForServeExit(
      fx.binPath,
      ["serve", ...fx.defaultServeArgs(homeDir)],
      {
        ...fakeHomeEnv(homeDir),
        GLV_CONFIG: writeConfig(homeDir, cronJobs),
      },
    );
    expect(status ?? 0).not.toBe(0);
    for (const fragment of stderrContains) expect(stderr).toContain(fragment);
    rmSync(homeDir, { recursive: true, force: true });
  };

  describe("scheduled sessions from the config file", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workingDir: string;
    let stdinCapture: string;
    let cwdCapture: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-home-"));
      workingDir = mkdtempSync(join(tmpdir(), "glv-cron-work-"));
      stdinCapture = join(homeDir, "stdin-capture.txt");
      cwdCapture = join(homeDir, "cwd-capture.txt");
      writeConfig(homeDir, [
        {
          name: "every-second",
          schedule: "* * * * * *",
          prompt: "Scheduled check-in from cron",
          workingDir,
        },
      ]);
      env = await fx.startEnv(
        "glv-cron-",
        {
          sessionName: "Cron Session",
          captureStdin: stdinCapture,
          captureCwd: cwdCapture,
        },
        homeDir,
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("starts a new session per fire with the job's prompt and working dir", async () => {
      // The job fires every second; poll the sidebar until a session lands.
      const deadline = Date.now() + 30_000;
      let html = "";
      while (Date.now() < deadline) {
        const res = await authedFetch(env, "/");
        html = await res.text();
        if (html.includes("Cron Session")) break;
        await sleep(500);
      }
      expect(html).toContain("Cron Session");

      // The agent received the job's prompt on stdin and ran in the job's
      // working directory — both captured by the mock agent process.
      const stdin = await waitForContent(stdinCapture);
      expect(stdin).toContain("Scheduled check-in from cron");
      const cwd = await waitForContent(cwdCapture);
      expect(cwd.trim()).toBe(workingDir);
    });
  });

  describe("disabled cron jobs", () => {
    let env: IntegrationEnv;
    let homeDir: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-off-"));
      writeConfig(homeDir, [
        {
          name: "paused",
          schedule: "* * * * * *",
          prompt: "Should never run",
          workingDir: mkdtempSync(join(tmpdir(), "glv-cron-offdir-")),
          enabled: false,
        },
      ]);
      env = await fx.startEnv(
        "glv-cron-off-",
        { sessionName: "Disabled Session" },
        homeDir,
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("never fires a disabled job", async () => {
      // The schedule fires every second; four seconds of fire windows pass
      // with no run ever appearing in the sidebar.
      await sleep(4000);
      const res = await authedFetch(env, "/");
      const html = await res.text();
      expect(html).not.toContain("Disabled Session");
    });
  });

  describe("establishment timeout", () => {
    let env: IntegrationEnv;
    let homeDir: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-timeout-"));
      writeConfig(homeDir, [
        {
          name: "never",
          schedule: "* * * * * *",
          prompt: "No session will appear",
          workingDir: mkdtempSync(join(tmpdir(), "glv-cron-todir-")),
        },
      ]);
      env = await fx.startEnv(
        "glv-cron-timeout-",
        { neverCreateSession: true },
        homeDir,
        { GLV_CRON_SESSION_TIMEOUT_MS: "2000" },
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("stops the run and logs when the agent never creates a session", async () => {
      // First fire ~1s after boot, then a 2s establishment window before
      // the failure lands on stderr.
      const deadline = Date.now() + 30_000;
      let stderr = "";
      while (Date.now() < deadline) {
        stderr = env.serverStderr();
        if (stderr.includes('cron job "never"')) break;
        await sleep(500);
      }
      expect(stderr).toContain('cron job "never"');
      expect(stderr).toContain("no session was created");
    });
  });

  describe("live config reload", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workingDir: string;
    let stdinCapture: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-live-"));
      workingDir = mkdtempSync(join(tmpdir(), "glv-cron-livework-"));
      stdinCapture = join(homeDir, "stdin-live.txt");
      writeConfig(homeDir, [
        {
          name: "live",
          schedule: "* * * * * *",
          prompt: "Boot prompt",
          workingDir,
        },
      ]);
      env = await fx.startEnv(
        "glv-cron-live-",
        { sessionName: "Live Session", captureStdin: stdinCapture },
        homeDir,
        // Shrinks the reload poll so every rewrite below is picked up
        // quickly even where directory change events never arrive.
        { GLV_CONFIG_WATCH_POLL_MS: "250" },
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    });

    // The sidebar renders each session's name exactly once, so counting
    // marker occurrences counts that name's sessions.
    const countSessions = async (): Promise<number> => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      return html.split('class="session-name">Live Session<').length - 1;
    };

    const waitForSessions = async (atLeast: number): Promise<number> => {
      let count = 0;
      await pollUntil(async () => {
        count = await countSessions();
        return count >= atLeast;
      }, 30_000);
      return count;
    };

    // Each fire overwrites the mock agent's stdin capture, so poll it
    // until a run shows the given prompt.
    const waitForPrompt = async (prompt: string): Promise<void> => {
      const reached = await pollUntil(
        () =>
          existsSync(stdinCapture) &&
          readFileSync(stdinCapture, "utf-8").includes(prompt),
        30_000,
      );
      expect(reached, `prompt "${prompt}" never reached the agent`).toBe(true);
    };

    const waitForStderr = async (fragment: string): Promise<void> => {
      await pollUntil(() => env.serverStderr().includes(fragment), 20_000);
    };

    it("fires the boot job before any edit", async () => {
      const count = await waitForSessions(1);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("keeps the running schedule when an edit is invalid", async () => {
      const before = await countSessions();

      // Unparseable JSON: logged, schedule untouched.
      writeFileSync(defaultConfigFile(homeDir, fx.binName), "{ not json");
      await waitForStderr("config reload failed");
      expect(env.serverStderr()).toContain("keeping the running schedule");

      // The every-second job kept firing through the broken window.
      const kept = await waitForSessions(before + 2);
      expect(kept).toBeGreaterThanOrEqual(before + 2);

      // Structurally valid file, invalid job: rejected the same way.
      writeConfig(homeDir, [
        {
          name: "live",
          schedule: "not a cron expression",
          prompt: "Boot prompt",
          workingDir,
        },
      ]);
      await waitForStderr("config reload rejected");
      const stderr = env.serverStderr();
      expect(stderr).toContain('cron job "live"');
      expect(stderr).toContain("invalid schedule");
    });

    it("applies an edited job to the running schedule", async () => {
      writeConfig(homeDir, [
        {
          name: "live",
          schedule: "* * * * * *",
          prompt: "Edited prompt",
          workingDir,
        },
      ]);
      await waitForPrompt("Edited prompt");
    });

    it("stops firing once the job is removed", async () => {
      writeConfig(homeDir, []);
      // Let the reload land, then confirm the count stays flat across
      // several fire windows of the former every-second schedule.
      await sleep(5000);
      const first = await countSessions();
      await sleep(5000);
      const second = await countSessions();
      expect(second).toBe(first);
    });
  });

  describe("config validation at serve start", () => {
    let restoreAgent: (() => void) | undefined;

    beforeAll(async () => {
      // serve resolves the agent binary against PATH, which CI runners
      // lack; the mock is never invoked — validation exits serve first.
      restoreAgent = await fx.mockAgent();
    });

    afterAll(() => {
      restoreAgent?.();
    });

    it("exits non-zero naming a job with an invalid schedule", () =>
      expectServeRefuses(
        [
          {
            name: "broken",
            schedule: "not a cron expression",
            prompt: "x",
            workingDir: tmpdir(),
          },
        ],
        "broken",
        "invalid schedule",
      ));

    it("exits non-zero naming a job with an invalid timezone", () =>
      expectServeRefuses(
        [
          {
            name: "tz-broken",
            schedule: "0 3 * * *",
            prompt: "x",
            workingDir: tmpdir(),
            timezone: "Bogus/Zone",
          },
        ],
        "tz-broken",
        "invalid timezone",
      ));

    it("exits non-zero for duplicate job names", () =>
      expectServeRefuses(
        [
          {
            name: "twin",
            schedule: "0 3 * * *",
            prompt: "x",
            workingDir: tmpdir(),
          },
          {
            name: "twin",
            schedule: "0 4 * * *",
            prompt: "y",
            workingDir: tmpdir(),
          },
        ],
        'duplicate cron job name "twin"',
      ));

    it("exits non-zero for a job with only half a model pin", () =>
      expectServeRefuses(
        [
          {
            name: "half-pin",
            schedule: "0 3 * * *",
            prompt: "x",
            workingDir: tmpdir(),
            model: "glm-5.3",
          },
        ],
        "half-pin",
        "must set modelProvider and model together",
      ));

    it("exits non-zero for a structurally invalid cronJobs value", () =>
      expectServeRefuses("nope", "cronJobs must be an array"));
  });
};

export { runCronSuite };
