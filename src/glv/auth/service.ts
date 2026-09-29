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
import { headerValue } from "../server/http.js";
import { errorMessage } from "../util.js";
import {
  API_TOKEN_TTL_SECONDS,
  type ApiTokenSummary,
  addCredential,
  apiTokenValid,
  type CredentialSummary,
  consumeEnrollmentToken,
  createApiToken,
  createEnrollmentToken,
  createOwner,
  createSession,
  deleteSession,
  enrollmentTokenValid,
  getCredential,
  isClaimed,
  listApiTokenSummaries,
  listCredentialSummaries,
  listCredentials,
  type NewCredential,
  ownerUserId,
  refreshSession,
  revokeApiToken,
  SESSION_TTL_SECONDS,
  touchApiToken,
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
  // API tokens (bearer credentials for curl/CI): minted against the
  // owner, validated as hashes, revoked and listed by their hash id.
  createApiToken: (name: string) => string | undefined;
  isValidApiToken: (token: string) => boolean;
  touchApiToken: (token: string) => void;
  revokeApiToken: (id: string) => void;
  listApiTokenSummaries: () => ApiTokenSummary[];
  readSessionCookie: (request: FastifyRequest) => string | undefined;
  setSessionCookie: (
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ) => void;
  isValidSession: (token: string | undefined) => boolean;
  logout: (request: FastifyRequest, reply: FastifyReply) => void;
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

  const readSessionCookie = (request: FastifyRequest): string | undefined =>
    request.cookies[cookieName];

  const setSessionCookie = (
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ): void => {
    const url = resolveRequestUrl(request);
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  };

  const logout = (request: FastifyRequest, reply: FastifyReply): void => {
    const token = request.cookies[cookieName];
    if (token !== undefined && token !== "") deleteSession(authDb, token);
    reply.clearCookie(cookieName, { path: "/" });
  };

  const issueEnrollmentToken = (): string | undefined => {
    const id = ownerUserId(authDb);
    return id === undefined
      ? undefined
      : createEnrollmentToken(authDb, id, ENROLLMENT_TTL_SECONDS);
  };

  // Returns the raw token exactly once; only its hash is persisted.
  // undefined when there is no owner to attach it to.
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
    createApiToken: (name: string) => {
      const id = ownerUserId(authDb);
      return id === undefined
        ? undefined
        : createApiToken(authDb, id, name, API_TOKEN_TTL_SECONDS);
    },
    isValidApiToken: (token: string) => apiTokenValid(authDb, token),
    touchApiToken: (token: string) => touchApiToken(authDb, token),
    revokeApiToken: (id: string) => revokeApiToken(authDb, id),
    listApiTokenSummaries: () => listApiTokenSummaries(authDb),
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

// Management routes (add/view passkeys, mint/revoke API tokens) require an
// existing session, unlike the rest of /auth/* which is the public auth gate
// itself. Enrollment redemption (/auth/enroll/:token) stays public because it
// authorizes via a bearer token.
const isPublicPath = (path: string): boolean =>
  path === "/auth" ||
  (path.startsWith("/auth/") &&
    !path.startsWith("/auth/devices") &&
    !path.startsWith("/auth/tokens")) ||
  path.startsWith(ASSET_PREFIX);

// Reconstructs the browser-visible URL, honoring the standard reverse-proxy
// headers. Behind a TLS-terminating proxy the backend hop is plain HTTP, so
// without this the RP origin would compute as http:// and WebAuthn verification
// would reject the real https:// assertion. Headers are only trusted when the
// proxy sends them; the app is passkey-gated, so a spoofed origin cannot forge
// an assertion (the authenticator still enforces the RP binding).
const firstForwardedValue = (
  header: string | string[] | undefined,
): string | undefined => {
  const first = headerValue(header)?.split(",")[0]?.trim();
  return first === "" ? undefined : first;
};

const resolveRequestUrl = (request: FastifyRequest): URL => {
  // The Host header carries the port (localhost:3457); Fastify's
  // request.hostname does not, and a portless origin would fail WebAuthn
  // origin verification on every non-standard port.
  const host = headerValue(request.headers.host) ?? "localhost";
  const url = new URL(request.raw.url ?? "/", `http://${host}`);
  const forwardedHost = firstForwardedValue(
    request.headers["x-forwarded-host"],
  );
  if (forwardedHost !== undefined) url.host = forwardedHost;
  const proto = firstForwardedValue(request.headers["x-forwarded-proto"]);
  if (proto !== undefined) url.protocol = `${proto}:`;
  return url;
};

// The JSON API surface for non-browser clients (curl, CI). Requests to
// it answer 401 JSON instead of the 302 to the HTML login page — a
// redirect would let a misconfigured script "succeed" while parsing the
// login page's markup.
const API_PREFIX = "/api/";

// Extracts the token from an `Authorization: Bearer <token>` header
// (scheme case-insensitive per RFC 9110). Anything else — a different
// scheme, a missing token — is "no bearer present", so the request falls
// through to the cookie path like any browser request.
const bearerToken = (request: FastifyRequest): string | undefined => {
  const raw = headerValue(request.headers.authorization);
  if (raw === undefined) return undefined;
  const space = raw.indexOf(" ");
  if (space <= 0) return undefined;
  const scheme = raw.slice(0, space);
  const token = raw.slice(space + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || token === "") return undefined;
  return token;
};

// Fastify onRequest hook; registered inside the route scope so it runs
// after @fastify/cookie's root-level parse hook. Every non-public request
// must carry a valid session before any route handler runs.
const authMiddleware =
  (auth: AuthService) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = request.url.split("?")[0];
    if (isPublicPath(path)) return;
    // Bearer credentials (API tokens) are checked before the cookie: a
    // request that carries one is a programmatic client, and an invalid
    // one must fail as JSON, never fall through to a login redirect.
    const bearer = bearerToken(request);
    if (bearer !== undefined) {
      if (!auth.isValidApiToken(bearer)) {
        await reply
          .status(401)
          .send({ error: "Missing or invalid bearer token." });
        return;
      }
      auth.touchApiToken(bearer);
      return;
    }
    const token = auth.readSessionCookie(request);
    if (token !== undefined && auth.isValidSession(token)) {
      // Sliding window: re-issue the cookie so the browser expiry tracks
      // the just-refreshed DB session rather than the original login.
      auth.setSessionCookie(request, reply, token);
      return;
    }
    // No credential of any kind: browser routes redirect to the auth
    // screens, JSON API routes answer in their own dialect.
    if (path.startsWith(API_PREFIX)) {
      await reply.status(401).send({ error: "Authentication required." });
      return;
    }
    const dest = auth.isClaimed() ? "/auth/login" : "/auth/register";
    await reply.redirect(dest);
  };

export type {
  ApiTokenSummary,
  AuthService,
  CredentialSummary,
  RpConfig,
  VerifyResult,
};
export {
  authMiddleware,
  makeAuthService,
  resolveRequestUrl,
  sessionCookieName,
};
