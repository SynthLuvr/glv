import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// bin/glv-goose.mjs (Node, package.json "bin") and bin/glv-goose (POSIX
// shell) must behave identically. These spawn the real launchers end-to-end
// (no database needed).
const SHELL_LAUNCHER = resolve("bin/glv-goose");
const NODE_LAUNCHER = resolve("bin/glv-goose.mjs");

type Out = { status: number; stdout: string };

const runShell = (args: string[]): Out => {
  const result = spawnSync(SHELL_LAUNCHER, args, { encoding: "utf-8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
};

const runNode = (args: string[]): Out => {
  const result = spawnSync(process.execPath, [NODE_LAUNCHER, ...args], {
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
};

describe("bin/glv-goose.mjs Node launcher", () => {
  it("loads cli.ts via tsx and prints serve help", () => {
    const { status, stdout } = runNode(["serve", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--forward");
  });

  it("produces output identical to the bin/glv-goose shell launcher", () => {
    expect(runNode(["serve", "--help"]).stdout).toBe(
      runShell(["serve", "--help"]).stdout,
    );
  });

  it("prints the top-level program help", () => {
    const { stdout } = runNode(["--help"]);
    expect(stdout).toContain("Usage: glv-goose");
  });

  it("forwards argv and propagates a non-zero exit from commander", () => {
    // Argument validation runs before the serve action and needs no database.
    const { status } = runNode(["serve", "--max-concurrent", "0"]);
    expect(status).not.toBe(0);
  });
});
