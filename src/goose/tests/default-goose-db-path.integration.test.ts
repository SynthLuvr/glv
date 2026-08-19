import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as harness from "../../glv/tests/harness.js";
import {
  GLV,
  gooseMockScriptPath,
  insertSessions,
  SESSIONS_SCHEMA,
} from "./integration-harness.js";

// goose's documented platform-default sessions DB ("Session Records" in
// goose's guides): the XDG data dir on Unix-like systems, the Known-Folders
// path %APPDATA%\Block\goose\data on Windows. Deliberately mirrors
// src/goose/db.ts — a regression in either place fails this test.
const defaultSessionsDb = (home: string): string =>
  harness.IS_WIN
    ? join(
        home,
        "AppData",
        "Roaming",
        "Block",
        "goose",
        "data",
        "sessions",
        "sessions.db",
      )
    : join(home, ".local", "share", "goose", "sessions", "sessions.db");

describe("default goose sessions db path", () => {
  it("serves sessions from the platform-default location with no --db or env override", async () => {
    const home = mkdtempSync(join(tmpdir(), "glv-defaultdb-"));
    const sessionsDb = defaultSessionsDb(home);
    mkdirSync(dirname(sessionsDb), { recursive: true });
    const db = new DatabaseSync(sessionsDb);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SESSIONS_SCHEMA);
    db.close();

    // Boots the real launcher with neither --db nor GOOSE_SESSIONS_DB, so
    // the sessions DB must resolve purely by platform default; glv-owned
    // databases still come from scratch.
    const adapter: harness.FlavorAdapter = {
      name: "goose",
      binPath: GLV,
      mockBinName: "goose",
      mockScriptPath: gooseMockScriptPath,
      mockEnvPrefix: "GOOSE",
      createDatabases: (scratchDir) =>
        harness.baseDatabases(scratchDir, { sessionsDb }),
      serveArgs: (dbs) => [
        ...harness.dbOverrideArgs(dbs),
        "--goose-binary",
        "goose",
      ],
      serverEnv: () => ({}),
    };

    const env = await harness.startEnv(adapter, "glv-defaultdb-", {}, home);
    try {
      insertSessions(sessionsDb, [
        {
          id: "default-db-1",
          name: "Found via platform default",
          workingDir: home,
        },
      ]);
      const res = await harness.authedFetch(env, "/");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Found via platform default");
    } finally {
      await env.cleanup();
      harness.rmScratch(home);
    }
  });
});
