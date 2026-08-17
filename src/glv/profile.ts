type FlavorProfile = {
  /** Stable flavor identifier ("goose", "claude"). */
  readonly id: string;
  /**
   * Stream-json envelope dialect the agent emits: "top-level" records
   * carry role/content directly; "message" records nest them under a
   * "message" wrapper. The stream preview parser accepts only the
   * declared shape — foreign envelopes are discarded, by design.
   */
  readonly streamEnvelope: StreamEnvelope;
  /** The agent's name in user-facing copy ("goose", "claude"). */
  readonly agentName: string;
  /** Viewer-owned data directory name ("glv-goose", "glv-claude"). */
  readonly dataDirName: string;
  /** 502 copy shown when a launched run never creates its session. */
  readonly sessionTimeoutError: string;
};

type StreamEnvelope = "top-level" | "message";

// Per-flavor facts the core receives as data. A difference between the
// flavors that is a name, path, or message belongs here — never in a
// core branch. (Phase 3 extends this with runner and branding data.)

export type { FlavorProfile, StreamEnvelope };
