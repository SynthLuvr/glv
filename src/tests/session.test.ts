import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessResult, Runner, SpawnFn } from "../runner/index.js";
import {
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  getHandle,
} from "../runner/index.js";
import type { ServerContext } from "../server/context.js";
import {
  findNewSessionId,
  pollForSessionId,
  prepareNewSession,
} from "../server/session.js";

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP
);
`;

// Each test group uses its own working dir so the shared db never leaks rows
// across assertions.
const DIR_FIND_A = "/tmp/glv-find-a";
const DIR_FIND_B = "/tmp/glv-find-b";
const DIR_FIND_C = "/tmp/glv-find-c";
const DIR_PREP = "/tmp/glv-prep";
const DIR_ENQUEUE = "/tmp/glv-enqueue";
const DIR_POLL_HIT = "/tmp/glv-poll-hit";
const DIR_POLL_MISS = "/tmp/glv-poll-miss";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const insertSession = (db: DatabaseSync, id: string, dir: string): void => {
  db.prepare("INSERT INTO sessions (id, working_dir) VALUES (?, ?)").run(
    id,
    dir,
  );
};

// A SpawnFn that records each invocation and yields no output, exiting only
// when killed. Lets tests assert the new-session args without the process
// racing to completion.
const createRecordingSpawn = (): {
  spawn: SpawnFn;
  invocations: Array<{ binary: string; args: string[] }>;
} => {
  const invocations: Array<{ binary: string; args: string[] }> = [];
  let pidCounter = 40000;

  const spawn: SpawnFn = (binary, args, _opts) => {
    const pid = ++pidCounter;
    invocations.push({ binary, args: [...args] });
    const local = { killed: false };
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const stdout = (async function* () {
      while (!local.killed) await new Promise((r) => setTimeout(r, 20));
    })();

    const kill = (signal?: string) => {
      if (local.killed) return;
      local.killed = true;
      resolveExit({ exitCode: null, signal: signal ?? "SIGTERM" });
    };

    return { pid, kill, stdout, exit };
  };

  return { spawn, invocations };
};

// prepareNewSession only reads ctx.db and ctx.runner, so a minimal stub
// satisfies the contract.
const makeCtx = (db: DatabaseSync, runner: Runner): ServerContext =>
  ({ db, runner }) as unknown as ServerContext;

let db: DatabaseSync;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

afterAll(() => {
  db.close();
});

describe("findNewSessionId", () => {
  it("returns the first id not present in known", () => {
    insertSession(db, "find-a-1", DIR_FIND_A);
    insertSession(db, "find-a-2", DIR_FIND_A);
    const known = new Set(["find-a-1"]);
    expect(findNewSessionId(db, DIR_FIND_A, known)).toBe("find-a-2");
  });

  it("returns undefined when every current id is known", () => {
    insertSession(db, "find-b-1", DIR_FIND_B);
    const known = new Set(["find-b-1"]);
    expect(findNewSessionId(db, DIR_FIND_B, known)).toBeUndefined();
  });

  it("returns undefined when the directory has no sessions", () => {
    expect(findNewSessionId(db, DIR_FIND_C, new Set())).toBeUndefined();
  });
});

describe("prepareNewSession", () => {
  it("returns a temp-prefixed key and snapshots known ids before enqueueing", () => {
    insertSession(db, "prep-existing", DIR_PREP);
    const { spawn } = createRecordingSpawn();
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const ctx = makeCtx(db, runner);

    const { tempKey, known } = prepareNewSession(ctx, DIR_PREP, "hello");

    // Inserted *after* the call; must be excluded from the snapshot.
    insertSession(db, "prep-after", DIR_PREP);

    expect(tempKey.startsWith("tmp_")).toBe(true);
    expect(known.has("prep-existing")).toBe(true);
    expect(known.has("prep-after")).toBe(false);
  });

  it("enqueues a run keyed by tempKey with isNewSession: true", async () => {
    const { spawn, invocations } = createRecordingSpawn();
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const ctx = makeCtx(db, runner);

    const { tempKey } = prepareNewSession(ctx, DIR_ENQUEUE, "do something");

    // The handle is registered synchronously, so the tempKey is the run key.
    expect(getHandle(runner, tempKey)).toBeDefined();

    // Let the runner queue drain so spawn records the invocation.
    await sleep(50);
    expect(invocations).toHaveLength(1);
    // newSessionInvocation uses ["run", ...STREAM_FLAGS]; resume adds "-r".
    expect(invocations[0].args).not.toContain("-r");
  });
});

describe("pollForSessionId", () => {
  it("delegates to findNewSessionId, returning a newly-present id", async () => {
    insertSession(db, "poll-old", DIR_POLL_HIT);
    insertSession(db, "poll-new", DIR_POLL_HIT);
    const known = new Set(["poll-old"]);
    const found = await pollForSessionId(db, DIR_POLL_HIT, known, 1000, 10);
    expect(found).toBe("poll-new");
  });

  it("returns undefined after the timeout when no new id appears", async () => {
    insertSession(db, "poll-only", DIR_POLL_MISS);
    const known = new Set(["poll-only"]);
    const start = Date.now();
    const found = await pollForSessionId(db, DIR_POLL_MISS, known, 40, 10);
    expect(found).toBeUndefined();
    // setTimeout never fires early, so the loop must have slept the full span.
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });
});
