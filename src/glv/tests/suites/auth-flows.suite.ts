import { DatabaseSync } from "node:sqlite";
import { type BrowserContext, expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type FlavorFixture, type IntegrationEnv } from "../harness.js";

// The "client" is a real headless Chromium: Playwright's virtual WebAuthn
// authenticator (BrowserContext.credentials) answers the page's own
// navigator.credentials.create()/get() ceremonies, so the real passkey.js
// posts genuine ES256-signed responses and the server verifies real
// cryptography over real HTTP — no function is mocked.
//
// Attacks a well-behaved authenticator cannot produce (unissued challenge,
// unknown credential, foreign origin, replay) are driven over HTTP: the
// server rejects each before it ever inspects a signature, so fabricated
// bodies with garbage signatures reach exactly the checks under test. The
// clone test tampers the *stored* counter instead of the authenticator's:
// the next genuine assertion then fails the server's counter check.

type OptionsJson = {
  challenge: string;
  rp?: { id?: string };
  allowCredentials?: { id: string }[];
};

const runAuthFlowsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  // Credential ids the two browser "devices" register; the first context
  // claims the app, the second enrolls through the single-use link.
  let ownerCred = "";
  let phoneCred = "";
  let phoneContext: BrowserContext | undefined;
  let claimToken = "";

  // The harness pre-seeds an owner session; these tests need a brand-new,
  // unclaimed app. The server created the full schema at boot and re-reads
  // the tables on every request, so clearing them after boot is safe.
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

  // A login body whose clientDataJSON names a genuinely-issued challenge,
  // with everything else attacker-controlled. The server consumes the
  // challenge, then rejects on credential lookup or origin — each before
  // any signature is inspected, so a garbage signature suffices.
  const forgedLogin = (id: string, challenge: string, origin: string) => ({
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin,
          crossOrigin: false,
        }),
        "utf8",
      ).toString("base64url"),
      authenticatorData: "",
      signature: "",
    },
  });

  // The registration counterpart: a well-shaped clientDataJSON naming a
  // challenge this server never issued. The challenge authority rejects it
  // before any WebAuthn verification runs.
  const forgedRegistration = (challenge: string) => ({
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin: env.baseUrl,
          crossOrigin: false,
        }),
        "utf8",
      ).toString("base64url"),
    },
  });

  // Clicks the passkey button on an auth page and waits for the success
  // redirect to "/". The virtual authenticator installed on the context
  // answers the ceremony; `onVerifyBody` observes the exact JSON the page
  // posts (captured for the replay test).
  const passkeyCeremony = async (
    context: BrowserContext,
    path: string,
    onVerifyBody?: (body: string) => void,
  ): Promise<void> => {
    const page = await context.newPage();
    if (onVerifyBody !== undefined)
      page.on("request", (req) => {
        if (req.method() === "POST" && req.url().endsWith("/verify"))
          onVerifyBody(req.postData() ?? "");
      });
    try {
      await page.goto(`${env.baseUrl}${path}`);
      await page.click("#passkey-button");
      await page.waitForURL(`${env.baseUrl}/`);
    } finally {
      await page.close();
    }
  };

  // A rejected ceremony keeps the page on the auth screen with the
  // server's error rendered in #auth-error.
  const rejectedCeremonyError = async (
    context: BrowserContext,
    path: string,
  ): Promise<string> => {
    const page = await context.newPage();
    try {
      await page.goto(`${env.baseUrl}${path}`);
      await page.click("#passkey-button");
      await page.waitForSelector("#auth-error:not([hidden])");
      return (await page.textContent("#auth-error")) ?? "";
    } finally {
      await page.close();
    }
  };

  // The session cookie a successful ceremony left in a browser context.
  const contextSessionToken = async (
    context: BrowserContext,
  ): Promise<string> => {
    const row = (await context.cookies()).find(
      (c) => c.name === env.cookieName,
    );
    if (row === undefined)
      throw new Error("browser context holds no session cookie");
    return row.value;
  };

  // The single passkey a context's virtual authenticator has created so far.
  const soleCredentialOf = async (context: BrowserContext): Promise<string> => {
    const creds = await context.credentials.get({ rpId: "localhost" });
    if (creds.length !== 1)
      throw new Error(`expected one credential, found ${creds.length}`);
    return creds[0].id;
  };

  // A second browser context models the owner's other device: its own
  // virtual authenticator, holding only the passkey it enrolls.
  const secondDevice = async (): Promise<BrowserContext> => {
    const browser = env.context.browser();
    if (browser === null) throw new Error("browser handle unavailable");
    const context = await browser.newContext();
    await context.credentials.install();
    return context;
  };

  const storedCounter = (credId: string): number => {
    const db = new DatabaseSync(env.dbs.authDb, { readOnly: true });
    const row = db
      .prepare("SELECT counter AS c FROM credentials WHERE id = ?")
      .get(credId) as { c: number } | undefined;
    db.close();
    if (row === undefined) throw new Error(`no stored credential ${credId}`);
    return row.c;
  };

  const setStoredCounter = (credId: string, counter: number): void => {
    const db = new DatabaseSync(env.dbs.authDb);
    db.prepare("UPDATE credentials SET counter = ? WHERE id = ?").run(
      counter,
      credId,
    );
    db.close();
  };

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

  const verificationBody = async (
    res: Response,
  ): Promise<{ verified: boolean; error: string }> =>
    (await res.json()) as { verified: boolean; error: string };

  const cookie = (token: string): string => `${env.cookieName}=${token}`;

  beforeAll(async () => {
    env = await fx.startEnv("glv-authflows-");
    resetAuthDb(env.dbs.authDb);
    // Install before any page touches navigator.credentials.
    await env.context.credentials.install();
  }, 90000);

  afterAll(async () => {
    await phoneContext?.close();
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
      const loginPage = await get("/auth/login");
      expect(loginPage.status).toBe(302);
      expect(loginPage.headers.get("location")).toBe("/auth/register");
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
    it("rejects a registration without an issued challenge", async () => {
      const res = await postJson(
        "/auth/register/verify",
        forgedRegistration("never-issued-by-this-server"),
      );
      expect(res.status).toBe(400);
      const body = await verificationBody(res);
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
      await passkeyCeremony(env.context, "/auth/register");
      ownerCred = await soleCredentialOf(env.context);
      claimToken = await contextSessionToken(env.context);
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
      expect(await res.text()).toContain(ownerCred.slice(0, 12));
    });
  });

  describe("device enrollment", () => {
    let enrollToken = "";

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
        forgedRegistration("bogus-challenge"),
      );
      expect(res.status).toBe(400);
      // A failed ceremony must not burn the token — retry stays possible.
      expect((await get(`/auth/enroll/${enrollToken}/options`)).status).toBe(
        200,
      );
    });

    it("enrolls a second passkey through the link", async () => {
      phoneContext = await secondDevice();
      await passkeyCeremony(phoneContext, `/auth/enroll/${enrollToken}`);
      phoneCred = await soleCredentialOf(phoneContext);
      expect(phoneCred).not.toBe("");
      expect(await contextSessionToken(phoneContext)).not.toBe("");

      // Only a successful enrollment burns the link.
      expect((await get(`/auth/enroll/${enrollToken}`)).status).toBe(302);
      expect((await get(`/auth/enroll/${enrollToken}/options`)).status).toBe(
        403,
      );
    });

    it("lists both passkeys once enrolled", async () => {
      const res = await get("/auth/devices", { cookie: cookie(claimToken) });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(ownerCred.slice(0, 12));
      expect(html).toContain(phoneCred.slice(0, 12));
    });

    it("degrades gracefully when stored transports are corrupt", async () => {
      const db = new DatabaseSync(env.dbs.authDb);
      db.prepare("UPDATE credentials SET transports = ? WHERE id = ?").run(
        "not-json",
        ownerCred,
      );
      db.close();
      const res = await get("/auth/devices", { cookie: cookie(claimToken) });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(phoneCred.slice(0, 12));
      expect(env.serverStderr()).toContain("[glv:auth]");
    });
  });

  describe("login", () => {
    it("offers every registered credential as an allow-list entry", async () => {
      const options = await loginOptions();
      const ids = (options.allowCredentials ?? []).map((c) => c.id);
      expect(ids).toContain(ownerCred);
      expect(ids).toContain(phoneCred);
    });

    it("rejects a malformed login body", async () => {
      expect((await postJson("/auth/login/verify", "}{")).status).toBe(400);
    });

    it("rejects an unknown credential", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        forgedLogin(
          "definitely-not-a-registered-credential",
          options.challenge,
          env.baseUrl,
        ),
      );
      expect(res.status).toBe(400);
      const body = await verificationBody(res);
      expect(body.error).toContain("Unknown credential");
    });

    it("rejects an assertion claiming a foreign origin", async () => {
      const options = await loginOptions();
      const res = await postJson(
        "/auth/login/verify",
        forgedLogin(ownerCred, options.challenge, "https://evil.example"),
      );
      expect(res.status).toBe(400);
      const body = await verificationBody(res);
      expect(body.error).toContain("origin");
    });

    it("logs in with a genuine assertion and admits the cookie", async () => {
      // The owner context's authenticator holds only the owner passkey,
      // so the assertion it signs is unambiguous.
      await passkeyCeremony(env.context, "/auth/login");
      const token = await contextSessionToken(env.context);

      const home = await get("/", { cookie: cookie(token) });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Sessions");
    });

    it("rejects a replayed assertion (the challenge is single-use)", async () => {
      let assertionBody = "";
      await passkeyCeremony(env.context, "/auth/login", (body) => {
        assertionBody = body;
      });
      expect(assertionBody).not.toBe("");
      const replay = await postJson("/auth/login/verify", assertionBody);
      expect(replay.status).toBe(400);
      const body = await verificationBody(replay);
      expect(body.error).toContain("No login in progress");
    });

    it("rejects a cloned authenticator (counter regression)", async () => {
      // A clone using the credential elsewhere leaves the stored counter
      // far ahead; the next genuine assertion then fails to advance past
      // it, exactly as a counter regression does.
      const genuine = storedCounter(ownerCred);
      setStoredCounter(ownerCred, genuine + 5000);
      const error = await rejectedCeremonyError(env.context, "/auth/login");
      expect(error).toContain("counter");
      setStoredCounter(ownerCred, genuine);
    });

    it("keeps the passkey usable after the rejected clones", async () => {
      await passkeyCeremony(env.context, "/auth/login");
    });

    it("logs out and invalidates the session", async () => {
      // The second device holds only the phone passkey, so its browser
      // login mints a phone session.
      const context = phoneContext;
      if (context === undefined) throw new Error("phone context missing");
      await passkeyCeremony(context, "/auth/login");
      const token = await contextSessionToken(context);

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
