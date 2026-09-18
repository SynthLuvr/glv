import "../warnings.js";
// First import on purpose: must evaluate before @simplewebauthn/server —
// its import-time WebCrypto probe is what this module silences.
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type } from "arktype";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pathOf } from "../server/http.js";
import { errorMessage } from "../util.js";
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
  readSessionCookie: (req: FastifyRequest) => string | undefined;
  setSessionCookie: (reply: FastifyReply, token: string) => void;
  isValidSession: (token: string | undefined) => boolean;
  logout: (req: FastifyRequest, reply: FastifyReply) => void;
};

// Stored transports are plain strings; validate each against the WebAuthn
// transport union rather than asserting the whole array sight-unseen. Values
// outside the union are dropped so a malformed record can't reach the
// verifier. v14 of @simplewebauthn/server drops the legacy 'cable' and
// 'smart-card' values from the union, so stored records carrying them fall
// back to no transports.
const Transport = type("'ble' | 'hybrid' | 'internal' | 'nfc' | 'usb'");

const toTransports = (raw: string[]): AuthenticatorTransport[] =>
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
  } catch (err) {
    console.debug("[glv:auth]", err);
    return undefined;
  }
};

type VerifiedCredential = {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
};

const makeAuthService = (
  authDb: DatabaseSync,
  authDbPath: string,
): AuthService => {
  const authority = makeChallengeAuthority();
  const cookieName = sessionCookieName(authDbPath);

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
      return { verified: false, error: errorMessage(err) };
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
      return { verified: false, error: errorMessage(err) };
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

  const readSessionCookie = (req: FastifyRequest): string | undefined =>
    req.cookies[cookieName];

  const setSessionCookie = (reply: FastifyReply, token: string): void => {
    const url = resolveRequestUrl(reply.request);
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  };

  const logout = (req: FastifyRequest, reply: FastifyReply): void => {
    const token = req.cookies[cookieName];
    if (token !== undefined && token !== "") deleteSession(authDb, token);
    reply.clearCookie(cookieName, { path: "/" });
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
    readSessionCookie,
    setSessionCookie,
    isValidSession,
    logout,
  };
};

// Browsers scope cookies by host and ignore the port (RFC 6265 has no port
// isolation), so sibling viewers on localhost share one cookie jar entry;
// with a fixed name, each login overwrites the other app's session. The
// name is derived from the auth DB path so each token namespace gets its
// own cookie; a shared auth DB shares the cookie, which is correct because
// its tokens are mutually valid.
const sessionCookieName = (authDbPath: string): string => {
  const digest = createHash("sha256").update(resolve(authDbPath)).digest("hex");
  return `glv-session-${digest.slice(0, 12)}`;
};

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

const resolveRequestUrl = (req: FastifyRequest): URL => {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.raw.url ?? "/", `http://${host}`);
  const forwardedHost = firstForwardedValue(
    typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"]
      : undefined,
  );
  if (forwardedHost !== undefined) url.host = forwardedHost;
  const forwardedProto = firstForwardedValue(
    typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"]
      : undefined,
  );
  if (forwardedProto !== undefined) url.protocol = `${forwardedProto}:`;
  return url;
};

// Auth gate for every non-public request: a valid session cookie must
// ride along before any route handler runs.
const authGate =
  (auth: AuthService) =>
  async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isPublicPath(pathOf(req))) return;
    const token = auth.readSessionCookie(req);
    if (token !== undefined && auth.isValidSession(token)) {
      // Sliding window: re-issue the cookie so the browser expiry tracks
      // the just-refreshed DB session rather than the original login.
      auth.setSessionCookie(reply, token);
      return;
    }
    const dest = auth.isClaimed() ? "/auth/login" : "/auth/register";
    await reply.redirect(dest, 302);
  };

export type { AuthService, CredentialSummary, RpConfig, VerifyResult };
export { authGate, makeAuthService, resolveRequestUrl, sessionCookieName };
