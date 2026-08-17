import type { SessionStore } from "../../glv/sessions.js";
import {
  formatSessionHeader,
  formatTranscript,
  parseMessage,
} from "../format/index.js";

const runView = (sessions: SessionStore, sessionId: string): void => {
  const session = sessions.getSession(sessionId);
  if (session === undefined) {
    console.error(`Session not found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }
  const messages = sessions.listMessages(sessionId).map(parseMessage);
  console.log(formatSessionHeader(session));
  console.log("");
  console.log(formatTranscript(messages));
};

export { runView };
