import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type IntegrationEnv,
  seedApiToken,
} from "../../glv/tests/harness.js";
import { claudeFixture } from "./integration-harness.js";

// claude-specific: a headless `claude --print` run never titles its
// session on its own, so glv asks for one over stream-json stdin (a
// generate_session_title control request). The mock models real claude:
// it writes an ai-title line only when that request arrives, so a
// session listed under its title — not a truncation of its prompt —
// proves the request was sent and the title read back.

type SessionRow = { name: string; status: string; user_set_name: number };

const TITLE = "Parser refactor plan";
const PROMPT = "Walk me through refactoring the stream parser into stages.";

describe("claude session auto-title", () => {
  let env: IntegrationEnv;
  let token = "";

  beforeAll(async () => {
    env = await claudeFixture.startEnv("glv-claude-title-", {
      sessionName: TITLE,
    });
    token = seedApiToken(env.dbs.authDb, "session-title");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const sessionOf = async (id: string): Promise<SessionRow> => {
    const res = await bearerFetch(env, `/api/sessions/${id}`, token);
    expect(res.status).toBe(200);
    return ((await res.json()) as { session: SessionRow }).session;
  };

  // Polls the detail endpoint until the run settles and the row matches.
  const waitForSession = async (
    id: string,
    done: (row: SessionRow) => boolean,
  ): Promise<SessionRow> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const row = await sessionOf(id);
      if (done(row)) return row;
      if (Date.now() > deadline)
        throw new Error(`session ${id} never settled: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const isIdle = (row: SessionRow): boolean => row.status === "idle";

  let sessionId = "";

  it("names a new session with claude's own generated title", async () => {
    const form = new FormData();
    form.append("prompt", PROMPT);
    form.append("working_dir", env.scratchDir);
    const created = await bearerFetch(env, "/api/sessions", token, {
      method: "POST",
      body: form,
    });
    expect(created.status).toBe(201);
    sessionId = ((await created.json()) as { id: string }).id;

    const row = await waitForSession(
      sessionId,
      (r) => isIdle(r) && r.name === TITLE,
    );
    expect(row.name).toBe(TITLE);
    // The title is claude's, not a viewer rename.
    expect(row.user_set_name).toBe(0);
  });

  it("keeps the title across a follow-up run", async () => {
    const res = await bearerFetch(
      env,
      `/api/sessions/${sessionId}/prompt`,
      token,
      {
        method: "POST",
        body: new URLSearchParams({ prompt: "And now the tests, please." }),
      },
    );
    expect(res.status).toBeLessThan(300);
    // Let the follow-up start before waiting for it to settle again.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await waitForSession(sessionId, isIdle);
    expect(row.name).toBe(TITLE);
  });
});
