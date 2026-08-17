import { readdirSync, readFileSync } from "node:fs";
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
// read straight from the sidecar file, not server-cached state.
const col = (id: string, name: string): unknown => {
  const db = new DatabaseSync(env.dbs.metaDb, { readOnly: true });
  const row = db
    .prepare(`SELECT ${name} AS v FROM session_meta WHERE id = ?`)
    .get(id) as { v: unknown } | undefined;
  db.close();
  return row?.v;
};

// The transcript file claude owns for a session, found by scanning the
// projects root — used to prove the viewer never writes into it.
const transcriptOf = (id: string): string | undefined => {
  for (const dir of readdirSync(env.dbs.projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const path = join(env.dbs.projectsDir, dir.name, `${id}.jsonl`);
    try {
      return readFileSync(path, "utf8");
    } catch {
      // not in this dir
    }
  }
  return undefined;
};

const post = (path: string, body: Record<string, string>): Promise<Response> =>
  authedFetch(env, path, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "HX-Request": "true" },
  });

beforeAll(async () => {
  env = await startIntegrationEnv("glv-readonly-");
  insertSessions(env.dbs.projectsDir, [
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

describe("read-only transcript browsing", () => {
  it("reads transcripts without writing them, yet sees live claude writes", async () => {
    // A transcript appended by an external writer (claude itself) must show
    // up on the next browse — the store re-reads files on every request.
    insertSessions(env.dbs.projectsDir, [
      {
        id: "ro-live",
        name: "Live From claude",
        workingDir: join(env.scratchDir, "live"),
      },
    ]);
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("#session-list")).toContainText("Browse Live");
      await expect(page.locator("#session-list")).toContainText(
        "Live From claude",
      );
    });
  });

  it("routes archive/rename through the glv-owned sidecar only", async () => {
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

    // The rename lives only in the sidecar — claude's transcript file is
    // never modified by the viewer.
    const transcript = transcriptOf("ro-mutate");
    expect(transcript).toBeDefined();
    expect(transcript).not.toContain("Renamed Safe");

    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("#session-list")).not.toContainText(
        "Renamed Safe",
      );
    });
  });
});
