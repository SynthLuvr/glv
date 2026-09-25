import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { authedFetch, type IntegrationEnv } from "../../glv/tests/harness.js";
import { runReadonlySessionsSuite } from "../../glv/tests/suites/readonly-sessions-db.suite.js";
import {
  claudeFixture,
  insertSessions,
  startIntegrationEnv,
} from "./integration-harness.js";

describe("readonly-sessions-db", () => runReadonlySessionsSuite(claudeFixture));

// claude-specific: transcripts are agent-owned plain files; the viewer's
// rename/archive must never modify them — only the sidecar changes.
describe("agent-owned transcripts stay untouched", () => {
  let env: IntegrationEnv;

  const transcriptOf = (id: string): string | undefined => {
    for (const dir of readdirSync(env.dbs.flavor.projectsDir, {
      withFileTypes: true,
    })) {
      if (!dir.isDirectory()) continue;
      const path = join(env.dbs.flavor.projectsDir, dir.name, `${id}.jsonl`);
      try {
        return readFileSync(path, "utf8");
      } catch {
        // not in this dir
      }
    }
    return undefined;
  };

  beforeAll(async () => {
    env = await startIntegrationEnv("glv-readonly-agent-");
    insertSessions(env.dbs.flavor.projectsDir, [
      {
        id: "ro-agent",
        name: "Agent Owned",
        workingDir: join(env.scratchDir, "agent"),
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("rename and archive never modify the transcript file", async () => {
    const before = transcriptOf("ro-agent");
    expect(before).toBeDefined();

    const renameUrl = `/sessions/${claudeFixture.viewId("ro-agent")}/rename`;
    const renameRes = await authedFetch(env, renameUrl, {
      method: "POST",
      body: new URLSearchParams({ name: "Renamed Safe", from: "header" }),
      headers: { "HX-Request": "true" },
    });
    expect(renameRes.status).toBe(200);
    const archiveUrl = `/sessions/${claudeFixture.viewId("ro-agent")}/archive`;
    const archiveRes = await authedFetch(env, archiveUrl, {
      method: "POST",
      body: new URLSearchParams({}),
      headers: { "HX-Request": "true" },
    });
    expect(archiveRes.status).toBe(200);

    expect(transcriptOf("ro-agent")).toBe(before);
    expect(transcriptOf("ro-agent")).not.toContain("Renamed Safe");
  });
});
