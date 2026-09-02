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

// Waits until the mock agent's capture file exists with content; the file
// is written by the spawned agent, which trails the fire that caused it.
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
  const writeConfig = (homeDir: string, jobs: unknown[]): string => {
    const path = defaultConfigFile(homeDir, fx.binName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ cronJobs: jobs }, null, 2));
    return path;
  };

  // Boots serve with the config at cfgPath and resolves once the process
  // exits (or is killed at the deadline — a serve that *boots* despite an
  // invalid config is itself the failure, so the null status fails the
  // non-zero assertion). The fake HOME keeps the real stores untouched.
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
      // The schedule fires every second; several fire windows pass with no
      // run ever appearing in the sidebar.
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
    it("exits non-zero naming a job with an invalid schedule", async () => {
      const home = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
      const cfgPath = writeConfig(home, [
        {
          name: "broken",
          schedule: "not a cron expression",
          prompt: "x",
          workingDir: home,
        },
      ]);
      const { status, stderr } = await serveUntilExit(cfgPath, home);
      expect(status ?? 0).not.toBe(0);
      expect(stderr).toContain("broken");
      expect(stderr).toContain("invalid schedule");
      rmSync(home, { recursive: true, force: true });
    });

    it("exits non-zero naming a job with an invalid timezone", async () => {
      const home = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
      const cfgPath = writeConfig(home, [
        {
          name: "tz-broken",
          schedule: "0 3 * * *",
          prompt: "x",
          workingDir: home,
          timezone: "Bogus/Zone",
        },
      ]);
      const { status, stderr } = await serveUntilExit(cfgPath, home);
      expect(status ?? 0).not.toBe(0);
      expect(stderr).toContain("tz-broken");
      expect(stderr).toContain("invalid timezone");
      rmSync(home, { recursive: true, force: true });
    });

    it("exits non-zero for duplicate job names", async () => {
      const home = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
      const cfgPath = writeConfig(home, [
        {
          name: "twin",
          schedule: "0 3 * * *",
          prompt: "x",
          workingDir: home,
        },
        {
          name: "twin",
          schedule: "0 4 * * *",
          prompt: "y",
          workingDir: home,
        },
      ]);
      const { status, stderr } = await serveUntilExit(cfgPath, home);
      expect(status ?? 0).not.toBe(0);
      expect(stderr).toContain('duplicate cron job name "twin"');
      rmSync(home, { recursive: true, force: true });
    });

    it("exits non-zero for a structurally invalid cronJobs value", async () => {
      const home = mkdtempSync(join(tmpdir(), "glv-cron-bad-"));
      const cfgPath = join(home, "config.json");
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify({ cronJobs: "nope" }));
      const { status, stderr } = await serveUntilExit(cfgPath, home);
      expect(status ?? 0).not.toBe(0);
      expect(stderr).toContain("cronJobs must be an array");
      rmSync(home, { recursive: true, force: true });
    });
  });
};

export { runCronSuite };
