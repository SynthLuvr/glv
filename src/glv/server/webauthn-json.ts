import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { type } from "arktype";

// Runtime validation for the WebAuthn verify endpoints' JSON bodies — the
// boundary Fastify hands over as `unknown`. The schemas mirror
// @simplewebauthn/server's ResponseJSON interfaces (esm/types/index.d.ts):
// verified structure only; @simplewebauthn re-validates every
// base64url/binary field itself and its errors surface as the endpoints'
// friendly 400s. `prf.results` is omitted because it cannot be serialized
// to JSON (BufferSource), so no honest JSON body ever carries it.

const ClientExtensionResults = type({
  "appid?": "boolean",
  "credProps?": type({
    "rk?": "boolean",
  }),
  "hmacCreateSecret?": "boolean",
  "prf?": type({
    "enabled?": "boolean",
  }),
});

const RegistrationBody = type({
  id: "string",
  rawId: "string",
  response: {
    clientDataJSON: "string",
    attestationObject: "string",
    "authenticatorData?": "string",
    "transports?": "string[]",
    "publicKeyAlgorithm?": "number",
    "publicKey?": "string",
  },
  "authenticatorAttachment?": "'cross-platform' | 'platform'",
  clientExtensionResults: ClientExtensionResults,
  type: "'public-key'",
});

const AuthenticationBody = type({
  id: "string",
  rawId: "string",
  response: {
    clientDataJSON: "string",
    authenticatorData: "string",
    signature: "string",
    "userHandle?": "string",
  },
  "authenticatorAttachment?": "'cross-platform' | 'platform'",
  clientExtensionResults: ClientExtensionResults,
  type: "'public-key'",
});

const parseRegistration = (
  body: unknown,
): RegistrationResponseJSON | undefined => {
  const parsed = RegistrationBody(body);
  return parsed instanceof type.errors ? undefined : parsed;
};

const parseAuthentication = (
  body: unknown,
): AuthenticationResponseJSON | undefined => {
  const parsed = AuthenticationBody(body);
  return parsed instanceof type.errors ? undefined : parsed;
};

export { parseAuthentication, parseRegistration };
