import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultConfigFile,
  defaultDataDir,
  type FlavorFixture,
  fakeHomeEnv,
  findFreePort,
  ROOT,
  readConfigRows,
  rmScratch,
  spawnLauncher,
  spawnLauncherSync,
  stopProcess,
  waitForHttp,
} from "../harness.js";

// No auth/prompts/groups store overrides are passed, so the glv-owned
// databases must resolve to the platform default under the fake home.
const runDefaultDataDirsSuite = (fx: FlavorFixture): void => {
  describe("platform-aware default data directory", () => {
    let homeDir: string;
    let restoreAgent: (() => void) | undefined;

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-default-data-"));
      restoreAgent = await fx.mockAgent();
    });

    afterAll(() => {
      restoreAgent?.();
      rmScratch(homeDir);
    });

    it("creates glv-owned databases under the default data directory", async () => {
      const port = await findFreePort();
      const baseUrl = `http://localhost:${port}`;
      const proc = spawnLauncher(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(homeDir), "-p", String(port)],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...fakeHomeEnv(homeDir) },
        },
      );
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      try {
        await waitForHttp(baseUrl);
        const dataDir = defaultDataDir(homeDir, fx.binName);
        for (const file of fx.defaultDbFiles)
          expect(existsSync(join(dataDir, file))).toBe(true);
      } finally {
        await stopProcess(proc);
        if (stderr.trim() !== "") console.error("glv serve stderr:\n" + stderr);
      }
    }, 30000);

    it("treats an empty env override as unset (no ephemeral temp database)", async () => {
      // GLV_AUTH_DB="" must fall through to the platform default: an empty
      // string would otherwise make node:sqlite open a private temporary
      // database, and all sessions would silently vanish on restart.
      const emptyHome = mkdtempSync(join(tmpdir(), "glv-default-empty-"));
      const port = await findFreePort();
      const baseUrl = `http://localhost:${port}`;
      const proc = spawnLauncher(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(emptyHome), "-p", String(port)],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ...fakeHomeEnv(emptyHome),
            GLV_AUTH_DB: "",
          },
        },
      );
      try {
        await waitForHttp(baseUrl);
        const dataDir = defaultDataDir(emptyHome, fx.binName);
        expect(existsSync(join(dataDir, "auth.db"))).toBe(true);
      } finally {
        await stopProcess(proc);
        rmScratch(emptyHome);
      }
    }, 30000);
  });

  describe("platform-aware config database location", () => {
    let homeDir: string;

    beforeAll(() => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-default-config-"));
    });

    afterAll(() => {
      rmScratch(homeDir);
    });

    it("stores config under the default data directory, not a config dir", () => {
      const result = spawnLauncherSync(
        fx.binPath,
        ["config", "set", "forwardHost", "example.com"],
        { env: { ...process.env, ...fakeHomeEnv(homeDir) }, encoding: "utf-8" },
      );
      expect(result.status).toBe(0);

      const configDb = join(defaultDataDir(homeDir, fx.binName), "config.db");
      expect(existsSync(configDb)).toBe(true);
      expect(readConfigRows(configDb)).toEqual({
        forwardHost: "example.com",
      });
      // The retired file's old location stays untouched: nothing is
      // written under ~/.config (LOCALAPPDATA) anymore.
      expect(existsSync(defaultConfigFile(homeDir, fx.binName))).toBe(false);
    });
  });
};

export { runDefaultDataDirsSuite };
