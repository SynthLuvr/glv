import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findFreePort,
  GLV,
  mockClaude,
  ROOT,
  stopProcess,
  waitForHttp,
} from "./integration-harness";

// No --auth-db / --prompts-db / --groups-db / --meta-db overrides are
// passed, so the glv-owned databases resolve to the platform default under
// the fake HOME.
describe("platform-aware default data directory", () => {
  let homeDir: string;
  let restoreClaude: (() => void) | undefined;

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "glv-default-data-"));
    restoreClaude = await mockClaude();
  });

  afterAll(() => {
    restoreClaude?.();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates glv-owned databases under the default data directory", async () => {
    const port = await findFreePort();
    const baseUrl = `http://localhost:${port}`;
    const proc = spawn(
      GLV,
      [
        "serve",
        "--projects-dir",
        join(homeDir, ".claude", "projects"),
        "-p",
        String(port),
        "--claude-binary",
        "claude",
      ],
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
      const dataDir = join(homeDir, ".local", "share", "glv-claude");
      expect(existsSync(join(dataDir, "auth.db"))).toBe(true);
      expect(existsSync(join(dataDir, "prompts.db"))).toBe(true);
      expect(existsSync(join(dataDir, "groups.db"))).toBe(true);
      expect(existsSync(join(dataDir, "meta.db"))).toBe(true);
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
      GLV,
      ["config", "set", "forwardHost", "example.com"],
      { env: { ...process.env, HOME: homeDir }, encoding: "utf-8" },
    );
    expect(result.status).toBe(0);

    const configPath = join(homeDir, ".config", "glv-claude", "config.json");
    expect(existsSync(configPath)).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw.forwardHost).toBe("example.com");
  });
});
