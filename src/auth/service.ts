import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type } from "arktype";
import {
  createOwner,
  createSession,
  deleteSession,
  getCredential,
  isClaimed,
  listCredentials,
  type NewCredential,
  refreshSession,
  updateCounter,
  validSession,
} from "./db.js";

type RpConfig = {
  rpName: string;
  rpID: string;
  expectedOrigin: string;
};

type VerifyResult = {
  verified: boolean;
  token?: string;
  error?: string;
};

type AuthService = {
  isClaimed: () => boolean;
  registrationOptions: (
    rp: RpConfig,
  ) => Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration: (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ) => Promise<VerifyResult>;
  loginOptions: (
    rp: RpConfig,
  ) => Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyLogin: (
    rp: RpConfig,
    body: AuthenticationResponseJSON,
  ) => Promise<VerifyResult>;
  isValidSession: (token: string | undefined) => boolean;
  logout: (token: string | undefined) => void;
};

const errDetail = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Stored transports are plain strings; validate each against the WebAuthn
// transport union rather than asserting the whole array sight-unseen. Values
// outside the union are dropped so a malformed record can't reach the verifier.
const Transport = type(
  "'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'",
);

const toTransports = (raw: string[]): AuthenticatorTransportFuture[] =>
  raw.flatMap((t) => {
    const parsed = Transport(t);
    return parsed instanceof type.errors ? [] : [parsed];
  });

// WebAuthn challenges should be short-lived: a ceremony that never completes
// must not leave a valid challenge sitting around indefinitely.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type ChallengeFlow = "register" | "login";

// A self-validating, per-ceremony challenge token. The token is itself the
// WebAuthn challenge: the authenticator signs it and echoes it back, so the
// server can re-verify it statelessly without remembering anything in memory.
// Every options call mints an independent token, so a second request — a retry,
// a second tab, or an unauthenticated attacker hammering the endpoint — can
// never overwrite another ceremony's challenge.
const makeChallengeAuthority = (
  ttlMs = CHALLENGE_TTL_MS,
): {
  issue: (flow: ChallengeFlow) => string;
  verify: (token: string, flow: ChallengeFlow) => boolean;
} => {
  // Random per process start. A restart invalidates any in-flight ceremony,
  // matching the lifetime the old in-memory slot had.
  const secret = randomBytes(32);

  const sign = (data: string): string =>
    createHmac("sha256", secret).update(data, "utf8").digest("hex");

  const sameSig = (a: string, b: string): boolean => {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  const issue = (flow: ChallengeFlow): string => {
    const body = JSON.stringify({
      n: randomBytes(16).toString("base64url"),
      e: Date.now() + ttlMs,
      f: flow,
    });
    return Buffer.from(JSON.stringify({ body, sig: sign(body) })).toString(
      "base64url",
    );
  };

  const verify = (token: string, flow: ChallengeFlow): boolean => {
    let outer: { body?: unknown; sig?: unknown };
    try {
      outer = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    const { body, sig } = outer;
    if (typeof body !== "string" || typeof sig !== "string") return false;
    if (!sameSig(sign(body), sig)) return false;
    let parsed: { e?: unknown; f?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
    return (
      parsed.f === flow &&
      typeof parsed.e === "number" &&
      Date.now() <= parsed.e
    );
  };

  return { issue, verify };
};

// Pull the challenge back out of a WebAuthn response's clientDataJSON so a
// signed token can be validated before the response reaches the verifier. The
// response body is untrusted, so every step is defensive.
const challengeFromResponse = (response: unknown): string | undefined => {
  if (typeof response !== "object" || response === null) return undefined;
  const { clientDataJSON } = response as { clientDataJSON?: unknown };
  if (typeof clientDataJSON !== "string") return undefined;
  try {
    const data = JSON.parse(
      Buffer.from(clientDataJSON, "base64url").toString("utf8"),
    ) as { challenge?: unknown };
    return typeof data.challenge === "string" ? data.challenge : undefined;
  } catch {
    return undefined;
  }
};

const makeAuthService = (authDb: DatabaseSync): AuthService => {
  const challenge = makeChallengeAuthority();

  const registrationOptions = async (
    rp: RpConfig,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> => {
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: "owner",
      // The challenge is a signed, time-boxed token (see makeChallengeAuthority)
      // so the server validates it statelessly instead of stashing it in a
      // single shared slot that any second request would clobber.
      challenge: challenge.issue("register"),
      attestationType: "none",
      // ES256 + RS256; excludes Ed25519 which some runtimes can't verify.
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    return options;
  };

  const verifyRegistration = async (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ): Promise<VerifyResult> => {
    const expectedChallenge = challengeFromResponse(body.response);
    if (
      expectedChallenge === undefined ||
      !challenge.verify(expectedChallenge, "register")
    )
      return {
        verified: false,
        error: "No registration in progress. Please reload and try again.",
      };
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: rp.expectedOrigin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      return { verified: false, error: errDetail(err) };
    }
    if (!verification.verified || verification.registrationInfo === undefined)
      return { verified: false, error: "Registration could not be verified." };
    const { credential } = verification.registrationInfo;
    const record: NewCredential = {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: body.response.transports ?? [],
    };
    const userId = createOwner(authDb, record);
    const token = createSession(authDb, userId);
    return { verified: true, token };
  };

  const loginOptions = async (
    rp: RpConfig,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> => {
    const creds = listCredentials(authDb);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      challenge: challenge.issue("login"),
      allowCredentials: creds.map((c) => ({
        id: c.id,
        type: "public-key",
        transports: toTransports(c.transports),
      })),
      userVerification: "preferred",
    });
    return options;
  };

  const verifyLogin = async (
    rp: RpConfig,
    body: AuthenticationResponseJSON,
  ): Promise<VerifyResult> => {
    const expectedChallenge = challengeFromResponse(body.response);
    if (
      expectedChallenge === undefined ||
      !challenge.verify(expectedChallenge, "login")
    )
      return {
        verified: false,
        error: "No login in progress. Please reload and try again.",
      };
    const cred = getCredential(authDb, body.id);
    if (cred === undefined)
      return { verified: false, error: "Unknown credential." };
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: rp.expectedOrigin,
        expectedRPID: rp.rpID,
        credential: {
          id: cred.id,
          publicKey: cred.publicKey,
          counter: cred.counter,
          transports: toTransports(cred.transports),
        },
        requireUserVerification: false,
      });
    } catch (err) {
      return { verified: false, error: errDetail(err) };
    }
    if (!verification.verified)
      return { verified: false, error: "Authentication failed." };
    updateCounter(authDb, cred.id, verification.authenticationInfo.newCounter);
    const token = createSession(authDb, cred.userId);
    return { verified: true, token };
  };

  const isValidSession = (token: string | undefined): boolean => {
    if (token === undefined || token === "") return false;
    if (!validSession(authDb, token)) return false;
    // Sliding window: refresh on every authenticated request.
    refreshSession(authDb, token);
    return true;
  };

  const logout = (token: string | undefined): void => {
    if (token !== undefined && token !== "") deleteSession(authDb, token);
  };

  return {
    isClaimed: () => isClaimed(authDb),
    registrationOptions,
    verifyRegistration,
    loginOptions,
    verifyLogin,
    isValidSession,
    logout,
  };
};

export type { AuthService, ChallengeFlow, RpConfig, VerifyResult };
export { makeAuthService, makeChallengeAuthority };
