import type { SessionStore } from "../db.js";
import { getSession, listMessages } from "../db.js";
import {
  formatSessionHeader,
  formatTranscript,
  parseMessage,
} from "../format/index.js";

const runView = (store: SessionStore, sessionId: string): void => {
  const session = getSession(store, sessionId);
  if (session === undefined) {
    console.error(`Session not found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }
  const messages = listMessages(store, sessionId).map(parseMessage);
  console.log(formatSessionHeader(session));
  console.log("");
  console.log(formatTranscript(messages));
};

export { runView };
