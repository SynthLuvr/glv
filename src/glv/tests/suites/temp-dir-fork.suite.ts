import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
//
// #387 follow-up: a managed temp dir is glv's to heal — a fork or
// follow-up whose dir already vanished re-creates it instead of
// inheriting a dead path, so the 422 guard stays for vanished,
// unmanaged directories only; and the per-prompt re-tag heals a stale
// single-owner marker (the pre-#370 fork shape) before a sweep can act
// on it.

const MARKER = ".glv-session-id";

type ApiMeta = {
  session: {
    working_dir: string;
    last_run?: { state: string };
  };
};

const runTempDirForkSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";

  // Both readers throw instead of expect(): they also run inside
  // expect.poll callbacks, where a nested expect breaks the retry.
  const readMeta = async (id: string): Promise<ApiMeta> => {
    const res = await bearerFetch(
      env,
      `/api/sessions/${id}?fields=meta`,
      token,
    );
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

  // The session ids recorded in a managed dir's marker file.
  const markerIdsOf = (dir: string): string[] =>
    readFileSync(join(dir, MARKER), "utf-8").trim().split(/\s+/);

  // The managed temp dirs whose marker names the given session id.
  const tempDirsOf = (id: string): string[] => {
    if (!existsSync(env.tempDir)) return [];
    return readdirSync(env.tempDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(env.tempDir, entry.name))
      .filter(
        (dir) => existsSync(join(dir, MARKER)) && markerIdsOf(dir).includes(id),
      );
  };

  // Starts a temp-dir session — the exact repro shape from the issue
  // (`session_mode=temp`, no working_dir field).
  const startTempSession = async (prompt: string): Promise<string> => {
    const res = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: new URLSearchParams({ prompt, session_mode: "temp" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  };

  const forkSession = async (id: string): Promise<string> => {
    const res = await bearerFetch(env, `/api/sessions/${id}/fork`, token, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
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

  beforeAll(async () => {
    env = await fx.startEnv("glv-tempfork-", { writeDb: true });
    token = seedApiToken(env.dbs.authDb, "tempfork");
    // The follow-up guard's vanished-directory session: its working dir
    // is deliberately never created.
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
      sourceId = await startTempSession("work in a scratch dir");
      await settleRun(sourceId);

      const dirs = tempDirsOf(sourceId);
      expect(dirs).toHaveLength(1);
      sharedDir = dirs[0] ?? "";
      expect(existsSync(sharedDir)).toBe(true);
    });

    it("forks the session and records the fork as a directory co-owner", async () => {
      forkId = await forkSession(sourceId);

      // The fork keeps working in the same managed directory…
      const body = await readMeta(forkId);
      expect(body.session.working_dir).toBe(sharedDir);

      // …and the directory's marker now names both owners.
      const ids = markerIdsOf(sharedDir);
      expect(ids).toContain(sourceId);
      expect(ids).toContain(forkId);
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
      sourceId = await startTempSession("delete me later");
      await settleRun(sourceId);
      sharedDir = tempDirsOf(sourceId)[0] ?? "";
      expect(sharedDir).not.toBe("");

      forkId = await forkSession(sourceId);

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
      const first = await startTempSession("batch one");
      const second = await startTempSession("batch two");
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

  describe("forking a session whose temp dir already vanished (#387)", () => {
    let sourceId = "";
    let forkId = "";
    let dir = "";

    it("re-creates the directory for the fork instead of a dead path", async () => {
      sourceId = await startTempSession("scratch that will vanish");
      await settleRun(sourceId);
      dir = tempDirsOf(sourceId)[0] ?? "";
      expect(dir).not.toBe("");

      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);

      forkId = await forkSession(sourceId);
      expect(existsSync(dir)).toBe(true);

      const body = await readMeta(forkId);
      expect(body.session.working_dir).toBe(dir);
      expect(markerIdsOf(dir)).toContain(forkId);
    });

    it("the fork's first prompt runs in the re-created directory", async () => {
      await promptRuns(forkId, "back in business");
    });
  });

  describe("follow-up on a vanished managed temp dir (#387)", () => {
    it("re-creates the directory and runs instead of 422ing", async () => {
      const id = await startTempSession("heal me on prompt");
      await settleRun(id);
      const dir = tempDirsOf(id)[0] ?? "";
      expect(dir).not.toBe("");

      rmSync(dir, { recursive: true, force: true });

      await promptRuns(id, "reclaim the working dir");
      expect(existsSync(dir)).toBe(true);
    });
  });

  describe("stale single-owner marker (pre-#370 fork shape)", () => {
    it("a prompt re-tags the marker, so the source's archive keeps the dir", async () => {
      const sourceId = await startTempSession("stale marker retag");
      await settleRun(sourceId);
      const dir = tempDirsOf(sourceId)[0] ?? "";
      expect(dir).not.toBe("");
      const forkId = await forkSession(sourceId);

      // Forge the pre-#370 shape: the marker names only the source.
      writeFileSync(join(dir, MARKER), `${sourceId}\n`);

      await promptRuns(forkId, "retag my dir");

      const res = await archive(sourceId);
      expect(res.status).toBe(200);
      expect(existsSync(dir)).toBe(true);
    });

    it("an unprompted fork still recovers its dir on the next prompt", async () => {
      const sourceId = await startTempSession("stale marker sweep");
      await settleRun(sourceId);
      const dir = tempDirsOf(sourceId)[0] ?? "";
      expect(dir).not.toBe("");
      const forkId = await forkSession(sourceId);

      writeFileSync(join(dir, MARKER), `${sourceId}\n`);

      // The stale marker lets the source's archive sweep the dir…
      const res = await archive(sourceId);
      expect(res.status).toBe(200);
      expect(existsSync(dir)).toBe(false);

      // …but the fork's next prompt claims it back instead of 422ing.
      await promptRuns(forkId, "my dir again");
      expect(existsSync(dir)).toBe(true);
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
