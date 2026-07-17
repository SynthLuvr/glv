import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context } from "hono";
import { sessionIdsInDir } from "../db.js";
import type { RunHandle } from "../runner/index.js";
import { isTerminalStatus } from "../runner/index.js";
import type { AssetBundle } from "./context.js";

const isHtmxRequest = (c: Context): boolean =>
  c.req.header("HX-Request") === "true";

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

const serveAsset = (c: Context, body: string, contentType: string) =>
  c.body(body, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const pollForSessionId = async (
  db: DatabaseSync,
  workingDir: string,
  known: Set<string>,
  timeoutMs = 10000,
  intervalMs = 50,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sessionIdsInDir(db, workingDir).find((id) => !known.has(id));
    if (found !== undefined) return found;
    await sleep(intervalMs);
  }
  return undefined;
};

const listHomeDirs = (home: string = homedir()): string[] =>
  readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(home, entry.name))
    .sort();

// The new-session form submits ~, which Node will not expand itself.
const expandHome = (path: string, home: string = homedir()): string =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? join(home, path.slice(2))
      : path;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const activeRunPrompt = (run: RunHandle | undefined): string | undefined =>
  run !== undefined && !isTerminalStatus(run.status) ? run.prompt : undefined;

// Resolved relative to this file (src/server/) so dist/ is two levels up.
const readAsset = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

// Read after the serve command has built dist/, so the bundle is current.
const buildAssetBundle = (): AssetBundle => ({
  htmx: readFileSync(
    fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
    "utf8",
  ),
  appCss: readAsset("../../dist/app.css"),
  sidebar: readAsset("../../dist/sidebar.js"),
  stream: readAsset("../../dist/stream.js"),
  theme: readAsset("../../dist/theme.js"),
  markdownCopy: readAsset("../../dist/markdown-copy.js"),
  rename: readAsset("../../dist/rename.js"),
  sourcePicker: readAsset("../../dist/source-picker.js"),
  passkey: readAsset("../../dist/passkey.js"),
});

export {
  activeRunPrompt,
  buildAssetBundle,
  errorMessage,
  expandHome,
  extractIds,
  isHtmxRequest,
  listHomeDirs,
  pollForSessionId,
  serveAsset,
  sleep,
};
