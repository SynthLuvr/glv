import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { openSessionLinksDb, tagParentSession } from "../../session-links.js";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  seedApiToken,
  withPage,
} from "../harness.js";

// The orchestrator link over real HTTP (#385): loops drive the whole
// pipeline through POST /api/sessions, and the parent_session field is
// the only record of who launched whom. One environment holds every
// shape — an orchestrator with seeded workers, a worker whose parent is
// gone (the orphan), and a plain human session — so the wire (create,
// read, filter), the sidebar nesting, and the delete cleanup all assert
// against the same truth.

type SessionRow = {
  id: string;
  name: string;
  parent_session?: string;
};

type RunAccepted = { id: string; status: string };

const runParentSessionSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token: string;
  let apiChild: string | undefined;
  let plainChild: string | undefined;

  const orch = (): string => fx.viewId("ps-orch");
  const worker = (id: string): string => fx.viewId(id);

  const fetchApi = (path: string, init: RequestInit = {}): Promise<Response> =>
    bearerFetch(env, path, token, init);

  const listRows = async (
    params: Record<string, string> = {},
  ): Promise<SessionRow[]> => {
    const search = new URLSearchParams(params).toString();
    const res = await fetchApi(`/api/sessions${search ? `?${search}` : ""}`);
    expect(res.status).toBe(200);
    return (await res.json()) as SessionRow[];
  };

  const detailRow = async (id: string): Promise<SessionRow> => {
    const res = await fetchApi(`/api/sessions/${id}?fields=meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: SessionRow };
    return body.session;
  };

  // The loop's launch call: a worker under the orchestrator.
  const postWorker = (fields: Record<string, string>): Promise<Response> => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("working_dir", env.scratchDir);
    return fetchApi("/api/sessions", { method: "POST", body: form });
  };

  beforeAll(async () => {
    env = await fx.startEnv("glv-psess-");
    token = seedApiToken(env.dbs.authDb, "parent-session");
    mkdirSync(join(env.scratchDir, "w"), { recursive: true });
    const workDir = join(env.scratchDir, "w");

    // The loop's cast: the orchestrator, its three workers, an orphaned
    // worker (its parent never visible), and a human's own session.
    fx.seedSessions(env, [
      { id: "ps-orch", name: "Loop Orchestrator", workingDir: workDir },
      { id: "ps-w1", name: "Issue #379 fix", workingDir: workDir },
      { id: "ps-w2", name: "Issue #379 refactor", workingDir: workDir },
      { id: "ps-w3", name: "Issue #328 fix", workingDir: workDir },
      { id: "ps-orphan", name: "Crash-retry orphan", workingDir: workDir },
      { id: "ps-solo", name: "Ad-hoc session", workingDir: workDir },
    ]);
    // Links ride the sidecar through its own module — the same writes the
    // server's create path performs, spelled with the namespaced ids the
    // sidebar and API rows carry.
    const links = openSessionLinksDb(env.dbs.cronDb);
    tagParentSession(links, worker("ps-w1"), orch());
    tagParentSession(links, worker("ps-w2"), orch());
    tagParentSession(links, worker("ps-w3"), orch());
    tagParentSession(links, worker("ps-orphan"), fx.viewId("ps-ghost"));
    links.close();
  }, 240000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("POST /api/sessions parent_session", () => {
    it("links the created session to its orchestrator", async () => {
      const res = await postWorker({
        prompt: "parent-session: fix issue #379",
        name: "Issue #379 fix (api)",
        parent_session: orch(),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as RunAccepted;
      apiChild = id;
      expect(await detailRow(id)).toMatchObject({
        id,
        parent_session: orch(),
      });
    });

    it("rejects an unknown parent with 422, naming it", async () => {
      const missing = fx.viewId("ps-nope");
      const res = await postWorker({
        prompt: "parent-session: bad link",
        parent_session: missing,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(missing);
    });

    it("omits the field when no parent was submitted", async () => {
      const res = await postWorker({
        prompt: "parent-session: human ad-hoc",
        name: "Plain api session",
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as RunAccepted;
      plainChild = id;
      const row = await detailRow(id);
      expect(row.parent_session).toBeUndefined();
    });
  });

  describe("GET /api/sessions reads and filters", () => {
    it("carries parent_session on linked list rows only", async () => {
      const rows = await listRows();
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(worker("ps-w1"))?.parent_session).toBe(orch());
      expect(byId.get(apiChild ?? "")?.parent_session).toBe(orch());
      expect(byId.get(worker("ps-solo"))?.parent_session).toBeUndefined();
      expect(byId.has(plainChild ?? "")).toBe(true);
    });

    it("?parent_session= answers exactly the loop's sessions", async () => {
      const rows = await listRows({ parent_session: orch() });
      expect(rows.map((row) => row.id).sort()).toEqual(
        [worker("ps-w1"), worker("ps-w2"), worker("ps-w3"), apiChild ?? ""]
          .filter((id) => id !== "")
          .sort(),
      );
      expect(rows.map((row) => row.id)).not.toContain(worker("ps-solo"));
    });

    it("?parent_session= composes with the window", async () => {
      const page1 = await listRows({ parent_session: orch(), limit: "2" });
      const page2 = await listRows({
        parent_session: orch(),
        limit: "2",
        offset: "2",
      });
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page1.filter((row) => page2.some((r) => r.id === row.id))).toEqual(
        [],
      );
    });

    it("?parent_session= still answers for a parent row that is not visible", async () => {
      // The orphan's orchestrator never appears as a session, but the
      // link is the sidecar's truth — the loop-membership query does not
      // depend on the parent being listable.
      const rows = await listRows({ parent_session: fx.viewId("ps-ghost") });
      expect(rows.map((row) => row.id)).toEqual([worker("ps-orphan")]);
    });

    it("?parent_session= answers empty for a session with no workers", async () => {
      expect(await listRows({ parent_session: worker("ps-solo") })).toEqual([]);
    });
  });

  describe("sidebar nesting", () => {
    it("nests workers under their orchestrator, collapsible", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const subtree = page.locator(
          `.orchestrator-group[data-group-id="${orch()}"]`,
        );
        await expect(subtree).toHaveCount(1);
        // The workers sit inside the subtree's members rail…
        await expect(
          subtree.locator(
            `.group-members .session-item[data-session-id="${worker("ps-w1")}"]`,
          ),
        ).toHaveCount(1);
        await expect(
          subtree.locator(
            `.group-members .session-item[data-session-id="${apiChild ?? ""}"]`,
          ),
        ).toHaveCount(1);
        // …not as top-level rows.
        await expect(
          page.locator(
            `#session-list > .session-item[data-session-id="${worker("ps-w1")}"]`,
          ),
        ).toHaveCount(0);
        // The orchestrator itself is the subtree's header row, with the
        // worker count beside it.
        await expect(
          subtree.locator(
            `.orchestrator-header .session-item[data-session-id="${orch()}"]`,
          ),
        ).toHaveCount(1);
        await expect(subtree.locator(".group-toggle")).toHaveCount(1);

        // The orphan's parent is not visible, so it lists flat.
        await expect(
          page.locator(
            `#session-list > .session-item[data-session-id="${worker("ps-orphan")}"]`,
          ),
        ).toHaveCount(1);

        // So does the human's unlinked session.
        await expect(
          page.locator(
            `#session-list > .session-item[data-session-id="${worker("ps-solo")}"]`,
          ),
        ).toHaveCount(1);

        // Collapse hides the members, expand restores them — the groups
        // mechanics apply unchanged.
        await subtree.locator(".group-toggle").click();
        await expect(subtree).toHaveClass(/collapsed/);
        await expect(subtree.locator(".group-members")).toBeHidden();
        await subtree.locator(".group-toggle").click();
        await expect(subtree.locator(".group-members")).toBeVisible();
      });
    });

    it("names the orchestrator in the worker's header", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${worker("ps-w2")}`);
        const chip = page.locator(".parent-chip");
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText("Loop Orchestrator");
        await expect(chip).toHaveAttribute("href", `/sessions/${orch()}`);
        // The orchestrator's own header carries no parent chip.
        await page.goto(`${env.baseUrl}/sessions/${orch()}`);
        await expect(page.locator(".parent-chip")).toHaveCount(0);
      });
    });
  });

  describe("delete cleanup", () => {
    it("drops the worker's link with the worker", async () => {
      const res = await authedFetch(
        env,
        `/sessions/${worker("ps-w2")}/delete`,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      const rows = await listRows({ parent_session: orch() });
      expect(rows.map((row) => row.id)).not.toContain(worker("ps-w2"));
    });

    it("drops every worker link with the orchestrator", async () => {
      const res = await authedFetch(env, `/sessions/${orch()}/delete`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await listRows({ parent_session: orch() })).toEqual([]);
      // The workers themselves survive, unlinked.
      const row = await detailRow(worker("ps-w1"));
      expect(row.parent_session).toBeUndefined();
    });
  });
};

export { runParentSessionSuite };
