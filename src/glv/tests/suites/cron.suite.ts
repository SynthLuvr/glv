import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  defaultConfigFile,
  type FlavorFixture,
  fakeHomeEnv,
  type IntegrationEnv,
  spawnLauncher,
  stopProcess,
} from "../harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  const writeConfig = (homeDir: string, cronJobs: unknown): string => {
    const path = defaultConfigFile(homeDir, fx.binName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ cronJobs }, null, 2));
    return path;
  };

  // Boots serve with the config at cfgPath and resolves on exit. A serve
  // still alive at the deadline is killed and yields status null — which
  // fails the callers' non-zero assertion, because a serve that boots
  // despite an invalid config is itself the bug. The fake HOME keeps the
  // real stores untouched.
  const serveUntilExit = async (
    cfgPath: string,
    homeDir: string,
  ): Promise<{ status: number | null; stderr: string }> => {
    const proc = spawnLauncher(
      fx.binPath,
      ["serve", ...fx.defaultServeArgs(homeDir)],
      {
        env: {
          ...process.env,
          ...fakeHomeEnv(homeDir),
          GLV_CONFIG: cfgPath,
        },
      },
    );
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const status = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        void stopProcess(proc);
        resolve(null);
      }, 20_000);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    return { status, stderr };
  };

  // Asserts serve refuses to start for the given cronJobs value, naming
  // every expected stderr fragment.
  const expectServeRefuses = async (
    cronJobs: unknown,
    ...stderrContains: string[]
  ): Promise<void> => {
    const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
    const { status, stderr } = await serveUntilExit(
      writeConfig(homeDir, cronJobs),
      homeDir,
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

    it("exits non-zero for a structurally invalid cronJobs value", () =>
      expectServeRefuses("nope", "cronJobs must be an array"));
  });
};

export { runCronSuite };
