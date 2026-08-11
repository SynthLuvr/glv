import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  startIntegrationEnv,
} from "./integration-harness";

let env: IntegrationEnv;
let childPidFile: string;
let trackedChildPid = 0;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

// Signal 0 probes liveness without actually delivering a signal.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startRun = (
  e: IntegrationEnv,
  id: string,
  prompt: string,
): Promise<Response> =>
  authedFetch(e, "/sessions/" + id + "/prompt", {
    method: "POST",
    body: new URLSearchParams({ prompt }),
    headers: { "HX-Request": "true" },
  });

beforeAll(async () => {
  // The descendant PID file must be decided before the server starts so its
  // path can be handed to the mock goose via GOOSE_MOCK_SPAWN_CHILD. A long
  // sleep keeps goose alive long enough to stop it mid-run.
  childPidFile = join(
    tmpdir(),
    `glv-child-${randomBytes(6).toString("hex")}.pid`,
  );
  env = await startIntegrationEnv("glv-stop-tree-", {
    sleepMs: 30000,
    spawnChild: childPidFile,
  });
  ensureDir(env.scratchDir + "/d");
  insertSessions(env.dbs.sessionsDb, [
    { id: "tree-1", name: "Tree Kill", workingDir: env.scratchDir + "/d" },
  ]);
  insertMessages(env.dbs.sessionsDb, "tree-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
}, 120000);

afterAll(async () => {
  // Best-effort: don't leak the descendant if the assertion bailed before stop.
  if (trackedChildPid !== 0 && isAlive(trackedChildPid))
    process.kill(trackedChildPid, "SIGKILL");
  await env?.cleanup();
});

describe("session stop reaps the whole process tree", () => {
  it("kills a descendant spawned by goose when the session is stopped", async () => {
    await startRun(env, "tree-1", "spawn a child please");

    // The mock goose writes its descendant's PID to the file before sleeping.
    let pid = 0;
    const writeDeadline = Date.now() + 10000;
    while (Date.now() < writeDeadline) {
      try {
        pid = Number(readFileSync(childPidFile, "utf8").trim());
      } catch {
        pid = 0;
      }
      if (pid > 0) break;
      await delay(100);
    }
    expect(pid).toBeGreaterThan(0);
    trackedChildPid = pid;

    // Sanity: the descendant is alive while goose is running.
    expect(isAlive(pid)).toBe(true);

    const res = await authedFetch(env, "/sessions/tree-1/stop", {
      method: "POST",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);

    // stop() sends SIGINT to goose's whole process tree via killDescendants,
    // so the descendant dies even though only goose was spawned directly. A
    // plain kill of the goose process alone would orphan and spare it.
    const killDeadline = Date.now() + 8000;
    while (Date.now() < killDeadline && isAlive(pid)) await delay(100);
    expect(isAlive(pid)).toBe(false);
  }, 30000);
});
