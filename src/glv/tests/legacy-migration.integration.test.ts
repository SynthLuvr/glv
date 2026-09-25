import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  mockGoose,
  SESSIONS_SCHEMA,
} from "../../goose/tests/integration-harness.js";
import {
  fakeHomeEnv,
  findFreePort,
  ROOT,
  rmScratch,
  spawnLauncher,
  stopProcess,
  waitForHttp,
} from "./harness.js";

// The one-time legacy migration of ADR 0007: a first `glv serve` against
// an empty unified data directory adopts the per-flavor directories'
// rows (re-keyed with their flavor prefix), adopts one auth database,
// moves tagged upload dirs, and retires the legacy directories by
// renaming them `.migrated` — never deleting anything.

// Builds a legacy glv-goose data directory under a fake HOME: prompt,
// group, cron, and auth databases with a couple of rows, plus a tagged
// upload dir.
const seedGooseLegacy = (home: string): void => {
  const dir = join(home, ".local", "share", "glv-goose");
  mkdirSync(dir, { recursive: true });

  const prompts = new DatabaseSync(join(dir, "prompts.db"));
  prompts.exec(
    "CREATE TABLE IF NOT EXISTS saved_prompts (" +
      "id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL," +
      "category TEXT, sort_order INTEGER NOT NULL DEFAULT 0," +
      "usage_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  prompts
    .prepare("INSERT INTO saved_prompts (id, title, body) VALUES (?, ?, ?)")
    .run("legacy-goose-prompt", "Legacy goose prompt", "prompt body");
  prompts.close();

  const groups = new DatabaseSync(join(dir, "groups.db"));
  groups.exec(
    "CREATE TABLE IF NOT EXISTS session_groups (" +
      "id TEXT PRIMARY KEY, name TEXT, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')));" +
      "CREATE TABLE IF NOT EXISTS group_members (" +
      "group_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE," +
      "PRIMARY KEY (group_id, session_id))",
  );
  groups
    .prepare("INSERT INTO session_groups (id, name) VALUES (?, ?)")
    .run("grp-1", "Legacy group");
  groups
    .prepare("INSERT INTO group_members (group_id, session_id) VALUES (?, ?)")
    .run("grp-1", "legacy-goose-session");
  groups.close();

  const cron = new DatabaseSync(join(dir, "cron.db"));
  cron.exec(
    "CREATE TABLE IF NOT EXISTS cron_jobs (" +
      "name TEXT PRIMARY KEY, schedule TEXT NOT NULL, schedule_input TEXT," +
      "prompt TEXT NOT NULL, working_dir TEXT NOT NULL, timezone TEXT," +
      "enabled INTEGER NOT NULL DEFAULT 1, model_provider TEXT, model TEXT," +
      "follow_ups TEXT, last_fired_at TEXT," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now')));" +
      "CREATE TABLE IF NOT EXISTS cron_sessions (" +
      "session_id TEXT PRIMARY KEY, job_name TEXT NOT NULL," +
      "fired_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  cron
    .prepare(
      "INSERT INTO cron_jobs (name, schedule, prompt, working_dir) " +
        "VALUES (?, ?, ?, ?)",
    )
    .run("legacy job", "0 4 * * *", "legacy prompt", "/tmp");
  cron
    .prepare("INSERT INTO cron_sessions (session_id, job_name) VALUES (?, ?)")
    .run("legacy-goose-session", "legacy job");
  cron.close();

  const auth = new DatabaseSync(join(dir, "auth.db"));
  auth.exec(
    "CREATE TABLE IF NOT EXISTS users (" +
      "id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT 'owner'," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')));" +
      "CREATE TABLE IF NOT EXISTS credentials (" +
      "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL," +
      "counter INTEGER NOT NULL, transports TEXT," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  auth
    .prepare("INSERT INTO users (id, username) VALUES (?, 'owner')")
    .run("owner-goose");
  auth.close();

  const uploads = join(dir, "uploads", "legacy-upload-dir");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, ".glv-session-id"), "legacy-goose-session");
};

// A claude legacy directory whose auth database also has an owner: both
// owners means goose's credential wins and claude's is retired.
const seedClaudeLegacy = (home: string): void => {
  const dir = join(home, ".local", "share", "glv-claude");
  mkdirSync(dir, { recursive: true });

  const auth = new DatabaseSync(join(dir, "auth.db"));
  auth.exec(
    "CREATE TABLE IF NOT EXISTS users (" +
      "id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT 'owner'," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  auth
    .prepare("INSERT INTO users (id, username) VALUES (?, 'owner')")
    .run("owner-claude");
  auth.close();

  const meta = new DatabaseSync(join(dir, "meta.db"));
  meta.exec(
    "CREATE TABLE IF NOT EXISTS session_meta (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT ''," +
      "user_set_name INTEGER NOT NULL DEFAULT 0, archived_at TEXT)",
  );
  meta
    .prepare("INSERT INTO session_meta (id, name) VALUES (?, ?)")
    .run("legacy-claude-session", "Legacy claude name");
  meta.close();
};

// Prepares goose's own sessions database at its platform default so the
// merged serve's default agent set finds goose usable.
const seedGooseStore = (home: string): void => {
  // goose's documented default: <data root>/goose/sessions/sessions.db.
  mkdirSync(join(home, ".local", "share", "goose", "sessions"), {
    recursive: true,
  });
  const db = new DatabaseSync(
    join(home, ".local", "share", "goose", "sessions", "sessions.db"),
  );
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SESSIONS_SCHEMA);
  db.close();
};

it("adopts the legacy directories into the unified glv directory once", async () => {
  const home = mkdtempSync(join(tmpdir(), "glv-migrate-"));
  seedGooseLegacy(home);
  seedClaudeLegacy(home);
  seedGooseStore(home);

  const restore = await mockGoose();
  const port = await findFreePort();
  const proc = spawnLauncher(
    join(ROOT, "bin", "glv.mjs"),
    ["serve", "-p", String(port), "--goose-binary", "goose"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...fakeHomeEnv(home) },
    },
  );
  let stdout = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  try {
    await waitForHttp(`http://localhost:${port}`);
    const glv = join(home, ".local", "share", "glv");

    // Prompts, groups, and cron rows landed, re-keyed where ids name
    // sessions; cron rows name the agent they came from.
    const prompts = new DatabaseSync(join(glv, "prompts.db"), {
      readOnly: true,
    });
    expect(prompts.prepare("SELECT id FROM saved_prompts").all()).toEqual([
      { id: "legacy-goose-prompt" },
    ]);
    prompts.close();

    const groups = new DatabaseSync(join(glv, "groups.db"), {
      readOnly: true,
    });
    expect(
      groups.prepare("SELECT session_id FROM group_members").all(),
    ).toEqual([{ session_id: "goose:legacy-goose-session" }]);
    groups.close();

    const cron = new DatabaseSync(join(glv, "cron.db"), {
      readOnly: true,
    });
    expect(
      cron
        .prepare("SELECT agent FROM cron_jobs WHERE name = ?")
        .get("legacy job"),
    ).toMatchObject({ agent: "goose" });
    expect(cron.prepare("SELECT session_id FROM cron_sessions").all()).toEqual([
      { session_id: "goose:legacy-goose-session" },
    ]);
    cron.close();

    // Auth: both legacy databases had owners, so goose's was adopted
    // and claude's retired with a notice.
    const auth = new DatabaseSync(join(glv, "auth.db"), {
      readOnly: true,
    });
    expect(auth.prepare("SELECT id FROM users").all()).toEqual([
      { id: "owner-goose" },
    ]);
    auth.close();
    expect(stdout).toContain("retired");

    // claude's viewer meta sidecar was re-keyed under its new home.
    const meta = new DatabaseSync(join(glv, "claude-meta.db"), {
      readOnly: true,
    });
    expect(meta.prepare("SELECT id, name FROM session_meta").all()).toEqual([
      { id: "claude:legacy-claude-session", name: "Legacy claude name" },
    ]);
    meta.close();

    // The tagged upload dir moved with its marker re-keyed.
    const uploadMarker = join(
      glv,
      "uploads",
      "legacy-upload-dir",
      ".glv-session-id",
    );
    expect(existsSync(uploadMarker)).toBe(true);
    expect(readFileSync(uploadMarker, "utf-8").trim()).toBe(
      "goose:legacy-goose-session",
    );

    // Legacy directories retired in place, never deleted.
    expect(
      existsSync(join(home, ".local", "share", "glv-goose.migrated")),
    ).toBe(true);
    expect(
      existsSync(join(home, ".local", "share", "glv-claude.migrated")),
    ).toBe(true);
    expect(existsSync(join(home, ".local", "share", "glv-goose"))).toBe(false);
  } finally {
    await stopProcess(proc);
    restore();
    rmScratch(home);
  }
}, 120000);
