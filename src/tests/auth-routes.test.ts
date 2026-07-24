import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOwner,
  createSession,
  openAuthDb,
  validSession,
} from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { createRunner, DEFAULT_RUNNER_CONFIG } from "../runner/index.js";
import { createApp } from "../server/index.js";

const SESSIONS_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP
);
`;

let sessionsDb: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-auth-routes-"));
  sessionsDb = new DatabaseSync(join(dir, "sessions.db"));
  sessionsDb.exec(SESSIONS_SCHEMA);
});

afterAll(() => {
  sessionsDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = (authDbPath: string) =>
  createApp(sessionsDb, createRunner(DEFAULT_RUNNER_CONFIG), {
    auth: makeAuthService(openAuthDb(authDbPath)),
  });

describe("unclaimed app — registration flow", () => {
  let authDir: string;

  beforeAll(() => {
    authDir = mkdtempSync(join(tmpdir(), "glv-auth-unclaimed-"));
  });

  afterAll(() => {
    rmSync(authDir, { recursive: true, force: true });
  });

  it("redirects unauthenticated / to the registration page", async () => {
    const res = await makeApp(join(authDir, "a.db")).request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/register");
  });

  it("serves the registration screen", async () => {
    const res = await makeApp(join(authDir, "b.db")).request("/auth/register");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Claim this app");
    expect(html).toContain("Create passkey");
  });

  it("returns registration options with a challenge and rp name", async () => {
    const res = await makeApp(join(authDir, "c.db")).request(
      "/auth/register/options",
    );
    expect(res.status).toBe(200);
    const options = await res.json();
    expect(options.challenge).toBeTruthy();
    expect(options.rp.name).toBe("Goose Log Viewer");
    expect(options.user.name).toBe("owner");
  });

  it("serves the passkey client script", async () => {
    const res = await makeApp(join(authDir, "d.db")).request(
      "/assets/passkey.js",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("returns a structured 400 on malformed registration JSON", async () => {
    const res = await makeApp(join(authDir, "e.db")).request(
      "/auth/register/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.verified).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("rejects registration verification without a valid challenge", async () => {
    const res = await makeApp(join(authDir, "f.db")).request(
      "/auth/register/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toContain("No registration in progress");
  });
});

describe("claimed app — login flow", () => {
  let authDb: DatabaseSync;
  let authDir: string;
  let ownerId: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    authDir = mkdtempSync(join(tmpdir(), "glv-auth-claimed-routes-"));
    const authDbPath = join(authDir, "auth.db");
    authDb = openAuthDb(authDbPath);
    ownerId = createOwner(authDb, {
      id: "cred-route",
      publicKey: new Uint8Array([5, 6]),
      counter: 1,
      transports: ["internal"],
    });
    app = createApp(sessionsDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      auth: makeAuthService(authDb),
    });
  });

  afterAll(() => {
    authDb.close();
    rmSync(authDir, { recursive: true, force: true });
  });

  it("redirects unauthenticated / to the login page", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("redirects /auth/register to /auth/login", async () => {
    const res = await app.request("/auth/register");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("blocks registration options with 403 after claiming", async () => {
    const res = await app.request("/auth/register/options");
    expect(res.status).toBe(403);
  });

  it("blocks registration verification with 403 after claiming", async () => {
    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("returns login options with a challenge", async () => {
    const res = await app.request("/auth/login/options");
    expect(res.status).toBe(200);
    const options = await res.json();
    expect(options.challenge).toBeTruthy();
    expect(options.allowCredentials).toHaveLength(1);
  });

  it("accepts a challenge issued by the login options endpoint", async () => {
    const optsRes = await app.request("/auth/login/options");
    const { challenge } = await optsRes.json();
    // Echo the server's challenge back exactly as an authenticator would.
    // The credential is intentionally unknown, but a valid challenge must get
    // past the "No login in progress" gate to the credential lookup.
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: "http://localhost",
      }),
    ).toString("base64url");
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "no-such-credential",
        rawId: Buffer.from("no-such-credential").toString("base64url"),
        response: {
          clientDataJSON,
          authenticatorData: "",
          signature: "",
          userHandle: null,
        },
        type: "public-key",
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.verified).toBe(false);
    // Reaching the credential lookup proves the challenge round-tripped.
    expect(json.error).toBe("Unknown credential.");
  });

  it("returns a structured 400 on malformed login JSON", async () => {
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.verified).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("serves the login screen", async () => {
    const res = await app.request("/auth/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Welcome back");
  });

  it("grants access with a valid session cookie", async () => {
    const token = createSession(authDb, ownerId);
    const res = await app.request("/", {
      headers: { Cookie: `glv_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Goose Sessions");
  });

  it("re-issues the session cookie on each authenticated request", async () => {
    const token = createSession(authDb, ownerId);
    const res = await app.request("/", {
      headers: { Cookie: `glv_session=${token}` },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("glv_session="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`glv_session=${token}`);
    expect(cookie?.toLowerCase()).toContain("max-age=86400");
  });

  it("rejects an unknown session cookie", async () => {
    const res = await app.request("/", {
      headers: { Cookie: "glv_session=bogus-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("logs out, deleting the session and redirecting to login", async () => {
    const token = createSession(authDb, ownerId);
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `glv_session=${token}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    expect(validSession(authDb, token)).toBe(false);
  });

  it("allows static assets without authentication", async () => {
    const res = await app.request("/assets/app.css");
    expect(res.status).toBe(200);
  });

  it("rejects login verification without a valid challenge", async () => {
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toContain("No login in progress");
  });
});

describe("claimed app — multi-origin enrollment", () => {
  let authDb: DatabaseSync;
  let authDir: string;
  let app: ReturnType<typeof createApp>;
  let sessionToken: string;

  beforeAll(() => {
    authDir = mkdtempSync(join(tmpdir(), "glv-auth-enroll-"));
    const authDbPath = join(authDir, "auth.db");
    authDb = openAuthDb(authDbPath);
    const ownerId = createOwner(authDb, {
      id: "cred-enroll-owner",
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ["internal"],
    });
    sessionToken = createSession(authDb, ownerId);
    app = createApp(sessionsDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      auth: makeAuthService(authDb),
    });
  });

  afterAll(() => {
    authDb.close();
    rmSync(authDir, { recursive: true, force: true });
  });

  const authHeaders = (): { Cookie: string } => ({
    Cookie: `glv_session=${sessionToken}`,
  });

  // POSTing the devices form mints a single-use enrollment link; the token is
  // echoed in a machine-readable element so the test can extract it.
  const issueEnrollToken = async (): Promise<string> => {
    const res = await app.request("/auth/devices", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/id="enroll-token" value="([^"]+)"/);
    if (match === null || match[1] === undefined)
      throw new Error("enrollment token not found in devices page");
    return match[1];
  };

  it("redirects unauthenticated /auth/devices to login", async () => {
    const res = await app.request("/auth/devices");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("lists passkeys when authenticated", async () => {
    const res = await app.request("/auth/devices", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Passkeys");
  });

  it("issues an enrollment link with a token", async () => {
    const token = await issueEnrollToken();
    expect(token).toBeTruthy();
  });

  it("serves the enrollment page for a valid token", async () => {
    const token = await issueEnrollToken();
    const res = await app.request(`/auth/enroll/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Add a passkey");
    expect(html).toContain(token);
  });

  it("returns registration options for a valid token", async () => {
    const token = await issueEnrollToken();
    const res = await app.request(`/auth/enroll/${token}/options`);
    expect(res.status).toBe(200);
    const options = await res.json();
    expect(options.challenge).toBeTruthy();
    expect(options.rp.name).toBe("Goose Log Viewer");
  });

  it("redirects an unknown enrollment token to login", async () => {
    const res = await app.request("/auth/enroll/no-such-token");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("rejects options for an unknown enrollment token", async () => {
    const res = await app.request("/auth/enroll/no-such-token/options");
    expect(res.status).toBe(403);
  });

  it("does not burn the token on a failed verification", async () => {
    const token = await issueEnrollToken();
    const res = await app.request(`/auth/enroll/${token}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.verified).toBe(false);
    // A failed ceremony must leave the link redeemable.
    expect(json.error).toContain("No registration in progress");
    const retry = await app.request(`/auth/enroll/${token}`);
    expect(retry.status).toBe(200);
  });

  it("treats a redeemed token as invalid", async () => {
    const token = await issueEnrollToken();
    authDb
      .prepare(
        "UPDATE enrollment_tokens SET used_at = datetime('now') WHERE id = ?",
      )
      .run(token);
    const page = await app.request(`/auth/enroll/${token}`);
    expect(page.status).toBe(302);
    const options = await app.request(`/auth/enroll/${token}/options`);
    expect(options.status).toBe(403);
  });
});
