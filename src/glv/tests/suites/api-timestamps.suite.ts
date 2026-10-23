import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP (#346): every timestamp the JSON API returns
// is ISO 8601 UTC with an explicit zone designator, never the bare
// "YYYY-MM-DD HH:MM:SS" spelling SQLite's datetime('now') /
// CURRENT_TIMESTAMP write — a bare value reads as local time in most
// parsers, so a +02:00 reader would misjudge every age by two hours.
// The stores genuinely hold bare spellings (goose's agent-owned rows,
// the viewer-owned sidecars), which is exactly what makes this suite a
// regression test: the normalization has to happen at the serialization
// boundary, not in storage.

// The wire's timestamp shape: a date-time with an explicit UTC
// designator, fractional seconds optional (claude transcripts carry
// them, SQLite spellings do not).
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// The bare SQLite spelling storage actually holds.
const BARE_SQLITE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

type SessionJson = {
  id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type MessageJson = { role: string; timestamp: string; items: unknown[] };

type PromptJson = {
  id: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

const runApiTimestampsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";

  beforeAll(async () => {
    env = await fx.startEnv("glv-apits-");
    token = seedApiToken(env.dbs.authDb, "api-timestamps");
    // One session with a transcript, so the detail read carries both the
    // row timestamps and a message timestamp.
    fx.seedSessions(env, [
      { id: "ts-a", name: "Timestamps", workingDir: env.scratchDir },
    ]);
    fx.seedMessages(env, "ts-a", [
      { role: "user", content: [{ type: "text", text: "seed prompt" }] },
    ]);
    // One prompt row with every timestamp spelled the bare SQLite way,
    // including a non-null last_used_at — the exact storage spelling the
    // wire must never leak verbatim.
    const db = new DatabaseSync(env.dbs.promptsDb);
    db.prepare(
      "INSERT INTO saved_prompts (id, title, body, category, sort_order, " +
        "last_used_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "ts-p1",
      "Timestamp probe",
      "A prompt seeded to probe the wire's timestamp spelling.",
      "Docs",
      0,
      "2026-01-02 03:04:05",
      "2026-01-01 00:00:00",
      "2026-01-02 03:04:05",
    );
    db.close();
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const detail = async (): Promise<{
    session: SessionJson;
    messages: MessageJson[];
  }> => {
    const res = await bearerFetch(
      env,
      `/api/sessions/${fx.viewId("ts-a")}`,
      token,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      session: SessionJson;
      messages: MessageJson[];
    };
  };

  describe("GET /api/sessions (listing)", () => {
    it("returns zoned timestamps on every listing row", async () => {
      const res = await bearerFetch(env, "/api/sessions?limit=500", token);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as SessionJson[];
      const row = rows.find((entry) => entry.id === fx.viewId("ts-a"));
      expect(row).toBeDefined();
      expect(row?.created_at).toMatch(ZONED_ISO);
      expect(row?.updated_at).toMatch(ZONED_ISO);
      expect(Date.parse(row?.created_at ?? "")).not.toBeNaN();
      expect(Date.parse(row?.updated_at ?? "")).not.toBeNaN();
    });
  });

  describe("GET /api/sessions/:id (detail)", () => {
    it("returns the session row's timestamps zoned", async () => {
      const body = await detail();
      expect(body.session.created_at).toMatch(ZONED_ISO);
      expect(body.session.updated_at).toMatch(ZONED_ISO);
      expect(body.session.archived_at).toBeNull();
    });

    it("returns each message's timestamp zoned", async () => {
      const body = await detail();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.timestamp).toMatch(ZONED_ISO);
      expect(Date.parse(body.messages[0]?.timestamp ?? "")).not.toBeNaN();
    });

    it("returns archived_at zoned once the session is archived", async () => {
      // The archive action is browser-only, so it rides the same form
      // route the transcript button posts.
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("ts-a")}/archive`,
        {
          method: "POST",
          body: new URLSearchParams({}),
          headers: { "HX-Request": "true" },
        },
      );
      expect(res.status).toBe(200);
      // What the flavor's store actually holds: SQLite's bare
      // CURRENT_TIMESTAMP spelling. The wire must answer the same
      // instant, zoned — "T" for the space, "Z" for the silence.
      const raw = fx.readSessionField(env, "archived_at", "ts-a");
      expect(raw).toMatch(BARE_SQLITE);
      const body = await detail();
      expect(body.session.archived_at).toBe(
        `${String(raw).replace(" ", "T")}Z`,
      );
    });
  });

  describe("GET /api/prompts", () => {
    it("returns the prompt row's timestamps zoned", async () => {
      const res = await bearerFetch(env, "/api/prompts", token);
      expect(res.status).toBe(200);
      const prompts = (await res.json()) as PromptJson[];
      const prompt = prompts.find((entry) => entry.id === "ts-p1");
      expect(prompt).toBeDefined();
      // The seeded bare spellings, re-spelled with the designator —
      // exact values, so a regression to the bare passthrough fails.
      expect(prompt?.created_at).toBe("2026-01-01T00:00:00Z");
      expect(prompt?.updated_at).toBe("2026-01-02T03:04:05Z");
      expect(prompt?.last_used_at).toBe("2026-01-02T03:04:05Z");
    });
  });
};

export { runApiTimestampsSuite };
