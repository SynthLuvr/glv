import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firstPromptSessionName } from "../db.js";
import { clearGroups, listGroups, openGroupsDb } from "../groups/db.js";
import { createRunner, DEFAULT_RUNNER_CONFIG } from "../runner/index.js";
import { createApp } from "../server/index.js";

const SESSIONS_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tokens INTEGER,
  metadata_json TEXT
);
`;

const insertSession = (db: DatabaseSync, id: string, updated: string): void => {
  db.prepare(
    "INSERT INTO sessions (id, name, working_dir, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, id, "/tmp", updated);
};

const insertPrompt = (
  db: DatabaseSync,
  sessionId: string,
  timestamp: number,
): void => {
  db.prepare(
    "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)",
  ).run(sessionId, "user", "[]", timestamp);
};

let sessionsDb: DatabaseSync;
let groupsDb: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-groups-routes-"));
  sessionsDb = new DatabaseSync(join(dir, "sessions.db"));
  sessionsDb.exec(SESSIONS_SCHEMA);
  insertSession(sessionsDb, "alpha", "2026-07-13 10:00:00");
  insertSession(sessionsDb, "beta", "2026-07-13 09:00:00");
  insertSession(sessionsDb, "gamma", "2026-07-13 08:00:00");
  insertSession(sessionsDb, "delta", "2026-07-13 07:00:00");
  insertSession(sessionsDb, "epsilon", "2026-07-13 06:00:00");
  // Earliest first-prompt timestamps: beta < alpha < gamma; delta & epsilon
  // have none, so a group of just those two stays nameless.
  insertPrompt(sessionsDb, "beta", 500);
  insertPrompt(sessionsDb, "alpha", 1_000);
  insertPrompt(sessionsDb, "gamma", 2_000);
  groupsDb = openGroupsDb(join(dir, "groups.db"));
});

afterAll(() => {
  sessionsDb.close();
  groupsDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = () =>
  createApp(sessionsDb, createRunner(DEFAULT_RUNNER_CONFIG), {
    groups: groupsDb,
  });

const postForm = async (
  app: ReturnType<typeof createApp>,
  path: string,
  fields: Record<string, string> = {},
  htmx = true,
): Promise<{ status: number; html: string }> => {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(htmx ? { "HX-Request": "true" } : {}),
    },
    body: form.toString(),
  });
  return { status: res.status, html: await res.text() };
};

describe("group-with creates and joins groups", () => {
  it("creates a new group when neither session is grouped", async () => {
    const { html } = await postForm(makeApp(), "/sessions/alpha/group-with", {
      otherId: "beta",
    });
    expect(html).toContain("group-header");
    // Both sessions should be inside the group
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toContain("alpha");
    expect(groups[0]?.memberIds).toContain("beta");
    // Named after the session with the earliest first prompt (beta @ 500)
    expect(groups[0]?.name).toBe("beta");
  });

  it("joins an existing group when the target is already grouped", async () => {
    await postForm(makeApp(), "/sessions/gamma/group-with", {
      otherId: "alpha",
    });
    // gamma joins alpha's existing group
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toHaveLength(3);
  });
});

describe("ungroup removes and dissolves", () => {
  it("removes a session and dissolves the group at one member", async () => {
    // Current group has alpha, beta, gamma (3 members)
    // Remove gamma → 2 remain, group survives
    await postForm(makeApp(), "/sessions/gamma/ungroup");
    let groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toHaveLength(2);

    // Remove beta → 1 remains, group dissolves
    await postForm(makeApp(), "/sessions/beta/ungroup");
    groups = listGroups(groupsDb);
    expect(groups).toHaveLength(0);
  });
});

describe("group menu routes", () => {
  it("group-picker returns a form with a select", async () => {
    // Set up a group first
    await postForm(makeApp(), "/sessions/alpha/group-with", {
      otherId: "beta",
    });
    const app = makeApp();
    const res = await app.request("/sessions/gamma/group-picker");
    const html = await res.text();
    expect(html).toContain("group-picker-form");
    expect(html).toContain("<select");
    expect(html).toContain('name="groupId"');
  });

  it("POST /sessions/:id/group joins an existing group", async () => {
    const groupsBefore = listGroups(groupsDb);
    const groupId = groupsBefore[0]?.id;
    expect(groupId).toBeTruthy();

    await postForm(makeApp(), "/sessions/gamma/group", { groupId: groupId! });
    const groupsAfter = listGroups(groupsDb);
    const g = groupsAfter.find((x) => x.id === groupId);
    expect(g?.memberIds).toContain("gamma");
  });

  it("POST /sessions/:id/group creates a new group when groupId is empty", async () => {
    const before = listGroups(groupsDb).length;
    await postForm(makeApp(), "/sessions/delta/group", { groupId: "" });
    const after = listGroups(groupsDb).length;
    expect(after).toBe(before + 1);
  });

  it("POST /groups/:id/rename updates the name", async () => {
    clearGroups(groupsDb);
    // Two prompt-less sessions form a null-named group that still renders
    // (≥ 2 visible members), so the renamed value shows in the sidebar.
    await postForm(makeApp(), "/sessions/delta/group-with", {
      otherId: "epsilon",
    });
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBeNull();
    const target = groups[0]!;
    const { html } = await postForm(makeApp(), `/groups/${target.id}/rename`, {
      name: "My Project",
    });
    expect(html).toContain("My Project");
  });
});

describe("dissolve on archive", () => {
  it("group vanishes from the sidebar when a member is archived", async () => {
    // Clean slate
    clearGroups(groupsDb);

    // Create a 2-member group
    await postForm(makeApp(), "/sessions/alpha/group-with", {
      otherId: "beta",
    });
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);

    // Verify the group renders before archiving
    const beforeHtml = (await makeApp().request("/")).text();
    const before = await beforeHtml;
    expect(before).toContain("group-header");

    // Archive beta — the group should drop to 1 visible member and vanish
    await postForm(makeApp(), "/sessions/beta/archive");

    const afterHtml = (await makeApp().request("/")).text();
    const after = await afterHtml;
    expect(after).not.toContain("group-header");

    // Membership is retained in the sidecar (archive doesn't delete it)
    const retained = listGroups(groupsDb);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.memberIds).toContain("beta");
  });
});

describe("archive group", () => {
  it("archives every member session in a group", async () => {
    clearGroups(groupsDb);
    // beta is archived by the previous suite; alpha + gamma are both visible
    await postForm(makeApp(), "/sessions/alpha/group-with", {
      otherId: "gamma",
    });
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    const groupId = groups[0]!.id;

    const { status, html } = await postForm(
      makeApp(),
      `/groups/${groupId}/archive`,
    );
    expect(status).toBe(200);
    // The group vanishes once all its members are hidden
    expect(html).not.toContain("group-header");

    const archived = sessionsDb
      .prepare(
        "SELECT id FROM sessions WHERE id IN ('alpha', 'gamma') AND archived_at IS NOT NULL",
      )
      .all();
    expect(archived).toHaveLength(2);

    // Membership is retained so an un-archive can restore the group
    const retained = listGroups(groupsDb);
    expect(retained).toHaveLength(1);
  });

  it("returns 404 for an unknown group", async () => {
    const { status } = await postForm(
      makeApp(),
      "/groups/does-not-exist/archive",
    );
    expect(status).toBe(404);
  });
});

describe("group default name", () => {
  it("names a new group after its sole session's first prompt", async () => {
    clearGroups(groupsDb);
    await postForm(makeApp(), "/sessions/gamma/group", { groupId: "" });
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("gamma");
  });

  it("names a group-with after the session with the earliest prompt", async () => {
    clearGroups(groupsDb);
    // alpha @ 1_000, beta @ 500 → earliest is beta
    await postForm(makeApp(), "/sessions/alpha/group-with", {
      otherId: "beta",
    });
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("beta");
  });

  it("leaves the name unset when no session has prompts", async () => {
    clearGroups(groupsDb);
    await postForm(makeApp(), "/sessions/delta/group", { groupId: "" });
    const groups = listGroups(groupsDb);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBeNull();
  });
});

describe("firstPromptSessionName", () => {
  it("returns the name of the session with the earliest prompt", () => {
    expect(firstPromptSessionName(sessionsDb, ["alpha", "beta", "gamma"])).toBe(
      "beta",
    );
  });

  it("ignores sessions that have no prompts", () => {
    expect(firstPromptSessionName(sessionsDb, ["alpha", "delta"])).toBe(
      "alpha",
    );
  });

  it("returns undefined when none of the sessions have prompts", () => {
    expect(firstPromptSessionName(sessionsDb, ["delta"])).toBeUndefined();
  });

  it("returns undefined for an empty id list", () => {
    expect(firstPromptSessionName(sessionsDb, [])).toBeUndefined();
  });
});
