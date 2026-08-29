import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

// A WebAuthn "software authenticator": a real P-256 key pair whose private
// half signs genuine ES256 assertions, wrapped in hand-built (but spec-
// shaped) attestation/assertion responses. This lets the integration suites
// drive the server's real verification path — @simplewebauthn/server parses
// and cryptographically checks every byte — without mocking any function.

type CeremonyInput = {
  /** base64url challenge returned by the server's options endpoint. */
  challenge: string;
  rpId: string;
  origin: string;
  /**
   * Assertion-only override of the signature counter (a real authenticator
   * can never move it backwards; negative tests use this to impersonate a
   * clone). Omitted → the internal counter advances by one.
   */
  count?: number;
};

type SoftwareAuthenticator = {
  /** base64url credential id, stable across ceremonies. */
  readonly credentialId: string;
  /** A `webauthn.create` response (fmt "none": no attestation signature). */
  readonly registrationResponse: (
    input: CeremonyInput,
  ) => RegistrationResponseJSON;
  /** A `webauthn.get` response; the signature counter advances per call. */
  readonly authenticationResponse: (
    input: CeremonyInput,
  ) => AuthenticationResponseJSON;
};

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// --- Minimal CBOR encoder ---------------------------------------------------
// Only the item shapes a WebAuthn registration needs: unsigned/negative
// integers, byte/text strings, and maps. Keys are emitted in canonical
// order (shortest encoding first) as genuine CBOR requires.

const cborHead = (major: number, arg: number): number[] => {
  const mt = major << 5;
  if (arg < 24) return [mt | arg];
  if (arg < 0x100) return [mt | 24, arg];
  if (arg < 0x10000) return [mt | 25, (arg >> 8) & 0xff, arg & 0xff];
  return [
    mt | 26,
    (arg >>> 24) & 0xff,
    (arg >>> 16) & 0xff,
    (arg >>> 8) & 0xff,
    arg & 0xff,
  ];
};

const cborInt = (value: number): number[] =>
  value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);

const cborBytes = (bytes: Uint8Array): number[] => [
  ...cborHead(2, bytes.length),
  ...bytes,
];

const cborText = (text: string): number[] => {
  const encoded = Buffer.from(text, "utf8");
  return [...cborHead(3, encoded.length), ...encoded];
};

type CborItem = number | Uint8Array | string | CborPair[];

type CborPair = [CborItem, CborItem];

const cborItem = (item: CborItem): number[] => {
  if (typeof item === "number") return cborInt(item);
  if (typeof item === "string") return cborText(item);
  if (Array.isArray(item)) return cborMap(item);
  return cborBytes(item);
};

const cborMap = (pairs: CborPair[]): number[] => [
  ...cborHead(5, pairs.length),
  ...pairs.flatMap(([key, value]) => [...cborItem(key), ...cborItem(value)]),
];

// COSE ES256 key: { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
// emitted in canonical key order.
const coseEs256Key = (x: Uint8Array, y: Uint8Array): Uint8Array =>
  new Uint8Array(
    cborMap([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );

// Attestation object for the "none" format: the verifier requires an empty
// attStmt and checks the attested credential data inside authData.
const attestationObject = (authData: Uint8Array): Uint8Array =>
  new Uint8Array(
    cborMap([
      ["fmt", "none"],
      ["attStmt", []],
      ["authData", authData],
    ]),
  );

const rpIdHashOf = (rpId: string): Uint8Array =>
  createHash("sha256").update(rpId, "utf8").digest();

const counterBytes = (count: number): Uint8Array =>
  new Uint8Array([
    (count >>> 24) & 0xff,
    (count >>> 16) & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ]);

const clientData = (
  type: "webauthn.create" | "webauthn.get",
  input: CeremonyInput,
): Uint8Array =>
  Buffer.from(
    JSON.stringify({
      type,
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false,
    }),
    "utf8",
  );

// UP | UV | AT — the flags @simplewebauthn expects for a registration.
const REG_FLAGS = 0x45;
// UP | UV — attestations are absent from assertion authData.
const AUTH_FLAGS = 0x05;
const TRANSPORTS: AuthenticatorTransportFuture[] = ["internal", "hybrid"];

const makeSoftwareAuthenticator = (): SoftwareAuthenticator => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const rawId = randomBytes(32);
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  const y = new Uint8Array(Buffer.from(jwk.y, "base64url"));
  const coseKey = coseEs256Key(x, y);
  let signCount = 0;

  const registrationAuthData = (rpId: string): Uint8Array =>
    concat(
      rpIdHashOf(rpId),
      new Uint8Array([REG_FLAGS]),
      counterBytes(0),
      new Uint8Array(16), // AAGUID (all zeroes)
      new Uint8Array([0, rawId.length]), // credential id length
      rawId,
      coseKey,
    );

  const registrationResponse = (
    input: CeremonyInput,
  ): RegistrationResponseJSON => {
    const clientDataJSON = clientData("webauthn.create", input);
    const response = {
      clientDataJSON: b64url(clientDataJSON),
      attestationObject: b64url(
        attestationObject(registrationAuthData(input.rpId)),
      ),
      transports: TRANSPORTS,
    };
    return {
      id: b64url(rawId),
      rawId: b64url(rawId),
      type: "public-key",
      response,
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  };

  const authenticationResponse = (
    input: CeremonyInput,
  ): AuthenticationResponseJSON => {
    signCount = input.count ?? signCount + 1;
    const clientDataJSON = clientData("webauthn.get", input);
    const authData = concat(
      rpIdHashOf(input.rpId),
      new Uint8Array([AUTH_FLAGS]),
      counterBytes(signCount),
    );
    // WebAuthn signs authenticatorData || SHA-256(clientDataJSON).
    const signed = concat(
      authData,
      createHash("sha256").update(clientDataJSON).digest(),
    );
    const signer = createSign("SHA256");
    signer.update(signed);
    const response = {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(signer.sign(privateKey)),
      userHandle: undefined,
    };
    return {
      id: b64url(rawId),
      rawId: b64url(rawId),
      type: "public-key",
      response,
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  };

  return {
    credentialId: b64url(rawId),
    registrationResponse,
    authenticationResponse,
  };
};

export type { SoftwareAuthenticator };
export { makeSoftwareAuthenticator };
