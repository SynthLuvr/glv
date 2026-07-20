import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getSession, type SessionRow, sessionIdsInDir } from "../db.js";
import type { RunHandle } from "../runner/index.js";
import { isTerminalStatus, rekey, stop } from "../runner/index.js";
import {
  type AssetBundle,
  SESSION_TIMEOUT_ERROR,
  type ServerContext,
} from "./context.js";

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

// Serializes async tasks per key. The stored tail swallows rejections so one
// failure can't poison the chain.
const withCreateLock = <T>(
  locks: Map<string, Promise<void>>,
  key: string,
  task: () => T | Promise<T>,
): Promise<T> => {
  const tail = locks.get(key) ?? Promise.resolve();
  const run = tail.then(task, task);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

type EstablishOutcome =
  | { ok: true; realId: string; session: SessionRow }
  | { ok: false; status: ContentfulStatusCode; error: string };

// Claims a freshly-created session: rekeys the temp run handle onto the real
// id, then confirms the session row exists. On either failure it stops the run
// and returns a structured error so the caller can render it. `conflictError`
// tailors the 409 copy ("directory" vs "repository"). The caller owns the
// withCreateLock serialization — safe to call inside an existing locked task,
// since this never acquires the lock itself.
const establishSession = (
  ctx: ServerContext,
  tempKey: string,
  realId: string,
  conflictError: string,
): EstablishOutcome => {
  if (!rekey(ctx.runner, tempKey, realId)) {
    stop(ctx.runner, tempKey);
    return { ok: false, status: 409, error: conflictError };
  }
  const session = getSession(ctx.db, realId);
  if (session === undefined) {
    stop(ctx.runner, realId);
    return { ok: false, status: 502, error: SESSION_TIMEOUT_ERROR };
  }
  return { ok: true, realId, session };
};

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
  ui: readAsset("../../dist/ui.js"),
  prompts: readAsset("../../dist/prompts.js"),
  passkey: readAsset("../../dist/passkey.js"),
});

export type { EstablishOutcome };
export {
  activeRunPrompt,
  buildAssetBundle,
  errorMessage,
  establishSession,
  expandHome,
  extractIds,
  isHtmxRequest,
  listHomeDirs,
  pollForSessionId,
  serveAsset,
  sleep,
  withCreateLock,
};
