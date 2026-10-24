import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// #367: a fork of a temp-dir session shares the managed working
// directory with its source, so archiving (or deleting) the source must
// not sweep the directory out from under the fork — the fork's next
// prompt would spawn into a deleted cwd. The directory is tagged with
// every owner's id and swept only once the last owner is archived or
// deleted. Also covers the batch archive route's sweep and the clear
// 422 a follow-up gets when its working directory vanished.

const MARKER = ".glv-session-id";

type ApiMeta = {
  session: {
    id: string;
    working_dir: string;
    status: string;
    last_run?: { state: string; reason?: string };
  };
};

const runTempDirForkSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";

  const readMeta = async (id: string): Promise<ApiMeta> => {
    const res = await bearerFetch(
      env,
      `/api/sessions/${id}?fields=meta`,
      token,
    );
    // Throws instead of expect(): these helpers also run inside
    // expect.poll callbacks, where a nested expect breaks the retry.
    if (res.status !== 200) throw new Error(`meta read failed: ${res.status}`);
    return (await res.json()) as ApiMeta;
  };

  const messageCount = async (id: string): Promise<number> => {
    const res = await bearerFetch(env, `/api/sessions/${id}`, token);
    if (res.status !== 200)
      throw new Error(`transcript read failed: ${res.status}`);
    const body = (await res.json()) as { messages?: unknown[] };
    return body.messages?.length ?? 0;
  };

  // The temp working dirs under GLV's private storage whose marker names
  // the given session id.
  const tempDirsOf = (id: string): string[] => {
    if (!existsSync(env.tempDir)) return [];
    return readdirSync(env.tempDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(env.tempDir, entry.name))
      .filter((dir) => {
        const marker = join(dir, MARKER);
        return (
          existsSync(marker) &&
          readFileSync(marker, "utf-8").trim().split(/\s+/).includes(id)
        );
      });
  };

  // Starts a temp-dir session over the JSON API — the exact repro shape
  // from the issue (`session_mode=temp`, no working_dir field).
  const startTempSession = async (
    prompt: string,
  ): Promise<{ id: string } | { error: string; status: number }> => {
    const res = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({ prompt, session_mode: "temp" }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    return res.status === 201 && body.id !== undefined
      ? { id: body.id }
      : { error: body.error ?? `status ${res.status}`, status: res.status };
  };

  const forkSession = async (
    id: string,
  ): Promise<{ id: string } | { error: string; status: number }> => {
    const res = await bearerFetch(env, `/api/sessions/${id}/fork`, token, {
      method: "POST",
    });
    const body = (await res.json()) as { id?: string; error?: string };
    return res.status === 201 && body.id !== undefined
      ? { id: body.id }
      : { error: body.error ?? `status ${res.status}`, status: res.status };
  };

  const promptSession = (id: string, prompt: string): Promise<Response> =>
    bearerFetch(env, `/api/sessions/${id}/prompt`, token, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  const archive = (id: string): Promise<Response> =>
    authedFetch(env, `/sessions/${id}/archive`, { method: "POST" });

  // Parks until the session's run settles (200), retrying a 202 past its
  // own deadline so a loaded shard's slow mock spawn still resolves.
  const settleRun = async (id: string): Promise<void> => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const res = await bearerFetch(
        env,
        `/api/sessions/${id}/wait?timeout=15000`,
        token,
      );
      if (res.status === 200) return;
      if (Date.now() > deadline) throw new Error(`run on ${id} never settled`);
    }
  };

  // Prompts the session and proves the run genuinely executed in its
  // working directory: the prompt is accepted, the settled run's
  // persisted verdict is "finished" (a spawn into a deleted cwd records
  // a failed run instead — the #367 symptom), and the transcript grew.
  const promptRuns = async (id: string, prompt: string): Promise<void> => {
    const before = await messageCount(id);
    const res = await promptSession(id, prompt);
    expect(res.status).toBe(200);
    await settleRun(id);
    // The verdict is persisted just after the run settles, so poll for
    // it rather than reading once.
    await expect
      .poll(async () => (await readMeta(id)).session.last_run?.state, {
        timeout: 30_000,
      })
      .toBe("finished");
    await expect
      .poll(() => messageCount(id), { timeout: 60_000 })
      .toBeGreaterThan(before);
  };

  const expectStarted = (
    outcome: { id: string } | { error: string; status: number },
  ): string => {
    if (!("id" in outcome)) throw new Error(outcome.error);
    return outcome.id;
  };

  beforeAll(async () => {
    env = await fx.startEnv("glv-tempfork-", { writeDb: true });
    token = seedApiToken(env.dbs.authDb, "tempfork");
    // The vanished-directory session for the follow-up guard: its
    // working dir is deliberately never created.
    fx.seedSessions(env, [
      {
        id: "gone-dir",
        name: "Vanished Directory",
        workingDir: join(env.scratchDir, "vanished-dir"),
      },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("temp-dir session shared with a fork", () => {
    let sourceId = "";
    let forkId = "";
    let sharedDir = "";

    it("starts a temp session whose directory is tagged with its id", async () => {
      sourceId = expectStarted(await startTempSession("work in a scratch dir"));
      await settleRun(sourceId);

      const dirs = tempDirsOf(sourceId);
      expect(dirs).toHaveLength(1);
      sharedDir = dirs[0] ?? "";
      expect(existsSync(sharedDir)).toBe(true);
    });

    it("forks the session and records the fork as a directory co-owner", async () => {
      forkId = expectStarted(await forkSession(sourceId));

      // The fork keeps working in the same managed directory…
      const body = await readMeta(forkId);
      expect(body.session.working_dir).toBe(sharedDir);

      // …and the directory's marker now names both owners.
      const markerIds = readFileSync(join(sharedDir, MARKER), "utf-8")
        .trim()
        .split(/\s+/);
      expect(markerIds).toContain(sourceId);
      expect(markerIds).toContain(forkId);
    });

    it("archiving the source leaves the shared directory in place (#367)", async () => {
      const res = await archive(sourceId);
      expect(res.status).toBe(200);
      expect(existsSync(sharedDir)).toBe(true);
    });

    it("the fork's next prompt still runs in the shared directory", async () => {
      await promptRuns(forkId, "keep going in the scratch dir");
      expect(existsSync(sharedDir)).toBe(true);
    });

    it("archiving the last owner sweeps the shared directory", async () => {
      const res = await archive(forkId);
      expect(res.status).toBe(200);
      expect(existsSync(sharedDir)).toBe(false);
    });
  });

  describe("deleting the source of a shared temp dir", () => {
    let sourceId = "";
    let forkId = "";
    let sharedDir = "";

    it("keeps the directory for the fork after the delete", async () => {
      sourceId = expectStarted(await startTempSession("delete me later"));
      await settleRun(sourceId);
      sharedDir = tempDirsOf(sourceId)[0] ?? "";
      expect(sharedDir).not.toBe("");

      forkId = expectStarted(await forkSession(sourceId));

      const res = await authedFetch(env, `/sessions/${sourceId}/delete`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(existsSync(sharedDir)).toBe(true);
    });

    it("the fork still runs, and its archive sweeps the directory", async () => {
      await promptRuns(forkId, "still here");

      const sweep = await archive(forkId);
      expect(sweep.status).toBe(200);
      expect(existsSync(sharedDir)).toBe(false);
    });
  });

  describe("batch archive", () => {
    it("sweeps the temp directories of every archived session", async () => {
      const first = expectStarted(await startTempSession("batch one"));
      const second = expectStarted(await startTempSession("batch two"));
      await settleRun(first);
      await settleRun(second);

      const firstDir = tempDirsOf(first)[0] ?? "";
      const secondDir = tempDirsOf(second)[0] ?? "";
      expect(firstDir).not.toBe("");
      expect(secondDir).not.toBe("");
      expect(firstDir).not.toBe(secondDir);

      const body = new URLSearchParams();
      body.append("id", first);
      body.append("id", second);
      const res = await authedFetch(env, "/sessions/archive", {
        method: "POST",
        body,
      });
      expect(res.status).toBe(200);

      expect(existsSync(firstDir)).toBe(false);
      expect(existsSync(secondDir)).toBe(false);
    });
  });

  describe("follow-up guard", () => {
    it("rejects a prompt whose working directory no longer exists", async () => {
      const res = await promptSession(fx.viewId("gone-dir"), "anyone there?");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("working directory no longer exists");
    });
  });
};

export { runTempDirForkSuite };
