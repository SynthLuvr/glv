import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type FlavorFixture, type IntegrationEnv } from "../harness.js";

const runCookieIsolationSuite = (fx: FlavorFixture): void => {
  // Browsers scope cookies by host and ignore the port, so glv and a sibling
  // app on different localhost ports share one cookie jar entry. These tests
  // run two viewers on distinct auth databases to reproduce the "can only log
  // in to one viewer at a time" bug a fixed cookie name would cause.
  let envA: IntegrationEnv;
  let envB: IntegrationEnv;

  beforeAll(async () => {
    // Separate scratch dirs give each server its own auth database.
    envA = await fx.startEnv("glv-cookie-a-");
    envB = await fx.startEnv("glv-cookie-b-");
  }, 120000);

  afterAll(async () => {
    // LIFO so the PATH mutations from the two mocked binaries unwind in order.
    await envB?.cleanup();
    await envA?.cleanup();
  });

  // /auth/logout is public and always clears the session cookie, so its
  // Set-Cookie header reveals the cookie name without importing server
  // internals.
  const discoverCookieName = async (env: IntegrationEnv): Promise<string> => {
    const res = await fetch(`${env.baseUrl}/auth/logout`, {
      method: "POST",
      redirect: "manual",
    });
    const setCookie = res.headers.getSetCookie()[0] ?? "";
    const name = setCookie.split("=")[0];
    expect(name).not.toBe("");
    return name;
  };

  const getRoot = async (
    env: IntegrationEnv,
    cookie: string,
  ): Promise<Response> =>
    fetch(`${env.baseUrl}/`, { redirect: "manual", headers: { cookie } });

  describe("session cookie isolation between sibling viewers", () => {
    it("derives a distinct session cookie name per auth database", async () => {
      const nameA = await discoverCookieName(envA);
      const nameB = await discoverCookieName(envB);
      expect(nameA).not.toBe(nameB);
    });

    it("keeps both viewers logged in when they share a browser cookie jar", async () => {
      const nameA = await discoverCookieName(envA);
      const nameB = await discoverCookieName(envB);

      // A browser jar is keyed by host, never port, so it sends every stored
      // cookie to both servers. Map.set replacing same-key values models the
      // overwrite a shared cookie name would cause.
      const jar = new Map<string, string>();
      jar.set(nameA, envA.dbs.token);
      jar.set(nameB, envB.dbs.token);
      const cookie = [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");

      expect((await getRoot(envA, cookie)).status).toBe(200);
      expect((await getRoot(envB, cookie)).status).toBe(200);
    });

    it("rejects a session token minted by the sibling viewer", async () => {
      // The two auth databases are separate token namespaces, so B's cookie
      // must never authenticate against A.
      const nameB = await discoverCookieName(envB);
      const res = await getRoot(envA, `${nameB}=${envB.dbs.token}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/login");
    });
  });
};

export { runCookieIsolationSuite };
