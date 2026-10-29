import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { mockBin } from "type-a-bin";
import { afterAll, beforeAll, describe, it } from "vitest";
import { RUN_SCOPE_PREFIX } from "../../runner/index.js";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
  waitForFile,
} from "../harness.js";

// The per-run memory ceiling (#392) end-to-end over real HTTP: with a
// ceiling configured, every agent invocation spawns inside its own
// `systemd-run --user --scope` unit — named glv-run-<run id>, so journal
// OOM records attribute — with MemoryMax (and MemorySwapMax=0) set, and
// the unit lands in the settled-run history. A shimmed systemd-run on
// PATH (a real script standing in for a real binary, the harness's only
// mock) makes the wrapped path deterministic on hosts without a user
// systemd; the disabled path (the test harness pins
// GLV_RUN_MEMORY_MAX=off) falls back to a direct spawn with a logged
// warning.

const fakeSystemdRunPath = fileURLToPath(
  new URL("../fake-systemd-run.ts", import.meta.url),
);

// The argv flag that names the scope unit; a run scope is one whose unit
// starts with the glv-run- prefix (the availability probe's line has no
// --unit at all).
const UNIT_ARG = "--unit=";
const isRunUnitArg = (arg: string): boolean =>
  arg.startsWith(`${UNIT_ARG}${RUN_SCOPE_PREFIX}`);

type RunEntry = {
  state: string;
  reason?: string;
  started_at?: string;
  ended_at: string;
  scope_unit?: string;
};

type RunHistory = { id: string; runs: RunEntry[] };

// One shimmed environment: the booted server, an API token, and the
// shim's invocation log (one JSON argv per line, probe included).
type ScopeEnv = {
  env: IntegrationEnv;
  token: string;
  logPath: string;
  restoreShim: () => void;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// One shimmed invocation line: the argv systemd-run received.
const invocationArgs = (line: string): string[] => {
  const parsed: unknown = JSON.parse(line);
  return Array.isArray(parsed) && parsed.every((a) => typeof a === "string")
    ? parsed
    : [];
};

const shimInvocations = async (scope: ScopeEnv): Promise<string[][]> =>
  (await waitForFile(scope.logPath))
    .split("\n")
    .filter((line) => line !== "")
    .map(invocationArgs);

// The invocation lines that carried a run scope — the availability
// probe's line has no --unit. The last one belongs to the most
// recently settled session.
const scopeInvocations = (lines: readonly string[][]): string[][] =>
  lines.filter((argv) => argv.some(isRunUnitArg));

// The full unit name (`glv-run-<run id>`) — the same string the run
// history records.
const unitOf = (argv: readonly string[]): string | undefined =>
  argv.find(isRunUnitArg)?.slice(UNIT_ARG.length);

// Starts a session over the JSON API exactly as a script would, with
// the given extra form fields (memory_max for the override tests).
const startSession = async (
  env: IntegrationEnv,
  token: string,
  fields: Record<string, string> = {},
): Promise<string> => {
  const workingDir = join(env.scratchDir, "w");
  mkdirSync(workingDir, { recursive: true });
  const res = await bearerFetch(env, "/api/sessions", token, {
    method: "POST",
    body: new URLSearchParams({
      prompt: "memory scope test",
      working_dir: workingDir,
      ...fields,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
};

// The wait endpoint parks until the run settles; the loop only guards
// a deadline the endpoint's own default may not reach.
const waitSettled = async (
  env: IntegrationEnv,
  token: string,
  id: string,
): Promise<string> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await bearerFetch(env, `/api/sessions/${id}/wait`, token);
    expect(res.status).toBe(200);
    const { status } = (await res.json()) as { status: string };
    if (status !== "queued" && status !== "running") return status;
    if (Date.now() > deadline) throw new Error("run never settled");
    await sleep(100);
  }
};

const historyOf = async (
  env: IntegrationEnv,
  token: string,
  id: string,
): Promise<RunHistory> => {
  const res = await bearerFetch(env, `/api/sessions/${id}/runs`, token);
  expect(res.status).toBe(200);
  return (await res.json()) as RunHistory;
};

const runScopeSuite = (fx: FlavorFixture): void => {
  const startScopeEnv = async (
    prefix: string,
    extraEnv: Record<string, string>,
  ): Promise<ScopeEnv> => {
    const logDir = mkdtempSync(join(tmpdir(), `${prefix}log-`));
    const restoreShim = await mockBin("systemd-run", {
      file: fakeSystemdRunPath,
    });
    try {
      const env = await fx.startEnv(prefix, undefined, undefined, {
        GLV_FAKE_SYSTEMD_RUN_LOG: join(logDir, "invocations.log"),
        ...extraEnv,
      });
      return {
        env,
        token: seedApiToken(env.dbs.authDb, "run-scope"),
        logPath: join(logDir, "invocations.log"),
        restoreShim,
      };
    } catch (err) {
      restoreShim();
      rmSync(logDir, { recursive: true, force: true });
      throw err;
    }
  };

  describe("with the ceiling on (shimmed systemd-run)", () => {
    let scope: ScopeEnv;

    beforeAll(async () => {
      scope = await startScopeEnv("glv-scope-on-", {
        GLV_RUN_MEMORY_MAX: "512M",
      });
    });

    afterAll(async () => {
      await scope.env.cleanup();
      scope.restoreShim();
    });

    it("spawns each run in its own glv-run scope with MemoryMax and no swap", async () => {
      const id = await startSession(scope.env, scope.token);
      expect(await waitSettled(scope.env, scope.token, id)).toBe("completed");

      const invocations = scopeInvocations(await shimInvocations(scope));
      expect(invocations.length).toBe(1);
      const run = invocations[0];
      if (run === undefined) return;
      for (const flag of ["--user", "--scope", "--quiet"])
        expect(run).toContain(flag);
      expect(run).toContain("MemoryMax=512M");
      expect(run).toContain("MemorySwapMax=0");
      // The agent command rides after --, unchanged.
      const commandAt = run.indexOf("--") + 1;
      expect(commandAt).toBeGreaterThan(0);
      expect(run[commandAt]).toBe(fx.name);
      // A per-invocation unit name: journal attribution (#392).
      expect(unitOf(run)).toMatch(
        new RegExp(`^${RUN_SCOPE_PREFIX}[0-9a-f-]{36}$`),
      );
    });

    it("records the scope unit in the run's history entry", async () => {
      const id = await startSession(scope.env, scope.token);
      await waitSettled(scope.env, scope.token, id);
      const history = await historyOf(scope.env, scope.token, id);
      const entry = history.runs.at(-1);
      expect(entry?.state).toBe("finished");
      const invocations = scopeInvocations(await shimInvocations(scope));
      expect(entry?.scope_unit).toBe(unitOf(invocations.at(-1) ?? []));
    });

    it("lets a submit override the ceiling for its own run", async () => {
      const id = await startSession(scope.env, scope.token, {
        memory_max: "64M",
      });
      expect(await waitSettled(scope.env, scope.token, id)).toBe("completed");
      const overrides = (await shimInvocations(scope)).filter((argv) =>
        argv.includes("MemoryMax=64M"),
      );
      expect(overrides.length).toBe(1);
      expect(unitOf(overrides[0] ?? [])).toMatch(
        new RegExp(`^${RUN_SCOPE_PREFIX}`),
      );
    });

    it("rejects a malformed memory_max with 422", async () => {
      const res = await bearerFetch(scope.env, "/api/sessions", scope.token, {
        method: "POST",
        body: new URLSearchParams({
          prompt: "bad limit",
          working_dir: join(scope.env.scratchDir, "w"),
          memory_max: "lots",
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("memory limit");
    });
  });

  describe("with the ceiling off", () => {
    let env: IntegrationEnv;
    let token: string;

    beforeAll(async () => {
      // No shim and no GLV_RUN_MEMORY_MAX: the harness's default pin
      // disables the ceiling — the direct-spawn fallback on every host.
      env = await fx.startEnv("glv-scope-off-");
      token = seedApiToken(env.dbs.authDb, "run-scope-off");
    });

    afterAll(async () => {
      await env.cleanup();
    });

    it("spawns directly, warns once, and records no scope in history", async () => {
      const id = await startSession(env, token);
      expect(await waitSettled(env, token, id)).toBe("completed");

      // The fallback is announced once, and no scope was used.
      expect(env.serverStderr()).toContain(
        "per-run memory ceiling is disabled",
      );
      expect(env.serverStdout()).not.toContain(", scope glv-run-");

      const history = await historyOf(env, token, id);
      expect(history.runs.at(-1)?.scope_unit).toBeUndefined();
    });
  });
};

export { runScopeSuite };
