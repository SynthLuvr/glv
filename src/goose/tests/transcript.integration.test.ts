import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type IntegrationEnv, withPage } from "../../glv/tests/harness.js";
import { runTranscriptSuite } from "../../glv/tests/suites/transcript.suite.js";
import {
  gooseFixture,
  insertMessages,
  insertSessions,
} from "./integration-harness.js";

describe("transcript", () => runTranscriptSuite(gooseFixture));

// goose-specific: the tool-extension badge renders _meta.goose_extension,
// which claude transcripts never carry.
describe("tool extension badge", () => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await gooseFixture.startEnv("glv-transcript-ext-");
    insertSessions(env.dbs.flavor.sessionsDb, [
      {
        id: "t-ext",
        name: "Extension Probe",
        workingDir: join(env.scratchDir, "ext"),
      },
    ]);
    insertMessages(env.dbs.flavor.sessionsDb, "t-ext", [
      {
        role: "assistant",
        content: [
          {
            type: "toolRequest",
            toolCall: {
              value: { name: "shell", arguments: { command: "echo hi" } },
            },
            _meta: { goose_extension: "developer" },
          },
        ],
      },
    ]);
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("renders the extension badge on tool calls", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/t-ext`);
      await expect(page.locator(".block.tool-call .tool-ext")).toHaveText(
        "developer",
      );
    });
  });
});
