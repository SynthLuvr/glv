import type { DatabaseSync } from "node:sqlite";
import { agentOfId } from "../agents.js";
import { jobNameFor } from "../cron-sessions.js";
import type { ModelSelection } from "../models.js";
import type { Runner } from "../runner/index.js";
import type { SessionStore } from "../sessions.js";
import { errorMessage, positiveEnvNumber, unrefTimer } from "../util.js";
import type { EphemeralAsk } from "./ask.js";
import {
  buildAskPrompt,
  conversationTail,
  parseSuggestionReply,
  runEphemeralAsk,
  turnKeyOf,
} from "./ask.js";
import { putSuggestions, readRow, suggestionsEnabled } from "./db.js";

// The background watcher: notices sessions whose run just completed and,
// for each, quietly asks the same assistant for a few next-prompt
// suggestions, storing them for the UI to render above the input box.
// Everything here is best-effort by design — a slow, failing, or absent
// ask must never surface as an error or slow anything down.

// How often the watcher scans the runner registry for finished runs.
// Terminal handles are retained for ~30s (terminalRetentionMs), so a
// scan this sparse can never miss one. GLV_SUGGESTIONS_POLL_MS shrinks
// it for tests.
const DEFAULT_POLL_MS = 1000;
const pollMs = (): number =>
  positiveEnvNumber("GLV_SUGGESTIONS_POLL_MS", DEFAULT_POLL_MS);

// Ceiling on one ask — a suggestion that never arrives is worth nothing:
// the process is killed and the turn is marked served. The
// GLV_SUGGESTIONS_TIMEOUT_MS override shrinks it for tests.
const DEFAULT_TIMEOUT_MS = 60_000;
const askTimeoutMs = (): number =>
  positiveEnvNumber("GLV_SUGGESTIONS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

// At most this many asks in flight at once. More means GLV is busy, and
// busy means suggestions simply do not happen that turn — they never
// queue up behind (or alongside) real work.
const DEFAULT_MAX_IN_FLIGHT = 2;
const maxInFlight = (): number =>
  positiveEnvNumber("GLV_SUGGESTIONS_MAX_IN_FLIGHT", DEFAULT_MAX_IN_FLIGHT);

type SuggestionService = {
  /** Stops the watcher poll; in-flight asks keep running. */
  readonly stop: () => void;
};

type ServiceDeps = {
  readonly db: DatabaseSync;
  readonly runner: Runner;
  readonly sessions: SessionStore;
  /** The cron sidecar, for suppressing job-started sessions. */
  readonly cronDb: DatabaseSync | undefined;
  /** Every ask runs in this glv-owned scratch directory. */
  readonly scratchDir: string;
  /** The ephemeral ask of a session's agent, by agent id. */
  readonly askOf: (agentId: string) => EphemeralAsk | undefined;
  /** Resolves the pinned model for an agent's asks; undefined → default. */
  readonly modelFor: (agentId: string) => ModelSelection | undefined;
};

// The turn a session currently sits at, when it is readable at all.
const currentTurn = (
  sessions: SessionStore,
  sessionId: string,
): { turnKey: string; tail: string } | undefined => {
  const session = sessions.getSession(sessionId);
  if (session === undefined) return undefined;
  const rows = sessions.listMessages(sessionId);
  return {
    turnKey: turnKeyOf(session, rows.length),
    tail: conversationTail(rows),
  };
};

const createSuggestionService = (deps: ServiceDeps): SuggestionService => {
  // The last turn each session was served suggestions for (this boot).
  // The DB row is the durable record; this map keeps the hot path off
  // SQLite for the repeated polls a retained terminal handle generates.
  const served = new Map<string, string>();
  // Session ids with an ask in flight, so a retained handle's repeated
  // polls never double-fire one turn.
  const inFlight = new Set<string>();

  // Marks the answered turn served and stores its prompts — the empty
  // set for unusable replies too, so that turn is never re-asked.
  const storeOutcome = (
    sessionId: string,
    turnKey: string,
    prompts: readonly string[],
  ): void => {
    served.set(sessionId, turnKey);
    try {
      putSuggestions(deps.db, sessionId, turnKey, prompts);
    } catch (err) {
      console.error(
        `suggestions: could not store suggestions for ${sessionId}: ` +
          errorMessage(err),
      );
    }
  };

  // One ask, end to end. Fire-and-forget by design: no caller ever waits
  // on it, and every failure path ends in a stored empty marker under
  // the answered turn's key.
  const ask = (
    askSpec: EphemeralAsk,
    agentId: string,
    sessionId: string,
    turn: { turnKey: string; tail: string },
  ): void => {
    inFlight.add(sessionId);
    void (async () => {
      let prompts: string[] | undefined;
      try {
        const result = await runEphemeralAsk(
          askSpec,
          buildAskPrompt(askSpec.name, turn.tail),
          deps.scratchDir,
          askTimeoutMs(),
          deps.modelFor(agentId),
        );
        prompts =
          result === undefined ? undefined : parseSuggestionReply(result.text);
      } catch {
        prompts = undefined;
      } finally {
        inFlight.delete(sessionId);
        storeOutcome(sessionId, turn.turnKey, prompts ?? []);
      }
    })();
  };

  const poll = (): void => {
    if (!suggestionsEnabled(deps.db)) return;
    if (inFlight.size >= maxInFlight()) return;
    for (const handle of deps.runner.registry.values()) {
      // Only a clean finish asks — a stopped or errored run suppressed
      // suggestions entirely, and a chained run is still going.
      if (handle.status !== "completed") continue;
      if (handle.pendingPrompts.length > 0) continue;
      const sessionId = handle.sessionId;
      // Scheduled jobs are automation: they never ask.
      if (
        deps.cronDb !== undefined &&
        jobNameFor(deps.cronDb, sessionId) !== undefined
      )
        continue;
      if (inFlight.has(sessionId)) continue;
      const agentId = agentOfId(sessionId);
      if (agentId === undefined) continue;
      const askSpec = deps.askOf(agentId);
      if (askSpec === undefined) continue;
      const turn = currentTurn(deps.sessions, sessionId);
      if (turn === undefined) continue;
      if (served.get(sessionId) === turn.turnKey) continue;
      const stored = readRow(deps.db, sessionId);
      if (stored?.turnKey === turn.turnKey) {
        served.set(sessionId, turn.turnKey);
        continue;
      }
      ask(askSpec, agentId, sessionId, turn);
      if (inFlight.size >= maxInFlight()) return;
    }
  };

  const timer = setInterval(poll, pollMs());
  unrefTimer(timer);
  return { stop: () => clearInterval(timer) };
};

export type { ServiceDeps, SuggestionService };
export { createSuggestionService };
