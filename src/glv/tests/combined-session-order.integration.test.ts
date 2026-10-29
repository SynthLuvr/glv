import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  backdateClaudeSession,
  backdateGooseSession,
  seedClaudeSessions,
  seedGooseSessions,
  startCombinedEnv,
} from "./combined-harness.js";
import type { IntegrationEnv } from "./harness.js";
import { authedFetch } from "./harness.js";

// The sidebar's cross-agent ordering: one serve process, both agents,
// sessions backdated so the two flavors' true recency interleaves. The
// composite store must merge by the instant each updated_at names —
// goose spells it as SQLite's zone-less "YYYY-MM-DD HH:MM:SS" while
// claude spells ISO 8601 — because lexicographic comparison reads
// 'T' > ' ' and pins every same-day claude row above every goose row,
// however old. All timestamps are anchored inside one UTC calendar day
// (noon ± minutes), the exact window where the string bug shows.

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

// All four instants share the UTC date they are anchored to: each is
// noon-anchored plus minutes, so no offset can cross midnight.
const utcNoon = (): number => {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    12,
  );
};

// The seeds and their true recency, newest first:
//   claude-fresh (noon+61m) > goose-fresh (noon+5m) >
//   claude-stale (noon+60m) > goose-stale (noon)
// The agents interleave, so any per-agent grouping (the string bug's
// symptom) fails the expected order.
const workDir = (name: string): string => join(env.scratchDir, name);
const noon = utcNoon();

const sidebarOrder = async (names: string[]): Promise<string[]> => {
  const res = await authedFetch(env, "/");
  const html = await res.text();
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
    backdateGooseSession(env, "order-goose-stale", noon);
    backdateGooseSession(env, "order-goose-fresh", noon + 5 * MINUTE);
    backdateClaudeSession(env, "order-claude-stale", noon + 60 * MINUTE);
    backdateClaudeSession(env, "order-claude-fresh", noon + 61 * MINUTE);

    expect(
      await sidebarOrder([
        "Order Claude Fresh",
        "Order Claude Stale",
        "Order Goose Fresh",
        "Order Goose Stale",
      ]),
    ).toEqual([
      "Order Claude Fresh",
      "Order Goose Fresh",
      "Order Claude Stale",
      "Order Goose Stale",
    ]);
  });

  it("lists goose newer than claude by true time, not by spelling", async () => {
    // The mirrored seeding: goose freshest, claude oldest. Grouping by
    // agent again puts both claude rows first; only instant comparison
    // yields the true order.
    backdateGooseSession(env, "order-goose-fresh", noon + 90 * MINUTE);
    backdateClaudeSession(env, "order-claude-fresh", noon + 62 * MINUTE);

    expect(
      await sidebarOrder([
        "Order Claude Fresh",
        "Order Claude Stale",
        "Order Goose Fresh",
        "Order Goose Stale",
      ]),
    ).toEqual([
      "Order Goose Fresh",
      "Order Claude Fresh",
      "Order Claude Stale",
      "Order Goose Stale",
    ]);
  });
});
