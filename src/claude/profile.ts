import type { FlavorProfile } from "../glv/profile.js";

const claudeProfile: FlavorProfile = {
  id: "claude",
  streamEnvelope: "message",
  agentName: "claude",
  dataDirName: "glv-claude",
  sessionTimeoutError:
    "claude did not create a session in time. Is the claude binary available?",
};

export { claudeProfile };
