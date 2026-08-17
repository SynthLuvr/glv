import {
  existsSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedFetch } from "../../glv/tests/harness.js";
import { runTranscriptSuite } from "../../glv/tests/suites/transcript.suite.js";
import {
  claudeFixture,
  type IntegrationEnv,
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
