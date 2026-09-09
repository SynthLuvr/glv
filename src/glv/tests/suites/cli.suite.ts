import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type FlavorFixture,
  fakeHomeEnv,
  seedConfigRow,
  spawnLauncherSync,
} from "../harness.js";

type RunResult = { status: number; stdout: string; stderr: string };

type RunCli = (args: string[], env?: Record<string, string>) => RunResult;

type CliDeps = {
  readonly run: RunCli;
  /** Temp dir for the config tests' GLV_CONFIG_DB target. */
  readonly cfgDir: () => string;
  /** Flavor-specific `view` header assertions beyond id/name/dir. */
  readonly assertViewHeader?: (stdout: string) => void;
};

// Builds the CLI runner each flavor wrapper uses: the launcher plus the
// flavor's global store flags, so every subcommand runs against the seeded
// store.
const makeRunner = (bin: string, globalFlags: () => string[]): RunCli => {
  const run = (args: string[], env: Record<string, string> = {}): RunResult => {
    const result = spawnLauncherSync(bin, [...globalFlags(), ...args], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  return run;
};

const runCliSuite = (fx: FlavorFixture, deps: CliDeps): void => {
  const { run, cfgDir, assertViewHeader } = deps;

  describe(`${fx.binName} sessions`, () => {
    it("lists sessions, excluding archived ones", () => {
      const { status, stdout } = run(["sessions"]);
      expect(status).toBe(0);
      expect(stdout).toContain("Alpha Session");
      expect(stdout).not.toContain("Archived One");
      expect(stdout).toContain("2 session(s) listed.");
    });

    it("degrades gracefully for null fields", () => {
      const { stdout } = run(["sessions"]);
      expect(stdout).not.toContain("null");
    });

    it("respects --limit", () => {
      const { stdout } = run(["sessions", "-n", "1"]);
      expect(stdout).toContain("1 session(s) listed.");
    });

    it("includes archived sessions with --all", () => {
      const { stdout } = run(["sessions", "--all"]);
      expect(stdout).toContain("Archived One");
    });

    it("defaults to the sessions listing when only global options are given", () => {
      // The runner prepends the global --db flag, so an empty args list is
      // exactly "global options, no subcommand": the default `sessions`
      // listing must run, not an unknown-command error.
      const { status, stdout } = run([]);
      expect(status).toBe(0);
      expect(stdout).toContain("Alpha Session");
    });

    it("rejects a non-numeric --limit", () => {
      const { status, stderr } = run(["sessions", "-n", "abc"]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("positive integer");
    });

    it("rejects a non-positive --limit", () => {
      const { status, stderr } = run(["sessions", "-n", "0"]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("positive integer");
    });
  });

  describe(`${fx.binName} view`, () => {
    it("shows prompts and outputs, skipping tool/thinking messages", () => {
      const { status, stdout } = run(["view", "alpha"]);
      expect(status).toBe(0);
      expect(stdout).toContain(`Hello ${fx.name}`);
      expect(stdout).toContain("Hi there");
      expect(stdout).not.toContain("tool out");
      expect(stdout).not.toContain("private");
    });

    it("surfaces the session header with id, name and dir", () => {
      const { stdout } = run(["view", "alpha"]);
      expect(stdout).toContain("alpha");
      expect(stdout).toContain("Alpha Session");
      expect(stdout).toContain("/tmp/alpha");
      assertViewHeader?.(stdout);
    });

    it("exits non-zero for an unknown session", () => {
      const { status } = run(["view", "no-such-session"]);
      expect(status).not.toBe(0);
    });
  });

  describe(`${fx.binName} config`, () => {
    let cfgPath: string;

    beforeAll(() => {
      cfgPath = join(cfgDir(), "config.db");
    });

    it("lists known keys with empty values when the database is absent", () => {
      const { status, stdout } = run(["config", "list"], {
        GLV_CONFIG_DB: cfgPath,
      });
      expect(status).toBe(0);
      expect(stdout).toContain("forwardHost=");
    });

    it("sets a field then reads it back", () => {
      run(["config", "set", "forwardHost", "203.0.113.5"], {
        GLV_CONFIG_DB: cfgPath,
      });
      const { stdout } = run(["config", "get", "forwardHost"], {
        GLV_CONFIG_DB: cfgPath,
      });
      expect(stdout.trim()).toBe("203.0.113.5");
    });

    it("exits non-zero for an unknown key", () => {
      const { status, stderr } = run(["config", "get", "bogus"], {
        GLV_CONFIG_DB: cfgPath,
      });
      expect(status).not.toBe(0);
      expect(stderr).toContain("Unknown config key");
    });

    it("tolerates unknown keys stored in the database when re-listing", () => {
      // A row the CLI never knew about (a future key, or one a migrated
      // file once carried) stays listed — the listing is honest about
      // every row the table holds.
      seedConfigRow(cfgPath, "future", "true");
      const { stdout } = run(["config", "list"], { GLV_CONFIG_DB: cfgPath });
      expect(stdout).toContain("future=true");
      expect(stdout).toContain("forwardHost=203.0.113.5");
    });

    it("refuses cronJobs as a settable key — it is not config anymore", () => {
      const { status, stderr } = run(["config", "set", "cronJobs", "[]"], {
        GLV_CONFIG_DB: cfgPath,
      });
      expect(status).not.toBe(0);
      expect(stderr).toContain("Unknown config key");
    });
  });

  describe(`${fx.binName} serve argument validation`, () => {
    it("rejects a non-positive --max-concurrent", () => {
      const { status, stderr } = run(["serve", "--max-concurrent", "0"]);
      expect(status).not.toBe(0);
      expect(stderr.toLowerCase()).toContain("positive integer");
    });

    it("rejects a non-numeric --max-concurrent", () => {
      const { status, stderr } = run(["serve", "--max-concurrent", "abc"]);
      expect(status).not.toBe(0);
      expect(stderr.toLowerCase()).toContain("positive integer");
    });

    it("rejects a binary path that does not exist", () => {
      const { status, stderr } = run([
        "serve",
        fx.binaryFlag,
        "/no/such/binary",
      ]);
      expect(status).not.toBe(0);
      expect(stderr.toLowerCase()).toContain("not found");
    });

    it("refuses --forward when no forwardHost is configured", () => {
      // The host is resolved from the config database during serve
      // boot, so an empty database refuses the flag with the command
      // that would fix it. A fake home keeps every store this boot
      // opens off the real profile.
      const { status, stderr } = run(
        ["serve", "--forward", fx.binaryFlag, process.execPath],
        {
          ...fakeHomeEnv(cfgDir()),
          GLV_CONFIG_DB: join(cfgDir(), "forward.db"),
        },
      );
      expect(status).not.toBe(0);
      expect(stderr).toContain("config set forwardHost");
    });

    it("documents the --forward flag in help", () => {
      const { stdout } = run(["serve", "--help"]);
      expect(stdout).toContain("--forward");
    });
  });
};

export type { CliDeps, RunCli, RunResult };
export { makeRunner, runCliSuite };
