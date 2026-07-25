import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  collectSse,
  type IntegrationEnv,
  type SseEvent,
  startIntegrationEnv,
} from "./integration-harness";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Dropped into src/scripts/ to trigger the file watcher. Not an esbuild
// entry point, so the rebuild output is identical — we only need the
// watcher to fire and the reload signal to bump.
const triggerFile = join(ROOT, "src", "scripts", "__hot_reload_trigger.ts");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let env: IntegrationEnv;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-hot-", {}, ["--hot"]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
  if (existsSync(triggerFile)) unlinkSync(triggerFile);
});

describe("frontend hot reload", () => {
  it("emits a reload SSE event when a frontend source file changes", async () => {
    const ssePromise = collectSse(
      env,
      "/events/status",
      (events) => events.some((e) => e.event === "reload"),
      20000,
    );

    // Let the EventSource connect before we trigger the watcher.
    await delay(1000);

    writeFileSync(triggerFile, "// hot reload test trigger\n");

    const events = await ssePromise;
    expect(events.some((e: SseEvent) => e.event === "reload")).toBe(true);
  });
});
