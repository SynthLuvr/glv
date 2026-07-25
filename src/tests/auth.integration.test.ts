import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  startIntegrationEnv,
} from "./integration-harness";

let env: IntegrationEnv;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-auth-");
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

// The harness pre-seeds an owner, so the app is "claimed": unauthenticated
// requests are redirected to the login page rather than registration.
const noCookie = (path: string): Promise<Response> =>
  fetch(`${env.baseUrl}${path}`, { redirect: "manual" });

describe("auth gate", () => {
  it("redirects an unauthenticated root request to the login page", async () => {
    const res = await noCookie("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("redirects an invalid session cookie to the login page", async () => {
    const res = await fetch(`${env.baseUrl}/`, {
      redirect: "manual",
      headers: { cookie: "glv_session=bogus" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("admits a request carrying a valid session cookie", async () => {
    const res = await fetch(`${env.baseUrl}/`, {
      redirect: "manual",
      headers: { cookie: env.cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sessions");
  });
});

describe("auth pages", () => {
  it("renders the login page with a passkey button", async () => {
    const res = await noCookie("/auth/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("passkey-button");
  });

  it("redirects registration to login once the app is claimed", async () => {
    const res = await noCookie("/auth/register");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });
});

describe("device management gate", () => {
  it("requires a session to view passkey devices", async () => {
    expect((await noCookie("/auth/devices")).status).toBe(302);
    const res = await fetch(`${env.baseUrl}/auth/devices`, {
      redirect: "manual",
      headers: { cookie: env.cookie },
    });
    expect(res.status).toBe(200);
  });

  it("logs out and clears the session cookie", async () => {
    const res = await fetch(`${env.baseUrl}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: env.cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    // The session cookie is overwritten with an empty value to expire it.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("glv_session=");
  });
});
