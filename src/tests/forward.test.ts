import { describe, expect, it } from "vitest";
import { forwardArgs } from "../forward.js";

describe("forwardArgs", () => {
  it("builds the full ssh reverse-tunnel invocation", () => {
    expect(forwardArgs(3000, "91.98.17.2")).toEqual([
      "-NT",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      "127.0.0.1:3000:127.0.0.1:3000",
      "91.98.17.2",
    ]);
  });

  it("binds the serve port on both sides of -R", () => {
    const args = forwardArgs(8080, "example.com");
    expect(args).toContain("127.0.0.1:8080:127.0.0.1:8080");
  });

  it("appends the host as the final positional argument", () => {
    const args = forwardArgs(3000, "10.0.0.5");
    expect(args[args.length - 1]).toBe("10.0.0.5");
  });
});
