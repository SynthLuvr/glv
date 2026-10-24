import { describe, expect, it } from "vitest";
import { isLoopbackAddress } from "../server/routes/token-bootstrap.js";

// The address classification the loopback bootstrap gate rests on. The
// end-to-end refusal (a real non-loopback TCP peer answered 403, and
// forged x-forwarded-for changing nothing) lives in the integration
// suite; this pins the classifier itself, including the IPv4-mapped
// spelling serve's "::" bind hands IPv4 peers.
describe("isLoopbackAddress", () => {
  it("admits the loopback spellings a wildcard bind produces", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("refuses every other address", () => {
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("203.0.113.9")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
    expect(isLoopbackAddress("::")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
