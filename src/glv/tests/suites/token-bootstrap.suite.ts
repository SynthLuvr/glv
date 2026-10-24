import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type Databases,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// End-to-end for the loopback-only HTTP token bootstrap (issue #365):
// flag-off boots answer POST /api/tokens exactly like an unknown /api
// route; flag-on boots mint from loopback (decided on the socket
// address — forwarded headers never consulted) and the fresh token
// drives the JSON API; non-loopback peers, blank names, and ownerless
// apps are refused; minting is rate-bounded; and the existing revoke
// surface kills a bootstrapped token.

type MintedToken = { token: string; name: string };

// The host's own non-loopback address, when it has one: serve binds the
// wildcard, so connecting to it from this machine yields exactly the
// non-loopback TCP peer the bootstrap must refuse. Loopback-only hosts
// skip that one test.
const nonLoopbackLocalAddress = (): string | undefined => {
  for (const addrs of Object.values(networkInterfaces()))
    for (const addr of addrs ?? []) if (!addr.internal) return addr.address;
  return undefined;
};

const NON_LOOPBACK = nonLoopbackLocalAddress();

const runTokenBootstrapSuite = (fx: FlavorFixture): void => {
  const startFlaggedEnv = (
    prefix: string,
    prepareDbs?: (dbs: Databases) => void,
  ): Promise<IntegrationEnv> =>
    fx.startEnv(prefix, undefined, undefined, undefined, prepareDbs, [
      "--allow-token-bootstrap",
    ]);

  const postBootstrap = (
    env: IntegrationEnv,
    init: RequestInit = {},
    hostOverride?: string,
  ): Promise<Response> => {
    const base =
      hostOverride === undefined
        ? env.baseUrl
        : env.baseUrl.replace("localhost", hostOverride);
    return fetch(`${base}/api/tokens`, {
      method: "POST",
      redirect: "manual",
      ...init,
    });
  };

  const jsonMint = (name: string, headers: Record<string, string> = {}) => ({
    headers: { "content-type": "application/json", ...headers },
    // "" sends an empty object — the missing-name case.
    body: JSON.stringify(name === "" ? {} : { name }),
  });

  const authRow = <T>(
    env: IntegrationEnv,
    sql: string,
    ...args: string[]
  ): T | undefined => {
    const db = new DatabaseSync(env.dbs.authDb, { readOnly: true });
    try {
      return db.prepare(sql).get(...args) as T | undefined;
    } finally {
      db.close();
    }
  };

  const tokenRow = (
    env: IntegrationEnv,
    name: string,
  ): { id: string } | undefined =>
    authRow<{ id: string }>(
      env,
      "SELECT id FROM api_tokens WHERE name = ?",
      name,
    );

  const apiTokenCount = (env: IntegrationEnv): number =>
    authRow<{ n: number }>(env, "SELECT COUNT(*) AS n FROM api_tokens")?.n ?? 0;

  describe("flag off (default)", () => {
    let env: IntegrationEnv;

    beforeAll(async () => {
      env = await fx.startEnv("glv-tokboot-off-");
    }, 180000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("answers POST /api/tokens exactly like an unknown /api route", async () => {
      // Indistinguishability is the invariant: with the flag off the
      // route does not exist, so a probe learns nothing — same status,
      // body, and content type as any never-route (today: the auth
      // gate's JSON 401, never a mint).
      const probe = async (
        path: string,
      ): Promise<{ status: number; body: string; type: string | null }> => {
        const res = await fetch(`${env.baseUrl}${path}`, {
          method: "POST",
          redirect: "manual",
        });
        return {
          status: res.status,
          body: await res.text(),
          type: res.headers.get("content-type"),
        };
      };
      const bootstrap = await probe("/api/tokens");
      const unknown = await probe("/api/never-a-route");
      expect(bootstrap).toEqual(unknown);
      expect(bootstrap.status).toBe(401);
    });

    it("stays unknown to an authenticated bearer too", async () => {
      const token = seedApiToken(env.dbs.authDb, "flag-off-probe");
      const res = await bearerFetch(env, "/api/tokens", token, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("mentions no bootstrap in the boot output", () => {
      expect(env.serverStderr()).not.toContain("token bootstrap");
    });
  });

  describe("flag on", () => {
    let env: IntegrationEnv;

    beforeAll(async () => {
      env = await startFlaggedEnv("glv-tokboot-on-");
    }, 180000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("warns about the proxy trap at boot", () => {
      const stderr = env.serverStderr();
      expect(stderr).toContain("token bootstrap");
      expect(stderr).toContain("reverse proxy");
    });

    it("mints from loopback and the fresh token drives the API", async () => {
      const res = await postBootstrap(env, jsonMint("remote agent"));
      expect(res.status).toBe(201);
      const body = (await res.json()) as MintedToken;
      expect(body.name).toBe("remote agent");
      // glv_at_ + 43 base64url chars, returned exactly once.
      expect(body.token).toMatch(/^glv_at_[A-Za-z0-9_-]{43}$/);
      // Hash-only storage: the row id is the SHA-256 of the plaintext.
      const row = tokenRow(env, "remote agent");
      expect(row?.id).toBe(
        createHash("sha256").update(body.token).digest("hex"),
      );
      // The filesystem-less bootstrap story: the HTTP-minted bearer is
      // the sole credential, and it works.
      const sessions = await bearerFetch(env, "/api/sessions", body.token);
      expect(sessions.status).toBe(200);
    });

    it("ignores x-forwarded-for — the peer is the socket address", async () => {
      // A forged forwarded header must neither upgrade nor downgrade a
      // loopback peer: an implementation trusting the header over
      // request.raw.socket.remoteAddress fails here.
      const res = await postBootstrap(
        env,
        jsonMint("forwarded spoof", { "x-forwarded-for": "203.0.113.9" }),
      );
      expect(res.status).toBe(201);
    });

    it("accepts the form spellings curl sends", async () => {
      const urlencoded = await postBootstrap(env, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "form minted" }).toString(),
      });
      expect(urlencoded.status).toBe(201);
      const form = new FormData();
      form.append("name", "multipart minted");
      const multipart = await postBootstrap(env, { body: form });
      expect(multipart.status).toBe(201);
    });

    it("refuses a non-loopback TCP peer", {
      skip: NON_LOOPBACK === undefined,
    }, async () => {
      // Bracket IPv6 literals for the URL; IPv4 needs nothing.
      const host = NON_LOOPBACK?.includes(":")
        ? `[${NON_LOOPBACK}]`
        : NON_LOOPBACK;
      const res = await postBootstrap(env, jsonMint("remote attempt"), host);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error:
          "Token bootstrap is limited to loopback peers (127.0.0.1 / ::1).",
      });
    });

    it("rejects a blank or missing name without minting", async () => {
      const before = apiTokenCount(env);
      for (const init of [jsonMint("   "), jsonMint("")]) {
        const res = await postBootstrap(env, init);
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({
          error: "A token name of 1–64 characters is required.",
        });
      }
      expect(apiTokenCount(env)).toBe(before);
    });

    it("revokes a bootstrapped token from the existing surface", async () => {
      const res = await postBootstrap(env, jsonMint("doomed token"));
      expect(res.status).toBe(201);
      const { token } = (await res.json()) as MintedToken;
      expect((await bearerFetch(env, "/api/sessions", token)).status).toBe(200);
      const row = tokenRow(env, "doomed token");
      expect(row).toBeDefined();
      const revoke = await authedFetch(env, `/auth/tokens/${row?.id}/revoke`, {
        method: "POST",
      });
      expect(revoke.status).toBe(200);
      expect((await bearerFetch(env, "/api/sessions", token)).status).toBe(401);
    });
  });

  describe("flag on, no owner", () => {
    let env: IntegrationEnv;

    beforeAll(async () => {
      env = await startFlaggedEnv("glv-tokboot-noowner-", (dbs) => {
        // The app that never had a passkey registered: drop the
        // harness-seeded owner row. node:sqlite enforces the schema's
        // foreign keys, so rows referencing users go first.
        const db = new DatabaseSync(dbs.authDb);
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM credentials");
        db.exec("DELETE FROM api_tokens");
        db.exec("DELETE FROM users");
        db.close();
      });
    }, 180000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("refuses to mint without an owner", async () => {
      const res = await postBootstrap(env, jsonMint("ownerless"));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "This app has no owner yet — register a passkey once, then mint " +
          "tokens.",
      });
      expect(apiTokenCount(env)).toBe(0);
    });
  });

  describe("mint valve", () => {
    let env: IntegrationEnv;

    beforeAll(async () => {
      env = await startFlaggedEnv("glv-tokboot-valve-");
    }, 180000);

    afterAll(async () => {
      await env?.cleanup();
    });

    it("bounds minting to 10 per rolling minute", async () => {
      const statuses: number[] = [];
      for (let i = 1; i <= 11; i++) {
        const res = await postBootstrap(env, jsonMint(`valve ${i}`));
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
      expect(statuses[10]).toBe(429);
      const refused = await postBootstrap(env, jsonMint("valve 12"));
      expect(await refused.json()).toEqual({
        error:
          "Token bootstrap is limited to 10 mints per minute; " +
          "retry shortly.",
      });
    });
  });
};

export { runTokenBootstrapSuite };
