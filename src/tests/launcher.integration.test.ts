import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Node launcher (bin/glv.mjs) and the POSIX shell launcher (bin/glv) must
// behave identically — bin/glv.mjs is the cross-platform entry point published
// via package.json's "bin" field, while bin/glv is kept for direct Unix
// invocation (the harness spawns it by path). These tests drive the Node
// launcher end-to-end: they spawn the real file, which in turn spawns node +
// the tsx loader + src/cli.ts, then assert parity with the shell launcher and
// correct exit-code forwarding. No database is required.
const SHELL_LAUNCHER = resolve("bin/glv");
const NODE_LAUNCHER = resolve("bin/glv.mjs");

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

describe("bin/glv.mjs Node launcher", () => {
  it("loads cli.ts via tsx and prints serve help", () => {
    const { status, stdout } = runNode(["serve", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--forward");
  });

  it("produces output identical to the bin/glv shell launcher", () => {
    expect(runNode(["serve", "--help"]).stdout).toBe(
      runShell(["serve", "--help"]).stdout,
    );
  });

  it("prints the top-level program help", () => {
    const { stdout } = runNode(["--help"]);
    expect(stdout).toContain("Usage: glv");
  });

  it("forwards argv and propagates a non-zero exit from commander", () => {
    // Argument validation runs before the serve action and needs no database.
    const { status } = runNode(["serve", "--max-concurrent", "0"]);
    expect(status).not.toBe(0);
  });
});
