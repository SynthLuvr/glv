import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseMessage, pendingTool } from "../format/index.js";
import { pullRepo } from "../git.js";
import { type EstablishOutcome, withCreateLock } from "../launch.js";
import {
  type AgentModelPick,
  decodeAgentModelValue,
  type ModelSelection,
  modelUnavailableError,
} from "../models.js";
import { bumpUsage } from "../prompts/db.js";
import { enqueueOrQueue, getHandle, stop } from "../runner/index.js";
import type { SessionRow } from "../sessions.js";
import { clearStopNotice } from "../stop-notices.js";
import type { AgentRuntime, ServerContext } from "./context.js";
import { firstString } from "./forms.js";
import { buildLocationContext, parseSharedLocation } from "./location.js";
import { expandHome } from "./paths.js";
import { activeRunPrompt } from "./session.js";
import {
  buildUploadContext,
  collectFiles,
  createTempDir,
  removeDir,
  saveUploads,
  shareTempDir,
  tagDir,
  uploadErrorMessage,
} from "./uploads.js";

// The shared operation layer: the validate-and-execute core of the three
// session mutations (start, follow-up, stop), extracted from the HTML
// handlers so the JSON API and the browser UI run literally the same
// effects. Every side effect lives here — validation failures come back
// as `{ok: false, status, error}` and the caller decides how to render
// them (an HTML form re-render or a JSON status code).

// One failure any operation can surface, HTTP-flavoured.
type OperationFailure = {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
};

// Where a submitted prompt sits when the operation returns.
type RunStartStatus = "started" | "queued";

type StartSessionOutcome =
  | OperationFailure
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly session: SessionRow;
      readonly runStatus: RunStartStatus;
    };

type FollowUpOutcome =
  | OperationFailure
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly session: SessionRow;
      readonly runStatus: RunStartStatus;
      // The prompt the transcript should highlight: the submitted text
      // when it began executing, the session's active-run prompt when
      // the submit queued behind one (queued prompts render as cards).
      readonly activePrompt: string | undefined;
    };

type StopOutcome =
  | OperationFailure
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly session: SessionRow;
    };

// A fork outcome: "created" when the copy landed with no prompt to run,
// otherwise where the submitted prompt sits (see RunStartStatus).
type ForkSessionOutcome =
  | OperationFailure
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly session: SessionRow;
      readonly runStatus: RunStartStatus | "created";
      // The prompt the transcript should highlight when a run started.
      readonly activePrompt: string | undefined;
    };

// The agent persists working_dir in canonical form, so the submitted dir
// must be normalized here or the new-session discovery poll compares
// against a different spelling, never finds the row, and stops the healthy
// run at its timeout — this also keeps the spawn cwd and the per-directory
// create lock on one spelling. Empty stays empty: resolve("") would invent
// the server's cwd.
const canonicalWorkingDir = (raw: string): string =>
  raw === "" ? raw : resolve(raw);

// Splits a submitted combined model value ("<agent>:<model value>") into
// the agent it names and that agent's runtime. A value that decodes to
// no agent — absent, empty, or malformed — falls back to `fallbackAgent`
// (the server default, or the stored row's own agent). `runtime` is
// undefined when the named agent is not served; `modelValue` is the
// remainder for the agent's own model source to resolve.
const resolveAgentPick = (
  ctx: ServerContext,
  submitted: string,
  fallbackAgent: string,
): {
  readonly pick: AgentModelPick;
  readonly agentId: string;
  readonly runtime: AgentRuntime | undefined;
  readonly modelValue: string;
} => {
  const pick = decodeAgentModelValue(submitted);
  const agentId = pick.kind === "pick" ? pick.agent : fallbackAgent;
  return {
    pick,
    agentId,
    runtime: ctx.agents.find((entry) => entry.id === agentId),
    modelValue: pick.kind === "pick" ? pick.modelValue : "",
  };
};

// Resolves the model half of a submitted pick the way a path that must
// answer definitively does (POST /api/sessions, scheduled-run saves):
// the agent's catalogue is warmed first, so a cold cache — a scripts/CI
// submit, or the TTL simply lapsed — cannot wave an unknown model id
// into a run that would die at agent startup. Submits are rare, so the
// one-off fetch is worth the wait; a browser submit finds the cache
// already warm from the picker. An empty value (the agent's default)
// skips the fetch and resolves as-is.
const resolveWarmedModel = async (
  runtime: AgentRuntime,
  modelValue: string,
): Promise<ModelSelection | undefined> => {
  if (modelValue !== "") await runtime.models?.warm?.();
  return runtime.models?.resolve(modelValue);
};

// A created run reports "queued" while it waits in the concurrency pool
// and "started" once execution has begun (a run that already finished
// also "started"). Establishment guarantees the pool's decision has
// settled by the time this runs, so the read is not racy.
const createRunStatus = (
  ctx: ServerContext,
  sessionId: string,
): RunStartStatus =>
  getHandle(ctx.runner, sessionId)?.status === "queued" ? "queued" : "started";

// Applies a creation-time name to a just-established session (#343):
// the rename rides the same viewer-managed rename the browser's rename
// action performs, so a driven loop can tell its runs apart at
// creation. Blank or absent names write nothing — derived naming stays
// in charge exactly as before. Returns the row the caller should
// answer with, re-read after the rename (the established row predates
// the name).
const applyCreationName = (
  ctx: ServerContext,
  sessionId: string,
  established: SessionRow,
  name: string,
): SessionRow => {
  if (name === "") return established;
  ctx.sessions.renameSession(sessionId, name);
  return ctx.sessions.getSession(sessionId) ?? established;
};

const createSessionOperations = (ctx: ServerContext) => {
  // Serializes session creation per working directory so two submits
  // can't race the repo pull or mint duplicate sessions; the lock map
  // lives here, beside its only consumer.
  const createLocks = new Map<string, Promise<void>>();

  const startSession = async (
    body: Record<string, unknown>,
  ): Promise<StartSessionOutcome> => {
    const bodyField = (key: string): string => firstString(body[key]);

    const prompt = bodyField("prompt");
    const promptId = bodyField("prompt_id");
    // #343: labels the session at creation; see applyCreationName.
    const name = bodyField("name");
    const sessionMode = bodyField("session_mode");
    const submittedWorkingDir = canonicalWorkingDir(
      expandHome(bodyField("working_dir")),
    );
    const { agentId, runtime, modelValue } = resolveAgentPick(
      ctx,
      bodyField("model"),
      ctx.defaultAgent.id,
    );

    const files = collectFiles(body.uploads);
    // Validated before any directory or session is created.
    const location = parseSharedLocation(bodyField("location"));

    const fail = (status: number, error: string): OperationFailure => ({
      ok: false,
      status,
      error,
    });

    if (runtime === undefined)
      return fail(422, `Agent "${agentId}" is not enabled.`);

    if (prompt === "")
      return fail(422, "A prompt is required to start a session.");

    if (location !== undefined && !location.ok)
      return fail(422, location.error);

    // The dropdown listed render-time config; resolve the pick against a
    // fresh read in case the agent's config changed since the form was
    // served — warmed, so the verdict holds even on a cold cache.
    const model = await resolveWarmedModel(runtime, modelValue);
    if (modelValue !== "" && model === undefined)
      return fail(422, modelUnavailableError(runtime.profile.agentName));

    if (
      sessionMode !== "temp" &&
      (submittedWorkingDir === "" || !existsSync(submittedWorkingDir))
    )
      return fail(422, "That working directory does not exist.");

    const tempWorkingDir =
      sessionMode === "temp" ? createTempDir(ctx.dataDirName) : undefined;
    const workingDir = tempWorkingDir ?? submittedWorkingDir;

    // Save uploaded files into GLV's private storage and append their
    // absolute paths to the prompt so the agent can read them.
    let uploadDir: string | undefined;
    let fullPrompt = prompt;
    if (files.length > 0)
      try {
        const saved = await saveUploads(files, ctx.dataDirName);
        fullPrompt = prompt + buildUploadContext(saved.paths);
        uploadDir = saved.dir;
      } catch (err) {
        return fail(422, uploadErrorMessage(err));
      }

    // After the upload section, so both attachments read as one context
    // block.
    if (location?.ok) fullPrompt += buildLocationContext(location.data);

    // Pre-tag cleanup for a failed attempt: these dirs are untagged, so
    // the archive-time sweep would never collect them.
    const removeAttemptDirs = (): void => {
      if (uploadDir !== undefined) removeDir(uploadDir);
      if (tempWorkingDir !== undefined) removeDir(tempWorkingDir);
    };

    const establishSession = async (): Promise<EstablishOutcome> =>
      withCreateLock(
        createLocks,
        workingDir,
        async (): Promise<EstablishOutcome> => {
          await pullRepo(workingDir, ctx.runGit);
          const handle = ctx.launcher.startNewFor(
            agentId,
            workingDir,
            fullPrompt,
            model,
          );

          const sessionId = await ctx.launcher.awaitNew(
            handle,
            workingDir,
            ctx.pollTimeoutMs,
          );
          if (sessionId === undefined) {
            stop(ctx.runner, handle);
            return {
              ok: false,
              status: 502,
              error: runtime.profile.sessionTimeoutError,
            };
          }
          return ctx.launcher.establish(
            handle,
            sessionId,
            "Another session is starting in that directory. Please try again.",
          );
        },
      );

    let result: EstablishOutcome;
    try {
      result = await establishSession();
    } catch (err) {
      // The lock helper only swallows *prior* attempts' rejections; a fresh
      // throw from this attempt must still clean up or its dirs leak forever.
      removeAttemptDirs();
      throw err;
    }

    if (!result.ok) {
      removeAttemptDirs();
      return fail(result.status, result.error);
    }
    const { sessionId, session: established } = result;
    const session = applyCreationName(ctx, sessionId, established, name);

    // Tag the upload dir with the real session id so cleanup finds it when
    // the session is archived.
    if (uploadDir !== undefined) tagDir(uploadDir, sessionId);
    if (tempWorkingDir !== undefined) tagDir(tempWorkingDir, sessionId);

    // A "Run" from a saved prompt tags the submit with the prompt id; bump
    // usage stats only once the run has actually been established.
    if (promptId !== "" && ctx.prompts !== undefined)
      bumpUsage(ctx.prompts, promptId);

    return {
      ok: true,
      sessionId,
      session,
      runStatus: createRunStatus(ctx, sessionId),
    };
  };

  const queueFollowUp = async (
    id: string,
    body: Record<string, unknown>,
  ): Promise<FollowUpOutcome> => {
    const session = ctx.sessions.getSession(id);
    if (session === undefined)
      return { ok: false, status: 404, error: `No session ${id}.` };

    const fail = (error: string): OperationFailure => ({
      ok: false,
      status: 422,
      error,
    });

    const prompt = firstString(body.prompt);
    if (prompt === "") return fail("A prompt is required.");

    // A follow-up spawns the agent in the session's working directory;
    // one deleted out from under the session (a shared temp dir swept
    // too early, a directory removed by hand) would die at spawn with an
    // opaque ENOENT (#367) — reject it with the actual reason instead.
    // Empty stays permitted: the store may hold sessions without one.
    if (session.working_dir !== "" && !existsSync(session.working_dir))
      return fail("That working directory no longer exists.");

    const runtime = ctx.agentOf(id);
    if (runtime === undefined)
      return fail("This session's agent is not enabled.");

    // Session id is known, so tag the upload dir immediately for cleanup.
    let fullPrompt = prompt;
    const files = collectFiles(body.uploads);
    if (files.length > 0)
      try {
        const saved = await saveUploads(files, ctx.dataDirName);
        fullPrompt = prompt + buildUploadContext(saved.paths);
        tagDir(saved.dir, id);
      } catch (err) {
        return fail(uploadErrorMessage(err));
      }

    // A malformed share rejects the submit so the user can retry, matching
    // uploads.
    const location = parseSharedLocation(firstString(body.location));
    if (location !== undefined && !location.ok) return fail(location.error);
    if (location?.ok) fullPrompt += buildLocationContext(location.data);

    const { queued } = enqueueOrQueue(
      ctx.runner,
      runtime.invocation,
      id,
      fullPrompt,
      session.working_dir,
    );

    // Continuing the session resolves whatever the last run's notice
    // explained (the new run's own outcome — a fresh refusal included —
    // will re-record one if it stops early again).
    if (ctx.stopNotices !== undefined) clearStopNotice(ctx.stopNotices, id);

    return {
      ok: true,
      sessionId: id,
      session,
      // The boolean decides, not a registry read — a just-dispatched
      // run's status has not necessarily flipped yet.
      runStatus: queued ? "queued" : "started",
      activePrompt: queued
        ? activeRunPrompt(getHandle(ctx.runner, id))
        : prompt,
    };
  };

  // Idempotent: stopping a session with no active run changes nothing.
  const stopSession = (id: string): StopOutcome => {
    stop(ctx.runner, id);
    const session = ctx.sessions.getSession(id);
    if (session === undefined)
      return { ok: false, status: 404, error: `No session ${id}.` };
    return { ok: true, sessionId: id, session };
  };

  // Forks a session — a pure copy under a fresh id, optionally keeping
  // only the messages up to a cutoff (the index of the last message to
  // keep, in transcript order) and optionally carrying a first prompt
  // through the exact follow-up path. A cutoff that would strand a tool
  // call without its result is rejected up front: the next model turn
  // would see a dangling tool_use and fail at the provider.
  const forkSession = async (
    id: string,
    body: Record<string, unknown>,
  ): Promise<ForkSessionOutcome> => {
    const fail = (status: number, error: string): OperationFailure => ({
      ok: false,
      status,
      error,
    });

    const source = ctx.sessions.getSession(id);
    if (source === undefined) return fail(404, `No session ${id}.`);

    const cutoffField = firstString(body.cutoff);
    const cutoff = cutoffField === "" ? null : Number(cutoffField);
    if (cutoff !== null) {
      if (!Number.isInteger(cutoff) || cutoff < 0)
        return fail(422, "The fork cutoff must be a message index.");
      const messages = ctx.sessions.listMessages(id).map(parseMessage);
      if (cutoff >= messages.length)
        return fail(
          422,
          "The fork cutoff is past the end of the session's transcript.",
        );
      if (pendingTool(messages.slice(0, cutoff + 1)) !== undefined)
        return fail(
          422,
          "Cannot fork between a tool call and its result — pick the " +
            "message after the tool result.",
        );
    }

    const forked = ctx.sessions.forkSession(id, cutoff);
    if (!forked.ok) return forked;

    // A fork copies the source's working_dir verbatim, so a fork of a
    // temp-dir session shares the managed directory (#367): record the
    // fork as a co-owner so archiving or deleting either session leaves
    // the directory in place until the last owner is gone — otherwise
    // the survivor's next prompt spawns into a deleted directory.
    shareTempDir(ctx.dataDirName, source.working_dir, forked.row.id);

    // A submitted prompt rides the exact follow-up path against the new
    // id, so the fork starts as an ordinary resumed session.
    if (firstString(body.prompt) === "")
      return {
        ok: true,
        sessionId: forked.row.id,
        session: forked.row,
        runStatus: "created",
        activePrompt: undefined,
      };
    return queueFollowUp(forked.row.id, body);
  };

  return { startSession, queueFollowUp, stopSession, forkSession };
};

type SessionOperations = ReturnType<typeof createSessionOperations>;

export type { SessionOperations };
export {
  canonicalWorkingDir,
  createSessionOperations,
  resolveAgentPick,
  resolveWarmedModel,
};
