import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: the transcript windows on the session
// detail read (#339, #383). GET /api/sessions/:id used to re-download
// every message on every poll, so an orchestrator polling a long run
// paid full-transcript cost per poll — and the cost grew with exactly
// the runs that most need polling. fields=meta now answers with the
// session row alone (the "done yet?" poll) plus message_count (the
// "is it still progressing?" poll, comparing integers instead of
// downloading messages to count them), after=<message-index> with only
// the messages from that transcript index on (the "any new messages?"
// poll), head=<n> with the first n (the fingerprint check), and
// last=<n> with the final n (the tail read that pulls a run's verdict
// out of a long transcript). One environment suffices: the windows are
// pure read logic over a seeded transcript, plus one real follow-up
// run whose reply must land past a cursor held before the run started.

type ParsedMessage = {
  role: string;
  items: { type: string; text?: string }[];
};

type DetailBody = {
  session: { id: string; status: string };
  message_count?: number;
  messages?: ParsedMessage[];
};

const textOf = (message: ParsedMessage): string =>
  message.items
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join(" ");

const runApiDetailWindowSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";
  // The seeded transcript: four messages, adw-one .. adw-four, so every
  // window boundary has messages on both sides.
  const SEED_TEXTS = ["adw-one", "adw-two", "adw-three", "adw-four"];

  const readDetail = async (query = ""): Promise<Response> =>
    bearerFetch(env, `/api/sessions/${fx.viewId("adw-1")}${query}`, token);

  const readBody = async (query = ""): Promise<DetailBody> => {
    const res = await readDetail(query);
    expect(res.status, query).toBe(200);
    return (await res.json()) as DetailBody;
  };

  const textsOf = async (query = ""): Promise<string[]> =>
    (await readBody(query)).messages?.map(textOf) ?? [];
  beforeAll(async () => {
    env = await fx.startEnv("glv-apidw-", {
      // The follow-up run must persist its reply to the session's store
      // for the incremental poll to see it land past the cursor.
      writeDb: true,
    });
    token = seedApiToken(env.dbs.authDb, "api-detail-window");
    // Follow-up runs spawn the agent in the session's working dir, so
    // the dir must exist or the spawn rejects and the run errors.
    mkdirSync(join(env.scratchDir, "w"), { recursive: true });
    fx.seedSessions(env, [
      {
        id: "adw-1",
        name: "Detail Window",
        workingDir: join(env.scratchDir, "w"),
      },
    ]);
    fx.seedMessages(
      env,
      "adw-1",
      SEED_TEXTS.map((text, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text }],
        // Backdated and stepped so the window between seeds cannot
        // swallow a live row: the follow-up's reply carries the real
        // clock and must sort after every seed, keeping the seeded
        // transcript's indices stable across the run (goose orders by
        // created_timestamp, id).
        createdTimestamp: Date.now() - 100_000 + i * 1000,
      })),
    );
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("GET /api/sessions/:id transcript windows", () => {
    it("returns the whole transcript when no window arrives", async () => {
      const body = await readBody();
      expect(body.session.id).toBe(fx.viewId("adw-1"));
      expect(body.messages?.map(textOf)).toEqual(SEED_TEXTS);
    });

    it("omits the transcript with fields=meta", async () => {
      const body = await readBody("?fields=meta");
      expect(body.session.id).toBe(fx.viewId("adw-1"));
      expect(typeof body.session.status).toBe("string");
      expect("messages" in body).toBe(false);
    });

    it("carries the transcript length as message_count under fields=meta", async () => {
      const body = await readBody("?fields=meta");
      expect(body.message_count).toBe(SEED_TEXTS.length);
      expect("messages" in body).toBe(false);
    });

    it("keeps the last N messages with last=N", async () => {
      expect(await textsOf("?last=2")).toEqual(SEED_TEXTS.slice(-2));
      expect(await textsOf("?last=1")).toEqual(SEED_TEXTS.slice(-1));
    });

    it("clamps last=N to the transcript length and answers empty at 0", async () => {
      expect(await textsOf(`?last=${SEED_TEXTS.length}`)).toEqual(SEED_TEXTS);
      expect(await textsOf(`?last=${SEED_TEXTS.length + 50}`)).toEqual(
        SEED_TEXTS,
      );
      expect(await textsOf("?last=0")).toEqual([]);
    });

    it("keeps the first N messages with head=N", async () => {
      expect(await textsOf("?head=1")).toEqual(SEED_TEXTS.slice(0, 1));
      expect(await textsOf("?head=3")).toEqual(SEED_TEXTS.slice(0, 3));
    });

    it("clamps head=N to the transcript length and answers empty at 0", async () => {
      expect(await textsOf(`?head=${SEED_TEXTS.length}`)).toEqual(SEED_TEXTS);
      expect(await textsOf(`?head=${SEED_TEXTS.length + 50}`)).toEqual(
        SEED_TEXTS,
      );
      expect(await textsOf("?head=0")).toEqual([]);
    });

    it("starts the transcript at the after index", async () => {
      expect(await textsOf("?after=0")).toEqual(SEED_TEXTS);
      expect(await textsOf("?after=1")).toEqual(SEED_TEXTS.slice(1));
      expect(await textsOf("?after=3")).toEqual(SEED_TEXTS.slice(3));
    });

    it("answers an empty window once the cursor reaches the tail", async () => {
      expect(await textsOf(`?after=${SEED_TEXTS.length}`)).toEqual([]);
      expect(await textsOf(`?after=${SEED_TEXTS.length + 50}`)).toEqual([]);
    });

    it("windows agree with slicing the unwindowed read", async () => {
      const full = await readBody();
      expect((await readBody("?after=2")).messages).toEqual(
        full.messages?.slice(2),
      );
      expect((await readBody("?head=2")).messages).toEqual(
        full.messages?.slice(0, 2),
      );
      expect((await readBody("?last=2")).messages).toEqual(
        full.messages?.slice(-2),
      );
    });

    it("delivers a live run's reply past a cursor held before it", async () => {
      // The poller's state: every seeded message, cursor at their count.
      const prompt = await bearerFetch(
        env,
        `/api/sessions/${fx.viewId("adw-1")}/prompt`,
        token,
        { method: "POST", body: new URLSearchParams({ prompt: "adw: reply" }) },
      );
      expect(prompt.status).toBe(200);

      // The mock persists its reply as it streams, so poll the window —
      // exactly the incremental fetch the issue asks for — until the
      // answer carries the reply the poller has not seen.
      const deadline = Date.now() + 30000;
      for (;;) {
        const fresh =
          (await readBody(`?after=${SEED_TEXTS.length}`)).messages ?? [];
        const joined = fresh.map(textOf).join(" ");
        if (joined.includes(fx.mockReply)) {
          // The seed stays behind the window; only the run's answer rides.
          expect(joined).toContain(fx.mockReply);
          for (const seed of SEED_TEXTS) expect(joined).not.toContain(seed);
          // The same reply, read as the meta poll the issue asks for:
          // message_count grows past the seeded length, no transcript
          // downloaded.
          const meta = await readBody("?fields=meta");
          expect(meta.message_count ?? 0).toBeGreaterThan(SEED_TEXTS.length);
          expect("messages" in meta).toBe(false);
          return;
        }
        if (Date.now() > deadline)
          throw new Error(
            "the run's reply never landed past the cursor; last window: " +
              JSON.stringify(fresh.map(textOf)),
          );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    });
  });

  describe("GET /api/sessions/:id window validation", () => {
    it("rejects invalid windows with 422", async () => {
      for (const query of [
        "?after=-1",
        "?after=abc",
        "?after=1.5",
        "?head=-1",
        "?head=abc",
        "?head=1.5",
        "?last=-3",
        "?last=abc",
        "?last=1.5",
        "?fields=rows",
      ]) {
        const res = await readDetail(query);
        expect(res.status, query).toBe(422);
        const body = (await res.json()) as { error: string };
        expect(body.error.length, query).toBeGreaterThan(0);
      }
    });

    it("names the rejected parameter in the error", async () => {
      const res = await readDetail("?after=nope");
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('"after"');
      const head = await readDetail("?head=nope");
      const headBody = (await head.json()) as { error: string };
      expect(headBody.error).toContain('"head"');
      const last = await readDetail("?last=nope");
      const lastBody = (await last.json()) as { error: string };
      expect(lastBody.error).toContain('"last"');
      const fields = await readDetail("?fields=rows");
      const fieldsBody = (await fields.json()) as { error: string };
      expect(fieldsBody.error).toContain('"fields"');
    });

    it("refuses fields=meta combined with a window", async () => {
      for (const query of [
        "?fields=meta&after=1",
        "?fields=meta&head=1",
        "?fields=meta&last=1",
      ]) {
        const res = await readDetail(query);
        expect(res.status, query).toBe(422);
        const body = (await res.json()) as { error: string };
        expect(body.error, query).toContain("fields=meta");
      }
    });

    it("refuses two windows at once, naming both", async () => {
      for (const query of [
        "?after=1&head=1",
        "?after=1&last=1",
        "?head=1&last=1",
      ]) {
        const res = await readDetail(query);
        expect(res.status, query).toBe(422);
        const body = (await res.json()) as { error: string };
        const [first, second] = query
          .slice(1)
          .split("&")
          .map((part) => part.split("=")[0]);
        expect(body.error, query).toContain(`"${first}"`);
        expect(body.error, query).toContain(`"${second}"`);
      }
    });

    it("validates the query before the session lookup", async () => {
      const res = await bearerFetch(env, "/api/sessions/nope?after=x", token);
      expect(res.status).toBe(422);
    });

    it("answers 404 for an unknown session with a valid window", async () => {
      const res = await bearerFetch(
        env,
        "/api/sessions/nope?fields=meta",
        token,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No session nope." });
    });
  });

  describe("GET /api/openapi.json", () => {
    it("documents the detail windows", async () => {
      const res = await bearerFetch(env, "/api/openapi.json", token);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<
          string,
          {
            get?: {
              parameters?: { name: string; in: string }[];
              responses?: Record<
                string,
                {
                  content?: {
                    "application/json"?: {
                      schema?: {
                        properties?: Record<string, unknown>;
                        required?: string[];
                      };
                    };
                  };
                }
              >;
            };
          }
        >;
      };
      const get = doc.paths["/api/sessions/{id}"]?.get;
      const names = (get?.parameters ?? []).map(
        (param) => `${param.in}:${param.name}`,
      );
      expect(names).toContain("query:fields");
      expect(names).toContain("query:after");
      expect(names).toContain("query:head");
      expect(names).toContain("query:last");
      expect(get?.responses?.["422"]).toBeDefined();

      const ok = get?.responses?.["200"]?.content?.["application/json"]?.schema;
      expect(ok?.required).toEqual(["session"]);
      expect(ok?.properties?.messages).toBeDefined();
      expect(ok?.properties?.message_count).toBeDefined();
    });
  });
};

export { runApiDetailWindowSuite };
