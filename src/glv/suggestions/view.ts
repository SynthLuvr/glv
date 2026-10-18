import type { DatabaseSync } from "node:sqlite";
import type { SessionRow } from "../sessions.js";
import { turnKeyOf } from "./ask.js";
import { readRow } from "./db.js";

// The read side of suggestions: what, if anything, the UI should render
// for a session right now. One answer shared by the transcript render,
// the prompt-bar fragment, and the SSE stream, so all three can never
// disagree.

// The suggestions visible for a session's current turn: the stored row
// only when its turn fingerprint matches the session exactly as it
// sits — a row left over from an earlier turn (or a stale transcript
// the server never ran) shows nothing.
const currentSuggestions = (
  db: DatabaseSync | undefined,
  session: SessionRow | undefined,
  messageCount: number,
): string[] => {
  if (db === undefined || session === undefined) return [];
  const stored = readRow(db, session.id);
  if (stored === undefined) return [];
  if (stored.turnKey !== turnKeyOf(session, messageCount)) return [];
  return stored.prompts;
};

export { currentSuggestions };
