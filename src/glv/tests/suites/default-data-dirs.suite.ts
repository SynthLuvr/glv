import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FlavorFixture,
  findFreePort,
  ROOT,
  stopProcess,
  waitForHttp,
} from "../harness.js";

// No auth/prompts/groups store overrides are passed, so the glv-owned
// databases must resolve to the platform default under the fake HOME.
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
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("creates glv-owned databases under the default data directory", async () => {
      const port = await findFreePort();
      const baseUrl = `http://localhost:${port}`;
      const proc = spawn(
        fx.binPath,
        ["serve", ...fx.defaultServeArgs(homeDir), "-p", String(port)],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, HOME: homeDir },
        },
      );
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      try {
        await waitForHttp(baseUrl);
        const dataDir = join(homeDir, ".local", "share", fx.binName);
        for (const file of fx.defaultDbFiles)
          expect(existsSync(join(dataDir, file))).toBe(true);
      } finally {
        await stopProcess(proc);
        if (stderr.trim() !== "") console.error("glv serve stderr:\n" + stderr);
      }
    }, 30000);
  });

  describe("platform-aware default config directory", () => {
    let homeDir: string;

    beforeAll(() => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-default-config-"));
    });

    afterAll(() => {
      rmSync(homeDir, { recursive: true, force: true });
    });

    it("writes the config file under the default config directory", () => {
      const result = spawnSync(
        fx.binPath,
        ["config", "set", "forwardHost", "example.com"],
        { env: { ...process.env, HOME: homeDir }, encoding: "utf-8" },
      );
      expect(result.status).toBe(0);

      const configPath = join(homeDir, ".config", fx.binName, "config.json");
      expect(existsSync(configPath)).toBe(true);

      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(raw.forwardHost).toBe("example.com");
    });
  });
};

export { runDefaultDataDirsSuite };
