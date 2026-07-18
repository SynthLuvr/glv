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

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type ChallengeFlow = "register" | "login";

// The token is itself the WebAuthn challenge: the authenticator signs and
// echoes it back, so the server re-verifies it statelessly. Each options call
// mints an independent token, so concurrent ceremonies never clobber each other.
const makeChallengeAuthority = (
  ttlMs = CHALLENGE_TTL_MS,
): {
  issue: (flow: ChallengeFlow) => string;
  verify: (token: string, flow: ChallengeFlow) => boolean;
} => {
  // Per-process secret: a restart invalidates any in-flight ceremony.
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
      nonce: randomBytes(16).toString("base64url"),
      expiry: Date.now() + ttlMs,
      flow,
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
    let payload: { expiry?: unknown; flow?: unknown };
    try {
      payload = JSON.parse(body);
    } catch {
      return false;
    }
    return (
      payload.flow === flow &&
      typeof payload.expiry === "number" &&
      Date.now() <= payload.expiry
    );
  };

  return { issue, verify };
};

const ClientDataView = type({ "clientDataJSON?": "string" });

const ChallengeView = type({ "challenge?": "string" });

const challengeFromResponse = (response: unknown): string | undefined => {
  const view = ClientDataView(response);
  if (view instanceof type.errors) return undefined;
  const { clientDataJSON } = view;
  if (clientDataJSON === undefined) return undefined;
  try {
    const data = ChallengeView(
      JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")),
    );
    if (data instanceof type.errors) return undefined;
    return data.challenge;
  } catch {
    return undefined;
  }
};

const makeAuthService = (authDb: DatabaseSync): AuthService => {
  const authority = makeChallengeAuthority();

  const registrationOptions = (
    rp: RpConfig,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> =>
    generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: "owner",
      challenge: authority.issue("register"),
      attestationType: "none",
      // ES256 + RS256; excludes Ed25519 which some runtimes can't verify.
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

  const verifyRegistration = async (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ): Promise<VerifyResult> => {
    const expectedChallenge = challengeFromResponse(body.response);
    if (
      expectedChallenge === undefined ||
      !authority.verify(expectedChallenge, "register")
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

  const loginOptions = (
    rp: RpConfig,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> => {
    const creds = listCredentials(authDb);
    return generateAuthenticationOptions({
      rpID: rp.rpID,
      challenge: authority.issue("login"),
      allowCredentials: creds.map((c) => ({
        id: c.id,
        type: "public-key",
        transports: toTransports(c.transports),
      })),
      userVerification: "preferred",
    });
  };

  const verifyLogin = async (
    rp: RpConfig,
    body: AuthenticationResponseJSON,
  ): Promise<VerifyResult> => {
    const expectedChallenge = challengeFromResponse(body.response);
    if (
      expectedChallenge === undefined ||
      !authority.verify(expectedChallenge, "login")
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

export type { AuthService, RpConfig, VerifyResult };
export { makeAuthService, makeChallengeAuthority };
