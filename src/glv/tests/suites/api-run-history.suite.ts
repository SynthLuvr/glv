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

// The settled-run history over real HTTP (#384): last_run is a
// PRIMARY KEY (session_id) upsert, so every settle overwrote the
// verdict before it and a clean settle cleared the stop notice — after
// an orchestrator loop's two silent stalls were followed by successful
// runs, glv's own data could no longer say the stalls happened at all.
// The stop-notices sidecar now appends one row per settled run (capped
// at the newest 20 per session), and GET /api/sessions/:id/runs
// returns them oldest-first. The suites here hold the accumulation
// (the point of the issue), the stop dedupe (a stop notifies twice —
// at the request and at the exit — but is one run), the cap, and the
// restart survival. Three environments hold the mock behaviours
// (scripted lines file re-read per run, long-lived run, crash exit)
// because the mock's sleep and exit code are fixed per environment.

type RunEntry = {
  state: string;
  reason?: string;
  started_at?: string;
  ended_at: string;
};

type RunHistory = { id: string; runs: RunEntry[] };

// One mock environment bound to the API token that speaks for it, so
// a helper can never pair one env's server with another env's token.
type HistoryClient = { env: IntegrationEnv; token: string };

const runApiRunHistorySuite = (fx: FlavorFixture): void => {
  let main: HistoryClient;
  let slow: HistoryClient;
  let crash: HistoryClient;
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
  ): Promise<HistoryClient> => {
    const env = await fx.startEnv(prefix, mock);
    return { env, token: seedApiToken(env.dbs.authDb, "api-run-history") };
  };

  const fetchApi = (
    client: HistoryClient,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => bearerFetch(client.env, path, client.token, init);

  // Follow-up runs spawn the agent in the session's working dir, so the
  // dir must exist or the spawn rejects and the run errors immediately.
  const ensureDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  };

  const seedSession = (client: HistoryClient, id: string, name: string) => {
    const workingDir = join(client.env.scratchDir, "w");
    ensureDir(workingDir);
    fx.seedSessions(client.env, [{ id, name, workingDir }]);
    fx.seedMessages(client.env, id, [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  };

  const historyOf = async (
    client: HistoryClient,
    id: string,
  ): Promise<RunHistory> => {
    const res = await fetchApi(client, `/api/sessions/${id}/runs`);
    expect(res.status).toBe(200);
    return (await res.json()) as RunHistory;
  };

  const postPrompt = (
    client: HistoryClient,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    fetchApi(client, `/api/sessions/${id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  // One prompt driven to settle: the wait primitive parks until the
  // run settles, so the history assertion that follows never races the
  // agent process.
  const runAndSettle = async (
    client: HistoryClient,
    id: string,
    prompt: string,
    want: readonly string[],
  ): Promise<void> => {
    const res = await postPrompt(client, id, prompt);
    expect(res.status).toBe(200);
    const deadline = Date.now() + 30000;
    for (;;) {
      const wait = await fetchApi(client, `/api/sessions/${id}/wait`);
      const body = (await wait.json()) as { status: string };
      if (body.status === "running" || body.status === "queued") {
        if (Date.now() > deadline) throw new Error(`run never settled`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      expect(want, `settled as ${body.status}`).toContain(body.status);
      return;
    }
  };

  // A settled entry worth asserting on: parseable instants, the run
  // spanning this suite, and no reason where none belongs.
  const expectEntry = (
    entry: RunEntry,
    state: string,
    reason: boolean,
  ): void => {
    expect(entry.state).toBe(state);
    expect(reason ? "reason" in entry : !("reason" in entry)).toBe(true);
    const ended = Date.parse(entry.ended_at);
    expect(Number.isNaN(ended)).toBe(false);
    expect(ended).toBeGreaterThan(Date.now() - 300000);
    if (entry.started_at !== undefined) {
      const started = Date.parse(entry.started_at);
      expect(Number.isNaN(started)).toBe(false);
      expect(started).toBeLessThanOrEqual(ended);
    } else {
      // A run that began executing always knows when it started; only
      // a queued-then-stopped run may omit it, and no entry here is
      // one (this suite never stops a queued run).
      throw new Error(`entry of ${state} carries no started_at`);
    }
  };

  beforeAll(async () => {
    linesDir = mkdtempSync(join(tmpdir(), "glv-run-history-"));
    writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
    main = await startClient("glv-apirh-", {
      linesFile: linesFileFor("main.txt"),
    });
    slow = await startClient("glv-apirh-slow-", { sleepMs: 30000 });
    crash = await startClient("glv-apirh-crash-", { exitCode: 1 });
    seedSession(main, "rh-1", "Run History One");
    seedSession(main, "rh-fresh", "Never Ran");
    seedSession(crash, "rh-crash", "Run History Crash");
  }, 240000);

  afterAll(async () => {
    await main?.env.cleanup();
    await slow?.env.cleanup();
    await crash?.env.cleanup();
    rmSync(linesDir, { recursive: true, force: true });
  });

  describe("GET /api/sessions/:id/runs", () => {
    it("answers an empty runs array for a session that never ran", async () => {
      const body = await historyOf(main, fx.viewId("rh-fresh"));
      expect(body.id).toBe(fx.viewId("rh-fresh"));
      expect(body.runs).toEqual([]);
    });

    it("answers 404 for an unknown session", async () => {
      const res = await fetchApi(main, "/api/sessions/goose:nonexistent/runs");
      expect(res.status).toBe(404);
    });

    it("appends verdicts instead of overwriting them (the #384 loss)", async () => {
      const id = fx.viewId("rh-1");
      // One refused run, then one clean run — the exact Oct 27 shape:
      // the refusal used to be erased by the later success.
      writeLines("main.txt", [
        fx.refusalRecord("Rate limit exceeded: usage limit reached."),
      ]);
      await runAndSettle(main, id, "hit the limit please", [
        "error",
        "stopped",
      ]);
      writeLines("main.txt", [fx.streamLine(fx.mockReply)]);
      await runAndSettle(main, id, "continue please", ["completed"]);
      const { runs } = await historyOf(main, id);
      expect(runs.length).toBe(2);
      expectEntry(runs[0] as RunEntry, "stopped_early", true);
      expect((runs[0] as RunEntry).reason).toContain("usage limit reached");
      expectEntry(runs[1] as RunEntry, "finished", false);
    });

    it("records a crash verdict with its reason", async () => {
      const id = fx.viewId("rh-crash");
      await runAndSettle(crash, id, "crash please", ["error"]);
      const { runs } = await historyOf(crash, id);
      expect(runs.length).toBe(1);
      expectEntry(runs[0] as RunEntry, "failed", true);
      expect((runs[0] as RunEntry).reason).toContain("exited with code 1");
    });

    it("counts a stopped run once, not once per notification", async () => {
      // A stop notifies the observer twice — at the stop request and
      // again at the process exit — and both notifications carry the
      // same run id, so the history must hold exactly one row.
      const form = new FormData();
      form.append("prompt", "run long enough to stop");
      form.append("working_dir", slow.env.scratchDir);
      const created = await fetchApi(slow, "/api/sessions", {
        method: "POST",
        body: form,
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      // timeout=0 snapshots the status without parking — the slow mock
      // would otherwise hold every wait for its full 30 s deadline.
      const snapshot = async (): Promise<string> => {
        const res = await fetchApi(slow, `/api/sessions/${id}/wait?timeout=0`);
        return ((await res.json()) as { status: string }).status;
      };
      const deadline = Date.now() + 30000;
      for (;;) {
        const status = await snapshot();
        if (status === "stopped") break;
        if (status === "running") {
          const res = await fetchApi(slow, `/api/sessions/${id}/stop`, {
            method: "POST",
          });
          expect(res.status).toBe(200);
        }
        if (Date.now() > deadline)
          throw new Error(`run never stopped (last status: ${status})`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const { runs } = await historyOf(slow, id);
      expect(runs.length).toBe(1);
      expectEntry(runs[0] as RunEntry, "stopped", false);
    });

    it("keeps the history across a server restart", async () => {
      await main.env.restart();
      const body = await historyOf(main, fx.viewId("rh-1"));
      expect(body.runs.length).toBe(2);
      expectEntry(body.runs[0] as RunEntry, "stopped_early", true);
      expectEntry(body.runs[1] as RunEntry, "finished", false);
    });

    it("caps the history at the newest 20 runs per session", async () => {
      const id = fx.viewId("rh-1");
      // The two entries above age out: 21 further runs push past the
      // cap, so the answer keeps exactly the newest 20 — all finished,
      // the two early entries gone.
      for (let i = 0; i < 21; i++)
        await runAndSettle(main, id, `cap run ${i}`, ["completed"]);
      const { runs } = await historyOf(main, id);
      expect(runs.length).toBe(20);
      for (const entry of runs) expectEntry(entry, "finished", false);
    }, 110000);
  });

  describe("GET /api/openapi.json", () => {
    it("documents the runs path and its entry component", async () => {
      const res = await fetchApi(main, "/api/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, { enum?: string[] }> }
          >;
        };
        paths: Record<
          string,
          { get?: { responses?: Record<string, unknown> } }
        >;
      };
      const runs = doc.paths["/api/sessions/{id}/runs"]?.get;
      expect(runs?.responses?.["200"]).toBeDefined();
      const entry = doc.components.schemas.RunHistoryEntry?.properties;
      expect(entry?.state?.enum).toEqual([
        "failed",
        "finished",
        "stopped",
        "stopped_early",
      ]);
      expect(entry?.started_at).toBeDefined();
      expect(entry?.ended_at).toBeDefined();
      expect(entry?.reason).toBeDefined();
    });
  });
};

export { runApiRunHistorySuite };
