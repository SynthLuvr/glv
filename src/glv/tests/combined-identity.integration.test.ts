import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  seedClaudeMessages,
  seedClaudeSessions,
  seedGooseMessages,
  seedGooseSessions,
  startCombinedEnv,
} from "./combined-harness.js";
import { TWO_PROVIDER_CONFIG_YAML, writeGooseConfig } from "./goose-config.js";
import type { IntegrationEnv } from "./harness.js";
import {
  authedFetch,
  collectSse,
  flagValue,
  postNewSession,
  waitForArgs,
} from "./harness.js";
import { fetchModelPicker } from "./model-picker.js";

// The identity-sensitive combined suites of ADR 0007's testing plan: one
// serve process, both agents, the composite store. Everything here would
// fail without the composite boundary prefixing and dispatching ids —
// the same suites also run per flavor through the single-agent fixtures.

let env: IntegrationEnv;
let argsDir: string;
let argsPath: string;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "glv-combined-home-"));
  writeGooseConfig(home, TWO_PROVIDER_CONFIG_YAML);
  argsDir = mkdtempSync(join(tmpdir(), "glv-combined-args-"));
  argsPath = join(argsDir, "args.json");
  env = await startCombinedEnv(
    "glv-combined-",
    { captureArgs: argsPath },
    home,
  );
}, 90000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(argsDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const workDir = (name: string): string => join(env.scratchDir, name);

describe("combined viewer — sidebar", () => {
  it("announces one glv product naming both agents", () => {
    const stdout = env.serverStdout();
    expect(stdout).toContain("glv web viewer (goose + claude) → ");
    expect(stdout).not.toContain("glv-goose");
    expect(stdout).not.toContain("glv-claude");
  });

  it("merges both agents' sessions, newest first, without agent chips", async () => {
    seedGooseSessions(env, [
      { id: "alpha", name: "Goose Alpha", workingDir: workDir("alpha") },
    ]);
    seedClaudeSessions(env, [
      { id: "beta", name: "Claude Beta", workingDir: workDir("beta") },
    ]);

    const res = await authedFetch(env, "/");
    const html = await res.text();
    expect(html).toContain("Goose Alpha");
    expect(html).toContain("Claude Beta");
    // The sidebar names no agent — rows read the same regardless of which
    // agent owns the session.
    expect(html).not.toContain("data-agent=");
    expect(html).toContain('data-session-id="goose:alpha"');
    expect(html).toContain('data-session-id="claude:beta"');
    // Claude was seeded last, so it lists first.
    const gooseAt = html.indexOf("Goose Alpha");
    const claudeAt = html.indexOf("Claude Beta");
    expect(claudeAt).toBeGreaterThan(-1);
    expect(gooseAt).toBeGreaterThan(claudeAt);
  });

  it("hides nothing when one agent has no sessions", async () => {
    const res = await authedFetch(env, "/sessions/sidebar-meta");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("sidebar-meta-goose_alpha");
    expect(html).toContain("sidebar-meta-claude_beta");
  });
});

describe("combined viewer — transcripts and streams", () => {
  it("serves each agent's transcript with its agent chip", async () => {
    seedGooseMessages(env, "alpha", [
      { role: "user", content: "hello goose" },
      {
        role: "assistant",
        content: [{ type: "text", text: "goose reply" }],
      },
    ]);
    seedClaudeMessages(env, "beta", [
      { role: "user", content: "hello claude" },
      {
        role: "assistant",
        content: [{ type: "text", text: "claude reply" }],
      },
    ]);

    const gooseRes = await authedFetch(env, "/sessions/goose:alpha");
    const gooseHtml = await gooseRes.text();
    expect(gooseHtml).toContain("goose reply");
    expect(gooseHtml).toContain('data-agent="goose"');
    expect(gooseHtml).toContain("goose:alpha");

    const claudeRes = await authedFetch(env, "/sessions/claude:beta");
    const claudeHtml = await claudeRes.text();
    expect(claudeHtml).toContain("claude reply");
    expect(claudeHtml).toContain('data-agent="claude"');
  });

  it("streams each agent's session events under its namespaced id", async () => {
    const events = await collectSse(
      env,
      "/sessions/claude:beta/events",
      (seen) => seen.some((event) => event.event === "messages"),
    );
    const data = JSON.parse(
      events.find((event) => event.event === "messages")?.data ?? "{}",
    ) as { entries?: { html: string }[] };
    expect(
      (data.entries ?? []).some((entry) => entry.html.includes("claude reply")),
    ).toBe(true);
  });

  it("404s a raw id that names no agent", async () => {
    const res = await authedFetch(env, "/sessions/alpha");
    expect(res.status).toBe(404);
  });
});

describe("combined viewer — new session model picker", () => {
  it("renders one combined picker and no agent select", async () => {
    const res = await authedFetch(env, "/sessions/new");
    const html = await res.text();
    expect(html).not.toContain('name="agent"');
    expect(html).toContain('class="form-field model-picker-slot"');
    expect(html).toContain('hx-get="/sessions/model-picker"');
  });

  it("lists both agents in one select, default agent preselected", async () => {
    const html = await fetchModelPicker(env);
    expect(html).toContain('<optgroup label="goose">');
    expect(html).toContain('<optgroup label="claude">');
    // Each agent leads with its default entry; goose is the default
    // agent, so its default is preselected.
    expect(html).toContain("goose default — zai / glm-5.3");
    expect(html).toContain('value="goose:" selected=""');
    expect(html).toContain("claude default");
    expect(html).toContain('value="claude:"');
    // goose's configured providers and claude's alias list share the
    // select, every value naming its agent.
    expect(html).toContain("zai / glm-5.3");
    expect(html).toContain('value="goose:zai:glm-5.3"');
    expect(html).toContain('value="goose:anthropic:claude-sonnet-4-5"');
    expect(html).toContain("Sonnet");
    expect(html).toContain('value="claude:claude:sonnet"');
  });

  it("starts a claude session with the picked model", async () => {
    const dir = workDir("picker-claude");
    mkdirSync(dir, { recursive: true });
    rmSync(argsPath, { force: true });
    const res = await postNewSession(
      env,
      dir,
      "combined picker prompt",
      "claude:claude:sonnet",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The transcript that lands is the claude one the mock created, under
    // the claude namespace, and the run carried the claude model flag.
    expect(html).toContain('data-session-id="claude:');
    expect(html).toContain('data-agent="claude"');
    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--model")).toBe("sonnet");
  }, 60000);

  it("starts a goose session with the picked provider/model", async () => {
    const dir = workDir("picker-goose");
    mkdirSync(dir, { recursive: true });
    rmSync(argsPath, { force: true });
    const res = await postNewSession(
      env,
      dir,
      "combined goose pick",
      "goose:zai:glm-5.3",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-session-id="goose:');
    const args = await waitForArgs(argsPath);
    expect(flagValue(args, "--provider")).toBe("zai");
    expect(flagValue(args, "--model")).toBe("glm-5.3");
  }, 60000);

  it("keeps the default agent on its own default when nothing is picked", async () => {
    const dir = workDir("picker-default");
    mkdirSync(dir, { recursive: true });
    rmSync(argsPath, { force: true });
    const res = await postNewSession(env, dir, "combined default pick");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-session-id="goose:');
    const args = await waitForArgs(argsPath);
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  }, 60000);
});

describe("combined viewer — mutations dispatch by prefix", () => {
  it("deletes only the named agent's session", async () => {
    const res = await authedFetch(env, "/sessions/goose:alpha/delete", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    // The goose row is gone…
    const gone = await authedFetch(env, "/sessions/goose:alpha");
    expect(gone.status).toBe(404);
    // …and the claude session is untouched.
    const kept = await authedFetch(env, "/sessions/claude:beta");
    expect(kept.status).toBe(200);
  });

  it("groups sessions across agents", async () => {
    seedGooseSessions(env, [
      { id: "grouped-g", name: "Grouped Goose", workingDir: workDir("g") },
    ]);
    seedClaudeSessions(env, [
      { id: "grouped-c", name: "Grouped Claude", workingDir: workDir("c") },
    ]);
    const res = await authedFetch(env, "/sessions/goose:grouped-g/group-with", {
      method: "POST",
      body: new URLSearchParams({ otherId: "claude:grouped-c" }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Grouped Goose");
    expect(html).toContain("Grouped Claude");
  });
});

describe("combined viewer — scheduled runs carry their agent", () => {
  it("saves a job naming the claude agent and shows its chip", async () => {
    mkdirSync(workDir("cron"), { recursive: true });
    const res = await authedFetch(env, "/cron", {
      method: "POST",
      body: new URLSearchParams({
        job_name: "combined claude job",
        schedule: "0 4 * * *",
        prompt: "combined cron prompt",
        working_dir: workDir("cron"),
        model: "claude:",
      }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("combined claude job");
    expect(html).toContain('data-agent="claude"');
  });

  it("rejects a job naming an agent that is not enabled", async () => {
    const res = await authedFetch(env, "/cron", {
      method: "POST",
      body: new URLSearchParams({
        job_name: "no such agent",
        schedule: "0 4 * * *",
        prompt: "prompt",
        working_dir: workDir("cron"),
        model: "cursor:",
      }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("not enabled");
  });
});
