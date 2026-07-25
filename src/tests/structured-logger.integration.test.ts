import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  startIntegrationEnv,
} from "./integration-harness";

let env: IntegrationEnv;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-structured-logger-");
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

// Seeds a credential whose transports column holds malformed JSON. The server
// reads fresh on every request, so rendering /auth/devices calls
// listCredentialSummaries, which routes the row through parseTransports and
// trips its catch.
const seedCorruptCredential = (): void => {
  const db = new DatabaseSync(env.dbs.authDb);
  db.prepare(
    "INSERT INTO credentials " +
      "(id, user_id, public_key, counter, transports, created_at) " +
      "VALUES (?, ?, ?, ?, ?, datetime('now'))",
  ).run("cred-corrupt", "owner-1", new Uint8Array([1, 2, 3]), 0, "not-json{");
  db.close();
};

describe("structured error logging", () => {
  it("emits a warn to stderr when a stored credential has malformed transports", async () => {
    seedCorruptCredential();
    const res = await fetch(`${env.baseUrl}/auth/devices`, {
      redirect: "manual",
      headers: { cookie: env.cookie },
    });
    expect(res.status).toBe(200);
    // Without the logger, parseTransports swallows the parse error silently
    // and stderr stays empty. With it, a structured [glv:auth] warn line is
    // left as a diagnostic trail for the corrupt row.
    expect(env.serverStderr()).toContain("[glv:auth] warn:");
  });

  it("stays silent for well-formed transports", async () => {
    // Remove the corrupt row so this assertion isn't polluted by the
    // previous test's fixture.
    const db = new DatabaseSync(env.dbs.authDb);
    db.prepare("DELETE FROM credentials WHERE id = 'cred-corrupt'").run();
    db.prepare(
      "INSERT INTO credentials " +
        "(id, user_id, public_key, counter, transports, created_at) " +
        "VALUES (?, ?, ?, ?, ?, datetime('now'))",
    ).run("cred-good", "owner-1", new Uint8Array([9, 9]), 0, '["usb"]');
    db.close();

    const stderrBefore = env.serverStderr();
    await fetch(`${env.baseUrl}/auth/devices`, {
      redirect: "manual",
      headers: { cookie: env.cookie },
    });
    // A valid JSON transports array parses cleanly, so stderr does not grow.
    expect(env.serverStderr()).toBe(stderrBefore);
  });
});
