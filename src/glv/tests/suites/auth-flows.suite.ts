import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type FlavorFixture, type IntegrationEnv } from "../harness.js";
import { makeSoftwareAuthenticator } from "../webauthn-authenticator.js";

// Exercises the real WebAuthn stack end-to-end over HTTP: options issuance,
// registration (claim), enrollment links, devices, login, challenge
// single-use, signature/origin/counter rejection, and logout. The "client"
// is a software authenticator producing genuine ES256-signed ceremonies —
// no function is mocked; the server verifies real cryptography.

type OptionsJson = {
  challenge: string;
  rp?: { id?: string };
  allowCredentials?: { id: string }[];
};

const runAuthFlowsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  const owner = makeSoftwareAuthenticator();
  const phone = makeSoftwareAuthenticator();
  const stranger = makeSoftwareAuthenticator();

  // The harness pre-seeds an owner session; these tests need a brand-new,
  // unclaimed app, so the owner/session rows are cleared. The server
  // re-reads the tables on every request and created the full schema at
  // boot, so this leaves a clean, unclaimed auth DB behind.
  const resetAuthDb = (path: string): void => {
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM credentials");
    db.exec("DELETE FROM users");
    db.exec("DELETE FROM enrollment_tokens");
    db.close();
  };

  const get = (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${env.baseUrl}${path}`, { redirect: "manual", headers });

  const postJson = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${env.baseUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const registerOptions = async (): Promise<OptionsJson> => {
    const res = await get("/auth/register/options");
    expect(res.status).toBe(200);
    return (await res.json()) as OptionsJson;
  };

  const loginOptions = async (): Promise<OptionsJson> => {
    const res = await get("/auth/login/options");
    expect(res.status).toBe(200);
    return (await res.json()) as OptionsJson;
  };

  const sessionTokenOf = (res: Response): string => {
    const setCookie = res.headers.getSetCookie();
    const row = setCookie.find((c) => c.startsWith(`${env.cookieName}=`));
    if (row === undefined) throw new Error("response set no session cookie");
    return row.slice(env.cookieName.length + 1).split(";")[0];
  };

  const cookie = (token: string): string => `${env.cookieName}=${token}`;

  beforeAll(async () => {
    env = await fx.startEnv("glv-authflows-");
    resetAuthDb(env.dbs.authDb);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("unclaimed app", () => {
    it("redirects unauthenticated requests to registration, not login", async () => {
      const res = await get("/");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/register");
    });

    it("serves the register page and redirects login to register", async () => {
      const page = await get("/auth/register");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("passkey-button");
      const login = await get("/auth/login");
      expect(login.status).toBe(302);
      expect(login.headers.get("location")).toBe("/auth/register");
    });

    it("derives the RP from x-forwarded proxy headers", async () => {
      const res = await get("/auth/register/options", {
        "x-forwarded-host": "staging.example.com",
        "x-forwarded-proto": "https",
      });
      expect(res.status).toBe(200);
      const options = (await res.json()) as OptionsJson;
      expect(options.rp?.id).toBe("staging.example.com");
    });

    it("issues a fresh challenge per options request", async () => {
      const first = await registerOptions();
      const second = await registerOptions();
      expect(first.challenge).not.toBe(second.challenge);
    });
  });

  describe("claiming the app", () => {
    let claimToken = "";

    it("rejects a registration without an issued challenge", async () => {
      const res = await postJson("/auth/register/verify", {
        ...owner.registrationResponse({
          challenge: "never-issued-by-this-server",
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { verified: boolean; error: string };
      expect(body.verified).toBe(false);
      expect(body.error).toContain("No registration in progress");
    });

    it("rejects a malformed verification body", async () => {
      const res = await postJson("/auth/register/verify", "{not json");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { verified: boolean };
      expect(body.verified).toBe(false);
    });

    it("claims the app with a genuine passkey registration", async () => {
      const options = await registerOptions();
      const res = await postJson(
        "/auth/register/verify",
        owner.registrationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { verified: boolean };
      expect(body.verified).toBe(true);
      claimToken = sessionTokenOf(res);
      expect(claimToken).not.toBe("");
    });

    it("closes registration once the app is claimed", async () => {
      expect((await get("/auth/register/options")).status).toBe(403);
      expect((await get("/auth/register")).status).toBe(302);
      expect((await postJson("/auth/register/verify", {})).status).toBe(403);
    });

    it("admits the session cookie minted by registration", async () => {
      const home = await get("/", { cookie: cookie(claimToken) });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Sessions");
    });

    it("lists the registered passkey on the devices page", async () => {
      const res = await get("/auth/devices", { cookie: cookie(claimToken) });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(owner.credentialId.slice(0, 12));
    });
  });

  describe("device enrollment", () => {
    let claimToken = "";
    let enrollToken = "";

    // The claim cookie from the previous describe (re-derived here because
    // describes cannot share locals) — a fresh login is not needed, any
    // valid owner session unlocks device management.
    beforeAll(async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        owner.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(200);
      claimToken = sessionTokenOf(res);
    });

    it("mints a single-use enrollment link", async () => {
      const res = await fetch(`${env.baseUrl}/auth/devices`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: cookie(claimToken) },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      const match = /id="enroll-token" value="([^"]+)"/.exec(html);
      expect(match).not.toBeNull();
      enrollToken = match?.[1] ?? "";
      expect(html).toContain(`/auth/enroll/${enrollToken}`);
    });

    it("rejects enrollment pages for unknown tokens", async () => {
      const res = await get("/auth/enroll/definitely-not-a-token");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/login");
      expect(
        (await get("/auth/enroll/definitely-not-a-token/options")).status,
      ).toBe(403);
      expect(
        (await postJson("/auth/enroll/definitely-not-a-token/verify", {}))
          .status,
      ).toBe(400);
    });

    it("serves the enroll page and its registration options", async () => {
      const page = await get(`/auth/enroll/${enrollToken}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("passkey-button");
      expect(html).toContain(enrollToken);

      const options = await get(`/auth/enroll/${enrollToken}/options`);
      expect(options.status).toBe(200);
      expect(((await options.json()) as OptionsJson).challenge).not.toBe("");
    });

    it("keeps the link alive after a failed ceremony", async () => {
      const res = await postJson(
        `/auth/enroll/${enrollToken}/verify`,
        phone.registrationResponse({
          challenge: "bogus-challenge",
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(400);
      // The token must not be burned by a failure — retry must be possible.
      expect((await get(`/auth/enroll/${enrollToken}/options`)).status).toBe(
        200,
      );
    });

    it("enrolls a second passkey through the link", async () => {
      const options = await get(`/auth/enroll/${enrollToken}/options`);
      const body = (await options.json()) as OptionsJson;
      const res = await postJson(
        `/auth/enroll/${enrollToken}/verify`,
        phone.registrationResponse({
          challenge: body.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { verified: boolean }).verified).toBe(true);
      expect(sessionTokenOf(res)).not.toBe("");

      // Single-use: only a successful enrollment burns the link.
      expect((await get(`/auth/enroll/${enrollToken}`)).status).toBe(302);
      expect((await get(`/auth/enroll/${enrollToken}/options`)).status).toBe(
        403,
      );
    });

    it("lists both passkeys once enrolled", async () => {
      const res = await get("/auth/devices", { cookie: cookie(claimToken) });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(owner.credentialId.slice(0, 12));
      expect(html).toContain(phone.credentialId.slice(0, 12));
    });

    it("degrades gracefully when stored transports are corrupt", async () => {
      const db = new DatabaseSync(env.dbs.authDb);
      db.prepare("UPDATE credentials SET transports = ? WHERE id = ?").run(
        "not-json",
        owner.credentialId,
      );
      db.close();
      const res = await get("/auth/devices", { cookie: cookie(claimToken) });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(phone.credentialId.slice(0, 12));
      expect(env.serverStderr()).toContain("[glv:auth]");
    });
  });

  describe("login", () => {
    it("offers every registered credential as an allow-list entry", async () => {
      const options = await loginOptions();
      const ids = (options.allowCredentials ?? []).map((c) => c.id);
      expect(ids).toContain(owner.credentialId);
      expect(ids).toContain(phone.credentialId);
    });

    it("rejects a malformed login body", async () => {
      expect((await postJson("/auth/login/verify", "}{")).status).toBe(400);
    });

    it("rejects an unknown credential", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        stranger.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { verified: boolean; error: string };
      expect(body.error).toContain("Unknown credential");
    });

    it("rejects an assertion signed for a foreign origin", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        owner.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: "https://evil.example",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { verified: boolean; error: string };
      expect(body.error).toContain("origin");
    });

    it("logs in with a genuine assertion and admits the cookie", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        owner.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(200);
      const token = sessionTokenOf(res);

      const home = await get("/", { cookie: cookie(token) });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Sessions");
    });

    it("rejects a replayed assertion (the challenge is single-use)", async () => {
      const options = await loginOptions();
      const assertion = owner.authenticationResponse({
        challenge: options.challenge,
        rpId: "localhost",
        origin: env.baseUrl,
      });
      expect((await postJson("/auth/login/verify", assertion)).status).toBe(
        200,
      );
      const replay = await postJson("/auth/login/verify", assertion);
      expect(replay.status).toBe(400);
      const body = (await replay.json()) as {
        verified: boolean;
        error: string;
      };
      expect(body.error).toContain("No login in progress");
    });

    it("rejects a cloned authenticator (counter regression)", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        owner.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
          count: 1,
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { verified: boolean; error: string };
      expect(body.error).toContain("counter");
    });

    it("keeps the passkey usable after the rejected clones", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        owner.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
          count: 9999,
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { verified: boolean }).verified).toBe(true);
    });

    it("logs out and invalidates the session", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        phone.authenticationResponse({
          challenge: options.challenge,
          rpId: "localhost",
          origin: env.baseUrl,
        }),
      );
      expect(res.status).toBe(200);
      const token = sessionTokenOf(res);

      const logout = await fetch(`${env.baseUrl}/auth/logout`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: cookie(token) },
      });
      expect(logout.status).toBe(302);
      expect(logout.headers.get("location")).toBe("/auth/login");

      const after = await get("/", { cookie: cookie(token) });
      expect(after.status).toBe(302);
      expect(after.headers.get("location")).toBe("/auth/login");
    });
  });
};

export { runAuthFlowsSuite };
