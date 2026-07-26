import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
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

// Seeds a credential whose transports column holds the raw value. The server
// reads fresh on every request, so /auth/devices routes the row through
// parseTransports, tripping its catch when transports is malformed JSON.
const insertCredential = (id: string, transports: string): void => {
  const db = new DatabaseSync(env.dbs.authDb);
  db.prepare(
    "INSERT INTO credentials " +
      "(id, user_id, public_key, counter, transports, created_at) " +
      "VALUES (?, ?, ?, ?, ?, datetime('now'))",
  ).run(id, "owner-1", new Uint8Array([1, 2, 3]), 0, transports);
  db.close();
};

describe("structured error logging", () => {
  it("emits a warn to stderr when a stored credential has malformed transports", async () => {
    insertCredential("cred-corrupt", "not-json{");
    const res = await authedFetch(env, "/auth/devices");
    expect(res.status).toBe(200);
    // Without the logger, parseTransports swallows the parse error silently;
    // with setupLogging wrapping console, the warn is routed through consola
    // (its "WARN" level label is the tell) and tagged with the auth component,
    // leaving a diagnostic trail on stderr.
    expect(env.serverStderr()).toContain("WARN");
    expect(env.serverStderr()).toContain("[glv:auth]");
  });

  it("stays silent for well-formed transports", async () => {
    // Remove the corrupt row so the prior fixture doesn't trip the catch.
    const db = new DatabaseSync(env.dbs.authDb);
    db.prepare("DELETE FROM credentials WHERE id = 'cred-corrupt'").run();
    db.close();
    insertCredential("cred-good", '["usb"]');

    const stderrBefore = env.serverStderr();
    await authedFetch(env, "/auth/devices");
    // A valid JSON array parses cleanly, so stderr does not grow.
    expect(env.serverStderr()).toBe(stderrBefore);
  });
});
