import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

// Drives the group endpoints the drag-and-drop suites reach only partially:
// joining an existing group (or creating one) via /sessions/:id/group,
// self-pairing no-ops, unknown-group 404s, and idempotent ungroup.

const runGroupsRoutesSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const post = (
    path: string,
    body: Record<string, string>,
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: { "HX-Request": "true" },
    });

  // Reads group_id → member ids straight from the sidecar DB.
  const groupsSnapshot = (): Map<string, string[]> => {
    const db = new DatabaseSync(env.dbs.groupsDb, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT g.id AS gid, m.session_id AS sid FROM session_groups g " +
          "LEFT JOIN group_members m ON m.group_id = g.id",
      )
      .all() as { gid: string; sid: string | null }[];
    db.close();
    const out = new Map<string, string[]>();
    for (const row of rows) {
      const members = out.get(row.gid) ?? [];
      if (row.sid !== null) members.push(row.sid);
      out.set(row.gid, members);
    }
    return out;
  };

  const groupContaining = (sessionId: string): string | undefined =>
    [...groupsSnapshot().entries()].find(([, members]) =>
      members.includes(sessionId),
    )?.[0];

  beforeAll(async () => {
    env = await fx.startEnv("glv-grouprt-");
    const ids = [
      "gr-a",
      "gr-b",
      "gr-c",
      "gr-d",
      "gr-e",
      "gr-f",
      "gr-g",
      "gr-h",
    ];
    fx.seedSessions(
      env,
      ids.map((id) => ({
        id,
        name: id.toUpperCase(),
        workingDir: `${env.scratchDir}/${id}`,
      })),
    );
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("group routes", () => {
    it("creates a group around one session, then a second session joins it", async () => {
      const create = await post(`/sessions/${fx.viewId("gr-a")}/group`, {});
      expect(create.status).toBe(200);
      expect(await create.text()).toContain('id="session-list"');
      const groupId = groupContaining(fx.viewId("gr-a"));
      expect(groupId).toBeDefined();

      const join = await post(`/sessions/${fx.viewId("gr-b")}/group`, {
        groupId: groupId ?? "",
      });
      expect(join.status).toBe(200);
      const html = await join.text();
      expect(html).toContain("session-group");
      expect(html).toContain("GR-A");
      expect(html).toContain("GR-B");
    });

    it("rejects joining an unknown group with 404", async () => {
      const res = await post(`/sessions/${fx.viewId("gr-c")}/group`, {
        groupId: "nope",
      });
      expect(res.status).toBe(404);
    });

    it("ignores a self-pairing and an empty target", async () => {
      const before = groupsSnapshot();
      const self = await post(`/sessions/${fx.viewId("gr-d")}/group-with`, {
        otherId: fx.viewId("gr-d"),
      });
      expect(self.status).toBe(200);
      const empty = await post(`/sessions/${fx.viewId("gr-e")}/group-with`, {
        otherId: "",
      });
      expect(empty.status).toBe(200);

      const after = groupsSnapshot();
      expect(after.size).toBe(before.size);
      expect(groupContaining("gr-d")).toBeUndefined();
      expect(groupContaining("gr-e")).toBeUndefined();
    });

    it("pairs two ungrouped sessions into a new group", async () => {
      const res = await post(`/sessions/${fx.viewId("gr-f")}/group-with`, {
        otherId: fx.viewId("gr-g"),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("session-group");
      expect(html).toContain("GR-F");
      expect(html).toContain("GR-G");
    });

    it("joins the target session's existing group", async () => {
      const res = await post(`/sessions/${fx.viewId("gr-h")}/group-with`, {
        otherId: fx.viewId("gr-f"),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("GR-F");
      expect(html).toContain("GR-G");
      expect(html).toContain("GR-H");
      const members = groupsSnapshot().get(
        groupContaining(fx.viewId("gr-f")) ?? "",
      );
      // Sidecar rows carry the namespaced ids the routes write.
      expect(members?.sort()).toEqual(
        ["gr-f", "gr-g", "gr-h"].map((id) => fx.viewId(id)),
      );
    });

    it("rejects archiving an unknown group with 404", async () => {
      const res = await post("/groups/nope/archive", {});
      expect(res.status).toBe(404);
    });

    it("ungroups a session that never belonged to one", async () => {
      const res = await post(`/sessions/${fx.viewId("gr-e")}/ungroup`, {});
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id="session-list"');
    });
  });
};

export { runGroupsRoutesSuite };
