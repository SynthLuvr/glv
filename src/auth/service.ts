import { randomBytes } from "node:crypto";
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
import { type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  createOwner,
  createSession,
  deleteSession,
  getCredential,
  isClaimed,
  listCredentials,
  type NewCredential,
  refreshSession,
  SESSION_TTL_SECONDS,
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

// Single-use WebAuthn challenges held only in process memory. The
// authenticator signs and returns the challenge; the server consumes it on
// success, so a verified challenge can never be replayed within its TTL.
const makeChallengeAuthority = (
  ttlMs = CHALLENGE_TTL_MS,
): {
  issue: (flow: ChallengeFlow) => string;
  verify: (token: string, flow: ChallengeFlow) => boolean;
} => {
  const pending = new Map<string, { flow: ChallengeFlow; expiry: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [key, record] of pending)
      if (record.expiry <= now) pending.delete(key);
  };

  const issue = (flow: ChallengeFlow): string => {
    sweep();
    const challenge = randomBytes(32).toString("base64url");
    pending.set(challenge, { flow, expiry: Date.now() + ttlMs });
    return challenge;
  };

  const verify = (token: string, flow: ChallengeFlow): boolean => {
    const record = pending.get(token);
    if (record === undefined) return false;
    if (record.flow !== flow || Date.now() > record.expiry) return false;
    pending.delete(token);
    return true;
  };

  return { issue, verify };
};

const ClientDataView = type({ clientDataJSON: "string" });

const ChallengeView = type({ challenge: "string" });

const challengeFromResponse = (response: unknown): string | undefined => {
  const view = ClientDataView(response);
  if (view instanceof type.errors) return undefined;
  try {
    const decoded = Buffer.from(view.clientDataJSON, "base64url").toString(
      "utf8",
    );
    const data = ChallengeView(JSON.parse(decoded));
    return data instanceof type.errors ? undefined : data.challenge;
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

const COOKIE_NAME = "glv_session";

// Every static asset is served under a single prefix so the auth gate can
// whitelist them as a group without naming each file individually.
const ASSET_PREFIX = "/assets/";

const isPublicPath = (path: string): boolean =>
  path === "/auth" ||
  path.startsWith("/auth/") ||
  path.startsWith(ASSET_PREFIX);

const setSessionCookie = (c: Context, token: string): void => {
  const url = new URL(c.req.url);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
};

const authMiddleware =
  (auth: AuthService): MiddlewareHandler =>
  async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    const token = getCookie(c, COOKIE_NAME);
    if (token !== undefined && auth.isValidSession(token)) {
      // Sliding window: re-issue the cookie so the browser expiry tracks
      // the just-refreshed DB session rather than the original login.
      setSessionCookie(c, token);
      return next();
    }
    const dest = auth.isClaimed() ? "/auth/login" : "/auth/register";
    return c.redirect(dest, 302);
  };

export type { AuthService, RpConfig, VerifyResult };
export { authMiddleware, COOKIE_NAME, makeAuthService, setSessionCookie };
