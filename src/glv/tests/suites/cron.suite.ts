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
  expectServeRefusal,
  type FlavorFixture,
  fakeHomeEnv,
  findFreePort,
  type IntegrationEnv,
  readConfigRows,
  readCronConfig,
  readCronJobRows,
  removeCronJobRow,
  seedCronJobRow,
  spawnLauncher,
  stopProcess,
  waitForHttp,
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
    const cfgPath = writeConfig(homeDir, cronJobs);
    const stderr = await expectServeRefusal(
      fx.binPath,
      ["serve", ...fx.defaultServeArgs(homeDir)],
      { ...fakeHomeEnv(homeDir), GLV_CONFIG: cfgPath },
    );
    for (const fragment of stderrContains) expect(stderr).toContain(fragment);
    rmSync(homeDir, { recursive: true, force: true });
  };

  describe("scheduled sessions from the cron database", () => {
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
      // Seeded through the config file, so this boot also exercises the
      // one-time migration into the cron database.
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

    it("migrates the config file's jobs into the cron database at boot", () => {
      // The row now lives where the scheduler read it from.
      expect(readCronJobRows(env.dbs.cronDb)).toEqual([
        {
          name: "every-second",
          schedule: "* * * * * *",
          prompt: "Scheduled check-in from cron",
          workingDir,
          enabled: true,
        },
      ]);
      // The file is retired wholesale — renamed to config.json.bak —
      // once its contents have been imported.
      expect(existsSync(defaultConfigFile(homeDir, fx.binName))).toBe(false);
      expect(existsSync(`${defaultConfigFile(homeDir, fx.binName)}.bak`)).toBe(
        true,
      );
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

  describe("migrating the config file into the cron database", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let cfgPath: string;
    let workA: string;
    let workB: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-mig-"));
      workA = mkdtempSync(join(tmpdir(), "glv-cron-mw-a-"));
      workB = mkdtempSync(join(tmpdir(), "glv-cron-mw-b-"));
      // An unnamed entry (named cron-1 by position), a disabled one with
      // a timezone, and a sibling config key that must survive the
      // rewrite.
      cfgPath = defaultConfigFile(homeDir, fx.binName);
      writeConfig(homeDir, [
        {
          schedule: "0 3 * * *",
          prompt: "Nightly sweep",
          workingDir: workA,
        },
        {
          name: "paused",
          schedule: "0 4 * * *",
          prompt: "Never fires yet",
          workingDir: workB,
          timezone: "Europe/Oslo",
          enabled: false,
        },
      ]);
      // writeCronConfig overwrites the file wholesale; re-add forwardHost
      // by hand so the rewrite has another key to preserve.
      const config = JSON.parse(readFileSync(cfgPath, "utf-8"));
      config.forwardHost = "203.0.113.7";
      writeFileSync(cfgPath, JSON.stringify(config, null, 2));
      env = await fx.startEnv(
        "glv-cron-mig-",
        { sessionName: "Migration Session" },
        homeDir,
      );
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("imports every entry, naming unnamed ones, and retires the file", () => {
      expect(readCronJobRows(env.dbs.cronDb)).toEqual([
        {
          name: "cron-1",
          schedule: "0 3 * * *",
          prompt: "Nightly sweep",
          workingDir: workA,
          enabled: true,
        },
        {
          name: "paused",
          schedule: "0 4 * * *",
          prompt: "Never fires yet",
          workingDir: workB,
          timezone: "Europe/Oslo",
          enabled: false,
        },
      ]);
      // The sibling scalar lands in the config database, not the file.
      expect(readConfigRows(env.dbs.configDb)).toEqual({
        forwardHost: "203.0.113.7",
      });
      // The file itself is retired — imported, then renamed away so a
      // copy stays behind instead of being destroyed.
      expect(existsSync(cfgPath)).toBe(false);
      expect(readCronConfig(`${cfgPath}.bak`)).toEqual({
        cronJobs: [
          { schedule: "0 3 * * *", prompt: "Nightly sweep", workingDir: workA },
          {
            name: "paused",
            schedule: "0 4 * * *",
            prompt: "Never fires yet",
            workingDir: workB,
            timezone: "Europe/Oslo",
            enabled: false,
          },
        ],
        forwardHost: "203.0.113.7",
      });
    });

    it("lists the migrated jobs in the Scheduled runs section", async () => {
      const res = await authedFetch(env, "/");
      const html = await res.text();
      expect(html).toContain("cron-1");
      expect(html).toContain("Paused");
      expect(html).toContain("(Europe/Oslo)");
    });

    it("re-imports jobs re-added to the config file without duplicating", async () => {
      // Hand-add the job to the config file again (the old habit) and
      // boot a second serve against the same cron database: the file's
      // entry wins on the name collision, the untouched row survives,
      // and the file is retired once more.
      writeConfig(homeDir, [
        {
          name: "paused",
          schedule: "0 4 * * *",
          prompt: "Edited while re-imported",
          workingDir: workB,
          timezone: "Europe/Oslo",
          enabled: false,
        },
      ]);
      const port = await findFreePort();
      const proc = spawnLauncher(
        fx.binPath,
        ["serve", "-p", String(port), ...fx.defaultServeArgs(homeDir)],
        {
          env: {
            ...process.env,
            ...fakeHomeEnv(homeDir),
            GLV_CONFIG: cfgPath,
            GLV_CRON_DB: env.dbs.cronDb,
          },
        },
      );
      try {
        await waitForHttp(`http://localhost:${port}`);
        expect(readCronJobRows(env.dbs.cronDb)).toEqual([
          {
            name: "cron-1",
            schedule: "0 3 * * *",
            prompt: "Nightly sweep",
            workingDir: workA,
            enabled: true,
          },
          {
            name: "paused",
            schedule: "0 4 * * *",
            prompt: "Edited while re-imported",
            workingDir: workB,
            timezone: "Europe/Oslo",
            enabled: false,
          },
        ]);
        expect(existsSync(cfgPath)).toBe(false);
      } finally {
        await stopProcess(proc);
      }
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
      // The schedule fires every second; three fire windows pass with
      // no run ever appearing in the sidebar.
      await sleep(3000);
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

  describe("live reload from the cron database", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workingDir: string;
    let stdinCapture: string;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-cron-live-"));
      workingDir = mkdtempSync(join(tmpdir(), "glv-cron-livework-"));
      stdinCapture = join(homeDir, "stdin-live.txt");
      env = await fx.startEnv(
        "glv-cron-live-",
        { sessionName: "Live Session", captureStdin: stdinCapture },
        homeDir,
        // Shrinks the watch poll so every row write below is picked up
        // quickly.
        { GLV_CRON_DB_POLL_MS: "250" },
      );
      // Seeded straight into the database the server serves from — an
      // external writer, exactly the case the poll exists for.
      seedCronJobRow(env.dbs.cronDb, {
        name: "live",
        schedule: "* * * * * *",
        prompt: "Boot prompt",
        workingDir,
        enabled: true,
      });
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

    it("picks up a job seeded externally after boot", async () => {
      const count = await waitForSessions(1);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("keeps the running schedule when a written row is invalid", async () => {
      const before = await countSessions();

      // A structurally valid row with an invalid schedule, written
      // straight into the database: logged, schedule untouched.
      seedCronJobRow(env.dbs.cronDb, {
        name: "live",
        schedule: "not a cron expression",
        prompt: "Boot prompt",
        workingDir,
        enabled: true,
      });
      await waitForStderr("reload rejected");
      const stderr = env.serverStderr();
      expect(stderr).toContain("keeping the running schedule");
      expect(stderr).toContain('cron job "live"');
      expect(stderr).toContain("invalid schedule");

      // The every-second job kept firing through the broken window.
      const kept = await waitForSessions(before + 2);
      expect(kept).toBeGreaterThanOrEqual(before + 2);
    });

    it("applies an edited row to the running schedule", async () => {
      seedCronJobRow(env.dbs.cronDb, {
        name: "live",
        schedule: "* * * * * *",
        prompt: "Edited prompt",
        workingDir,
        enabled: true,
      });
      await waitForPrompt("Edited prompt");
    });

    it("stops firing once the row is removed", async () => {
      removeCronJobRow(env.dbs.cronDb, "live");
      // Let the reload land (the 250ms poll picks the delete up in well
      // under a second), then confirm the count stays flat across three
      // fire windows of the former every-second schedule.
      await sleep(3000);
      const first = await countSessions();
      await sleep(3000);
      const second = await countSessions();
      expect(second).toBe(first);
    });
  });

  describe("job validation at serve start", () => {
    let restoreAgent: (() => void) | undefined;

    beforeAll(async () => {
      // serve resolves the agent binary against PATH, which CI runners
      // lack; the mock is never invoked — validation exits serve first.
      restoreAgent = await fx.mockAgent();
    });

    afterAll(() => {
      restoreAgent?.();
    });

    // Each case boots its own serve process (fresh fake home and
    // config) just to watch it exit non-zero and shares no state with
    // the others, so concurrency overlaps the five boots instead of
    // stacking tens of seconds of serial startups on a CI runner.
    // Every case seeds the legacy config file: the migration is what
    // validates it, and a refusal must leave the file untouched so it
    // stays hand-fixable.
    it.concurrent("exits non-zero naming a job with an invalid schedule", () =>
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

    it.concurrent("exits non-zero naming a job with an invalid timezone", () =>
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

    it.concurrent("exits non-zero for duplicate job names", () =>
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

    it.concurrent("exits non-zero for a job with only half a model pin", () =>
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

    it.concurrent("exits non-zero for a structurally invalid cronJobs value", () =>
      expectServeRefuses("nope", "cronJobs must be an array"));

    it.concurrent("exits non-zero for a legacy file that is not valid JSON", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-json-"));
      const cfgPath = defaultConfigFile(homeDir, fx.binName);
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, "{ not valid json");
      const stderr = await expectServeRefusal(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(homeDir)],
        { ...fakeHomeEnv(homeDir), GLV_CONFIG: cfgPath },
      );
      expect(stderr).toContain("not valid JSON");
      rmSync(homeDir, { recursive: true, force: true });
    });

    it.concurrent("exits non-zero for a legacy file that is not an object", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-obj-"));
      const cfgPath = defaultConfigFile(homeDir, fx.binName);
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, "5");
      const stderr = await expectServeRefusal(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(homeDir)],
        { ...fakeHomeEnv(homeDir), GLV_CONFIG: cfgPath },
      );
      expect(stderr).toContain("glv config at");
      expect(stderr).toContain("must be an object");
      rmSync(homeDir, { recursive: true, force: true });
    });

    it.concurrent("leaves the config file untouched when it refuses", async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "glv-cron-keep-"));
      const cfgPath = writeConfig(homeDir, [
        {
          name: "broken",
          schedule: "not a cron expression",
          prompt: "x",
          workingDir: tmpdir(),
        },
      ]);
      await expectServeRefusal(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(homeDir)],
        { ...fakeHomeEnv(homeDir), GLV_CONFIG: cfgPath },
      );
      // The invalid jobs stay in the file — fixable by hand, retriable
      // on the next serve.
      expect(readCronConfig(cfgPath).cronJobs).toHaveLength(1);
      rmSync(homeDir, { recursive: true, force: true });
    });
  });
};

export { runCronSuite };
