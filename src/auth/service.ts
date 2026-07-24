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
  addCredential,
  type CredentialSummary,
  consumeEnrollmentToken,
  createEnrollmentToken,
  createOwner,
  createSession,
  deleteSession,
  enrollmentTokenValid,
  getCredential,
  isClaimed,
  listCredentialSummaries,
  listCredentials,
  type NewCredential,
  ownerUserId,
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
  ownerUserId: () => string | undefined;
  registrationOptions: (
    rp: RpConfig,
  ) => Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration: (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ) => Promise<VerifyResult>;
  verifyEnrollment: (
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
  issueEnrollmentToken: () => string | undefined;
  isEnrollmentTokenValid: (token: string) => boolean;
  consumeEnrollmentToken: (token: string) => string | undefined;
  listCredentialSummaries: () => CredentialSummary[];
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

// Enrollment links live longer than a challenge because the owner opens them on
// a different device/domain minutes after generating them.
const ENROLLMENT_TTL_SECONDS = 15 * 60;

type ChallengeFlow = "register" | "login";

// Single-use WebAuthn challenges held only in process memory. The
// authenticator signs and returns the challenge; the server consumes it on
// success, so a verified challenge can never be replayed within its TTL.
const makeChallengeAuthority = (
  ttlMs = CHALLENGE_TTL_MS,
): {
  issue: (flow: ChallengeFlow) => Uint8Array<ArrayBuffer>;
  verify: (token: string, flow: ChallengeFlow) => boolean;
} => {
  const pending = new Map<string, { flow: ChallengeFlow; expiry: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [key, record] of pending)
      if (record.expiry <= now) pending.delete(key);
  };

  const issue = (flow: ChallengeFlow): Uint8Array<ArrayBuffer> => {
    // Return raw bytes — SimpleWebAuthn encodes the challenge itself, so
    // the store keys on the resulting base64url, not a pre-encoded string.
    sweep();
    const bytes = randomBytes(32);
    pending.set(bytes.toString("base64url"), {
      flow,
      expiry: Date.now() + ttlMs,
    });
    return Uint8Array.from(bytes);
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

type VerifiedCredential = {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
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

  // Shared verification for both the initial claim and enrollment: validates
  // the challenge + signature and returns the verified credential, leaving the
  // decision of *where* to store it (new owner vs. existing owner) to callers.
  const verifyRegistrationCore = async (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ): Promise<
    | { verified: true; credential: VerifiedCredential; transports: string[] }
    | { verified: false; error: string }
  > => {
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
    return {
      verified: true,
      credential,
      transports: body.response.transports ?? [],
    };
  };

  const toNewCredential = (
    credential: VerifiedCredential,
    transports: string[],
  ): NewCredential => ({
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports,
  });

  const verifyRegistration = async (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ): Promise<VerifyResult> => {
    const result = await verifyRegistrationCore(rp, body);
    if (!result.verified) return { verified: false, error: result.error };
    const userId = createOwner(
      authDb,
      toNewCredential(result.credential, result.transports),
    );
    const token = createSession(authDb, userId);
    return { verified: true, token };
  };

  const verifyEnrollment = async (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ): Promise<VerifyResult> => {
    const ownerId = ownerUserId(authDb);
    if (ownerId === undefined)
      return { verified: false, error: "This app has no owner yet." };
    const result = await verifyRegistrationCore(rp, body);
    if (!result.verified) return { verified: false, error: result.error };
    addCredential(
      authDb,
      ownerId,
      toNewCredential(result.credential, result.transports),
    );
    const token = createSession(authDb, ownerId);
    return { verified: true, token };
  };

  const loginOptions = (
    rp: RpConfig,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> => {
    const creds = listCredentials(authDb);
    // Every credential is offered regardless of its origin: the authenticator
    // only signs for the credential whose stored RP-ID hash matches the current
    // rpID, so credentials minted for other domains are harmlessly ignored.
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

  const issueEnrollmentToken = (): string | undefined => {
    const id = ownerUserId(authDb);
    return id === undefined
      ? undefined
      : createEnrollmentToken(authDb, id, ENROLLMENT_TTL_SECONDS);
  };

  return {
    isClaimed: () => isClaimed(authDb),
    ownerUserId: () => ownerUserId(authDb),
    registrationOptions,
    verifyRegistration,
    verifyEnrollment,
    loginOptions,
    verifyLogin,
    issueEnrollmentToken,
    isEnrollmentTokenValid: (token: string) =>
      enrollmentTokenValid(authDb, token),
    consumeEnrollmentToken: (token: string) =>
      consumeEnrollmentToken(authDb, token),
    listCredentialSummaries: () => listCredentialSummaries(authDb),
    isValidSession,
    logout,
  };
};

const COOKIE_NAME = "glv_session";

// Every static asset is served under a single prefix so the auth gate can
// whitelist them as a group without naming each file individually.
const ASSET_PREFIX = "/assets/";

// Management routes (add/view passkeys) require an existing session, unlike the
// rest of /auth/* which is the public auth gate itself. Enrollment redemption
// (/auth/enroll/:token) stays public because it authorizes via a bearer token.
const isPublicPath = (path: string): boolean =>
  path === "/auth" ||
  (path.startsWith("/auth/") && !path.startsWith("/auth/devices")) ||
  path.startsWith(ASSET_PREFIX);

// Reconstructs the browser-visible URL, honoring the standard reverse-proxy
// headers. Behind a TLS-terminating proxy the backend hop is plain HTTP, so
// without this the RP origin would compute as http:// and WebAuthn verification
// would reject the real https:// assertion. Headers are only trusted when the
// proxy sends them; the app is passkey-gated, so a spoofed origin cannot forge
// an assertion (the authenticator still enforces the RP binding).
const firstForwardedValue = (
  header: string | undefined,
): string | undefined => {
  if (header === undefined || header === "") return undefined;
  const first = header.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
};

const resolveRequestUrl = (c: Context): URL => {
  const url = new URL(c.req.url);
  const host = firstForwardedValue(c.req.header("x-forwarded-host"));
  if (host !== undefined) url.host = host;
  const proto = firstForwardedValue(c.req.header("x-forwarded-proto"));
  if (proto !== undefined) url.protocol = `${proto}:`;
  return url;
};

const setSessionCookie = (c: Context, token: string): void => {
  const url = resolveRequestUrl(c);
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

export type { AuthService, CredentialSummary, RpConfig, VerifyResult };
export {
  authMiddleware,
  COOKIE_NAME,
  makeAuthService,
  makeChallengeAuthority,
  resolveRequestUrl,
  setSessionCookie,
};
