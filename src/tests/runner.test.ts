import { describe, expect, it, vi } from "vitest";
import type {
  ProcessResult,
  RunHandle,
  RunStatus,
  SpawnFn,
} from "../runner/index.js";
import {
  clearPending,
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  enqueue,
  enqueueNew,
  enqueueOrQueue,
  generateTempKey,
  getHandle,
  getStatus,
  killProcessGroup,
  makeRunnerConfig,
  newSessionInvocation,
  rekey,
  resumeInvocation,
  stop,
  stopAll,
} from "../runner/index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForStatus = async (
  handle: RunHandle,
  status: RunStatus,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (handle.status !== status) {
    if (Date.now() > deadline)
      throw new Error(
        `Timeout waiting for status "${status}", current: "${handle.status}"`,
      );
    await sleep(2);
  }
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for condition");
    await sleep(2);
  }
};

type MockState = {
  invocations: Array<{
    binary: string;
    args: string[];
    opts: { stdin: string; cwd: string };
  }>;
  killCalls: Array<{ pid: number; signal?: string }>;
};

/** Creates a fake SpawnFn that yields controlled output lines. */
const createMockSpawn = (
  lines: string[],
  opts: { delayMs?: number; exitCode?: number } = {},
): { spawn: SpawnFn; state: MockState } => {
  const state: MockState = {
    invocations: [],
    killCalls: [],
  };
  let pidCounter = 10000;

  const spawn: SpawnFn = (binary, args, spawnOpts) => {
    state.invocations.push({ binary, args, opts: spawnOpts });
    const pid = ++pidCounter;
    const local = { killed: false };
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const stdout = (async function* () {
      for (const line of lines) {
        if (local.killed) return;
        if (opts.delayMs !== undefined) await sleep(opts.delayMs);
        yield line;
      }
      if (!local.killed) resolveExit({ exitCode: opts.exitCode ?? 0 });
    })();

    const kill = (signal?: string) => {
      if (local.killed) return;
      local.killed = true;
      state.killCalls.push({ pid, signal });
      resolveExit({ exitCode: null, signal: signal ?? "SIGTERM" });
    };

    return { pid, kill, stdout, exit };
  };

  return { spawn, state };
};

/**
 * Children ignore `ignoreSignals` and never exit on their own; they die only
 * when killed with a signal they don't ignore.
 */
const createStubbornSpawn = (
  ignoreSignals: ReadonlySet<string>,
  opts: { lines?: readonly string[]; delayMs?: number } = {},
): { spawn: SpawnFn; state: MockState } => {
  const state: MockState = {
    invocations: [],
    killCalls: [],
  };
  let pidCounter = 40000;

  const spawn: SpawnFn = (binary, args, spawnOpts) => {
    state.invocations.push({ binary, args, opts: spawnOpts });
    const pid = ++pidCounter;
    const local = { killed: false };
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const stdout = (async function* () {
      for (const line of opts.lines ?? []) {
        if (local.killed) return;
        if (opts.delayMs !== undefined) await sleep(opts.delayMs);
        yield line;
      }
    })();

    const kill = (signal = "SIGINT"): void => {
      state.killCalls.push({ pid, signal });
      if (ignoreSignals.has(signal) || local.killed) return;
      local.killed = true;
      resolveExit({ exitCode: null, signal });
    };

    return { pid, kill, stdout, exit };
  };

  return { spawn, state };
};

describe("goose invocation builders", () => {
  it("pipes the prompt over stdin, never as a -t argument (resume)", () => {
    const inv = resumeInvocation("abc123", "hello goose");
    expect(inv.stdin).toBe("hello goose");
    expect(inv.args).toContain("-i");
    expect(inv.args).toContain("-");
    expect(inv.args).not.toContain("-t");
    // the prompt itself must never leak into the argument list
    expect(inv.args).not.toContain("hello goose");
  });

  it("pipes the prompt over stdin for a new session too", () => {
    const inv = newSessionInvocation("write a haiku");
    expect(inv.stdin).toBe("write a haiku");
    expect(inv.args).not.toContain("-t");
    expect(inv.args).not.toContain("write a haiku");
  });

  it("resumes an existing session with -r --session-id", () => {
    const { args } = resumeInvocation("abc123", "hi");
    expect(args[0]).toBe("run");
    expect(args).toContain("-r");
    expect(args).toContain("--session-id");
    expect(args).toContain("abc123");
  });

  it("starts a new session without a name, --session-id, or -r", () => {
    const { args } = newSessionInvocation("hi");
    expect(args[0]).toBe("run");
    expect(args).not.toContain("-n");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("-r");
  });

  it("streams JSON output so the live view can be rendered incrementally", () => {
    expect(resumeInvocation("x", "y").args).toContain("stream-json");
    expect(newSessionInvocation("y").args).toContain("stream-json");
  });
});

describe("runner configuration", () => {
  it("defaults to 6 concurrent goose runs and the goose binary on PATH", () => {
    expect(DEFAULT_RUNNER_CONFIG.maxConcurrent).toBe(6);
    expect(DEFAULT_RUNNER_CONFIG.gooseBinary).toBe("goose");
  });

  it("parses and accepts a custom configuration", () => {
    const cfg = makeRunnerConfig(3, "/usr/local/bin/goose");
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.gooseBinary).toBe("/usr/local/bin/goose");
  });

  it("rejects a non-positive concurrency", () => {
    expect(() => makeRunnerConfig(0, "goose")).toThrow();
  });

  it("rejects an empty goose binary path", () => {
    expect(() => makeRunnerConfig(6, "")).toThrow();
  });
});

describe("createRunner", () => {
  it("bounds the queue to the configured concurrency", () => {
    const { config, queue } = createRunner(makeRunnerConfig(4, "goose"));
    expect(config.maxConcurrent).toBe(4);
    expect(queue.concurrency).toBe(4);
  });

  it("defaults to the standard configuration", () => {
    const { config, queue } = createRunner();
    expect(config.maxConcurrent).toBe(6);
    expect(queue.concurrency).toBe(6);
  });

  it("uses the provided spawn function and exposes a registry", () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(makeRunnerConfig(3, "goose"), spawn);
    expect(runner.spawn).toBe(spawn);
    expect(runner.registry).toBeInstanceOf(Map);
  });
});

describe("enqueue and run", () => {
  it("streams output lines as they arrive", async () => {
    const { spawn } = createMockSpawn(["line1", "line2", "line3"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const received: string[] = [];
    const handle = enqueue(runner, "s1", "hello", "/tmp", {
      onLine: (line) => received.push(line),
    });
    await waitForStatus(handle, "completed");
    expect(received).toEqual(["line1", "line2", "line3"]);
    expect(handle.lines).toEqual(["line1", "line2", "line3"]);
  });

  it("transitions through queued, running, completed", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 10 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const statuses: RunStatus[] = [];
    const handle = enqueue(runner, "s1", "hi", "/tmp", {
      onStatus: (h) => statuses.push(h.status),
    });
    await waitForStatus(handle, "completed");
    expect(statuses).toEqual(["queued", "running", "completed"]);
  });

  it("builds a resume invocation with stdin-piped prompt", async () => {
    const { spawn, state } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "abc123", "hello goose", "/work");
    await waitForStatus(handle, "completed");
    expect(state.invocations).toHaveLength(1);
    const [{ binary, args, opts }] = state.invocations;
    expect(binary).toBe("goose");
    expect(args).toContain("-r");
    expect(args).toContain("--session-id");
    expect(args).toContain("abc123");
    expect(args).toContain("-i");
    expect(args).toContain("-");
    expect(args).not.toContain("-t");
    expect(args).not.toContain("hello goose");
    expect(opts.stdin).toBe("hello goose");
  });

  it("spawns goose in the session working directory", async () => {
    const { spawn, state } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/path/to/project");
    await waitForStatus(handle, "completed");
    expect(state.invocations[0].opts.cwd).toBe("/path/to/project");
  });

  it("returns a live handle whose status updates in place", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 10 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    // p-queue starts immediately, so the handle reflects the transition in place.
    await waitForStatus(handle, "completed");
    expect(handle.status).toBe("completed");
  });
});

describe("queue position", () => {
  it("reports an approximate queue position when queued", () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 100 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);

    enqueue(runner, "s1", "hi", "/tmp");
    const h2 = enqueue(runner, "s2", "hi", "/tmp");
    const h3 = enqueue(runner, "s3", "hi", "/tmp");

    // With concurrency 1: s1 is pending, s2 is first in queue, s3 is second.
    expect(h2.queuePosition).toBe(0);
    expect(h3.queuePosition).toBe(1);
  });

  it("clears queue position when the run starts", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 50 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);

    const h1 = enqueue(runner, "s1", "hi", "/tmp");
    const h2 = enqueue(runner, "s2", "hi", "/tmp");

    expect(h2.queuePosition).toBe(0);

    await waitForStatus(h1, "completed");
    await waitForStatus(h2, "running");
    expect(h2.queuePosition).toBeUndefined();

    await waitForStatus(h2, "completed");
  });

  it("decrements queue position as earlier runs finish", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 30 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);

    enqueue(runner, "s1", "hi", "/tmp");
    enqueue(runner, "s2", "hi", "/tmp");
    const positions: number[] = [];
    const h3 = enqueue(runner, "s3", "hi", "/tmp", {
      onStatus: (h) => {
        if (h.queuePosition !== undefined) positions.push(h.queuePosition);
      },
    });

    // h3 starts behind s2, at position 1.
    expect(h3.queuePosition).toBe(1);

    await waitForStatus(h3, "running");
    // As s1 and s2 finished, h3's reported position dropped 1 -> 0.
    expect(positions).toEqual([1, 0]);

    await waitForStatus(h3, "completed");
  });

  it("decrements positions when a queued run is stopped", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 50 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);

    enqueue(runner, "s1", "hi", "/tmp");
    enqueue(runner, "s2", "hi", "/tmp");
    const h3 = enqueue(runner, "s3", "hi", "/tmp");

    // s2 and s3 are queued behind the running s1.
    expect(runner.registry.get("s2")?.queuePosition).toBe(0);
    expect(h3.queuePosition).toBe(1);

    // Stopping s2 (still queued) bumps s3 up to the front of the queue.
    expect(stop(runner, "s2")).toBe(true);
    expect(h3.queuePosition).toBe(0);

    await waitForStatus(h3, "completed");
  });
});

describe("stop", () => {
  it("stops a running session by sending a kill signal", async () => {
    const { spawn, state } = createMockSpawn(["line1", "line2"], {
      delayMs: 100,
    });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);

    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "running");

    expect(stop(runner, "s1")).toBe(true);
    await waitForStatus(handle, "stopped");

    expect(state.killCalls).toHaveLength(1);
    expect(state.killCalls[0].signal).toBe("SIGINT");
  });

  it("stops a queued session without spawning a process", () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);

    enqueue(runner, "s1", "hi", "/tmp");
    const h2 = enqueue(runner, "s2", "hi", "/tmp");

    expect(stop(runner, "s2")).toBe(true);
    expect(h2.status).toBe("stopped");
    expect(state.killCalls).toHaveLength(0);
  });

  it("returns false when no run exists for the session", () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    expect(stop(runner, "nonexistent")).toBe(false);
  });

  it("returns false for an already-completed session", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "completed");
    expect(stop(runner, "s1")).toBe(false);
  });
});

describe("stop signal escalation", () => {
  it("escalates to SIGTERM when SIGINT is ignored past the grace period", async () => {
    const { spawn, state } = createStubbornSpawn(new Set(["SIGINT"]));
    const runner = createRunner(makeRunnerConfig(1, "goose", 30), spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "running");
    stop(runner, "s1");
    await waitForStatus(handle, "stopped");
    await waitFor(() => state.killCalls.length >= 2);
    expect(state.killCalls.map((c) => c.signal)).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM is also ignored", async () => {
    const { spawn, state } = createStubbornSpawn(
      new Set(["SIGINT", "SIGTERM"]),
    );
    const runner = createRunner(makeRunnerConfig(1, "goose", 30), spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "running");
    stop(runner, "s1");
    await waitForStatus(handle, "stopped");
    await waitFor(() => state.killCalls.length >= 3);
    expect(state.killCalls.map((c) => c.signal)).toEqual([
      "SIGINT",
      "SIGTERM",
      "SIGKILL",
    ]);
  });

  it("does not escalate when the process exits promptly on SIGINT", async () => {
    const { spawn, state } = createMockSpawn(["a", "b", "c"], { delayMs: 100 });
    const runner = createRunner(makeRunnerConfig(1, "goose", 30), spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "running");
    stop(runner, "s1");
    await waitForStatus(handle, "stopped");
    expect(state.killCalls).toHaveLength(1);
    expect(state.killCalls[0].signal).toBe("SIGINT");
  });

  it("releases the runner slot so a queued run can start after escalation", async () => {
    const { spawn } = createStubbornSpawn(new Set(["SIGINT"]));
    const runner = createRunner(makeRunnerConfig(1, "goose", 30), spawn);
    const h1 = enqueue(runner, "s1", "hi", "/tmp");
    const h2 = enqueue(runner, "s2", "yo", "/tmp");
    await waitForStatus(h1, "running");
    expect(h2.status).toBe("queued");
    stop(runner, "s1");
    await waitForStatus(h1, "stopped");
    await waitForStatus(h2, "running");
    stop(runner, "s2");
    await waitForStatus(h2, "stopped");
  });
});

describe("stopAll", () => {
  it("stops every running and queued session and returns the count", async () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(makeRunnerConfig(4, "goose"), spawn);
    const h1 = enqueue(runner, "s1", "hi", "/tmp");
    const h2 = enqueue(runner, "s2", "hi", "/tmp");
    await waitForStatus(h1, "running");
    await waitForStatus(h2, "running");

    const stopped = stopAll(runner);

    expect(stopped).toBe(2);
    await waitForStatus(h1, "stopped");
    await waitForStatus(h2, "stopped");
    expect(state.killCalls).toHaveLength(2);
    expect(state.killCalls.every((c) => c.signal === "SIGINT")).toBe(true);
  });

  it("stops a queued session without spawning an extra process", () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 300 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);
    enqueue(runner, "s1", "hi", "/tmp");
    const h2 = enqueue(runner, "s2", "hi", "/tmp");

    const stopped = stopAll(runner);

    expect(stopped).toBe(2);
    expect(h2.status).toBe("stopped");
    // Only s1 was running; s2 was cancelled in the queue (no kill call).
    expect(state.killCalls).toHaveLength(1);
  });

  it("is a no-op on an empty registry", () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    expect(stopAll(runner)).toBe(0);
  });

  it("does not count already-terminal handles", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const h1 = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(h1, "completed");
    expect(stopAll(runner)).toBe(0);
  });
});

describe("killProcessGroup", () => {
  it("sends the signal to the entire process group via negative PID", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessGroup(12345, "SIGINT");
    expect(spy).toHaveBeenCalledWith(-12345, "SIGINT");
    spy.mockRestore();
  });

  it("defaults to SIGINT when no signal is specified", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessGroup(99);
    expect(spy).toHaveBeenCalledWith(-99, "SIGINT");
    spy.mockRestore();
  });

  it("does not throw when the process has already exited", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(() => killProcessGroup(12345)).not.toThrow();
    spy.mockRestore();
  });
});

describe("concurrency", () => {
  it("runs at most maxConcurrent sessions simultaneously", async () => {
    let active = 0;
    let maxActive = 0;

    const spawn: SpawnFn = () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const pid = 20000 + active;
      const local = { killed: false };
      let resolveExit!: (r: ProcessResult) => void;
      const exit = new Promise<ProcessResult>((resolve) => {
        resolveExit = resolve;
      });

      const stdout = (async function* () {
        await sleep(30);
        if (!local.killed) {
          yield "ok";
          active--;
          resolveExit({ exitCode: 0 });
        }
      })();

      const kill = (signal?: string) => {
        if (local.killed) return;
        local.killed = true;
        active--;
        resolveExit({ exitCode: null, signal: signal ?? "SIGTERM" });
      };

      return { pid, kill, stdout, exit };
    };

    const runner = createRunner(makeRunnerConfig(2, "goose"), spawn);

    for (let i = 0; i < 5; i++) enqueue(runner, `s${i}`, "hi", "/tmp");

    await sleep(500);
    expect(maxActive).toBe(2);
  });
});

describe("session exclusivity", () => {
  it("rejects a second enqueue for a session that is already running", () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    enqueue(runner, "s1", "hi", "/tmp");
    expect(() => enqueue(runner, "s1", "hi again", "/tmp")).toThrow(
      /already has an active/,
    );
  });

  it("rejects a second enqueue for a session that is queued", () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(makeRunnerConfig(1, "goose"), spawn);
    enqueue(runner, "s1", "hi", "/tmp");
    enqueue(runner, "s2", "hi", "/tmp");
    expect(() => enqueue(runner, "s2", "again", "/tmp")).toThrow(
      /already has an active/,
    );
  });

  it("allows re-enqueue after a session completes", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const h1 = enqueue(runner, "s1", "first", "/tmp");
    await waitForStatus(h1, "completed");
    const h2 = enqueue(runner, "s1", "second", "/tmp");
    await waitForStatus(h2, "completed");
  });

  it("allows re-enqueue after a session is stopped", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const h1 = enqueue(runner, "s1", "first", "/tmp");
    await waitForStatus(h1, "running");
    stop(runner, "s1");
    await waitForStatus(h1, "stopped");

    const h2 = enqueue(runner, "s1", "second", "/tmp");
    await waitForStatus(h2, "completed");
  });
});

describe("enqueueOrQueue (follow-up prompt queuing)", () => {
  it("starts immediately when the session is idle", () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle, queued } = enqueueOrQueue(runner, "s1", "hi", "/tmp");
    expect(queued).toBe(false);
    expect(handle.prompt).toBe("hi");
    expect(state.invocations).toHaveLength(1);
  });

  it("queues the prompt when the session is busy", async () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(getHandle(runner, "s1")!, "running");
    const { handle, queued } = enqueueOrQueue(runner, "s1", "second", "/tmp");
    expect(queued).toBe(true);
    expect(handle.pendingPrompts).toEqual(["second"]);
    expect(state.invocations).toHaveLength(1);
  });

  it("runs queued prompts automatically after the current run completes", async () => {
    const { spawn, state } = createMockSpawn(["line1"], { delayMs: 30 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    await waitForStatus(handle, "completed");
    expect(state.invocations).toHaveLength(2);
    expect(state.invocations[0].opts.stdin).toBe("first");
    expect(state.invocations[1].opts.stdin).toBe("second");
  });

  it("accumulates lines across all chained runs without resetting", async () => {
    const { spawn } = createMockSpawn(["a", "b"], { delayMs: 20 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    await waitForStatus(handle, "completed");
    expect(handle.lines).toEqual(["a", "b", "a", "b"]);
  });

  it("tracks started prompts for stream replay", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 20 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    enqueueOrQueue(runner, "s1", "third", "/tmp");
    await waitForStatus(handle, "completed");
    expect(handle.startedPrompts).toEqual(["second", "third"]);
  });

  it("does not block the chain when a run errors", async () => {
    const { spawn, state } = createMockSpawn(["x"], {
      delayMs: 20,
      exitCode: 1,
    });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    await waitForStatus(handle, "error");
    expect(state.invocations).toHaveLength(2);
  });

  it("queues multiple prompts in FIFO order", async () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 20 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "p1", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "p2", "/tmp");
    enqueueOrQueue(runner, "s1", "p3", "/tmp");
    await waitForStatus(handle, "completed");
    expect(state.invocations.map((i) => i.opts.stdin)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("stops the current run and clears all pending prompts", async () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    enqueueOrQueue(runner, "s1", "third", "/tmp");
    expect(handle.pendingPrompts).toHaveLength(2);
    stop(runner, "s1");
    await waitForStatus(handle, "stopped");
    expect(handle.pendingPrompts).toEqual([]);
    expect(state.invocations).toHaveLength(1);
  });

  it("fires onStatus when a prompt is queued", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const statuses: string[] = [];
    enqueueOrQueue(runner, "s1", "first", "/tmp", {
      onStatus: (h) => statuses.push(`${h.status}:${h.pendingPrompts.length}`),
    });
    await waitForStatus(getHandle(runner, "s1")!, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    expect(statuses).toContain("running:1");
  });
});

describe("clearPending", () => {
  it("removes all pending prompts and returns the count", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    enqueueOrQueue(runner, "s1", "third", "/tmp");
    const cleared = clearPending(runner, "s1");
    expect(cleared).toBe(2);
    expect(handle.pendingPrompts).toEqual([]);
  });

  it("returns 0 when there are no pending prompts", () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    expect(clearPending(runner, "s1")).toBe(0);
  });

  it("does not stop the currently running process", async () => {
    const { spawn, state } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const { handle } = enqueueOrQueue(runner, "s1", "first", "/tmp");
    await waitForStatus(handle, "running");
    enqueueOrQueue(runner, "s1", "second", "/tmp");
    clearPending(runner, "s1");
    expect(handle.status).toBe("running");
    expect(state.killCalls).toHaveLength(0);
  });
});

describe("error handling", () => {
  it("reports an error when goose exits non-zero", async () => {
    const { spawn } = createMockSpawn(["x"], { exitCode: 1 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "error");
    expect(handle.error).toBe("goose exited with code 1");
  });

  it("reports an error when spawn throws synchronously", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("binary not found");
    };
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "error");
    expect(handle.error).toBe("binary not found");
  });

  it("still reports partial lines before a non-zero exit", async () => {
    const { spawn } = createMockSpawn(["partial", "output"], {
      exitCode: 42,
    });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    await waitForStatus(handle, "error");
    expect(handle.lines).toEqual(["partial", "output"]);
    expect(handle.error).toBe("goose exited with code 42");
  });
});

describe("getStatus and getHandle", () => {
  it("returns the current status for an active session", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueue(runner, "s1", "hi", "/tmp");
    // With available capacity p-queue starts immediately.
    expect(["queued", "running"]).toContain(getStatus(runner, "s1"));
    await waitForStatus(handle, "completed");
    expect(getStatus(runner, "s1")).toBe("completed");
  });

  it("returns undefined for an unknown session", () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    expect(getStatus(runner, "nope")).toBeUndefined();
    expect(getHandle(runner, "nope")).toBeUndefined();
  });

  it("returns a handle with the prompt and session id", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    enqueue(runner, "sess-42", "do the thing", "/work");
    const handle = getHandle(runner, "sess-42");
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe("sess-42");
    expect(handle!.prompt).toBe("do the thing");
  });
});

describe("enqueueNew (new-session runs)", () => {
  it("builds a new-session invocation with no name or --session-id", async () => {
    const { spawn, state } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueueNew(runner, "tmp-1", "hello", "/tmp");
    await waitForStatus(handle, "completed");
    expect(state.invocations).toHaveLength(1);
    const [{ args }] = state.invocations;
    expect(args).not.toContain("-n");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("-r");
  });

  it("pipes the prompt via stdin, never as an argument", async () => {
    const { spawn, state } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueueNew(runner, "tmp-1", "write a haiku", "/tmp");
    await waitForStatus(handle, "completed");
    expect(state.invocations[0].opts.stdin).toBe("write a haiku");
    expect(state.invocations[0].args).not.toContain("write a haiku");
    expect(state.invocations[0].args).not.toContain("-t");
  });

  it("spawns goose in the chosen working directory", async () => {
    const { spawn, state } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueueNew(runner, "tmp-1", "hi", "/path/to/work");
    await waitForStatus(handle, "completed");
    expect(state.invocations[0].opts.cwd).toBe("/path/to/work");
  });

  it("registers the run under the temporary key", () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    enqueueNew(runner, "tmp-99", "hi", "/tmp");
    expect(getHandle(runner, "tmp-99")).toBeDefined();
  });

  it("streams output lines as they arrive", async () => {
    const { spawn } = createMockSpawn(["a", "b", "c"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const received: string[] = [];
    const handle = enqueueNew(runner, "tmp-1", "hi", "/tmp", {
      onLine: (line) => received.push(line),
    });
    await waitForStatus(handle, "completed");
    expect(received).toEqual(["a", "b", "c"]);
  });
});

describe("rekey", () => {
  it("moves the handle from the temp key to the real session id", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueueNew(runner, "tmp-1", "hi", "/tmp");
    await waitForStatus(handle, "running");

    expect(rekey(runner, "tmp-1", "real-42")).toBe(true);
    expect(getHandle(runner, "real-42")).toBe(handle);
    expect(getHandle(runner, "real-42")?.sessionId).toBe("real-42");
    expect(getHandle(runner, "tmp-1")).toBeUndefined();
  });

  it("keeps the run's accumulated lines across the re-key", async () => {
    const { spawn } = createMockSpawn(["one", "two"], { delayMs: 100 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handle = enqueueNew(runner, "tmp-1", "hi", "/tmp");
    await waitForStatus(handle, "running");
    await sleep(150);
    rekey(runner, "tmp-1", "real-1");
    expect(getHandle(runner, "real-1")?.lines).toContain("one");
  });

  it("returns false when the temp key is unknown", () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    expect(rekey(runner, "nope", "real-1")).toBe(false);
  });

  it("refuses to clobber a handle already keyed to the target id", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 200 });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const handleA = enqueueNew(runner, "tmp-a", "hi", "/tmp");
    const handleB = enqueueNew(runner, "tmp-b", "hi", "/tmp");
    await waitForStatus(handleA, "running");
    await waitForStatus(handleB, "running");

    expect(rekey(runner, "tmp-a", "real-1")).toBe(true);
    // The second must not overwrite the first; the loser keeps its temp key.
    expect(rekey(runner, "tmp-b", "real-1")).toBe(false);
    expect(getHandle(runner, "real-1")).toBe(handleA);
    expect(getHandle(runner, "tmp-b")).toBe(handleB);
    expect(getHandle(runner, "tmp-a")).toBeUndefined();
  });
});

describe("generateTempKey", () => {
  it("prefixes the key so it can never collide with a real goose id", () => {
    expect(generateTempKey()).toMatch(/^tmp_/);
  });

  it("produces unique keys across calls", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i++) keys.add(generateTempKey());
    expect(keys.size).toBe(200);
  });
});
