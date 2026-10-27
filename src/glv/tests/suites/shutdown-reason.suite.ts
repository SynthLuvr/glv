import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// #379: a teardown stopAll() used to write the verdict `stopped` with
// no reason — indistinguishable from a user stop, which cost real
// diagnosis time after a systemd OOM-kill tore the unit down. The
// shutdown path now threads a reason into the last_run sidecar, so a
// teardown stop says so. (A user stop still records no reason: the
// api-last-run suite pins that.)
//
// POSIX-only (see WINDOWS_EXCLUDED_SUITES in vitest.config.ts): the
// harness stops the serve process with SIGTERM, which on Windows is an
// unconditional TerminateProcess — the exit handlers this suite depends
// on never run.
const runShutdownReasonSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token: string;

  const fetchApi = (path: string, init: RequestInit = {}): Promise<Response> =>
    bearerFetch(env, path, token, init);

  const sessionOf = async (id: string) => {
    const res = await fetchApi(`/api/sessions/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: Record<string, unknown> };
    return body.session;
  };

  // Polls the session row until its status is `want`.
  const waitForStatus = async (id: string, want: string): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const status = (await sessionOf(id)).status;
      if (status === want) return status;
      if (Date.now() > deadline)
        throw new Error(
          `status of ${id} stayed "${String(status)}"; wanted ${want}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    // A slow agent: the run is still mid-flight when the server stops.
    env = await fx.startEnv("glv-shutdown-", { sleepMs: 30000 });
    token = seedApiToken(env.dbs.authDb, "shutdown-reason");
    const workingDir = join(env.scratchDir, "w");
    mkdirSync(workingDir, { recursive: true });
    fx.seedSessions(env, [{ id: "shut-1", name: "Shutdown", workingDir }]);
    fx.seedMessages(env, "shut-1", [
      { role: "user", content: [{ type: "text", text: "seed" }] },
    ]);
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("server shutdown verdicts", () => {
    it(`records why ${fx.name} runs were stopped when the server shuts down mid-run`, async () => {
      const id = fx.viewId("shut-1");
      const res = await fetchApi(`/api/sessions/${id}/prompt`, {
        method: "POST",
        body: new URLSearchParams({
          prompt: "run long enough to be torn down",
        }),
      });
      expect(res.status).toBe(200);
      await waitForStatus(id, "running");

      // SIGTERM, the same path systemd's unit teardown takes.
      await env.restart();

      // The fresh registry holds no handle, so the session reads idle —
      // only the persisted verdict can explain how the run ended.
      const session = await sessionOf(id);
      expect(session.status).toBe("idle");
      const lastRun = session.last_run as
        | { state: string; reason?: string }
        | undefined;
      expect(lastRun?.state).toBe("stopped");
      expect(lastRun?.reason).toBe("server shutdown");
    }, 60000);
  });
};

export { runShutdownReasonSuite };
