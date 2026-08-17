import type { FlavorProfile } from "../glv/profile.js";

const gooseProfile: FlavorProfile = {
  id: "goose",
  streamEnvelope: "top-level",
  agentName: "goose",
  dataDirName: "glv-goose",
  sessionTimeoutError:
    "goose did not create a session in time. Is the goose binary available?",
};

export { gooseProfile };
