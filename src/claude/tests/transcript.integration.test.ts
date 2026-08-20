import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedFetch, type IntegrationEnv } from "../../glv/tests/harness.js";
import { runTranscriptSuite } from "../../glv/tests/suites/transcript.suite.js";
import { encodeWorkingDir } from "../store/working-dir.js";
import {
  claudeFixture,
  insertMessages,
  insertSessions,
} from "./integration-harness.js";

describe("transcript", () => runTranscriptSuite(claudeFixture));

// claude-specific: transcripts are plain files the agent may rewrite in
// place; the store must notice same-size edits (no stale parse cache).
describe("transcript re-reads", () => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await claudeFixture.startEnv("glv-transcript-cache-");
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("picks up an in-place, same-size edit (no stale parse cache)", async () => {
    insertSessions(env.dbs.flavor.projectsDir, [
      {
        id: "t-cache",
        name: "Cache Probe",
        workingDir: join(env.scratchDir, "cache"),
      },
    ]);
    insertMessages(env.dbs.flavor.projectsDir, "t-cache", [
      {
        role: "assistant",
        content: [{ type: "text", text: "rich text alpha" }],
      },
    ]);
    const first = await authedFetch(env, "/sessions/t-cache");
    expect(await first.text()).toContain("rich text alpha");

    // Same-length rewrite plus an explicit mtime bump: the parse cache is
    // keyed on (mtime, size), so this must register as a change.
    let file: string | undefined;
    for (const dir of readdirSync(env.dbs.flavor.projectsDir, {
      withFileTypes: true,
    })) {
      if (!dir.isDirectory()) continue;
      const path = join(env.dbs.flavor.projectsDir, dir.name, "t-cache.jsonl");
      if (existsSync(path)) file = path;
    }
    if (file === undefined) throw new Error("t-cache transcript not found");
    const bumped = new Date(Date.now() + 60000);
    writeFileSync(file, readFileSync(file, "utf8").replace("alpha", "bravo"));
    utimesSync(file, bumped, bumped);

    const second = await authedFetch(env, "/sessions/t-cache");
    const html = await second.text();
    expect(html).toContain("rich text bravo");
    expect(html).not.toContain("rich text alpha");
  });
});

// claude-specific: editors that re-save a transcript with a UTF-8 BOM used
// to make JSON.parse reject the first line, silently dropping the first
// record (usually the opening user prompt).
describe("transcript BOM", () => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await claudeFixture.startEnv("glv-transcript-bom-");
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("parses the first line of a BOM-prefixed transcript", async () => {
    const dir = join(env.dbs.flavor.projectsDir, encodeWorkingDir("/seeded"));
    mkdirSync(dir, { recursive: true });
    const line = (role: string, body: string): string =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: role,
        message: { role, content: [{ type: "text", text: body }] },
        uuid: `bom-${role}`,
        timestamp: new Date().toISOString(),
        cwd: "/seeded",
        sessionId: "t-bom",
      });
    writeFileSync(
      join(dir, "t-bom.jsonl"),
      "\uFEFF" +
        line("user", "first prompt survives a bom") +
        "\n" +
        line("assistant", "assistant reply") +
        "\n",
    );

    const res = await authedFetch(env, "/sessions/t-bom");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("first prompt survives a bom");
  });
});
