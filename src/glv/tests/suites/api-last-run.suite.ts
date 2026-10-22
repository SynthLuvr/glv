import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  type MockConfig,
  seedApiToken,
} from "../harness.js";

// The last-run verdict over real HTTP (#340): a run leaving the active
// list used to be indistinguishable from a successful finish — a
// usage-limit refusal (goose prints it and exits 0), a crash exit, and a
// startup-watchdog kill all read as "session went idle". The session
// rows the read API returns now carry `last_run`, the persisted verdict
// of the most recent settled run (finished/stopped/stopped_early/
// failed), surviving the run handle's ~30 s registry window and a
// server restart. Four environments hold the four behaviours (scripted
// lines file re-read per run, crash exit, long-lived run for a manual
// stop, silent start for the watchdog) because the mock's behaviour is
// fixed per environment.

type LastRun = { state: string; reason?: string; ended_at: string };

type SessionRow = { id: string; status: string; last_run?: LastRun };

type RunAccepted = { id: string; status: string };

// One mock environment bound to the API token that speaks for it.
type LastRunClient = { env: IntegrationEnv; token: string };

const runApiLastRunSuite = (fx: FlavorFixture): void => {
  let main: LastRunClient;
  let crash: LastRunClient;
  let slow: LastRunClient;
  let stall: LastRunClient;
  let linesDir: string;

  const linesFileFor = (name: string): string => join(linesDir, name);

  const writeLines = (name: string, lines: readonly string[]): string => {
    const path = linesFileFor(name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  };

  const startClient = async (
    prefix: string,
    mock: MockConfig = {},
    extraEnv?: Record<string, string>,
  ): Promise<LastRunClient> => {
    const env = await fx.startEnv(prefix, mock, undefined, extraEnv);
    return { env, token: seedApiToken(env.dbs.authDb, "api-last-run") };
  };

  const fetchApi = (
    client: LastRunClient,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => bearerFetch(client.env, path, client.token, init);

  // Follow-up runs spawn the agent in the session's working dir, so the
  // dir must exist or the spawn rejects and the run errors immediately.
  const ensureDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  };

  const seedSession = (client: LastRunClient, id: string, name: string) => {
    const workingDir = join(client.env.scratchDir, "w");
    ensureDir(workingDir);
    fx.seedSessions(client.env, [{ id, name, workingDir }]);
    fx.seedMessages(client.env, id, [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  };

  const sessionOf = async (
    client: LastRunClient,
    id: string,
  ): Promise<SessionRow> => {
    const res = await fetchApi(client, `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: SessionRow };
    return body.session;
  };

  // Polls the detail endpoint until the last-run verdict lands in
  // `want`; the row is written the moment the run settles, which races
  // the agent process.
  const waitForLastRun = async (
    client: LastRunClient,
    id: string,
    want: readonly string[],
  ): Promise<LastRun> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const session = await sessionOf(client, id);
      if (
        session.last_run !== undefined &&
        want.includes(session.last_run.state)
      )
        return session.last_run;
      if (Date.now() > deadline) {
        const seen =
          session.last_run === undefined ? "none" : session.last_run.state;
        throw new Error(
          `last_run of ${id} stayed "${seen}"; wanted one of ` + want.join("/"),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  // The session status, for tests that need to observe the live window
  // (e.g. "running" before a manual stop).
  const waitForStatus = async (
    client: LastRunClient,
    id: string,
    want: readonly string[],
  ): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const status = (await sessionOf(client, id)).status;
      if (want.includes(status)) return status;
      if (Date.now() > deadline)
        throw new Error(
          `status of ${id} stayed "${status}"; wanted one of ` + want.join("/"),
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const postPrompt = (
    client: LastRunClient,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    fetchApi(client, `/api/sessions/${id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  // A settled verdict worth asserting on: parseable instant, recent
  // (the run settled during this suite), and no reason where none
  // belongs.
  const expectSettled = (
    lastRun: LastRun,
    state: string,
    reason: boolean,
  ): void => {
    expect(lastRun.state).toBe(state);
    expect(reason ? "reason" in lastRun : !("reason" in lastRun)).toBe(true);
    const at = Date.parse(lastRun.ended_at);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThan(Date.now() - 120000);
  };

  beforeAll(async () => {
    linesDir = mkdtempSync(join(tmpdir(), "glv-last-run-"));
    writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
    main = await startClient("glv-apilr-", {
      linesFile: linesFileFor("main.txt"),
    });
    crash = await startClient("glv-apilr-crash-", { exitCode: 1 });
    slow = await startClient("glv-apilr-slow-", { sleepMs: 30000 });
    // A start that says nothing and lives on: the startup watchdog
    // (deadline shrunk from the 300 s default) fails and kills it.
    stall = await startClient(
      "glv-apilr-stall-",
      { behaviour: { delayMs: 45_000 } },
      { GLV_STARTUP_TIMEOUT_MS: "2500" },
    );
    for (const client of [main, crash, stall])
      seedSession(client, "lr-1", "Last Run One");
    seedSession(main, "lr-fresh", "Never Ran");
  }, 240000);

  afterAll(async () => {
    await main?.env.cleanup();
    await crash?.env.cleanup();
    await slow?.env.cleanup();
    await stall?.env.cleanup();
    rmSync(linesDir, { recursive: true, force: true });
  });

  describe("GET /api/sessions/:id last_run", () => {
    it("omits last_run on a session that never ran", async () => {
      const session = await sessionOf(main, fx.viewId("lr-fresh"));
      expect("last_run" in session).toBe(false);
    });

    it("reports finished after a clean run", async () => {
      const id = fx.viewId("lr-1");
      const res = await postPrompt(main, id, "finish me please");
      expect(res.status).toBe(200);
      expectSettled(
        await waitForLastRun(main, id, ["finished"]),
        "finished",
        false,
      );
    });

    it("reports stopped_early with the provider's own words after a usage-limit refusal (exit 0)", async () => {
      writeLines("main.txt", [
        fx.refusalRecord(
          "Rate limit exceeded: usage limit reached. Your quota resets at 17:01.",
        ),
      ]);
      const id = fx.viewId("lr-1");
      await postPrompt(main, id, "hit the limit please");
      const lastRun = await waitForLastRun(main, id, ["stopped_early"]);
      expect(lastRun.reason).toContain("usage limit reached");
      expect(lastRun.reason).toContain("resets at 17:01");
    });

    it("reports failed with the crash verdict after a non-zero exit", async () => {
      const id = fx.viewId("lr-1");
      const res = await postPrompt(crash, id, "crash please");
      expect(res.status).toBe(200);
      const lastRun = await waitForLastRun(crash, id, ["failed"]);
      expect(lastRun.reason).toContain("exited with code 1");
    });

    it("reports failed with the watchdog verdict after a silent start", async () => {
      const id = fx.viewId("lr-1");
      const res = await postPrompt(stall, id, "say nothing please");
      expect(res.status).toBe(200);
      const lastRun = await waitForLastRun(stall, id, ["failed"]);
      expect(lastRun.reason).toContain("produced no output");
      expect(lastRun.reason).toContain("was killed");
    });

    it("reports stopped after a requested stop", async () => {
      const form = new FormData();
      form.append("prompt", "run long enough to stop");
      form.append("working_dir", slow.env.scratchDir);
      const created = await fetchApi(slow, "/api/sessions", {
        method: "POST",
        body: form,
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as RunAccepted;
      expect(await waitForStatus(slow, id, ["running"])).toBe("running");
      const stop = await fetchApi(slow, `/api/sessions/${id}/stop`, {
        method: "POST",
      });
      expect(stop.status).toBe(200);
      expect(await waitForStatus(slow, id, ["stopped"])).toBe("stopped");
      expectSettled(
        await waitForLastRun(slow, id, ["stopped"]),
        "stopped",
        false,
      );
    });

    it("keeps the verdicts across a server restart, after the registry window", async () => {
      await main.env.restart();
      const finished = await sessionOf(main, fx.viewId("lr-fresh"));
      expect("last_run" in finished).toBe(false);
      // lr-1 refused service before the restart: the verdict outlives
      // the run handle, so status reads idle while last_run still
      // explains the stop — the exact case an orchestration loop needs.
      const refused = await sessionOf(main, fx.viewId("lr-1"));
      expect(refused.status).toBe("idle");
      expect(refused.last_run?.state).toBe("stopped_early");
      expect(refused.last_run?.reason).toContain("resets at 17:01");
    });

    it("re-records the verdict when a stopped-early session continues and finishes", async () => {
      writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
      const id = fx.viewId("lr-1");
      await postPrompt(main, id, "continue please");
      expectSettled(
        await waitForLastRun(main, id, ["finished"]),
        "finished",
        false,
      );
    });
  });

  describe("GET /api/sessions last_run", () => {
    it("decorates listing rows with the settled verdict", async () => {
      const res = await fetchApi(main, "/api/sessions");
      expect(res.status).toBe(200);
      const rows = (await res.json()) as SessionRow[];
      expect(rows.length).toBeGreaterThan(0);
      const settled = rows.find((row) => row.id === fx.viewId("lr-1"));
      expect(settled?.last_run?.state).toBe("finished");
      const fresh = rows.find((row) => row.id === fx.viewId("lr-fresh"));
      expect(fresh === undefined || !("last_run" in fresh)).toBe(true);
    });
  });

  describe("GET /api/openapi.json", () => {
    it("documents last_run on the Session schema and a LastRun component", async () => {
      const res = await fetchApi(main, "/api/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, { enum?: string[] }> }
          >;
        };
      };
      const session = doc.components.schemas.Session?.properties;
      expect(session?.last_run).toBeDefined();
      const lastRun = doc.components.schemas.LastRun?.properties;
      expect(lastRun?.state?.enum).toEqual([
        "failed",
        "finished",
        "stopped",
        "stopped_early",
      ]);
      expect(lastRun?.ended_at).toBeDefined();
      expect(lastRun?.reason).toBeDefined();
    });
  });
};

export { runApiLastRunSuite };
