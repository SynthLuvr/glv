import { describe, expect, it } from "vitest";
import { makeChallengeAuthority } from "../auth/service.js";

describe("challenge authority", () => {
  it("issues independent challenges that do not clobber each other", () => {
    const ca = makeChallengeAuthority();
    const a = ca.issue("register");
    const b = ca.issue("register");
    expect(a).not.toBe(b);
    expect(ca.verify(a, "register")).toBe(true);
    expect(ca.verify(b, "register")).toBe(true);
  });

  it("is single-use: a verified challenge cannot be replayed", () => {
    const ca = makeChallengeAuthority();
    const token = ca.issue("register");
    expect(ca.verify(token, "register")).toBe(true);
    expect(ca.verify(token, "register")).toBe(false);
  });

  it("binds a challenge to its ceremony flow", () => {
    const ca = makeChallengeAuthority();
    const reg = ca.issue("register");
    const login = ca.issue("login");
    expect(ca.verify(reg, "login")).toBe(false);
    expect(ca.verify(login, "register")).toBe(false);
    expect(ca.verify(reg, "register")).toBe(true);
    expect(ca.verify(login, "login")).toBe(true);
  });

  it("rejects expired challenges", () => {
    const ca = makeChallengeAuthority(-1);
    const token = ca.issue("register");
    expect(ca.verify(token, "register")).toBe(false);
  });

  it("rejects a challenge issued by a different authority", () => {
    const caA = makeChallengeAuthority();
    const caB = makeChallengeAuthority();
    const token = caA.issue("register");
    expect(caB.verify(token, "register")).toBe(false);
  });

  it("rejects malformed or unknown input", () => {
    const ca = makeChallengeAuthority();
    expect(ca.verify("", "register")).toBe(false);
    expect(ca.verify("not-a-valid-token", "register")).toBe(false);
    expect(ca.verify("####", "register")).toBe(false);
  });
});
