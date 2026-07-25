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

// Reads a column straight from the goose sessions DB the server browses, so a
// mutation's persistence is checked against the real file, not server state.
const col = (id: string, name: string): unknown => {
  const db = new DatabaseSync(env.dbs.sessionsDb, { readOnly: true });
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
  insertSessions(env.dbs.sessionsDb, [
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
    // The server browses through a read-only connection, so an external writer
    // (the real goose process appending a row) must still show up via WAL.
    insertSessions(env.dbs.sessionsDb, [
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
    // A read-only browsing connection cannot mutate, so these only succeed via
    // the dedicated writable connection. They must persist to the file and be
    // reflected by the next read-only browse.
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

    // The archived (renamed) session is now excluded from browsing.
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("#session-list")).not.toContainText(
        "Renamed Safe",
      );
    });
  });
});
