import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { formatOneShotInZone, formatOneShotLocal } from "../../schedule.js";
import {
  countSessions,
  pollUntil,
  sleep,
  withSeconds,
} from "../cron-helpers.js";
import {
  authedFetch,
  bearerFetch,
  type CronJobRow,
  cronJobRow,
  type FlavorFixture,
  type IntegrationEnv,
  readCronJobRows,
  seedApiToken,
  seedCronJobRow,
} from "../harness.js";

// End-to-end over real HTTP: the JSON cron surface — GET /api/cron, GET
// /api/cron/:name, POST /api/cron, POST /api/cron/:name/run,
// DELETE /api/cron/:name — which rides
// the same shared operation layer the browser's Scheduled runs section
// uses. Writes carry the API-token bearer exactly as a script would send
// them; the final describe schedules a real one-shot through the API and
// watches it fire once and retire itself, proving an API-created row
// reaches the running scheduler without a restart.

type JobJson = {
  name: string;
  schedule: string;
  schedule_input?: string;
  prompt: string;
  working_dir: string;
  timezone?: string;
  enabled: boolean;
  agent: string;
  model_provider?: string;
  model?: string;
  follow_ups?: string[];
  last_fired_at?: string;
  next_runs?: string[];
};

const runApiCronSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";
  let agentId = "";
  // Exists before startEnv so the seeded rows can point at it (the
  // scratch dir is only minted inside the boot).
  const seedWorkDir = mkdtempSync(join(tmpdir(), "glv-apicron-work-"));
  const captureDir = mkdtempSync(join(tmpdir(), "glv-apicron-"));
  const captureStdin = join(captureDir, "stdin.txt");

  beforeAll(async () => {
    env = await fx.startEnv(
      "glv-apicron-",
      {
        sessionName: "Api Cron Session",
        captureStdin,
      },
      undefined,
      {},
      ({ cronDb }) => {
        // One enabled and one paused row, seeded the way an external
        // writer would, so the listing tests read rows the API itself
        // did not create.
        seedCronJobRow(cronDb, {
          name: "Seeded weekly",
          schedule: "0 9 * * 1-5",
          prompt: "Seeded sweep",
          workingDir: seedWorkDir,
          enabled: true,
        });
        seedCronJobRow(cronDb, {
          name: "Paused sweep",
          schedule: "0 3 * * *",
          prompt: "Not firing",
          workingDir: seedWorkDir,
          enabled: false,
        });
      },
    );
    token = seedApiToken(env.dbs.authDb, "api-cron");
    agentId = fx.viewId("ac-1").split(":")[0];
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(seedWorkDir, { recursive: true, force: true });
    rmSync(captureDir, { recursive: true, force: true });
  });

  // The form submit exactly as curl -F would send it; repeated keys
  // (follow_ups) ride along in submit order.
  const postCron = (
    fields: Record<string, string | string[]>,
  ): Promise<Response> => {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields))
      for (const entry of Array.isArray(value) ? value : [value])
        form.append(key, entry);
    return bearerFetch(env, "/api/cron", token, {
      method: "POST",
      body: form,
    });
  };

  const findInList = async (name: string): Promise<JobJson | undefined> => {
    const res = await bearerFetch(env, "/api/cron", token);
    const jobs = (await res.json()) as JobJson[];
    return jobs.find((job) => job.name === name);
  };

  describe("cron auth boundary", () => {
    it("rejects a cookie-authenticated POST with 401 JSON", async () => {
      const res = await authedFetch(env, "/api/cron", {
        method: "POST",
        body: new URLSearchParams({ name: "x", schedule: "at 9:00" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error:
          "Write requests under /api require an API-token bearer; " +
          "session cookies are not accepted.",
      });
    });

    it("rejects an unauthenticated GET with 401 JSON", async () => {
      const res = await fetch(`${env.baseUrl}/api/cron`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("rejects a garbage bearer POST with 401 JSON", async () => {
      const res = await bearerFetch(env, "/api/cron", "wrong-token", {
        method: "POST",
        body: new URLSearchParams({ name: "x" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Missing or invalid bearer token.",
      });
    });

    it("admits the session cookie for reads", async () => {
      const res = await authedFetch(env, "/api/cron");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/cron", () => {
    it("lists stored rows in the documented shape", async () => {
      const res = await bearerFetch(env, "/api/cron", token);
      expect(res.status).toBe(200);
      const jobs = (await res.json()) as JobJson[];
      const seeded = jobs.find((job) => job.name === "Seeded weekly");
      expect(seeded).toBeDefined();
      expect(seeded?.schedule).toBe("0 9 * * 1-5");
      expect(seeded?.prompt).toBe("Seeded sweep");
      expect(seeded?.working_dir).toBe(seedWorkDir);
      expect(seeded?.enabled).toBe(true);
      expect(seeded?.agent).toBe(agentId);
      expect(seeded?.schedule_input).toBeUndefined();
      expect(seeded?.timezone).toBeUndefined();
      expect(seeded?.model_provider).toBeUndefined();
      // The store seeds the missed-run marker at creation.
      expect(typeof seeded?.last_fired_at).toBe("string");
      // An enabled cron pattern spells its next three fire times.
      expect(seeded?.next_runs).toHaveLength(3);
      for (const run of seeded?.next_runs ?? [])
        expect(Number.isNaN(Date.parse(run))).toBe(false);
    });

    it("marks paused rows enabled:false with no next_runs", async () => {
      const paused = await findInList("Paused sweep");
      expect(paused?.enabled).toBe(false);
      expect(paused?.next_runs).toBeUndefined();
    });
  });

  describe("POST /api/cron", () => {
    it("creates a one-off from an ISO datetime", async () => {
      // Aimed at a minute boundary exactly an hour out, so the form's
      // minute-precision spelling names the instant without truncation.
      const target = new Date((Math.floor(Date.now() / 60_000) + 61) * 60_000);
      const res = await postCron({
        name: "One-off report",
        schedule: formatOneShotLocal(target),
        prompt: "Write the one-off report",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("location")).toBe(
        `/api/cron/${encodeURIComponent("One-off report")}`,
      );
      const body = (await res.json()) as JobJson;
      expect(body.name).toBe("One-off report");
      expect(body.enabled).toBe(true);
      expect(body.agent).toBe(agentId);
      expect(body.next_runs).toHaveLength(1);
      expect(
        Math.abs(Date.parse(body.next_runs?.[0] ?? "") - target.getTime()),
      ).toBeLessThan(1000);

      // The row the scheduler reads holds exactly what was submitted.
      expect(cronJobRow(env.dbs.cronDb, "One-off report")).toMatchObject({
        schedule: formatOneShotLocal(target),
        prompt: "Write the one-off report",
        workingDir: env.scratchDir,
        enabled: true,
      });
      expect(await findInList("One-off report")).toBeDefined();
    });

    it("creates a recurring job from a cron pattern", async () => {
      const res = await postCron({
        name: "Weekday build",
        schedule: "0 9 * * 1-5",
        prompt: "Run the weekday build",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as JobJson;
      expect(body.schedule).toBe("0 9 * * 1-5");
      expect(body.next_runs).toHaveLength(3);
    });

    it("stores human text as its cron translation", async () => {
      const res = await postCron({
        name: "Human sweep",
        schedule: "every weekday at 9:00",
        prompt: "Human-scheduled sweep",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as JobJson;
      expect(body.schedule_input).toBe("every weekday at 9:00");
      expect(body.schedule).not.toBe("every weekday at 9:00");
      expect(cronJobRow(env.dbs.cronDb, "Human sweep")).toMatchObject({
        scheduleInput: "every weekday at 9:00",
      });
    });

    it("accepts a timezone override and rejects an unknown zone", async () => {
      const target = new Date(Date.now() + 3_600_000);
      const ok = await postCron({
        name: "Zoned one-off",
        // Spelled in the override's own wall clock so the moment is
        // future wherever the server runs.
        schedule: formatOneShotInZone(target, "America/New_York"),
        prompt: "Zoned run",
        working_dir: env.scratchDir,
        timezone: "America/New_York",
      });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as JobJson).timezone).toBe("America/New_York");

      const bad = await postCron({
        name: "Bad zone",
        schedule: formatOneShotInZone(target, "America/New_York"),
        prompt: "Zoned run",
        working_dir: env.scratchDir,
        timezone: "Bogus/Zone",
      });
      expect(bad.status).toBe(422);
      expect(await bad.json()).toEqual({
        error:
          'Timezone "Bogus/Zone" is not recognized — use an IANA name ' +
          "like America/New_York (the field suggests them as you type).",
      });
    });

    it("stores repeated follow_ups fields in order", async () => {
      const res = await postCron({
        name: "Chained sweep",
        schedule: "0 9 * * 1-5",
        prompt: "First step",
        working_dir: env.scratchDir,
        follow_ups: ["Second step", "Third step"],
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as JobJson).follow_ups).toEqual([
        "Second step",
        "Third step",
      ]);
      expect(cronJobRow(env.dbs.cronDb, "Chained sweep")?.followUps).toEqual([
        "Second step",
        "Third step",
      ]);
    });

    it("rejects more follow-on steps than the cap", async () => {
      const res = await postCron({
        name: "Too chained",
        schedule: "0 9 * * 1-5",
        prompt: "First step",
        working_dir: env.scratchDir,
        follow_ups: Array.from({ length: 10 }, (_, i) => `Step ${i + 2}`),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("at most 9 follow-on steps");
      expect(cronJobRow(env.dbs.cronDb, "Too chained")).toBeUndefined();
    });

    it("rejects an empty prompt with 422", async () => {
      const res = await postCron({
        name: "No prompt",
        schedule: "at 9:00",
        prompt: "  ",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "A prompt is required." });
    });

    it("rejects a missing working directory with 422", async () => {
      const res = await postCron({
        name: "No dir",
        schedule: "at 9:00",
        prompt: "Somewhere to run",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "A working directory is required.",
      });
    });

    it("rejects a working directory that does not exist with 422", async () => {
      const res = await postCron({
        name: "Ghost dir",
        schedule: "at 9:00",
        prompt: "Run nowhere",
        working_dir: "/definitely/not/a/real/dir",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "That working directory does not exist.",
      });
    });

    it("rejects an invalid job name with 422", async () => {
      const res = await postCron({
        name: "not a valid name!",
        schedule: "at 9:00",
        prompt: "Run",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Job names start with");
    });

    it("rejects a name collision with an existing job", async () => {
      const res = await postCron({
        name: "Seeded weekly",
        schedule: "at 8:30",
        prompt: "Duplicate",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("already exists");
    });

    it("rejects a one-shot in the past with 422", async () => {
      const res = await postCron({
        name: "Past one-off",
        schedule: "2000-01-01T09:00",
        prompt: "Too late",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("already in the past");
    });

    it("rejects an unparseable schedule with 422", async () => {
      const res = await postCron({
        name: "Broken schedule",
        schedule: "definitely not a schedule",
        prompt: "Run",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Couldn’t understand");
    });

    it("rejects a model naming an unserved agent with 422", async () => {
      const res = await postCron({
        name: "Ghost agent",
        schedule: "at 9:00",
        prompt: "Run",
        working_dir: env.scratchDir,
        model: "nosuchagent:",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'Agent "nosuchagent" is not enabled.',
      });
    });

    it("rejects a model the agent does not offer with 422", async () => {
      const res = await postCron({
        name: "Ghost model",
        schedule: "at 9:00",
        prompt: "Run",
        working_dir: env.scratchDir,
        model: `${agentId}:definitely-not-a-model`,
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error:
          `That model is no longer available in ${fx.name}. ` +
          "Pick another from the list.",
      });
    });
  });

  describe("GET /api/cron/:name", () => {
    it("returns one row, spaces in the name URL-encoded", async () => {
      const res = await bearerFetch(
        env,
        `/api/cron/${encodeURIComponent("Seeded weekly")}`,
        token,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as JobJson;
      expect(body.name).toBe("Seeded weekly");
      expect(body.schedule).toBe("0 9 * * 1-5");
    });

    it("answers 404 JSON for an unknown name", async () => {
      const res = await bearerFetch(env, "/api/cron/nope", token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No scheduled run nope." });
    });
  });

  describe("DELETE /api/cron/:name", () => {
    it("deletes a job created through the API", async () => {
      const create = await postCron({
        name: "Cleanup task 2",
        schedule: "0 9 * * 1-5",
        prompt: "Deleted before ever firing",
        working_dir: env.scratchDir,
      });
      expect(create.status).toBe(201);

      const res = await bearerFetch(
        env,
        `/api/cron/${encodeURIComponent("Cleanup task 2")}`,
        token,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        name: "Cleanup task 2",
        status: "deleted",
      });
      expect(cronJobRow(env.dbs.cronDb, "Cleanup task 2")).toBeUndefined();
      expect(await findInList("Cleanup task 2")).toBeUndefined();

      const again = await bearerFetch(
        env,
        `/api/cron/${encodeURIComponent("Cleanup task 2")}`,
        token,
        { method: "DELETE" },
      );
      expect(again.status).toBe(404);
    });
  });

  describe("POST /api/cron/:name/run", () => {
    it("fires a stored run now and answers 202 once accepted", async () => {
      const res = await bearerFetch(
        env,
        `/api/cron/${encodeURIComponent("Seeded weekly")}/run`,
        token,
        { method: "POST" },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        name: "Seeded weekly",
        status: "started",
      });

      // The answer says "started": the session lands in the sidebar as
      // the agent creates it, carrying the job's prompt.
      const started = await pollUntil(
        async () => (await countSessions(env, "Api Cron Session")) >= 1,
        20_000,
        250,
      );
      expect(started, "the run-now fire never reached the agent").toBe(true);
      const transcript = `${captureStdin}.invocations`;
      const prompted = await pollUntil(
        () =>
          existsSync(transcript) &&
          readFileSync(transcript, "utf-8").includes("Seeded sweep"),
        10_000,
        250,
      );
      expect(prompted, "the run-now prompt never reached the agent").toBe(true);

      // The fire recorded its occurrence and the row stays scheduled —
      // running a job now does not consume it.
      await pollUntil(
        () =>
          cronJobRow(env.dbs.cronDb, "Seeded weekly")?.lastFiredAt !==
          undefined,
        10_000,
        250,
      );
      expect(cronJobRow(env.dbs.cronDb, "Seeded weekly")?.enabled).toBe(true);
    });

    it("answers 404 JSON for an unknown name", async () => {
      const res = await bearerFetch(env, "/api/cron/nope/run", token, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No scheduled run nope." });
    });
  });

  describe("an API-scheduled one-shot fires once and retires", () => {
    it("fires at its moment and leaves the store", async () => {
      // Second precision, a few seconds out — the same spelling the
      // browser form writes, aimed close so the suite stays fast.
      const target = new Date(Date.now() + 6_000);
      const res = await postCron({
        name: "Fire once",
        schedule: withSeconds(formatOneShotLocal(target), target),
        prompt: "api cron: fire once marker",
        working_dir: env.scratchDir,
      });
      expect(res.status).toBe(201);

      // The agent received the job's prompt on stdin — the API-written
      // row reached the running scheduler without a restart.
      const fired = await pollUntil(
        () =>
          existsSync(captureStdin) &&
          readFileSync(captureStdin, "utf-8").includes(
            "api cron: fire once marker",
          ),
        30_000,
        250,
      );
      expect(fired, "the one-shot never reached the agent").toBe(true);

      // Once its moment has passed the row retires itself, so the API
      // that listed it stops seeing it.
      const retired = await pollUntil(
        async () => (await findInList("Fire once")) === undefined,
        30_000,
        250,
      );
      expect(retired, "the fired one-shot never retired").toBe(true);
      const rows = readCronJobRows(env.dbs.cronDb).filter(
        (job: CronJobRow) => job.name === "Fire once",
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("run now while a fire is in flight", () => {
    let env: IntegrationEnv;
    let homeDir: string;
    let workDir: string;
    // A separate serve process with its own auth database — its token
    // cannot be the outer suite's.
    let runToken = "";

    beforeAll(async () => {
      homeDir = mkdtempSync(join(tmpdir(), "glv-apicron-runnow-"));
      workDir = mkdtempSync(join(tmpdir(), "glv-apicron-rnwork-"));
      // A two-step chain on a slow agent: the in-flight window spans
      // both steps, wide enough for the second POST to land inside it.
      env = await fx.startEnv(
        "glv-apicron-runnow-",
        { sessionName: "Run Now Api", sleepMs: 4000 },
        homeDir,
        {},
        ({ cronDb }) =>
          seedCronJobRow(cronDb, {
            name: "chained",
            schedule: "0 9 * * 1-5",
            prompt: "run-now chain step one",
            workingDir: workDir,
            followUps: ["run-now chain step two"],
            enabled: true,
          }),
      );
      runToken = seedApiToken(env.dbs.authDb, "api-cron-runnow");
    }, 120000);

    afterAll(async () => {
      await env?.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    });

    it("refuses a second fire instead of stacking pipelines", async () => {
      const first = await bearerFetch(env, "/api/cron/chained/run", runToken, {
        method: "POST",
      });
      expect(first.status).toBe(202);

      // Step one is established (and the chain still walking) — a run
      // now now must answer 409, not start a parallel chain.
      const stepOne = await pollUntil(
        async () => (await countSessions(env, "Run Now Api")) >= 1,
        20_000,
        250,
      );
      expect(stepOne, "the first fire never established").toBe(true);

      const second = await bearerFetch(env, "/api/cron/chained/run", runToken, {
        method: "POST",
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        error:
          'cron job "chained" is still running — wait for it to finish, ' +
          "or stop its session",
      });

      // The refused fire started nothing extra: the chain settles at
      // exactly two sessions.
      const settled = await pollUntil(
        async () => (await countSessions(env, "Run Now Api")) === 2,
        45_000,
        500,
      );
      expect(settled, "the chain never ran both steps").toBe(true);
      await sleep(1500);
      expect(await countSessions(env, "Run Now Api")).toBe(2);
    });
  });

  describe("the generated contract", () => {
    it("documents the cron surface", async () => {
      const res = await bearerFetch(env, "/api/openapi.json", token);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<
          string,
          { get?: unknown; post?: unknown; delete?: unknown }
        >;
        components: { schemas: Record<string, unknown> };
      };
      expect(Object.keys(doc.paths)).toContain("/api/cron");
      expect(Object.keys(doc.paths)).toContain("/api/cron/{name}");
      expect(Object.keys(doc.paths)).toContain("/api/cron/{name}/run");
      expect(doc.paths["/api/cron"]?.post).toBeDefined();
      expect(doc.paths["/api/cron/{name}"]?.get).toBeDefined();
      expect(doc.paths["/api/cron/{name}"]?.delete).toBeDefined();
      expect(doc.paths["/api/cron/{name}/run"]?.post).toBeDefined();
      for (const schema of [
        "CronJob",
        "CronJobForm",
        "CronDeleted",
        "CronRunAccepted",
      ])
        expect(Object.keys(doc.components.schemas)).toContain(schema);
    });
  });
};

export { runApiCronSuite };
