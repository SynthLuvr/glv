import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authedFetch } from "../../glv/tests/harness.js";
import {
  currentServeEntries,
  killRegisteredServes,
  listHarnessServeProcesses,
  sweepOrphanedServes,
  sweepStaleServes,
  workerServeRegistryFile,
} from "../../glv/tests/serve-registry.js";
import { startIntegrationEnv } from "./integration-harness.js";

// Issue #360: a serve whose spawning worker dies without cleanup must
// not outlive the run. The registry machinery is exercised end to end
// against a real server: boot it, find its registry entry, run the very
// sweep the vitest global hooks run, and watch the HTTP listener die.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls until the server stops answering at all — a connection error is
// the listener (and the process group behind it) being gone.
const waitForServerDown = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(baseUrl, { redirect: "manual" });
    } catch {
      return;
    }
    if (Date.now() > deadline)
      throw new Error(`server at ${baseUrl} is still responding`);
    await sleep(250);
  }
};

describe("serve registry sweeps (issue #360)", () => {
  it("records a live serve and the teardown sweep kills it", async () => {
    const env = await startIntegrationEnv("glv-reg-");
    let pid: number | undefined;
    try {
      const res = await authedFetch(env, "/api/sessions");
      expect(res.status).toBe(200);
      pid = env.serverPid;
      expect(pid).toBeDefined();
      const entry = currentServeEntries().find((e) => e.pid === pid);
      expect(entry).toBeDefined();
      expect(entry?.argv[1]).toBe("serve");
      // The global-teardown sweep, aimed at this worker's registry file:
      // it kills exactly the serves this worker booted and left alive.
      await killRegisteredServes(workerServeRegistryFile());
      await waitForServerDown(env.baseUrl);
    } finally {
      // must tolerate the already-dead server (stop before the rest)
      await env.cleanup();
    }
    // cleanup saw the exit and unregistered the serve — a healthy run
    // leaves no entries behind for the next sweep to chew on.
    expect(currentServeEntries().some((e) => e.pid === pid)).toBe(false);
  }, 60_000);

  it("the boot sweep kills a serve a previous run left registered", async () => {
    const env = await startIntegrationEnv("glv-stale-");
    // An isolated registry root standing in for a previous run's
    // leftovers, so the sweep cannot touch any other run on this host.
    const oldRoot = mkdtempSync(join(tmpdir(), "glv-reg-root-"));
    try {
      const res = await authedFetch(env, "/api/sessions");
      expect(res.status).toBe(200);
      const entry = currentServeEntries().find((e) => e.pid === env.serverPid);
      if (entry === undefined) throw new Error("serve was never registered");
      const oldDir = join(oldRoot, "run-previous");
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, "123456.jsonl"), `${JSON.stringify(entry)}\n`);
      // minAgeMs 0 forces the entry to count as stale, exactly like a
      // day-old leftover would under the production threshold.
      await sweepStaleServes({ root: oldRoot, minAgeMs: 0 });
      await waitForServerDown(env.baseUrl);
      // an emptied registry directory is reaped along with its serves
      expect(existsSync(oldDir)).toBe(false);
    } finally {
      await env.cleanup();
      rmSync(oldRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("the orphan sweep matches harness serves and spares the young", async () => {
    const env = await startIntegrationEnv("glv-orphan-");
    try {
      const res = await authedFetch(env, "/api/sessions");
      expect(res.status).toBe(200);
      // The process-table matcher recognizes the running serve by its
      // unambiguous signature: glv.mjs, the serve verb, and a database
      // flag under the scratch area.
      const pid = env.serverPid;
      const seen = listHarnessServeProcesses().find((p) => p.pid === pid);
      expect(seen).toBeDefined();
      // With a threshold nothing can exceed, the sweep enumerates and
      // dates the process but kills nothing — this serve is registered
      // by a live run and only seconds old.
      await sweepOrphanedServes({ minAgeMs: Number.POSITIVE_INFINITY });
      const after = await authedFetch(env, "/api/sessions");
      expect(after.status).toBe(200);
    } finally {
      await env.cleanup();
    }
  }, 60_000);
});
