import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isRecord } from "./http.js";

// Boundary parsing for the WebAuthn verify endpoints.
//
// The application/json content parser hands handlers the raw body string
// (see server/index.tsx), so parsing happens here — a body that is not
// valid JSON, or not an object with a `response` object, is reported as
// malformed by the endpoint. Deeper shape is deliberately NOT asserted:
// @simplewebauthn validates every field (base64url payloads, credential
// ids, attestation structure) and its errors surface as the endpoints'
// friendly 400s. The integration suites pin this contract — forged
// partial bodies (only `response.clientDataJSON`) must reach the
// verifier so it can reject them on challenge ownership, not on shape.

const parseJson = (body: unknown): unknown => {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const isRegistrationJson = (
  value: unknown,
): value is RegistrationResponseJSON =>
  isRecord(value) && isRecord(value.response);

const isAuthenticationJson = (
  value: unknown,
): value is AuthenticationResponseJSON =>
  isRecord(value) && isRecord(value.response);

const parseRegistration = (
  body: unknown,
): RegistrationResponseJSON | undefined => {
  const parsed = parseJson(body);
  return isRegistrationJson(parsed) ? parsed : undefined;
};

const parseAuthentication = (
  body: unknown,
): AuthenticationResponseJSON | undefined => {
  const parsed = parseJson(body);
  return isAuthenticationJson(parsed) ? parsed : undefined;
};

export { parseAuthentication, parseRegistration };
