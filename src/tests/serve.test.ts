import { describe, expect, it, vi } from "vitest";
import {
  closeServer,
  createShutdown,
  registerShutdown,
} from "../commands/serve.js";

describe("closeServer", () => {
  it("resolves once the server's close callback fires", async () => {
    let fired = false;
    const server = {
      close: (cb?: () => void): void => {
        fired = true;
        cb?.();
      },
    };
    await closeServer(server);
    expect(fired).toBe(true);
  });

  it("waits for an asynchronous drain to finish", async () => {
    let drained = false;
    const server = {
      close: (cb?: () => void): void => {
        setTimeout(() => {
          drained = true;
          cb?.();
        }, 5);
      },
    };
    await closeServer(server);
    expect(drained).toBe(true);
  });
});

describe("createShutdown", () => {
  it("drains requests before stopping processes, closing dbs, and exiting", async () => {
    const order: string[] = [];
    const server = {
      close: (cb?: () => void): void => {
        setTimeout(() => {
          order.push("drained");
          cb?.();
        }, 5);
      },
    };
    const shutdown = createShutdown({
      server,
      stopProcesses: () => order.push("stopped"),
      closeDbs: () => order.push("dbs-closed"),
      exit: (code) => order.push(`exit:${code ?? 0}`),
    });

    await shutdown();

    // The drain must complete first so no in-flight response is truncated.
    expect(order).toEqual(["drained", "stopped", "dbs-closed", "exit:0"]);
  });

  it("closes the databases exactly once on repeat signals", async () => {
    let dbCloses = 0;
    const server = { close: (cb?: () => void) => cb?.() };
    const shutdown = createShutdown({
      server,
      stopProcesses: () => undefined,
      closeDbs: () => {
        dbCloses++;
      },
      exit: () => undefined,
    });

    await shutdown();
    await shutdown();

    expect(dbCloses).toBe(1);
  });

  it("stops goose processes exactly once on repeat signals", async () => {
    let stops = 0;
    const server = { close: (cb?: () => void) => cb?.() };
    const shutdown = createShutdown({
      server,
      stopProcesses: () => {
        stops++;
      },
      closeDbs: () => undefined,
      exit: () => undefined,
    });

    await shutdown();
    await shutdown();

    expect(stops).toBe(1);
  });

  it("force-exits non-zero on a second interrupt while draining", async () => {
    const codes: number[] = [];
    const server = { close: (cb?: () => void) => cb?.() };
    const shutdown = createShutdown({
      server,
      stopProcesses: () => undefined,
      closeDbs: () => undefined,
      exit: (code) => codes.push(code ?? 0),
    });

    await shutdown();
    await shutdown();

    expect(codes).toEqual([0, 1]);
  });

  it("forwards a caller-supplied non-zero exit code", async () => {
    const codes: number[] = [];
    const server = { close: (cb?: () => void) => cb?.() };
    const shutdown = createShutdown({
      server,
      stopProcesses: () => undefined,
      closeDbs: () => undefined,
      exit: (code) => codes.push(code ?? 0),
    });

    await shutdown(1);

    expect(codes).toEqual([1]);
  });
});

describe("registerShutdown", () => {
  const makeEmitter = () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      handlers,
      on: (event: string, listener: (signal: unknown) => void): void => {
        handlers.set(event, listener);
      },
    };
  };

  it("subscribes to signals and abnormal-exit events", () => {
    const emitter = makeEmitter();
    const shutdown = (): Promise<void> => Promise.resolve();
    registerShutdown(shutdown, emitter);

    expect([...emitter.handlers.keys()].sort()).toEqual(
      ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].sort(),
    );
  });

  it("triggers a graceful (exit 0) shutdown on SIGINT and SIGTERM", () => {
    const emitter = makeEmitter();
    const codes: number[] = [];
    const shutdown = (code = 0): Promise<void> => {
      codes.push(code);
      return Promise.resolve();
    };
    registerShutdown(shutdown, emitter);

    emitter.handlers.get("SIGINT")?.();
    emitter.handlers.get("SIGTERM")?.();

    expect(codes).toEqual([0, 0]);
  });

  it("logs and triggers a non-zero shutdown on crash events", () => {
    const emitter = makeEmitter();
    const codes: number[] = [];
    const shutdown = (code = 0): Promise<void> => {
      codes.push(code);
      return Promise.resolve();
    };
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    registerShutdown(shutdown, emitter);
    emitter.handlers.get("uncaughtException")?.(new Error("boom"));

    expect(errorSpy).toHaveBeenCalled();
    expect(codes).toEqual([1]);
    errorSpy.mockRestore();
  });
});
