import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type FlavorFixture, IS_WIN } from "../harness.js";

const runLauncherSuite = (fx: FlavorFixture): void => {
  // The Node launcher (package.json "bin") and the POSIX shell launcher
  // must behave identically. These spawn the real launchers end-to-end
  // (no database needed).
  const SHELL_LAUNCHER = resolve(`bin/glv-${fx.name}`);
  const NODE_LAUNCHER = resolve(`bin/glv-${fx.name}.mjs`);

  type Out = { status: number; stdout: string };

  // Windows cannot execute the POSIX launcher directly; when a POSIX sh is
  // on PATH (Git for Windows), the parity check runs through it. MSYS sh
  // treats backslashes as plain characters, so a Windows path would make
  // dirname("$0") resolve to "." and the launcher would compute the wrong
  // project root — hand sh a forward-slash path instead.
  const runShell = (args: string[]): Out => {
    const result = IS_WIN
      ? spawnSync("sh", [SHELL_LAUNCHER.replaceAll("\\", "/"), ...args], {
          encoding: "utf-8",
        })
      : spawnSync(SHELL_LAUNCHER, args, { encoding: "utf-8" });
    return { status: result.status ?? -1, stdout: result.stdout ?? "" };
  };

  // Some minimal sh builds (e.g. Git's sh.exe invoked with a plain Windows
  // PATH, as on CI runners) cannot run the launcher at all, so parity is
  // only asserted where the launcher demonstrably executes.
  const canRunShell =
    !IS_WIN ||
    (spawnSync("sh", ["-c", "exit 0"]).status === 0 &&
      runShell(["--help"]).stdout.includes(`Usage: glv-${fx.name}`));

  const runNode = (args: string[]): Out => {
    const result = spawnSync(process.execPath, [NODE_LAUNCHER, ...args], {
      encoding: "utf-8",
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? "" };
  };

  describe(`bin/glv-${fx.name}.mjs Node launcher`, () => {
    it("loads cli.ts via tsx and prints serve help", () => {
      const { status, stdout } = runNode(["serve", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("--forward");
    });

    it.runIf(canRunShell)(
      `produces output identical to the bin/glv-${fx.name} shell launcher`,
      () => {
        expect(runNode(["serve", "--help"]).stdout).toBe(
          runShell(["serve", "--help"]).stdout,
        );
      },
    );

    it("prints the top-level program help", () => {
      const { stdout } = runNode(["--help"]);
      expect(stdout).toContain(`Usage: glv-${fx.name}`);
    });

    it("forwards argv and propagates a non-zero exit from commander", () => {
      // Argument validation runs before the serve action and needs no database.
      const { status } = runNode(["serve", "--max-concurrent", "0"]);
      expect(status).not.toBe(0);
    });
  });
};

export { runLauncherSuite };
