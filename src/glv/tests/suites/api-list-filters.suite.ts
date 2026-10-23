import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bearerFetch,
  type FlavorFixture,
  type IntegrationEnv,
  type MockConfig,
  seedApiToken,
} from "../harness.js";

// End-to-end over real HTTP: the listing filters on GET /api/sessions
// (#344). Answering "what's running / what has run in this repo" used to
// mean pulling the newest N sessions and filtering client-side; the
// listing now narrows server-side — ?working_dir= keeps sessions under
// one directory (a path-boundary prefix, so a sibling that merely shares
// a stem does not match), ?agent= keeps one served agent's sessions, and
// ?active=true keeps only sessions with a live run. Every filter applies
// before the limit/offset window, so pagination pages the filtered order
// — the pagination tests below pin that composition. Two environments:
// one for the pure read logic over seeded sessions, one with a
// long-lived mock run (the mock's sleep is fixed per environment) for
// the active filter's live-set behaviour.

type ListRow = {
  id: string;
  agent?: string;
  working_dir: string;
  status: string;
};

// One mock environment bound to the API token that speaks for it, so a
// helper can never pair one env's server with another env's token.
type ListClient = { env: IntegrationEnv; token: string };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runApiListFiltersSuite = (fx: FlavorFixture): void => {
  let main: ListClient;
  let slow: ListClient;

  // The other agent id — served nowhere in the single-agent fixtures, so
  // the agent filter's rejection has a real name to miss with.
  const unservedAgent = fx.name === "goose" ? "claude" : "goose";

  const startClient = async (
    prefix: string,
    mock: MockConfig = {},
  ): Promise<ListClient> => {
    const env = await fx.startEnv(prefix, mock);
    return { env, token: seedApiToken(env.dbs.authDb, "api-list-filters") };
  };

  const fetchApi = (
    client: ListClient,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => bearerFetch(client.env, path, client.token, init);

  // The listing's query, spelled as parameters and encoded once by
  // URLSearchParams — no call site hand-rolls an encodeURIComponent.
  const listQuery = (params: Record<string, string>): string => {
    const search = new URLSearchParams(params).toString();
    return search === "" ? "" : `?${search}`;
  };

  const listRows = async (
    client: ListClient,
    params: Record<string, string> = {},
  ): Promise<ListRow[]> => {
    const query = listQuery(params);
    const res = await fetchApi(client, `/api/sessions${query}`);
    expect(res.status, query).toBe(200);
    return (await res.json()) as ListRow[];
  };

  const listIds = async (
    client: ListClient,
    params: Record<string, string> = {},
  ): Promise<string[]> => (await listRows(client, params)).map((row) => row.id);

  const statusOf = async (client: ListClient, id: string): Promise<string> => {
    const res = await fetchApi(client, `/api/sessions/${id}?fields=meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string } };
    return body.session.status;
  };

  // Polls the detail endpoint until status lands in `want`; a settled run
  // lingers in the registry for ~30s, so any reasonable poll cadence
  // observes the terminal status before it drops to "idle".
  const waitForStatus = async (
    client: ListClient,
    id: string,
    want: readonly string[],
  ): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const status = await statusOf(client, id);
      if (want.includes(status)) return status;
      if (Date.now() > deadline)
        throw new Error(
          `status of ${id} stayed "${status}"; wanted one of ` + want.join("/"),
        );
      await delay(200);
    }
  };

  const postPrompt = (
    client: ListClient,
    id: string,
    prompt: string,
  ): Promise<Response> =>
    fetchApi(client, `/api/sessions/${id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ prompt }),
    });

  beforeAll(async () => {
    main = await startClient("glv-apilf-");
    slow = await startClient("glv-apilf-slow-", { sleepMs: 30000 });

    // Follow-up runs spawn the agent in the session's working dir, so the
    // slow env's run dir must exist; the main env never runs anything, so
    // its seeded dirs may stay notional.
    mkdirSync(join(slow.env.scratchDir, "run-here"), { recursive: true });

    // proj-a holds three sessions (one in a nested directory), proj-ab is
    // the sibling that shares proj-a's stem — the boundary case the
    // prefix must not swallow — and proj-b is simply elsewhere.
    const a = join(main.env.scratchDir, "proj-a");
    fx.seedSessions(main.env, [
      { id: "lf-a1", name: "Under A", workingDir: a },
      { id: "lf-a2", name: "Under A Nested", workingDir: join(a, "nested") },
      { id: "lf-a3", name: "Under A Again", workingDir: a },
      {
        id: "lf-ab1",
        name: "Sibling Stem",
        workingDir: join(main.env.scratchDir, "proj-ab"),
      },
      {
        id: "lf-b1",
        name: "Elsewhere",
        workingDir: join(main.env.scratchDir, "proj-b"),
      },
    ]);

    // The active filter's pair: one session a run is started against, one
    // that never runs.
    fx.seedSessions(slow.env, [
      {
        id: "lf-run",
        name: "Will Run",
        workingDir: join(slow.env.scratchDir, "run-here"),
      },
      {
        id: "lf-idle",
        name: "Never Runs",
        workingDir: join(slow.env.scratchDir, "run-here"),
      },
    ]);
  }, 240000);

  afterAll(async () => {
    await main?.env.cleanup();
    await slow?.env.cleanup();
  });

  describe("GET /api/sessions working_dir filter", () => {
    const dirA = (): string => join(main.env.scratchDir, "proj-a");

    it("keeps only sessions under the directory, boundary-aware", async () => {
      const ids = await listIds(main, { working_dir: dirA() });
      expect(ids.sort()).toEqual(
        [fx.viewId("lf-a1"), fx.viewId("lf-a2"), fx.viewId("lf-a3")].sort(),
      );
      // The nested session rides along, the sibling stem does not.
      expect(ids).toContain(fx.viewId("lf-a2"));
      expect(ids).not.toContain(fx.viewId("lf-ab1"));
      expect(ids).not.toContain(fx.viewId("lf-b1"));
    });

    it("matches the directory itself but not the sibling sharing its stem", async () => {
      const ids = await listIds(main, {
        working_dir: join(main.env.scratchDir, "proj-ab"),
      });
      expect(ids).toEqual([fx.viewId("lf-ab1")]);
    });

    it("tolerates a trailing separator on the prefix", async () => {
      const ids = await listIds(main, { working_dir: `${dirA()}/` });
      expect(ids.sort()).toEqual(
        [fx.viewId("lf-a1"), fx.viewId("lf-a2"), fx.viewId("lf-a3")].sort(),
      );
    });

    it("answers an empty list for a directory with no sessions", async () => {
      expect(
        await listIds(main, {
          working_dir: join(main.env.scratchDir, "nowhere"),
        }),
      ).toEqual([]);
    });

    it("windows the filtered order — pagination composes", async () => {
      const all = await listIds(main, { working_dir: dirA() });
      expect(all.length).toBe(3);
      const firstPage = await listIds(main, {
        working_dir: dirA(),
        limit: "2",
      });
      expect(firstPage.length).toBe(2);
      const secondPage = await listIds(main, {
        working_dir: dirA(),
        limit: "2",
        offset: "2",
      });
      expect(secondPage.length).toBe(1);
      // The two windows are disjoint and cover the filtered set — the
      // offset skipped filtered rows, not unfiltered ones.
      expect(firstPage.filter((id) => secondPage.includes(id))).toEqual([]);
      expect([...firstPage, ...secondPage].sort()).toEqual([...all].sort());
    });
  });

  describe("GET /api/sessions agent filter", () => {
    it("keeps the served agent's sessions and stamps the agent", async () => {
      const rows = await listRows(main, { agent: fx.name });
      expect(rows.length).toBe(5);
      for (const row of rows) expect(row.agent, row.id).toBe(fx.name);
      expect(rows.map((row) => row.id)).toContain(fx.viewId("lf-a1"));
    });

    it("answers 422 for an agent this server does not serve", async () => {
      const res = await fetchApi(main, `/api/sessions?agent=${unservedAgent}`);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('"agent"');
      expect(body.error).toContain(fx.name);
    });

    it("reads an empty agent as absent", async () => {
      const rows = await listRows(main, { agent: "" });
      expect(rows.length).toBe(5);
    });
  });

  describe("GET /api/sessions active filter", () => {
    const runId = (): string => fx.viewId("lf-run");
    const runDir = (): string => join(slow.env.scratchDir, "run-here");

    it("answers an empty list while nothing runs", async () => {
      expect(await listIds(slow, { active: "true" })).toEqual([]);
    });

    it("lists the running session — and only it", async () => {
      const accepted = await postPrompt(slow, runId(), "list-filters: run");
      expect(accepted.status).toBe(200);
      expect(await waitForStatus(slow, runId(), ["running"])).toBe("running");

      const rows = await listRows(slow, { active: "true" });
      expect(rows.map((row) => row.id)).toEqual([runId()]);
      // The idle sibling exists but never ran, so it stays out.
      expect(rows.map((row) => row.id)).not.toContain(fx.viewId("lf-idle"));
      expect(["queued", "running"]).toContain(rows[0]?.status);
    });

    it("composes with working_dir", async () => {
      expect(
        await listIds(slow, { active: "true", working_dir: runDir() }),
      ).toEqual([runId()]);
      expect(
        await listIds(slow, {
          active: "true",
          working_dir: join(slow.env.scratchDir, "elsewhere"),
        }),
      ).toEqual([]);
    });

    it("composes with the agent filter", async () => {
      expect(await listIds(slow, { active: "true", agent: fx.name })).toEqual([
        runId(),
      ]);
    });

    it("drops the session once its run settles", async () => {
      const stop = await fetchApi(slow, `/api/sessions/${runId()}/stop`, {
        method: "POST",
      });
      expect(stop.status).toBe(200);
      expect(await waitForStatus(slow, runId(), ["stopped"])).toBe("stopped");
      // A settled run is not active, even while its terminal handle
      // lingers in the registry.
      expect(await listIds(slow, { active: "true" })).toEqual([]);
    });
  });

  describe("GET /api/sessions filter validation", () => {
    it("rejects a non-boolean active with 422, naming it", async () => {
      const res = await fetchApi(main, "/api/sessions?active=sure");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('"active"');
    });

    it("reads active=false as absent", async () => {
      const rows = await listRows(main, { active: "false" });
      expect(rows.length).toBe(5);
    });

    it("still validates limit alongside the filters", async () => {
      const res = await fetchApi(main, "/api/sessions?active=true&limit=0");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('"limit"');
    });
  });

  describe("GET /api/openapi.json", () => {
    it("documents the listing filters", async () => {
      const res = await fetchApi(main, "/api/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<
          string,
          {
            get?: {
              parameters?: {
                name: string;
                in: string;
                description?: string;
                schema?: { enum?: string[] };
              }[];
            };
          }
        >;
      };
      const params = doc.paths["/api/sessions"]?.get?.parameters ?? [];
      const byName = new Map(params.map((param) => [param.name, param]));
      expect(byName.get("working_dir")?.in).toBe("query");
      expect(byName.get("agent")?.in).toBe("query");
      expect(byName.get("agent")?.description).toContain(fx.name);
      expect(byName.get("active")?.schema?.enum).toEqual(["false", "true"]);
    });
  });
};

export { runApiListFiltersSuite };
