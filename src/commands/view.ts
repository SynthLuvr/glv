import type { DatabaseSync } from "node:sqlite";
import { getSession, listMessages } from "../db.js";
import {
  formatSessionHeader,
  formatTranscript,
  parseMessage,
} from "../format.js";

const runView = (db: DatabaseSync, sessionId: string): void => {
  const session = getSession(db, sessionId);
  if (session === undefined) {
    console.error(`Session not found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }
  const messages = listMessages(db, sessionId).map(parseMessage);
  console.log(formatSessionHeader(session));
  console.log("");
  console.log(formatTranscript(messages));
};

export { runView };
