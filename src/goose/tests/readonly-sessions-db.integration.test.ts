import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

let env: IntegrationEnv;

// Opens a fresh read-only connection each call so the mutation's effect is
// read straight from the sessions file, not server-cached state.
const col = (id: string, name: string): unknown => {
  const db = new DatabaseSync(env.dbs.flavor.sessionsDb, { readOnly: true });
  const row = db
    .prepare(`SELECT ${name} AS v FROM sessions WHERE id = ?`)
    .get(id) as { v: unknown } | undefined;
  db.close();
  return row?.v;
};

const post = (path: string, body: Record<string, string>): Promise<Response> =>
  authedFetch(env, path, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "HX-Request": "true" },
  });

beforeAll(async () => {
  env = await startIntegrationEnv("glv-readonly-");
  insertSessions(env.dbs.flavor.sessionsDb, [
    {
      id: "ro-browse",
      name: "Browse Live",
      workingDir: join(env.scratchDir, "browse"),
    },
    {
      id: "ro-mutate",
      name: "Mutate Me",
      workingDir: join(env.scratchDir, "mutate"),
    },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("read-only browsing connection", () => {
  it("opens the sessions database read-only yet still sees live goose writes", async () => {
    // A read-only browse connection must still see rows an external writer
    // (goose) appends — SQLite WAL propagates them.
    insertSessions(env.dbs.flavor.sessionsDb, [
      {
        id: "ro-live",
        name: "Live From Goose",
        workingDir: join(env.scratchDir, "live"),
      },
    ]);
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("#session-list")).toContainText("Browse Live");
      await expect(page.locator("#session-list")).toContainText(
        "Live From Goose",
      );
    });
  });

  it("routes archive/rename through the separate writable connection", async () => {
    // These mutate, so they succeed only via the writable connection, then
    // persist to the file and show up on the next read-only browse.
    const renameRes = await post("/sessions/ro-mutate/rename", {
      name: "Renamed Safe",
      from: "header",
    });
    expect(renameRes.status).toBe(200);
    expect(col("ro-mutate", "name")).toBe("Renamed Safe");
    expect(col("ro-mutate", "user_set_name")).toBe(1);

    const archiveRes = await post("/sessions/ro-mutate/archive", {});
    expect(archiveRes.status).toBe(200);
    expect(col("ro-mutate", "archived_at")).not.toBeNull();

    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("#session-list")).not.toContainText(
        "Renamed Safe",
      );
    });
  });
});
