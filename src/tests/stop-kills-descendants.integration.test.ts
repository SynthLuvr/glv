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

// Signal 0 probes liveness without actually delivering a signal.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startRun = (prompt: string): Promise<Response> =>
  authedFetch(env, "/sessions/tree-1/prompt", {
    method: "POST",
    body: new URLSearchParams({ prompt }),
    headers: { "HX-Request": "true" },
  });

beforeAll(async () => {
  childPidFile = join(
    tmpdir(),
    `glv-child-${randomBytes(6).toString("hex")}.pid`,
  );
  env = await startIntegrationEnv("glv-stop-tree-", {
    sleepMs: 30000,
    spawnChild: childPidFile,
  });
  const workingDir = join(env.scratchDir, "d");
  mkdirSync(workingDir, { recursive: true });
  insertSessions(env.dbs.projectsDir, [
    { id: "tree-1", name: "Tree Kill", workingDir },
  ]);
  insertMessages(env.dbs.projectsDir, "tree-1", [
    { role: "user", content: [{ type: "text", text: "seed" }] },
  ]);
}, 120000);

afterAll(async () => {
  // Don't leak the descendant if the test bailed before stop.
  if (trackedChildPid !== 0 && isAlive(trackedChildPid))
    process.kill(trackedChildPid, "SIGKILL");
  await env?.cleanup();
});

describe("session stop reaps the whole process tree", () => {
  it("kills a descendant spawned by claude when the session is stopped", async () => {
    await startRun("spawn a child please");

    // The mock writes the descendant's PID before sleeping, so poll for it.
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
    expect(isAlive(pid)).toBe(true);

    const res = await authedFetch(env, "/sessions/tree-1/stop", {
      method: "POST",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);

    // killDescendants reaps the whole tree, so the orphaned descendant dies.
    const killDeadline = Date.now() + 8000;
    while (Date.now() < killDeadline && isAlive(pid)) await delay(100);
    expect(isAlive(pid)).toBe(false);
  }, 30000);
});
