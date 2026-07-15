import { describe, expect, it } from "vitest";
import {
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
} from "../runner.js";

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
    const inv = newSessionInvocation("my-session", "write a haiku");
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

  it("starts a new session with -n and no --session-id", () => {
    const { args } = newSessionInvocation("fresh", "hi");
    expect(args[0]).toBe("run");
    expect(args).toContain("-n");
    expect(args).toContain("fresh");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("-r");
  });

  it("streams JSON output so the live view can be rendered incrementally", () => {
    expect(resumeInvocation("x", "y").args).toContain("stream-json");
    expect(newSessionInvocation("x", "y").args).toContain("stream-json");
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
});
