import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  ROOT,
  spawnLauncherSync,
} from "../harness.js";

// End-to-end for `glv token create|list|revoke` (issue #361): the CLI
// mints through the same createApiToken the browser page uses, the
// printed plaintext works as the sole credential over the live JSON API,
// list shows the stored row, revoke kills it (next request answers
// 401). Guards: no owner yet refuses to mint; a blank name mints
// nothing.

type RunResult = { status: number; stdout: string; stderr: string };

const runTokenCliSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-tokcli-");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  // `glv --auth-db <path> …` against the served instance's own auth
  // database, so CLI writes and server reads observe the same rows.
  const run = (args: string[], authDb = env.dbs.authDb): RunResult => {
    const result = spawnLauncherSync(
      fx.binPath,
      ["--auth-db", authDb, ...args],
      { cwd: ROOT, env: { ...process.env }, encoding: "utf-8" },
    );
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  // One row from the server's api_tokens table, by token name.
  const tokenRow = (
    name: string,
    authDb = env.dbs.authDb,
  ): { id: string; name: string } | undefined => {
    const db = new DatabaseSync(authDb, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT id, name FROM api_tokens WHERE name = ?")
        .get(name) as { id: string; name: string } | undefined;
      return row;
    } finally {
      db.close();
    }
  };

  // A multipart create exactly as curl -F would send it — the first
  // step of the driven loop this token exists for.
  const postCreate = (token: string): Promise<Response> => {
    const form = new FormData();
    form.append("prompt", "cli token bootstrap");
    form.append("working_dir", env.scratchDir);
    form.append("name", "agent bootstrapped");
    return bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: form,
    });
  };

  describe("token create", () => {
    it("mints a token the JSON API accepts, storing only its hash", async () => {
      const { status, stdout, stderr } = run([
        "token",
        "create",
        "--name",
        "cli-minted",
      ]);
      expect(status).toBe(0);
      const token = stdout.trim();
      // glv_at_ + 43 base64url chars; the command's whole stdout is the
      // token so `TOKEN=$(glv token create …)` captures it cleanly.
      expect(token).toMatch(/^glv_at_[A-Za-z0-9_-]{43}$/);
      expect(stdout.split("\n").filter((line) => line.trim() !== "")).toEqual([
        token,
      ]);
      expect(stderr).toContain("shown once");
      const row = tokenRow("cli-minted");
      expect(row?.id).toBe(createHash("sha256").update(token).digest("hex"));
      expect(row?.id).not.toBe(token);

      // The minted credential is enough to read and to start a run
      // against the running server — no browser, no cookie.
      expect((await bearerFetch(env, "/api/sessions", token)).status).toBe(200);
      const created = await postCreate(token);
      expect(created.status).toBe(201);
      expect(created.headers.get("location")).toMatch(/\/api\/sessions\//);
    });

    it("refuses to mint when the app has no owner", () => {
      // A fresh auth database has schema but no owner row: minting
      // underneath a passkey owner is the security model, so it must
      // refuse rather than create a root credential from nothing.
      const ownerless = join(env.scratchDir, "ownerless-auth.db");
      const { status, stdout, stderr } = run(
        ["token", "create", "--name", "no-owner"],
        ownerless,
      );
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("glv_at_");
      expect(stderr).toContain("no owner");
    });

    it("rejects a blank name without minting", () => {
      const { status, stderr } = run(["token", "create", "--name", "   "]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("1–64 characters");
      expect(tokenRow("")).toBeUndefined();
    });
  });

  describe("token list", () => {
    it("lists stored tokens with the id revoke needs", () => {
      const { status, stdout } = run(["token", "list"]);
      expect(status).toBe(0);
      const row = tokenRow("cli-minted");
      expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
      // The full 64-char hash must survive the table — truncated ids
      // would make the printed list unusable for revoke.
      expect(stdout).toContain(row?.id ?? "");
      expect(stdout).toContain("cli-minted");
      expect(stdout).toContain("1 token(s) listed.");
    });

    it("reports an empty database without failing", () => {
      const ownerless = join(env.scratchDir, "empty-auth.db");
      const { status, stdout } = run(["token", "list"], ownerless);
      expect(status).toBe(0);
      expect(stdout).toContain("No tokens found.");
    });
  });

  describe("token revoke", () => {
    it("revokes by id; the token then answers 401", async () => {
      const minted = run(["token", "create", "--name", "revoke-me"]);
      expect(minted.status).toBe(0);
      const token = minted.stdout.trim();
      expect((await bearerFetch(env, "/api/sessions", token)).status).toBe(200);
      const id = tokenRow("revoke-me")?.id ?? "";
      expect(id).toMatch(/^[0-9a-f]{64}$/);

      const revoked = run(["token", "revoke", id]);
      expect(revoked.status).toBe(0);
      expect(revoked.stdout).toContain("revoke-me");
      expect((await bearerFetch(env, "/api/sessions", token)).status).toBe(401);
      expect(tokenRow("revoke-me")).toBeUndefined();
    });

    it("errors for an unknown id", () => {
      const { status, stderr } = run(["token", "revoke", "0".repeat(64)]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("No token with id");
    });
  });
};

export { runTokenCliSuite };
