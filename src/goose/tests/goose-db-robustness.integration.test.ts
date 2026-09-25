import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieName } from "../../glv/auth/service.js";
import {
  baseDatabases,
  dbOverrideArgs,
  findFreePort,
  ROOT,
  rmScratch,
  spawnLauncher,
  spawnLauncherSync,
  stopProcess,
  waitForHttp,
} from "../../glv/tests/harness.js";
import { gooseFixture, SESSIONS_SCHEMA } from "./integration-harness.js";

const GLV = join(ROOT, "bin", "glv.mjs");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// goose owns its schema and only creates it on first run; before that, glv
// boots against an empty database file and must degrade to empty results
// instead of 500-ing every read.
describe("goose sessions db robustness", () => {
  it("lists zero sessions against an empty (schema-less) database", () => {
    const dir = mkdtempSync(join(tmpdir(), "glv-emptydb-"));
    try {
      const dbPath = join(dir, "sessions.db");
      writeFileSync(dbPath, "");
      const result = spawnLauncherSync(
        GLV,
        [
          "--goose-db",
          dbPath,
          // Pins the other agent's store away from the host's real
          // ~/.claude: the listing must be empty because goose's store
          // is, not because of what the host happens to have.
          "--projects-dir",
          join(dir, "no-claude-projects"),
          "sessions",
        ],
        {
          env: { ...process.env },
          encoding: "utf-8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No sessions found.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Reads ride the read-only handle, which used to carry busy_timeout=0:
  // a concurrent goose write made the sidebar fail instantly with
  // SQLITE_BUSY instead of waiting out the writer.
  describe("read-only handle waits out a concurrent writer", () => {
    let scratch: string;
    let dbs: ReturnType<typeof baseDatabases>;
    let dbPath: string;
    let port: number;
    let baseUrl: string;
    let proc: ReturnType<typeof spawnLauncher>;

    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), "glv-busy-"));
      dbPath = join(scratch, "sessions.db");
      // Rollback-journal DB (deliberately not WAL) so BEGIN EXCLUSIVE
      // blocks readers for as long as the test holds it.
      const seed = new DatabaseSync(dbPath);
      seed.exec(SESSIONS_SCHEMA);
      seed
        .prepare("INSERT INTO sessions (id, working_dir) VALUES (?, ?)")
        .run("busy-1", "/tmp/busy");
      seed.close();

      dbs = baseDatabases(scratch, {});
      port = await findFreePort();
      baseUrl = `http://localhost:${port}`;
      // No --goose-binary flag: its coercion requires the agent on PATH,
      // which CI doesn't have; the default skips validation and this test
      // never spawns an agent anyway.
      proc = spawnLauncher(
        GLV,
        [
          "serve",
          "-p",
          String(port),
          "--goose-db",
          dbPath,
          "--projects-dir",
          join(scratch, "no-claude-projects"),
          // The merged CLI gates the default agent set on the binary
          // being resolvable; node exists everywhere and this test
          // never spawns an agent.
          "--goose-binary",
          process.execPath,
          ...dbOverrideArgs(dbs),
        ],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        },
      );
      await waitForHttp(baseUrl);
    }, 60000);

    afterAll(async () => {
      await stopProcess(proc);
      rmScratch(scratch);
    });

    it("serves the sidebar while a writer holds an exclusive lock", async () => {
      const cookie = `${sessionCookieName(dbs.authDb)}=${dbs.token}`;

      const writer = new DatabaseSync(dbPath);
      writer.exec("BEGIN EXCLUSIVE");
      const pending = fetch(baseUrl, {
        headers: { cookie },
        redirect: "manual",
      });
      // The read is now blocked behind the writer; with no busy timeout it
      // would have failed immediately. Hold briefly, then release.
      await delay(400);
      writer.exec("COMMIT");
      writer.close();

      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(gooseFixture.viewId("busy-1"));
    }, 15000);
  });
});
