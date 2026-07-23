import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { makeChallengeAuthority } from "../auth/service.js";

// These tests guard the WebAuthn challenge round-trip: the value an
// authenticator echoes back in clientDataJSON must equal the one the
// authority stored. SimpleWebAuthn re-encodes STRING challenges, so the
// authority must hand over raw bytes and key the store by their base64url.
describe("challenge authority", () => {
  it("round-trips a login challenge through SimpleWebAuthn options", async () => {
    const authority = makeChallengeAuthority();
    const options = await generateAuthenticationOptions({
      rpID: "localhost",
      challenge: authority.issue("login"),
      allowCredentials: [],
      userVerification: "preferred",
    });
    expect(authority.verify(options.challenge, "login")).toBe(true);
  });

  it("round-trips a registration challenge through SimpleWebAuthn options", async () => {
    const authority = makeChallengeAuthority();
    const options = await generateRegistrationOptions({
      rpName: "Goose Log Viewer",
      rpID: "localhost",
      userName: "owner",
      challenge: authority.issue("register"),
    });
    expect(authority.verify(options.challenge, "register")).toBe(true);
  });

  it("rejects a challenge for the wrong flow", async () => {
    const authority = makeChallengeAuthority();
    const options = await generateAuthenticationOptions({
      rpID: "localhost",
      challenge: authority.issue("register"),
      allowCredentials: [],
      userVerification: "preferred",
    });
    expect(authority.verify(options.challenge, "login")).toBe(false);
  });

  it("consumes a challenge on first use", async () => {
    const authority = makeChallengeAuthority();
    const options = await generateAuthenticationOptions({
      rpID: "localhost",
      challenge: authority.issue("login"),
      allowCredentials: [],
      userVerification: "preferred",
    });
    expect(authority.verify(options.challenge, "login")).toBe(true);
    expect(authority.verify(options.challenge, "login")).toBe(false);
  });
});
