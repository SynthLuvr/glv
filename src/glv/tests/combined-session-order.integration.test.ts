import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { claudeFixture } from "../../claude/tests/integration-harness.js";
import { gooseFixture } from "../../goose/tests/integration-harness.js";
import {
  seedClaudeSessions,
  seedGooseSessions,
  startCombinedEnv,
} from "./combined-harness.js";
import type { IntegrationEnv } from "./harness.js";
import { authedFetch } from "./harness.js";

// The sidebar's cross-agent ordering: one serve process, both agents,
// sessions backdated so the two flavors' true recency interleaves. The
// composite must merge by the instant each updated_at names — goose
// spells it SQLite's zone-less "YYYY-MM-DD HH:MM:SS", claude ISO 8601,
// and lexicographic comparison reads 'T' > ' ', pinning every same-day
// claude row above every goose row however old. Every instant anchors
// inside one UTC calendar day (noon ± minutes), the exact window where
// the string bug mis-sorts.

let env: IntegrationEnv;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "glv-combined-order-home-"));
  env = await startCombinedEnv("glv-combined-order-", undefined, home);
}, 180000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(home, { recursive: true, force: true });
});

const MINUTE = 60_000;

// Noon of today's UTC date; every seeded instant is noon ± minutes, so
// none can cross midnight into another calendar day.
const now = new Date();
const noon = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate(),
  12,
);

const SESSION_NAMES = [
  "Order Claude Fresh",
  "Order Claude Stale",
  "Order Goose Fresh",
  "Order Goose Stale",
] as const;

const workDir = (name: string): string => join(env.scratchDir, name);

// The names in the order they appear in the sidebar HTML.
const sidebarOrder = async (names: readonly string[]): Promise<string[]> => {
  const html = await (await authedFetch(env, "/")).text();
  return names
    .map((name) => ({ name, at: html.indexOf(name) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.name);
};

describe("combined viewer — mixed-agent session order", () => {
  it("lists claude newer than goose by true time, not by spelling", async () => {
    seedGooseSessions(env, [
      {
        id: "order-goose-fresh",
        name: "Order Goose Fresh",
        workingDir: workDir("gf"),
      },
      {
        id: "order-goose-stale",
        name: "Order Goose Stale",
        workingDir: workDir("gs"),
      },
    ]);
    seedClaudeSessions(env, [
      {
        id: "order-claude-stale",
        name: "Order Claude Stale",
        workingDir: workDir("cs"),
      },
      {
        id: "order-claude-fresh",
        name: "Order Claude Fresh",
        workingDir: workDir("cf"),
      },
    ]);
    // True recency interleaves the agents (the string bug's symptom is
    // per-agent grouping): claude+70m > goose+65m > claude+60m > goose.
    gooseFixture.backdateSession(env, "order-goose-stale", noon);
    gooseFixture.backdateSession(env, "order-goose-fresh", noon + 65 * MINUTE);
    claudeFixture.backdateSession(
      env,
      "order-claude-stale",
      noon + 60 * MINUTE,
    );
    claudeFixture.backdateSession(
      env,
      "order-claude-fresh",
      noon + 70 * MINUTE,
    );

    expect(await sidebarOrder(SESSION_NAMES)).toEqual([
      "Order Claude Fresh",
      "Order Goose Fresh",
      "Order Claude Stale",
      "Order Goose Stale",
    ]);
  });

  it("lists goose newer than claude by true time, not by spelling", async () => {
    // Mirror the first seeding's top: goose freshest, claude second —
    // only instant comparison yields this order.
    gooseFixture.backdateSession(env, "order-goose-fresh", noon + 90 * MINUTE);
    claudeFixture.backdateSession(
      env,
      "order-claude-fresh",
      noon + 75 * MINUTE,
    );

    expect(await sidebarOrder(SESSION_NAMES)).toEqual([
      "Order Goose Fresh",
      "Order Claude Fresh",
      "Order Claude Stale",
      "Order Goose Stale",
    ]);
  });
});
