import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  bearerFetch,
  type FlavorFixture,
  flagValue,
  type IntegrationEnv,
  seedApiToken,
  waitForFile,
  withPage,
} from "../harness.js";

// Fork end-to-end over real HTTP: the storage copy (every message the
// agent persisted), the cutoff (a prefix the agent will resume), and the
// original-untouched guarantee — asserted against the flavor-owned store
// bytes, not just the API's projection. The mock agents already emulate
// resume persistence (they append their replies to the resumed id), so a
// fork + prompt exercises the exact path a real follow-up takes.

type ApiSession = {
  session: { id: string; name: string; user_set_name: number | null };
  messages: { role: string; items: unknown[] }[];
};

const runSessionForkSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let token = "";
  // The mock agent's captured argv lands here (one file, overwritten per
  // invocation — read right after the run under test starts).
  const captureDir = mkdtempSync(join(tmpdir(), "glv-forkcap-"));

  const post = (
    path: string,
    body: Record<string, string> = {},
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: { "HX-Request": "true" },
    });

  const apiFork = (
    id: string,
    fields: Record<string, string> = {},
  ): Promise<Response> =>
    bearerFetch(env, `/api/sessions/${id}/fork`, token, {
      method: "POST",
      body: new URLSearchParams(fields),
    });

  // Server-emitted ids are namespaced; the flavor stores speak native
  // ones (assertSessionGone, readSessionField, snapshotStore).
  const nativeOf = (viewId: string): string =>
    viewId.startsWith(`${fx.name}:`)
      ? viewId.slice(fx.name.length + 1)
      : viewId;

  const readApi = async (id: string): Promise<ApiSession> => {
    const res = await authedFetch(env, `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ApiSession;
  };

  const messageTexts = (session: ApiSession): string[] =>
    session.messages.flatMap((message) =>
      message.items
        .filter(
          (item): item is { type: "text"; text: string } =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: unknown }).type === "text",
        )
        .map((item) => item.text),
    );

  beforeAll(async () => {
    env = await fx.startEnv("glv-fork-", {
      // The mock persists its reply to the resumed id (writeDb) and
      // sleeps briefly so one test can fork a genuinely running source.
      writeDb: true,
      sleepMs: 2500,
      captureArgs: join(captureDir, "args.json"),
    });
    token = seedApiToken(env.dbs.authDb, "fork");
    // The runner spawns agents with the session's working dir as cwd, so
    // the seeded dirs must exist for the fork runs.
    for (const dir of ["fork-a", "fork-b", "fork-c"])
      mkdirSync(join(env.scratchDir, dir), { recursive: true });
    fx.seedSessions(env, [
      {
        id: "fk-src",
        name: "Fork Source",
        workingDir: join(env.scratchDir, "fork-a"),
      },
      {
        id: "fk-tool",
        name: "Tool Session",
        workingDir: join(env.scratchDir, "fork-b"),
      },
      {
        id: "fk-empty",
        name: "Empty Session",
        workingDir: join(env.scratchDir, "fork-c"),
      },
    ]);
    // The runs this suite starts commit rows stamped "now", so the seeds
    // are backdated ten minutes: the copies read back in seed order and
    // any run reply lands after them, regardless of spawn latency.
    const seedBase = Date.now() - 10 * 60 * 1000;
    fx.seedMessages(env, "fk-src", [
      {
        role: "user",
        createdTimestamp: seedBase,
        content: [{ type: "text", text: "first prompt" }],
      },
      {
        role: "assistant",
        createdTimestamp: seedBase + 1000,
        content: [{ type: "text", text: "first reply" }],
      },
      {
        role: "user",
        createdTimestamp: seedBase + 2000,
        content: [{ type: "text", text: "second prompt" }],
      },
      {
        role: "assistant",
        createdTimestamp: seedBase + 3000,
        content: [{ type: "text", text: "second reply" }],
      },
    ]);
    fx.seedMessages(env, "fk-tool", [
      {
        role: "user",
        createdTimestamp: seedBase,
        content: [{ type: "text", text: "please run the tool" }],
      },
      {
        role: "assistant",
        createdTimestamp: seedBase + 1000,
        content: [fx.toolRequest("shell", { command: "echo hi" })],
      },
      {
        role: "user",
        createdTimestamp: seedBase + 2000,
        content: [fx.toolResponse("hi", false)],
      },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(captureDir, { recursive: true, force: true });
  });

  describe("whole-history fork with a prompt (JSON API)", () => {
    it("copies the transcript, resumes the copy, and leaves the source untouched", async () => {
      const sourceBefore = fx.snapshotStore(env, "fk-src");

      const res = await apiFork(fx.viewId("fk-src"), {
        prompt: "continue from the fork",
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("Location")).toMatch(/^\/api\/sessions\//);
      const body = (await res.json()) as { id: string; status: string };
      expect(body.status).toBe("started");
      expect(body.id).not.toBe(fx.viewId("fk-src"));

      // The mock agent resumes the fork id — the run is recorded under
      // the copy, exactly like a real follow-up. The capture read waits
      // for a settled file (mid-write reads must not leak in) and as
      // patiently as the boot helpers — a loaded shard can push a cold
      // mock spawn past many seconds.
      const argsText = await waitForFile(join(captureDir, "args.json"), 90_000);
      const args = JSON.parse(argsText) as string[];
      expect(flagValue(args, fx.resumeFlag)).toBe(nativeOf(body.id));

      // The reply lands in the fork once the run finishes.
      await expect
        .poll(async () => messageTexts(await readApi(body.id)), {
          timeout: 60000,
        })
        .toContain(fx.mockReply);

      const fork = await readApi(body.id);
      expect(fork.session.name).toBe("Fork Source (fork)");
      expect(fork.session.user_set_name).toBe(1);
      expect(messageTexts(fork).slice(0, 4)).toEqual([
        "first prompt",
        "first reply",
        "second prompt",
        "second reply",
      ]);
      expect(fx.readSessionField(env, "user_set_name", nativeOf(body.id))).toBe(
        1,
      );

      // The original is byte-identical in its own store and whole over
      // HTTP — the fork run wrote only to the copy.
      expect(fx.snapshotStore(env, "fk-src")).toBe(sourceBefore);
      const source = await readApi(fx.viewId("fk-src"));
      expect(messageTexts(source)).toEqual([
        "first prompt",
        "first reply",
        "second prompt",
        "second reply",
      ]);
    });
  });

  describe("fork at a cutoff", () => {
    it("keeps the prefix and drops the rest (HTML surface)", async () => {
      const res = await post(`/sessions/${fx.viewId("fk-src")}/fork`, {
        cutoff: "1",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("HX-Push-Url")).toMatch(/^\/sessions\//);
      const html = await res.text();
      expect(html).toContain("Fork Source (fork)");
      expect(html).toContain("first reply");
      expect(html).not.toContain("second prompt");
      expect(html).not.toContain("second reply");

      // The fork id from the push header reads back over the API with
      // exactly the two kept messages.
      const forkId = (res.headers.get("HX-Push-Url") ?? "").split("/").pop();
      expect(forkId).toBeDefined();
      const fork = await readApi(forkId ?? "");
      expect(messageTexts(fork)).toEqual(["first prompt", "first reply"]);

      const source = await readApi(fx.viewId("fk-src"));
      expect(messageTexts(source)).toHaveLength(4);
    });
  });

  describe("validation", () => {
    it("rejects a cutoff that would strand a tool call", async () => {
      const api = await apiFork(fx.viewId("fk-tool"), { cutoff: "1" });
      expect(api.status).toBe(422);
      expect(await api.json()).toMatchObject({
        error: expect.stringMatching(/tool/i),
      });

      // The HTML surface re-renders the source with the reason.
      const html = await post(`/sessions/${fx.viewId("fk-tool")}/fork`, {
        cutoff: "1",
      });
      expect(html.status).toBe(200);
      const text = await html.text();
      expect(text).toContain("tool");
      // Nothing was forked.
      const source = await readApi(fx.viewId("fk-tool"));
      expect(source.messages).toHaveLength(3);
    });

    it("accepts the tool-result boundary (the message after the call)", async () => {
      const res = await apiFork(fx.viewId("fk-tool"), { cutoff: "2" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const fork = await readApi(body.id);
      expect(fork.messages).toHaveLength(3);
    });

    it("rejects a cutoff past the transcript end", async () => {
      const res = await apiFork(fx.viewId("fk-src"), { cutoff: "99" });
      expect(res.status).toBe(422);
    });

    it("rejects a non-numeric cutoff", async () => {
      const res = await apiFork(fx.viewId("fk-src"), { cutoff: "soon" });
      expect(res.status).toBe(422);
    });

    it("404s for an unknown session on both surfaces", async () => {
      const api = await apiFork(fx.viewId("nope"));
      expect(api.status).toBe(404);
      const html = await post(`/sessions/${fx.viewId("nope")}/fork`);
      expect(html.status).toBe(404);
      expect(await html.text()).toContain("Session not found");
    });
  });

  describe("fork without a prompt", () => {
    it("creates an idle copy (status created, no run)", async () => {
      const res = await apiFork(fx.viewId("fk-empty"));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; status: string };
      expect(body.status).toBe("created");

      // The copy renders with a ready prompt bar and no run artifacts.
      const page = await authedFetch(env, `/sessions/${body.id}`);
      const html = await page.text();
      expect(html).toContain("Empty Session (fork)");
      expect(html).toContain('class="send-btn"');
      expect(html).not.toContain('class="stop-btn"');
      // Nothing to resume — the mock was never invoked for this id.
      const fork = await readApi(body.id);
      expect(fork.messages).toHaveLength(0);
    });
  });

  describe("fork of a running session", () => {
    it("copies what is persisted and never disturbs the live run", async () => {
      const started = await post(`/sessions/${fx.viewId("fk-src")}/prompt`, {
        prompt: "slow prompt while forking",
      });
      expect(started.status).toBe(200);

      const res = await apiFork(fx.viewId("fk-src"));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const forkAtCopy = await readApi(body.id);
      expect(messageTexts(forkAtCopy).slice(0, 4)).toEqual([
        "first prompt",
        "first reply",
        "second prompt",
        "second reply",
      ]);

      // The source's run finishes on the source; the fork keeps exactly
      // what the copy found.
      await expect
        .poll(async () => messageTexts(await readApi(fx.viewId("fk-src"))), {
          timeout: 60000,
        })
        .toContain(fx.mockReply);
      const forkAfter = await readApi(body.id);
      expect(messageTexts(forkAfter)).toEqual(messageTexts(forkAtCopy));
    });
  });

  describe("forks are ordinary sessions", () => {
    it("forks a fork", async () => {
      const first = await apiFork(fx.viewId("fk-src"));
      const firstBody = (await first.json()) as { id: string };
      const second = await apiFork(firstBody.id);
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { id: string };
      const fork = await readApi(secondBody.id);
      expect(fork.session.name).toBe("Fork Source (fork) (fork)");
      expect(messageTexts(fork).slice(0, 4)).toEqual([
        "first prompt",
        "first reply",
        "second prompt",
        "second reply",
      ]);
    });

    it("deleting a fork leaves the source readable", async () => {
      const res = await post(`/sessions/${fx.viewId("fk-src")}/fork`, {
        cutoff: "0",
      });
      const forkId = (res.headers.get("HX-Push-Url") ?? "").split("/").pop();
      expect(forkId).toBeDefined();

      const del = await post(`/sessions/${forkId}/delete`);
      expect(del.status).toBe(200);
      fx.assertSessionGone(env, nativeOf(forkId ?? ""));

      const source = await authedFetch(env, `/sessions/${fx.viewId("fk-src")}`);
      expect(source.status).toBe(200);
      const sourceBody = await readApi(fx.viewId("fk-src"));
      // The earlier running-session test appends its reply to the source,
      // so the invariant is the seeded prefix in order — deleting the fork
      // never touches the source's own history.
      expect(messageTexts(sourceBody).slice(0, 4)).toEqual([
        "first prompt",
        "first reply",
        "second prompt",
        "second reply",
      ]);
    });
  });

  describe("fork UI", () => {
    it("forks from the action menu and lands focused on the copy", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("fk-src")}`);
        await page.locator("form.prompt-bar").waitFor();

        await page.click(".session-menu-toggle");
        const panel = page.locator(".session-menu-panel");
        await expect(panel).toBeVisible();
        await expect(panel).toContainText("Fork session");
        await page.click(".session-menu-fork");

        await expect(page.locator(".session-header")).toContainText(
          "Fork Source (fork)",
        );
        expect(page.url()).toMatch(/\/sessions\/[^/]+$/);
        expect(page.url()).not.toContain(fx.viewId("fk-src"));
        // The sidebar refreshed out-of-band: the copy is listed.
        await expect(page.locator("#session-list")).toContainText(
          "Fork Source (fork)",
        );
        // The copy's prompt bar takes focus for the first prompt.
        await expect(page.locator("textarea.prompt-input")).toBeFocused();
        await expect(page.locator(".send-btn")).toBeVisible();
      });
    });

    it("forks from a message button at that boundary and grays unsafe points", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("fk-src")}`);
        await page.locator("form.prompt-bar").waitFor();

        // The second message's button forks keeping exactly two messages.
        await page
          .locator('.message[data-msg-index="1"] .fork-here-btn')
          .click();
        await expect(page.locator(".session-header")).toContainText(
          "Fork Source (fork)",
        );
        await expect(page.locator("#messages")).toContainText("first reply");
        await expect(page.locator("#messages")).not.toContainText(
          "second prompt",
        );

        // The tool-call message cannot be a boundary — its button renders
        // disabled; the tool-result message right after it is fine.
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("fk-tool")}`);
        await page.locator("form.prompt-bar").waitFor();
        await expect(
          page.locator('.message[data-msg-index="1"] .fork-here-btn'),
        ).toBeDisabled();
        await expect(
          page.locator('.message[data-msg-index="2"] .fork-here-btn'),
        ).toBeEnabled();
      });
    });
  });
};

export { runSessionForkSuite };
