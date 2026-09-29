import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
  withPage,
} from "../harness.js";

// API tokens: the bearer credentials non-browser clients send in the
// Authorization header. Covers the whole chain end-to-end over real HTTP —
// the gate's bearer branch (valid/garbage/expired/revoked), the JSON-401
// (never login-redirect) contract for /api/*, the /auth/tokens minting UI
// driven in a real browser, and the JSON surface the tokens unlock.

type SessionJson = { id: string; name: string };

const runApiTokensSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-apitok-");
    fx.seedSessions(env, [
      { id: "at-1", name: "Token Session", workingDir: env.scratchDir },
    ]);
    fx.seedMessages(env, "at-1", [
      { role: "user", content: [{ type: "text", text: "draft the notes" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "here are the notes" }],
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const bearerFetch = (path: string, token: string): Promise<Response> =>
    fetch(`${env.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });

  // One row from the server's api_tokens table, by token name.
  const tokenRow = (
    name: string,
  ): { id: string; last_used_at: string | null } | undefined => {
    const db = new DatabaseSync(env.dbs.authDb, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT id, last_used_at FROM api_tokens WHERE name = ?")
        .get(name) as { id: string; last_used_at: string | null } | undefined;
      return row;
    } finally {
      db.close();
    }
  };

  // Reads the first complete SSE frame off a raw request whose only
  // credential is the bearer header (no session cookie).
  const readFirstSseFrame = async (
    path: string,
    token: string,
  ): Promise<string> => {
    const res = await fetch(`${env.baseUrl}${path}`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    if (res.body === null) throw new Error("no response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("\n\n")) return buf;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return buf;
  };

  describe("bearer gate", () => {
    it("admits a valid API token to the JSON API", async () => {
      const token = seedApiToken(env.dbs.authDb, "suite-valid");
      const res = await bearerFetch("/api/sessions", token);
      expect(res.status).toBe(200);
      const sessions = (await res.json()) as SessionJson[];
      expect(sessions.some((s) => s.id === fx.viewId("at-1"))).toBe(true);
    });

    it("records last_used_at when a token is used", async () => {
      const token = seedApiToken(env.dbs.authDb, "suite-touched");
      await bearerFetch("/api/sessions", token);
      const row = tokenRow("suite-touched");
      expect(row).toBeDefined();
      expect(row?.last_used_at).not.toBeNull();
    });

    it("rejects a garbage bearer token with a JSON 401", async () => {
      const res = await bearerFetch("/api/sessions", "not-a-real-token");
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({
        error: "Missing or invalid bearer token.",
      });
    });

    it("lets an invalid bearer outrank a valid session cookie", async () => {
      // The header is the explicit credential: a script that sends a stale
      // token must fail, not silently ride the browser cookie.
      const res = await fetch(`${env.baseUrl}/api/sessions`, {
        headers: { cookie: env.cookie, authorization: "Bearer wrong" },
        redirect: "manual",
      });
      expect(res.status).toBe(401);
    });

    it("rejects an expired token", async () => {
      const token = seedApiToken(env.dbs.authDb, "suite-expired", -60);
      const res = await bearerFetch("/api/sessions", token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Missing or invalid bearer token.",
      });
    });

    it("rejects a revoked token", async () => {
      const token = seedApiToken(env.dbs.authDb, "suite-revoked");
      expect((await bearerFetch("/api/sessions", token)).status).toBe(200);
      const row = tokenRow("suite-revoked");
      expect(row).toBeDefined();
      const res = await authedFetch(env, `/auth/tokens/${row?.id}/revoke`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect((await bearerFetch("/api/sessions", token)).status).toBe(401);
    });

    it("admits a session cookie to /api routes too", async () => {
      const res = await authedFetch(env, "/api/sessions");
      expect(res.status).toBe(200);
      const sessions = (await res.json()) as SessionJson[];
      expect(sessions.length).toBeGreaterThan(0);
    });
  });

  describe("unauthenticated requests", () => {
    it("answers 401 JSON for /api routes instead of redirecting", async () => {
      const res = await fetch(`${env.baseUrl}/api/sessions`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("still redirects browser routes to the login page", async () => {
      const res = await fetch(`${env.baseUrl}/`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/login");
    });
  });

  describe("token management UI", () => {
    it("keeps the tokens page behind the session gate", async () => {
      const anon = await fetch(`${env.baseUrl}/auth/tokens`, {
        redirect: "manual",
      });
      expect(anon.status).toBe(302);
      expect(anon.headers.get("location")).toBe("/auth/login");
      const res = await authedFetch(env, "/auth/tokens");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("API tokens");
    });

    it("rejects an empty token name without minting", async () => {
      const res = await authedFetch(env, "/auth/tokens", {
        method: "POST",
        body: new URLSearchParams({ name: "   " }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("1–64 characters");
      expect(tokenRow("")).toBeUndefined();
    });

    it("mints a token in the browser, uses it, and revokes it", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/auth/tokens`);
        await page.locator('input[name="name"]').fill("browser-minted");
        await page.locator('button[type="submit"]').click();
        await page.locator(".token-value").waitFor();
        const token = await page.locator("#api-token").getAttribute("value");
        // glv_at_ + 43 base64url chars; only the hash is ever stored.
        expect(token).toMatch(/^glv_at_[A-Za-z0-9_-]{43}$/);
        const row = tokenRow("browser-minted");
        expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
        expect(row?.id).not.toBe(token);

        expect((await bearerFetch("/api/sessions", token ?? "")).status).toBe(
          200,
        );

        await page
          .locator("li[data-token-id]", { hasText: "browser-minted" })
          .locator("button")
          .click();
        await page
          .locator("li[data-token-id]", { hasText: "browser-minted" })
          .waitFor({ state: "detached" });
        expect((await bearerFetch("/api/sessions", token ?? "")).status).toBe(
          401,
        );
      });
    });
  });

  describe("JSON API surface", () => {
    it("serves a session detail with its parsed messages", async () => {
      const res = await authedFetch(env, `/api/sessions/${fx.viewId("at-1")}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session: SessionJson;
        messages: { role: string }[];
      };
      expect(body.session.id).toBe(fx.viewId("at-1"));
      expect(body.session.name).toBe("Token Session");
      expect(body.messages.length).toBe(2);
      expect(body.messages[0]?.role).toBe("user");
    });

    it("answers 404 JSON for an unknown session", async () => {
      const res = await authedFetch(env, "/api/sessions/nope");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });

    it("streams SSE to a bearer-only client", async () => {
      const token = seedApiToken(env.dbs.authDb, "suite-sse");
      const frame = await readFirstSseFrame("/events/status", token);
      expect(frame).toContain("event: sync");
    });
  });
};

export { runApiTokensSuite };
