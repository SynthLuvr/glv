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

const makeAuthService = (authDb: DatabaseSync): AuthService => {
  // Single-user app: only one in-flight challenge is needed at a time. The
  // options endpoint stores it; the verify endpoint consumes it.
  let currentChallenge: string | undefined;

  const storeChallenge = (challenge: string): void => {
    currentChallenge = challenge;
  };

  const takeChallenge = (): string | undefined => {
    const challenge = currentChallenge;
    currentChallenge = undefined;
    return challenge;
  };

  const registrationOptions = async (
    rp: RpConfig,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> => {
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: "owner",
      attestationType: "none",
      // ES256 + RS256; excludes Ed25519 which some runtimes can't verify.
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    storeChallenge(options.challenge);
    return options;
  };

  const verifyRegistration = async (
    rp: RpConfig,
    body: RegistrationResponseJSON,
  ): Promise<VerifyResult> => {
    const expectedChallenge = takeChallenge();
    if (expectedChallenge === undefined)
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
      allowCredentials: creds.map((c) => ({
        id: c.id,
        type: "public-key",
        transports: toTransports(c.transports),
      })),
      userVerification: "preferred",
    });
    storeChallenge(options.challenge);
    return options;
  };

  const verifyLogin = async (
    rp: RpConfig,
    body: AuthenticationResponseJSON,
  ): Promise<VerifyResult> => {
    const expectedChallenge = takeChallenge();
    if (expectedChallenge === undefined)
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
    // Sliding window with an absolute cap: refresh on every authenticated
    // request. validSession already rejected sessions past their hard
    // lifetime, and refreshSession never extends expires_at past it.
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
export { makeAuthService };
